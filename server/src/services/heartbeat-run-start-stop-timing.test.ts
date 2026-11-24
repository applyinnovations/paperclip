import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createRuntimeProgressReporter } from "@paperclipai/adapter-utils";

const mockLogger = vi.hoisted(() => {
  const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
  logger.child = () => logger;
  return logger as { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
});
vi.mock("../middleware/logger.js", () => ({ logger: mockLogger }));

import {
  HEARTBEAT_RUN_START_STOP_TIMING_MESSAGE,
  buildHeartbeatRunStartStopTiming,
  describeHeartbeatRunReuse,
  installHeartbeatRunTransferObserver,
  logHeartbeatRunStartStopTiming,
  peekHeartbeatRunMarksForTests,
  recordHeartbeatRunAttemptEnded,
  recordHeartbeatRunLease,
  recordHeartbeatRunOutput,
  repositoryFromRepoUrl,
  resetHeartbeatRunStartStopTimingForTests,
} from "./heartbeat-run-start-stop-timing.js";
import { withRunExecutionTiming, withRunWorkspaceFinalizationTiming } from "./execution-preparation-timing.js";

const T0 = Date.parse("2026-11-24T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms);
const MB = 1024 * 1024;

type Row = {
  id: string; companyId: string; agentId: string; status: string; errorCode: string | null;
  createdAt: Date | null; startedAt: Date | null; finishedAt: Date | null; contextSnapshot: unknown;
  agentName: string | null; adapterType: string | null;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "run-1", companyId: "company-1", agentId: "agent-1", status: "succeeded", errorCode: null,
    createdAt: at(0), startedAt: at(1_000), finishedAt: at(60_000),
    contextSnapshot: {
      issueId: "issue-1",
      paperclipWorkspace: { repoUrl: "https://github.com/example-org/paperclip.git" },
      paperclipEnvironment: { driver: "kubernetes" },
    },
    agentName: "Engineer", adapterType: "claude_local",
    ...overrides,
  };
}

/** The select → from → leftJoin → where chain the logger uses, answering with one row. */
function fakeDb(current: () => Row | null): Db {
  const chain = {
    select: () => chain, from: () => chain, leftJoin: () => chain,
    where: () => Promise.resolve(current() ? [current()!] : []),
  };
  return chain as unknown as Db;
}

function loggedLines() {
  return mockLogger.info.mock.calls.filter(([, msg]) => msg === HEARTBEAT_RUN_START_STOP_TIMING_MESSAGE).map(([fields]) => fields);
}

afterEach(() => {
  resetHeartbeatRunStartStopTimingForTests();
  vi.clearAllMocks();
});

describe("heartbeat run start/stop timing", () => {
  it("attributes sync-in and sync-out transfers to the run whose execution scope they run in", async () => {
    installHeartbeatRunTransferObserver();
    await withRunExecutionTiming("run-1", async () => {
      const syncIn = createRuntimeProgressReporter({ sink: () => {}, phase: "Syncing", label: "workspace", direction: "to", target: "sandbox" });
      await syncIn.complete(4 * MB, 4 * MB);
      recordHeartbeatRunOutput("run-1", "stdout", "[paperclip] Syncing workspace to sandbox: 4.0 MB\n");
      recordHeartbeatRunOutput("run-1", "stderr", "warning\n");
      expect(peekHeartbeatRunMarksForTests("run-1")?.firstOutputAtMs).toBeNull();
      recordHeartbeatRunOutput("run-1", "stdout", "{\"type\":\"system\"}\n");
      const restore = createRuntimeProgressReporter({ sink: () => {}, phase: "Restoring", label: "workspace", direction: "from", target: "sandbox" });
      await restore.complete(2 * MB, 2 * MB);
    });
    await withRunWorkspaceFinalizationTiming("run-1", async () => {
      const exportGit = createRuntimeProgressReporter({ sink: () => {}, phase: "Exporting git history", direction: "from", target: "sandbox" });
      await exportGit.complete(MB, MB);
    });
    // Outside any run scope: not attributed to anyone.
    await createRuntimeProgressReporter({ sink: () => {}, phase: "Syncing", direction: "to", target: "sandbox" }).complete(9 * MB, 9 * MB);

    const marks = peekHeartbeatRunMarksForTests("run-1");
    expect(marks?.firstOutputAtMs).not.toBeNull();
    const line = buildHeartbeatRunStartStopTiming(row(), { name: "Engineer", adapterType: "claude_local" }, marks);
    expect(line).toMatchObject({ syncInBytes: 4 * MB, syncOutBytes: 3 * MB, gitExportBytes: MB, failedStep: null, outcome: "succeeded" });
    expect(line.syncInMs).toEqual(expect.any(Number));
    expect(line.syncOutMs).toEqual(expect.any(Number));
  });

  it("splits a successful run into its steps", () => {
    const marks = {
      leaseStartedAtMs: T0 + 2_000, leaseEndedAtMs: T0 + 12_000, leaseFailed: false, environmentDriver: "kubernetes",
      firstOutputAtMs: T0 + 25_000, attemptEndedAtMs: T0 + 55_000,
      transfers: new Map([
        [1, { direction: "in" as const, phase: "Syncing" as const, startedAtMs: T0 + 15_000, endedAtMs: T0 + 20_000, bytes: 50 * MB, failed: false }],
        [2, { direction: "out" as const, phase: "Restoring" as const, startedAtMs: T0 + 50_000, endedAtMs: T0 + 53_000, bytes: 7 * MB, failed: false }],
        [3, { direction: "out" as const, phase: "Exporting git history" as const, startedAtMs: T0 + 53_000, endedAtMs: T0 + 54_000, bytes: MB, failed: false }],
      ]),
      workspaceReuse: "reused" as const, workspaceReuseReason: null, sessionResumed: true, sessionResumeMissReason: null,
    };
    expect(buildHeartbeatRunStartStopTiming(row(), { name: "Engineer", adapterType: "claude_local" }, marks)).toEqual({
      runId: "run-1", agentId: "agent-1", agentName: "Engineer", companyId: "company-1", issueId: "issue-1",
      repository: "example-org/paperclip", adapter: "claude_local", environmentDriver: "kubernetes",
      outcome: "succeeded", status: "succeeded", errorCode: null, failedStep: null,
      queueMs: 1_000, leaseMs: 10_000, prepareMs: 4_000, syncInMs: 5_000, providerStartMs: 5_000,
      timeToFirstOutputMs: 25_000, agentMs: 25_000, syncOutMs: 4_000, finalizeMs: 6_000, totalMs: 60_000,
      syncInBytes: 50 * MB, syncOutBytes: 8 * MB, gitExportBytes: MB,
      workspaceReuse: "reused", workspaceReuseReason: null, sessionResumed: true, sessionResumeMissReason: null,
    });
  });

  it("names the failed step for each way a run can fail", () => {
    const build = (status: string, marks: Parameters<typeof buildHeartbeatRunStartStopTiming>[2], overrides: Partial<Row> = {}) =>
      buildHeartbeatRunStartStopTiming(row({ status, ...overrides }), null, marks).failedStep;
    const base = () => ({
      leaseStartedAtMs: null, leaseEndedAtMs: null, leaseFailed: false, environmentDriver: null,
      firstOutputAtMs: null, attemptEndedAtMs: null, transfers: new Map(),
      workspaceReuse: null, workspaceReuseReason: null, sessionResumed: null, sessionResumeMissReason: null,
    });
    const transfer = (direction: "in" | "out", endedAtMs: number | null, failed = false) => ({
      direction, phase: direction === "in" ? "Syncing" as const : "Restoring" as const, startedAtMs: T0 + 1, endedAtMs, bytes: 1, failed,
    });

    expect(build("cancelled", null, { startedAt: null })).toBe("queue");
    expect(build("failed", { ...base(), leaseStartedAtMs: T0, leaseEndedAtMs: T0 + 30_000, leaseFailed: true })).toBe("lease");
    expect(build("failed", base())).toBe("workspace_setup");
    expect(build("failed", { ...base(), transfers: new Map([[1, transfer("in", null)]]) })).toBe("sync_in");
    expect(build("failed", { ...base(), transfers: new Map([[1, transfer("in", T0 + 2, true)]]) })).toBe("sync_in");
    expect(build("failed", { ...base(), transfers: new Map([[1, transfer("in", T0 + 2)]]) })).toBe("provider_start");
    expect(build("failed", { ...base(), firstOutputAtMs: T0 + 3 })).toBe("agent");
    expect(build("timed_out", { ...base(), firstOutputAtMs: T0 + 3, transfers: new Map([[1, transfer("out", null)]]) })).toBe("sync_out");
    expect(build("failed", { ...base(), firstOutputAtMs: T0 + 3, transfers: new Map([[1, transfer("out", T0 + 4)]]) })).toBe("finalize");
    // A later successful lease after a failed one is not a lease failure.
    expect(build("succeeded", { ...base(), leaseStartedAtMs: T0, leaseEndedAtMs: T0 + 1, leaseFailed: true })).toBeNull();
  });

  it("reports a lease timeout with the lease duration and no later steps", () => {
    recordHeartbeatRunLease("run-1", { startedAtMs: T0 + 1_000, endedAtMs: T0 + 31_000, failed: true });
    const line = buildHeartbeatRunStartStopTiming(
      row({ status: "failed", errorCode: "environment_acquire_failed", finishedAt: at(32_000) }), null, peekHeartbeatRunMarksForTests("run-1"),
    );
    expect(line).toMatchObject({
      outcome: "failed", failedStep: "lease", leaseMs: 30_000, prepareMs: 1_000, syncInMs: null, syncInBytes: null,
      timeToFirstOutputMs: null, agentMs: null, syncOutMs: null, totalMs: 32_000, environmentDriver: "kubernetes",
    });
  });

  it("adds the time of every lease acquisition across resumed attempts", () => {
    recordHeartbeatRunLease("run-1", { startedAtMs: T0, endedAtMs: T0 + 4_000, failed: false });
    recordHeartbeatRunLease("run-1", { startedAtMs: T0 + 10_000, endedAtMs: T0 + 13_000, failed: false, environmentDriver: "kubernetes" });
    const marks = peekHeartbeatRunMarksForTests("run-1")!;
    expect(marks.leaseEndedAtMs! - marks.leaseStartedAtMs!).toBe(7_000);
    expect(marks.environmentDriver).toBe("kubernetes");
  });

  it("still describes a run this process never executed, with unknown steps as null", () => {
    const line = buildHeartbeatRunStartStopTiming(row({ status: "interrupted", contextSnapshot: {} }), null, null);
    expect(line).toMatchObject({
      outcome: "interrupted", repository: "none", agentName: null, adapter: null, environmentDriver: null,
      failedStep: "workspace_setup", queueMs: 1_000, leaseMs: null, prepareMs: null, finalizeMs: null, totalMs: 60_000,
      workspaceReuse: null, sessionResumed: null,
    });
  });

  it("derives workspace and session reuse", () => {
    const workspace = { workspaceReused: false, reuseRequested: true, previousWorkspaceId: "ws-0", action: "recreate", reasons: ["branch_changed"] };
    const session = { taskSessionAvailable: true, reset: false, resetReasons: [] };
    const compaction = { rotate: false, reason: null };
    expect(describeHeartbeatRunReuse({ workspace, session, sessionResumed: false, sessionCompaction: compaction, credentialCompatible: true }))
      .toEqual({ workspaceReuse: "replaced", workspaceReuseReason: "branch_changed", sessionResumed: false, sessionResumeMissReason: "not_resumable" });
    expect(describeHeartbeatRunReuse({
      workspace: { ...workspace, workspaceReused: true }, session, sessionResumed: true, sessionCompaction: compaction, credentialCompatible: true,
    })).toEqual({ workspaceReuse: "reused", workspaceReuseReason: null, sessionResumed: true, sessionResumeMissReason: null });
    expect(describeHeartbeatRunReuse({
      workspace: { ...workspace, reuseRequested: false, previousWorkspaceId: null, reasons: [] },
      session: { taskSessionAvailable: false, reset: false, resetReasons: [] }, sessionResumed: false, sessionCompaction: compaction, credentialCompatible: true,
    })).toMatchObject({ workspaceReuse: "created", workspaceReuseReason: "reuse_not_requested", sessionResumeMissReason: "no_prior_session" });
    expect(describeHeartbeatRunReuse({
      workspace, session: { ...session, reset: true, resetReasons: ["config_changed"] }, sessionResumed: false, sessionCompaction: compaction, credentialCompatible: true,
    }).sessionResumeMissReason).toBe("reset: config_changed");
    expect(describeHeartbeatRunReuse({
      workspace, session, sessionResumed: false, sessionCompaction: { rotate: true, reason: "token budget" }, credentialCompatible: true,
    }).sessionResumeMissReason).toBe("rotated: token budget");
    expect(describeHeartbeatRunReuse({
      workspace, session, sessionResumed: false, sessionCompaction: compaction, credentialCompatible: false,
    }).sessionResumeMissReason).toBe("ai_credential_changed");
  });

  it("reads owner/name from https, ssh and scp-like remotes", () => {
    expect(repositoryFromRepoUrl("https://github.com/example-org/paperclip")).toBe("example-org/paperclip");
    expect(repositoryFromRepoUrl("https://github.com/example-org/paperclip.git/")).toBe("example-org/paperclip");
    expect(repositoryFromRepoUrl("git@github.com:example-org/deployments.git")).toBe("example-org/deployments");
    expect(repositoryFromRepoUrl("ssh://git@github.com/example-org/paperclip.git")).toBe("example-org/paperclip");
    expect(repositoryFromRepoUrl("not a url")).toBeNull();
    expect(repositoryFromRepoUrl(null)).toBeNull();
  });

  it("logs exactly one line per settled run and none while the run is still live", async () => {
    let current: Row | null = row({ status: "running", finishedAt: null });
    const db = fakeDb(() => current);
    recordHeartbeatRunAttemptEnded("run-1", T0 + 59_000);

    await logHeartbeatRunStartStopTiming(db, "run-1");
    expect(loggedLines()).toHaveLength(0);
    expect(peekHeartbeatRunMarksForTests("run-1")).not.toBeNull();

    current = row({ status: "failed", errorCode: "adapter_failed" });
    await Promise.all([logHeartbeatRunStartStopTiming(db, "run-1"), logHeartbeatRunStartStopTiming(db, "run-1")]);
    await logHeartbeatRunStartStopTiming(db, "run-1");
    expect(loggedLines()).toEqual([expect.objectContaining({
      runId: "run-1", agentName: "Engineer", adapter: "claude_local", outcome: "failed", errorCode: "adapter_failed", finalizeMs: 1_000,
    })]);
    expect(peekHeartbeatRunMarksForTests("run-1")).toBeNull();
  });

  it("never throws when the lookup fails", async () => {
    const db = { select: () => { throw new Error("db down"); } } as unknown as Db;
    await expect(logHeartbeatRunStartStopTiming(db, "run-1")).resolves.toBeUndefined();
    expect(loggedLines()).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1" }), "failed to log heartbeat run start/stop timing");
  });
});
