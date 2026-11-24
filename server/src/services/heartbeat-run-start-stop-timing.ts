import { eq } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { setRuntimeTransferObserver, type RuntimeTransferEvent } from "@paperclipai/adapter-utils";
import { parseObject } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";
import { currentExecutionScopeRunId } from "./execution-preparation-timing.js";

/**
 * One structured server log line per settled run with its start/stop cost:
 * `msg: "heartbeat run start/stop timing"`. This is a pino line only. It is not
 * Telemetry, an OpenTelemetry span, or a run-log event.
 *
 * While a run executes on this process, the heartbeat records marks here
 * (environment lease, first agent output, execution attempt end, workspace and
 * session reuse), and the adapter-utils transfer observer attributes each
 * `Syncing`/`Importing git history` (inbound) and `Restoring`/`Exporting git
 * history` (outbound) transfer to the run whose execution scope it runs in.
 * At settlement the marks are combined with the run row. A run settled on a
 * process that never executed it (cancelled while queued, recovered after a
 * restart) still logs one line; fields it cannot know are null.
 */
export const HEARTBEAT_RUN_START_STOP_TIMING_MESSAGE = "heartbeat run start/stop timing";

export type HeartbeatRunFailedStep =
  | "queue" | "lease" | "workspace_setup" | "sync_in" | "provider_start" | "agent" | "sync_out" | "finalize";

export type WorkspaceReuse = "reused" | "replaced" | "created";

type Transfer = {
  direction: "in" | "out";
  phase: RuntimeTransferEvent["phase"];
  startedAtMs: number;
  endedAtMs: number | null;
  bytes: number;
  failed: boolean;
};

type RunMarks = {
  leaseStartedAtMs: number | null;
  leaseEndedAtMs: number | null;
  leaseFailed: boolean;
  environmentDriver: string | null;
  firstOutputAtMs: number | null;
  attemptEndedAtMs: number | null;
  transfers: Map<number, Transfer>;
  workspaceReuse: WorkspaceReuse | null;
  workspaceReuseReason: string | null;
  sessionResumed: boolean | null;
  sessionResumeMissReason: string | null;
};

// Mirrors TERMINAL_HEARTBEAT_RUN_STATUSES in issues.ts without importing that service.
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);
const MAX_TRACKED_RUNS = 512;
const MAX_TRANSFERS_PER_RUN = 64;
const MAX_REMEMBERED_LOGGED_RUNS = 2048;
const marksByRun = new Map<string, RunMarks>();
const loggedRuns = new Set<string>();

function marksFor(runId: string): RunMarks {
  let marks = marksByRun.get(runId);
  if (!marks) {
    if (marksByRun.size >= MAX_TRACKED_RUNS) {
      const oldest = marksByRun.keys().next().value;
      if (oldest !== undefined) marksByRun.delete(oldest);
    }
    marks = {
      leaseStartedAtMs: null, leaseEndedAtMs: null, leaseFailed: false, environmentDriver: null,
      firstOutputAtMs: null, attemptEndedAtMs: null, transfers: new Map(),
      workspaceReuse: null, workspaceReuseReason: null, sessionResumed: null, sessionResumeMissReason: null,
    };
    marksByRun.set(runId, marks);
  }
  return marks;
}

/** Environment acquisition (including sandbox/pod start) for the run's attempt. */
export function recordHeartbeatRunLease(runId: string, input: {
  startedAtMs: number; endedAtMs: number; failed: boolean; environmentDriver?: string | null;
}): void {
  const marks = marksFor(runId);
  // A resumed attempt acquires again; the line reports the total time spent leasing.
  const previousMs = marks.leaseStartedAtMs != null && marks.leaseEndedAtMs != null
    ? marks.leaseEndedAtMs - marks.leaseStartedAtMs : 0;
  marks.leaseStartedAtMs = input.startedAtMs - previousMs;
  marks.leaseEndedAtMs = input.endedAtMs;
  marks.leaseFailed = input.failed;
  if (input.environmentDriver) marks.environmentDriver = input.environmentDriver;
}

/** Marks the first agent output: stdout that is not a `[paperclip]` host line. */
export function recordHeartbeatRunOutput(runId: string, stream: "stdout" | "stderr", chunk: string, atMs = Date.now()): void {
  if (stream !== "stdout") return;
  const existing = marksByRun.get(runId);
  if (existing?.firstOutputAtMs != null) return;
  const agentLine = chunk.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("[paperclip]");
  });
  if (agentLine) marksFor(runId).firstOutputAtMs = atMs;
}

export function recordHeartbeatRunAttemptEnded(runId: string, atMs = Date.now()): void {
  marksFor(runId).attemptEndedAtMs = atMs;
}

export function recordHeartbeatRunReuse(runId: string, input: {
  workspaceReuse: WorkspaceReuse;
  workspaceReuseReason: string | null;
  sessionResumed: boolean;
  sessionResumeMissReason: string | null;
}): void {
  Object.assign(marksFor(runId), input);
}

/** Derives workspace and session reuse from session preparation's freshness metadata. */
export function describeHeartbeatRunReuse(input: {
  workspace: {
    workspaceReused: boolean;
    reuseRequested: boolean;
    previousWorkspaceId: string | null | undefined;
    action: string | null | undefined;
    reasons: readonly unknown[] | null | undefined;
  };
  session: { taskSessionAvailable: boolean; reset: boolean; resetReasons: readonly unknown[] | null | undefined };
  sessionResumed: boolean;
  sessionCompaction: { rotate: boolean; reason: string | null };
  credentialCompatible: boolean;
}): Parameters<typeof recordHeartbeatRunReuse>[1] {
  const { workspace, session } = input;
  const workspaceReasons = (workspace.reasons ?? []).filter((reason): reason is string => typeof reason === "string");
  const resetReasons = (session.resetReasons ?? []).filter((reason): reason is string => typeof reason === "string");
  const workspaceReuse: WorkspaceReuse = workspace.workspaceReused
    ? "reused"
    : workspace.reuseRequested && workspace.previousWorkspaceId ? "replaced" : "created";
  const workspaceReuseReason = workspaceReuse === "reused"
    ? null
    : workspaceReasons[0]
      ?? (workspaceReuse === "replaced" ? workspace.action ?? "not_reusable"
        : workspace.reuseRequested ? "no_previous_workspace" : "reuse_not_requested");
  const sessionResumeMissReason = input.sessionResumed
    ? null
    : input.sessionCompaction.rotate
      ? `rotated${input.sessionCompaction.reason ? `: ${input.sessionCompaction.reason}` : ""}`
      : session.reset ? `reset${resetReasons.length ? `: ${resetReasons.join(", ")}` : ""}`
        : !input.credentialCompatible ? "ai_credential_changed"
          : session.taskSessionAvailable ? "not_resumable" : "no_prior_session";
  return { workspaceReuse, workspaceReuseReason, sessionResumed: input.sessionResumed, sessionResumeMissReason };
}

function onRuntimeTransfer(event: RuntimeTransferEvent): void {
  const runId = currentExecutionScopeRunId();
  if (!runId) return;
  const marks = marksFor(runId);
  if (event.kind === "start") {
    if (marks.transfers.size >= MAX_TRANSFERS_PER_RUN) return;
    const direction = event.phase === "Syncing" || event.phase === "Importing git history" ? "in" : "out";
    marks.transfers.set(event.id, { direction, phase: event.phase, startedAtMs: event.atMs, endedAtMs: null, bytes: 0, failed: false });
    return;
  }
  const transfer = marks.transfers.get(event.id);
  if (!transfer) return;
  transfer.endedAtMs = event.atMs;
  transfer.bytes = event.bytes;
  transfer.failed = event.outcome === "failed";
}

let observerInstalled = false;
/** Idempotent. Called once by the heartbeat service on this process. */
export function installHeartbeatRunTransferObserver(): void {
  if (observerInstalled) return;
  observerInstalled = true;
  setRuntimeTransferObserver(onRuntimeTransfer);
}

type SettledRun = {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  errorCode: string | null;
  createdAt: Date | string | null;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  contextSnapshot: unknown;
};

export type HeartbeatRunStartStopTiming = {
  runId: string;
  agentId: string;
  agentName: string | null;
  companyId: string;
  issueId: string | null;
  repository: string;
  adapter: string | null;
  environmentDriver: string | null;
  outcome: "succeeded" | "failed" | "cancelled" | "interrupted";
  status: string;
  errorCode: string | null;
  failedStep: HeartbeatRunFailedStep | null;
  queueMs: number | null;
  leaseMs: number | null;
  prepareMs: number | null;
  syncInMs: number | null;
  providerStartMs: number | null;
  timeToFirstOutputMs: number | null;
  agentMs: number | null;
  syncOutMs: number | null;
  finalizeMs: number | null;
  totalMs: number | null;
  syncInBytes: number | null;
  syncOutBytes: number | null;
  gitExportBytes: number | null;
  workspaceReuse: WorkspaceReuse | null;
  workspaceReuseReason: string | null;
  sessionResumed: boolean | null;
  sessionResumeMissReason: string | null;
};

function toMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function span(from: number | null, to: number | null): number | null {
  return from == null || to == null ? null : Math.max(0, Math.round(to - from));
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** `owner/name` of a git remote URL (https, ssh or scp-like), or null. */
export function repositoryFromRepoUrl(repoUrl: string | null): string | null {
  if (!repoUrl) return null;
  const match = repoUrl.trim().replace(/\/+$/, "").replace(/\.git$/, "")
    .match(/[/:]([^/:]+)\/([^/:]+)$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function outcomeOf(status: string): HeartbeatRunStartStopTiming["outcome"] {
  if (status === "succeeded" || status === "cancelled" || status === "interrupted") return status;
  return "failed";
}

type TransferWindow = { startedAtMs: number | null; endedAtMs: number | null; bytes: number | null; unfinished: boolean };

function windowOf(transfers: Transfer[]): TransferWindow {
  if (transfers.length === 0) return { startedAtMs: null, endedAtMs: null, bytes: null, unfinished: false };
  const unfinished = transfers.some((transfer) => transfer.endedAtMs == null || transfer.failed);
  const ended = transfers.flatMap((transfer) => transfer.endedAtMs == null ? [] : [transfer.endedAtMs]);
  return {
    startedAtMs: Math.min(...transfers.map((transfer) => transfer.startedAtMs)),
    endedAtMs: ended.length > 0 ? Math.max(...ended) : null,
    bytes: transfers.reduce((sum, transfer) => sum + transfer.bytes, 0),
    unfinished,
  };
}

/** Pure: combines a settled run row with the marks recorded while it executed. */
export function buildHeartbeatRunStartStopTiming(
  run: SettledRun,
  agent: { name: string | null; adapterType: string | null } | null,
  marks: RunMarks | null,
  nowMs = Date.now(),
): HeartbeatRunStartStopTiming {
  const context = parseObject(run.contextSnapshot);
  const workspace = parseObject(context.paperclipWorkspace);
  const environment = parseObject(context.paperclipEnvironment);
  const createdAtMs = toMs(run.createdAt);
  const startedAtMs = toMs(run.startedAt);
  const finishedAtMs = toMs(run.finishedAt) ?? nowMs;
  const transfers = [...(marks?.transfers.values() ?? [])];
  const syncIn = windowOf(transfers.filter((transfer) => transfer.direction === "in"));
  const syncOutTransfers = transfers.filter((transfer) => transfer.direction === "out");
  const syncOut = windowOf(syncOutTransfers);
  const gitExport = windowOf(syncOutTransfers.filter((transfer) => transfer.phase === "Exporting git history"));
  const leaseMs = span(marks?.leaseStartedAtMs ?? null, marks?.leaseEndedAtMs ?? null);
  const firstOutputAtMs = marks?.firstOutputAtMs ?? null;
  const agentEndedAtMs = syncOut.startedAtMs ?? marks?.attemptEndedAtMs ?? null;
  const preparedAtMs = syncIn.startedAtMs ?? firstOutputAtMs ?? agentEndedAtMs ?? (marks ? finishedAtMs : null);
  const prepareSpan = span(startedAtMs, preparedAtMs);
  const outcome = outcomeOf(run.status);

  let failedStep: HeartbeatRunFailedStep | null = null;
  if (outcome !== "succeeded") {
    if (startedAtMs == null) failedStep = "queue";
    else if (marks?.leaseStartedAtMs != null && (marks.leaseFailed || marks.leaseEndedAtMs == null)) failedStep = "lease";
    else if (syncIn.unfinished) failedStep = "sync_in";
    else if (firstOutputAtMs == null) failedStep = syncIn.startedAtMs != null ? "provider_start" : "workspace_setup";
    else if (syncOut.unfinished) failedStep = "sync_out";
    // Without sync-out the agent's own result is what settled the run; after a
    // completed sync-out only settlement work remains.
    else failedStep = syncOut.startedAtMs == null ? "agent" : "finalize";
  }

  return {
    runId: run.id,
    agentId: run.agentId,
    agentName: agent?.name ?? null,
    companyId: run.companyId,
    issueId: readString(context.issueId) ?? readString(context.taskId),
    repository: repositoryFromRepoUrl(readString(workspace.repoUrl)) ?? "none",
    adapter: agent?.adapterType ?? null,
    environmentDriver: marks?.environmentDriver ?? readString(environment.driver),
    outcome,
    status: run.status,
    errorCode: run.errorCode ?? null,
    failedStep,
    queueMs: span(createdAtMs, startedAtMs),
    leaseMs,
    prepareMs: prepareSpan == null ? null : Math.max(0, prepareSpan - (leaseMs ?? 0)),
    syncInMs: span(syncIn.startedAtMs, syncIn.endedAtMs),
    providerStartMs: span(syncIn.endedAtMs, firstOutputAtMs),
    timeToFirstOutputMs: span(createdAtMs, firstOutputAtMs),
    agentMs: span(firstOutputAtMs, agentEndedAtMs ?? (firstOutputAtMs != null ? finishedAtMs : null)),
    syncOutMs: span(syncOut.startedAtMs, syncOut.endedAtMs),
    finalizeMs: span(syncOut.endedAtMs ?? marks?.attemptEndedAtMs ?? null, finishedAtMs),
    totalMs: span(createdAtMs, finishedAtMs),
    syncInBytes: syncIn.bytes,
    syncOutBytes: syncOut.bytes,
    gitExportBytes: gitExport.bytes,
    workspaceReuse: marks?.workspaceReuse ?? null,
    workspaceReuseReason: marks?.workspaceReuseReason ?? null,
    sessionResumed: marks?.sessionResumed ?? null,
    sessionResumeMissReason: marks?.sessionResumeMissReason ?? null,
  };
}

/**
 * Logs the run's start/stop timing line once. Called beside every terminal
 * status write (the `agent.task_run` emission point), after commit. Never
 * throws and never delays settlement: call it with `void`.
 */
export async function logHeartbeatRunStartStopTiming(db: Db, runId: string): Promise<void> {
  if (loggedRuns.has(runId)) return;
  try {
    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        createdAt: heartbeatRuns.createdAt,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        agentName: agents.name,
        adapterType: agents.adapterType,
      })
      .from(heartbeatRuns)
      .leftJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    // Only a settled run gets a line; a caller handing over a still-live row must
    // not use up the run's one line before it actually settles.
    if (!run || loggedRuns.has(runId) || !TERMINAL_STATUSES.has(run.status)) return;
    if (loggedRuns.size >= MAX_REMEMBERED_LOGGED_RUNS) {
      const oldest = loggedRuns.values().next().value;
      if (oldest !== undefined) loggedRuns.delete(oldest);
    }
    loggedRuns.add(runId);
    const marks = marksByRun.get(runId) ?? null;
    marksByRun.delete(runId);
    logger.info(
      buildHeartbeatRunStartStopTiming(run, { name: run.agentName, adapterType: run.adapterType }, marks),
      HEARTBEAT_RUN_START_STOP_TIMING_MESSAGE,
    );
  } catch (err) {
    logger.warn({ err, runId }, "failed to log heartbeat run start/stop timing");
  }
}

/** Test-only: forget all recorded marks and logged runs. */
export function resetHeartbeatRunStartStopTimingForTests(): void {
  marksByRun.clear();
  loggedRuns.clear();
}

/** Test-only: the marks recorded so far for a run. */
export function peekHeartbeatRunMarksForTests(runId: string): RunMarks | null {
  return marksByRun.get(runId) ?? null;
}
