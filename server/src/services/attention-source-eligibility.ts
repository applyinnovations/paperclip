import { and, eq, gt, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import {
  agents, agentWakeupRequests, heartbeatRuns, issueRecoveryActions, issueRelations, issues, issueThreadInteractions, type Db,
} from "@paperclipai/db";
import { ISSUE_TERMINAL_BLOCKER_STRANDED_WAKE_REASON } from "@paperclipai/shared";
import { isHeartbeatWakeOnDemandEnabled } from "./heartbeat-policy.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

export const HUMAN_RECOVERY_OWNER_TYPES = ["user", "board"] as const;
const OPEN_RECOVERY_ATTENTION_STATUSES = ["active", "escalated"] as const;

export function recoveryActionAttentionCondition() {
  return and(inArray(issueRecoveryActions.status, [...OPEN_RECOVERY_ATTENTION_STATUSES]),
    inArray(issueRecoveryActions.ownerType, [...HUMAN_RECOVERY_OWNER_TYPES]))!;
}
export const ATTENTION_BUDGET_WARNING_PERCENT = 85;
export const ATTENTION_AGENT_ERROR_STATUS = "error";

function confirmationAudienceKey(row: { issueId: string; addresseeUserId?: string | null; addresseeAgentId?: string | null }) {
  return `${row.issueId}:${row.addresseeUserId ?? ""}:${row.addresseeAgentId ?? ""}`;
}

function payloadFlag(payload: unknown, key: string) {
  return Boolean(payload && typeof payload === "object" && key in payload && (payload as Record<string, unknown>)[key]);
}

/** Payload keys that bind a confirmation to one specific action (tool call, secret, app connection). */
const GOVERNED_CONFIRMATION_PAYLOAD_KEYS = ["toolAction", "secretProposal", "connectionAuthorization"] as const;

/** Governed confirmations gate one action; answering one never answers an ordinary ask, and vice versa. */
function governedAction(payload: unknown) {
  // Truthy, not key presence: the summary read projects absent keys as JSON null.
  return GOVERNED_CONFIRMATION_PAYLOAD_KEYS.some((key) => payloadFlag(payload, key));
}

/**
 * A pending confirmation is superseded once the same issue has a newer
 * ordinary confirmation — pending, or already answered/expired. Without the
 * settled case, answering the newest card (from chat or anywhere else)
 * resurfaces the older ask it replaced. Quality approvals stay
 * independent; tool-action, secret-proposal and app-connection approvals gate
 * one specific action, so they neither hide nor are hidden by a settled
 * confirmation.
 * Only an ask to the same recipient settles it, so one person's answer never
 * hides a request addressed to someone else.
 */
export function collapsePendingConfirmationsToNewest<T extends {
  id: string;
  issueId: string;
  kind: string;
  createdAt: Date;
  payload: unknown;
  addresseeUserId?: string | null;
  addresseeAgentId?: string | null;
}>(rows: T[], newestSettledConfirmationAt: ReadonlyMap<string, Date> = new Map()) {
  const independent = (row: T) => payloadFlag(row.payload, "qualityReview");
  const newestByGroup = new Map<string, T>();
  for (const row of rows) {
    if (row.kind !== "request_confirmation" || independent(row)) continue;
    const groupKey = `${row.issueId}:${row.kind}`;
    const newest = newestByGroup.get(groupKey);
    if (
      !newest
      || row.createdAt.getTime() > newest.createdAt.getTime()
      || (row.createdAt.getTime() === newest.createdAt.getTime() && row.id > newest.id)
    ) {
      newestByGroup.set(groupKey, row);
    }
  }

  return rows.filter((row) => {
    if (row.kind !== "request_confirmation" || independent(row)) return true;
    if (newestByGroup.get(`${row.issueId}:${row.kind}`)?.id !== row.id) return false;
    const settledAt = governedAction(row.payload) ? undefined : newestSettledConfirmationAt.get(confirmationAudienceKey(row));
    return !settledAt || settledAt.getTime() <= row.createdAt.getTime();
  });
}

// Cancelled/failed replacements do not settle the ask, so an older card returns.
const SETTLED_CONFIRMATION_STATUSES = ["accepted", "rejected", "answered", "expired"] as const;

/** Newest answered/expired ordinary confirmation per issue and recipient (see the collapse above). */
export async function loadNewestSettledConfirmationAt(db: Db, companyId: string, issueIds: string[]) {
  const ids = [...new Set(issueIds)];
  if (ids.length === 0) return new Map<string, Date>();
  const rows = await db.select({
    issueId: issueThreadInteractions.issueId,
    addresseeUserId: issueThreadInteractions.addresseeUserId,
    addresseeAgentId: issueThreadInteractions.addresseeAgentId,
    createdAt: sql<string>`max(${issueThreadInteractions.createdAt})::text`,
  }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, companyId),
    inArray(issueThreadInteractions.issueId, ids),
    eq(issueThreadInteractions.kind, "request_confirmation"),
    inArray(issueThreadInteractions.status, [...SETTLED_CONFIRMATION_STATUSES]),
    sql`jsonb_typeof(${issueThreadInteractions.payload}->'qualityReview') is distinct from 'object'`,
    sql`not (${issueThreadInteractions.payload} ?| array['toolAction', 'secretProposal', 'connectionAuthorization'])`,
  )).groupBy(issueThreadInteractions.issueId, issueThreadInteractions.addresseeUserId, issueThreadInteractions.addresseeAgentId);
  return new Map(rows.map((row) => [confirmationAudienceKey(row), new Date(row.createdAt)]));
}

export function readRunIssueId(contextSnapshot: Record<string, unknown> | null) {
  const issueId = contextSnapshot?.issueId ?? contextSnapshot?.taskId;
  return typeof issueId === "string" && issueId.length > 0 ? issueId : null;
}

type FailedRunProbe = { id: string; agentId: string; issueId: string | null; createdAt: Date };

const FAILED_RUN_PROBE_BATCH_SIZE = 1000;

export async function listFailedRunsWithNewerRun(db: Db, companyId: string, failedRuns: FailedRunProbe[]) {
  const withNewerRun = new Set<string>();
  const keyed = failedRuns.filter(run => run.issueId !== null);
  for (let start = 0; start < keyed.length; start += FAILED_RUN_PROBE_BATCH_SIZE) {
    const batch = keyed.slice(start, start + FAILED_RUN_PROBE_BATCH_SIZE);
    for (const id of await listFailedRunBatchWithNewerRun(db, companyId, batch)) withNewerRun.add(id);
  }
  const unkeyed = failedRuns.filter(run => run.issueId === null);
  if (unkeyed.length === 0) return withNewerRun;
  const agentIds = [...new Set(unkeyed.map(run => run.agentId))];
  const oldestCreatedAt = unkeyed.reduce((oldest, run) => run.createdAt < oldest ? run.createdAt : oldest,
    unkeyed[0]!.createdAt);
  const latestByAgent = new Map<string, Date>();
  for (let start = 0; start < agentIds.length; start += FAILED_RUN_PROBE_BATCH_SIZE) {
    const rows = await db.select({
      agentId: heartbeatRuns.agentId,
      createdAt: sql<Date>`max(${heartbeatRuns.createdAt})`.mapWith(heartbeatRuns.createdAt),
    }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId),
      inArray(heartbeatRuns.agentId, agentIds.slice(start, start + FAILED_RUN_PROBE_BATCH_SIZE)),
      gt(heartbeatRuns.createdAt, oldestCreatedAt),
      sql`coalesce(${heartbeatRuns.contextSnapshot} ->> 'issueId', ${heartbeatRuns.contextSnapshot} ->> 'taskId', '') = ''`,
    )).groupBy(heartbeatRuns.agentId);
    for (const row of rows) latestByAgent.set(row.agentId, row.createdAt);
  }
  for (const run of unkeyed) {
    if ((latestByAgent.get(run.agentId)?.getTime() ?? 0) > run.createdAt.getTime()) withNewerRun.add(run.id);
  }
  return withNewerRun;
}

async function listFailedRunBatchWithNewerRun(db: Db, companyId: string, failedRuns: FailedRunProbe[]) {
  if (failedRuns.length === 0) return [];
  const failed = sql.join(
    failedRuns.map((run) => sql`(${run.id}::uuid, ${run.agentId}::uuid, ${run.issueId}::text, ${new Date(run.createdAt.getTime() + 1).toISOString()}::timestamptz)`),
    sql`, `,
  );
  const runIssueId = sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId')`;
  const runTaskId = sql`(${heartbeatRuns.contextSnapshot} ->> 'taskId')`;
  const newerRunExists = (match: SQL) => sql`exists (
    select 1 from ${heartbeatRuns}
    where ${heartbeatRuns.companyId} = ${companyId}
      and ${heartbeatRuns.agentId} = failed.agent_id
      and ${heartbeatRuns.createdAt} >= failed.newer_from
      and ${match}
  )`;
  const rows = await db.execute(sql`
    select failed.id
    from (values ${failed}) as failed (id, agent_id, issue_id, newer_from)
    where ${newerRunExists(sql`${runIssueId} = failed.issue_id`)}
      or ${newerRunExists(sql`${runTaskId} = failed.issue_id and ${runIssueId} is null`)}
  `) as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}


export function requiresReviewAttention(input: {
  hasHumanParticipant: boolean; hasUserAssignee: boolean; hasPendingApproval: boolean; stalled: boolean;
}) {
  return input.hasHumanParticipant || input.hasUserAssignee || input.hasPendingApproval || input.stalled;
}

/** The blocked tree is not moving and its terminal blocker is stalled or needs attention. */
export function terminalBlockerIsStranded<T extends { state?: string; blockingTreeLive?: boolean }>(
  attention: T | null | undefined,
): attention is T & { state: "stalled" | "needs_attention" } {
  return Boolean(attention && !attention.blockingTreeLive && ["stalled", "needs_attention"].includes(attention.state ?? ""));
}

/**
 * Whether a stranded terminal blocker needs the board now. An agent-owned
 * blocker that Paperclip is still auto-waking (APP-761) does not: its owner
 * gets the wake first, and the card appears only once a human is needed.
 * attention.ts and decision-retention.ts both decide through here.
 */
export function terminalBlockerRequiresAttention<T extends { state?: string; blockingTreeLive?: boolean }>(
  attention: T | null | undefined,
  autoWake: TerminalBlockerAutoWakeState | null | undefined,
): attention is T & { state: "stalled" | "needs_attention" } {
  return terminalBlockerIsStranded(attention) && !terminalBlockerAutoWakeHoldsCard(autoWake);
}

/**
 * Auto-wake of stranded terminal blockers (APP-761).
 *
 * A terminal blocker is the leaf a blocked tree waits on. When it is `todo` or
 * `in_review`, owned by an agent that takes wakes, and nothing has touched it
 * for `quietMs`, the recovery sweep wakes that agent (attempt 1). If the wake
 * ends with no progress, it wakes once more after `backoffMs` (attempt 2).
 * After that, or as soon as a human is needed, the board card appears.
 *
 * "No progress" means the stall fingerprint is unchanged: same status, same
 * status version and same assignee. Any status change or reassignment starts a
 * new fingerprint with fresh attempts.
 */
export const TERMINAL_BLOCKER_AUTO_WAKE = {
  quietMs: 5 * 60_000,
  backoffMs: 15 * 60_000,
  maxAttempts: 2,
  /**
   * A due wake that has not been sent this long after its deadline (no sweep
   * visited it, for example because every downstream issue is user-owned)
   * stops holding the card, so the safety net never hides a blocker.
   */
  overdueGraceMs: 10 * 60_000,
  /** An "active" run or wake untouched this long no longer counts as progress. */
  activeStaleMs: 60 * 60_000,
} as const;

const AUTO_WAKE_ISSUE_STATUSES = ["todo", "in_review"];
/** Not invokable for auto-wake. `error` is included: an errored agent needs a human, not another wake. */
export const AUTO_WAKE_NON_INVOKABLE_AGENT_STATUSES = ["paused", "terminated", "pending_approval", ATTENTION_AGENT_ERROR_STATUS];
const AUTO_WAKE_ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
const AUTO_WAKE_PENDING_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed"];

export type TerminalBlockerHumanReason =
  | "not_blocking" | "not_agent_recoverable" | "user_owned" | "unassigned" | "human_review"
  | "agent_unavailable" | "agent_takes_no_wakes";

export type TerminalBlockerAutoWakeState =
  | { kind: "human"; reason: TerminalBlockerHumanReason }
  | { kind: "active" }
  | { kind: "pending"; agentId: string; agentName: string; fingerprint: string; attempt: number; dueAt: number; overdue: boolean }
  | { kind: "exhausted"; agentId: string; agentName: string; fingerprint: string; attempts: number };

export type TerminalBlockerAutoWakeFacts = {
  issue: {
    status: string; statusVersion: number; assigneeAgentId: string | null; assigneeUserId: string | null;
    reviewPolicy: string | null; executionState: unknown; hiddenAt: Date | null;
  };
  agent: { id: string; name: string; status: string; wakeOnDemand: boolean } | null;
  blocksOpenWork: boolean;
  /** A run or wake for this issue is in flight and was touched within activeStaleMs. */
  active: boolean;
  /** Latest run, wake or issue update for this issue. */
  lastActivityAt: number;
  /** Auto-wakes already requested for the current fingerprint. */
  attempts: number;
};

export function terminalBlockerAutoWakeFingerprint(issue: { status: string; statusVersion: number; assigneeAgentId: string | null }) {
  return `${issue.status}.${issue.statusVersion}.${issue.assigneeAgentId ?? "none"}`;
}

/** One key per terminal blocker, stall fingerprint and attempt: one cause, one wake. */
export function terminalBlockerAutoWakeKey(issueId: string, fingerprint: string, attempt: number) {
  return `${ISSUE_TERMINAL_BLOCKER_STRANDED_WAKE_REASON}:${issueId}:${fingerprint}:${attempt}`;
}

export function decideTerminalBlockerAutoWake(facts: TerminalBlockerAutoWakeFacts, now: number): TerminalBlockerAutoWakeState {
  const { issue, agent } = facts;
  if (!facts.blocksOpenWork) return { kind: "human", reason: "not_blocking" };
  if (issue.hiddenAt || !AUTO_WAKE_ISSUE_STATUSES.includes(issue.status)) return { kind: "human", reason: "not_agent_recoverable" };
  if (issue.assigneeUserId) return { kind: "human", reason: "user_owned" };
  if (!issue.assigneeAgentId) return { kind: "human", reason: "unassigned" };
  if (issue.status === "in_review") {
    const state = parseIssueExecutionState(issue.executionState);
    const participant = state?.status === "pending" ? state.currentParticipant : null;
    if (participant?.type === "user" || issue.reviewPolicy === "human_only") return { kind: "human", reason: "human_review" };
  }
  if (!agent || agent.id !== issue.assigneeAgentId || AUTO_WAKE_NON_INVOKABLE_AGENT_STATUSES.includes(agent.status)) {
    return { kind: "human", reason: "agent_unavailable" };
  }
  if (!agent.wakeOnDemand) return { kind: "human", reason: "agent_takes_no_wakes" };
  if (facts.active) return { kind: "active" };
  const fingerprint = terminalBlockerAutoWakeFingerprint(issue);
  if (facts.attempts >= TERMINAL_BLOCKER_AUTO_WAKE.maxAttempts) {
    return { kind: "exhausted", agentId: agent.id, agentName: agent.name, fingerprint, attempts: facts.attempts };
  }
  const dueAt = facts.lastActivityAt + (facts.attempts === 0 ? TERMINAL_BLOCKER_AUTO_WAKE.quietMs : TERMINAL_BLOCKER_AUTO_WAKE.backoffMs);
  return { kind: "pending", agentId: agent.id, agentName: agent.name, fingerprint, attempt: facts.attempts + 1, dueAt,
    overdue: now > dueAt + TERMINAL_BLOCKER_AUTO_WAKE.overdueGraceMs };
}

/** Auto-wake is still pending or in progress, so the board card waits. */
export function terminalBlockerAutoWakeHoldsCard(state: TerminalBlockerAutoWakeState | null | undefined) {
  return state?.kind === "active" || (state?.kind === "pending" && !state.overdue);
}

/** The board card's whyNow when auto-wake gave up or never ran. Null keeps the default text. */
export function terminalBlockerAutoWakeWhyNow(state: TerminalBlockerAutoWakeState | null | undefined) {
  if (state?.kind === "exhausted") return `Auto-woke ${state.agentName} ${state.attempts}×, no progress.`;
  if (state?.kind === "pending" && state.overdue) return `Auto-wake of ${state.agentName} is overdue.`;
  return null;
}

/**
 * The auto-wake state of each issue, read from durable rows only (issue, agent,
 * runs, wakes), so the sweep, the Inbox and decision retention agree and a
 * restart reconstructs it.
 */
export async function loadTerminalBlockerAutoWakeStates(db: Db, companyId: string, issueIds: readonly string[], now = Date.now()) {
  const ids = [...new Set(issueIds)];
  const states = new Map<string, TerminalBlockerAutoWakeState>();
  if (ids.length === 0) return states;
  const rows = await db.select({
    id: issues.id, status: issues.status, statusVersion: issues.statusVersion, parentId: issues.parentId,
    assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId, reviewPolicy: issues.reviewPolicy,
    executionState: issues.executionState, hiddenAt: issues.hiddenAt, updatedAt: issues.updatedAt,
    executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId,
  }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)));
  if (rows.length === 0) return states;
  const rowIds = rows.map(row => row.id);
  const agentIds = [...new Set(rows.map(row => row.assigneeAgentId).filter((id): id is string => Boolean(id)))];
  const parentIds = [...new Set(rows.map(row => row.parentId).filter((id): id is string => Boolean(id)))];
  const lockRunIds = [...new Set(rows.flatMap(row => [row.executionRunId, row.checkoutRunId]).filter((id): id is string => Boolean(id)))];
  const staleBefore = new Date(now - TERMINAL_BLOCKER_AUTO_WAKE.activeStaleMs);
  const staleBeforeSql = sql`${staleBefore.toISOString()}::timestamptz`;
  const runIssueId = sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
  const wakeIssueId = sql<string>`${agentWakeupRequests.payload} ->> 'issueId'`;
  const [agentRows, blockingRows, blockedParents, runRows, lockRuns, wakeRows, attemptRows] = await Promise.all([
    agentIds.length === 0 ? [] : db.select({ id: agents.id, name: agents.name, status: agents.status, runtimeConfig: agents.runtimeConfig })
      .from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds))),
    db.selectDistinct({ id: issueRelations.issueId }).from(issueRelations)
      .innerJoin(issues, and(eq(issues.id, issueRelations.relatedIssueId), eq(issues.companyId, issueRelations.companyId)))
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks"), inArray(issueRelations.issueId, rowIds),
        notInArray(issues.status, ["done", "cancelled"]), isNull(issues.hiddenAt))),
    parentIds.length === 0 ? [] : db.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, parentIds), eq(issues.status, "blocked"))),
    // Runs keyed to the issue: latest activity, and whether one is still in flight.
    db.select({
      issueId: runIssueId,
      lastAt: sql<string | null>`max(coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt}))::text`,
      active: sql<boolean>`coalesce(bool_or(${inArray(heartbeatRuns.status, AUTO_WAKE_ACTIVE_RUN_STATUSES)}
        and greatest(${heartbeatRuns.updatedAt}, coalesce(${heartbeatRuns.scheduledRetryAt}, ${heartbeatRuns.updatedAt})) > ${staleBeforeSql}), false)`,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), inArray(runIssueId, rowIds))).groupBy(runIssueId),
    lockRunIds.length === 0 ? [] : db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, lockRunIds),
      inArray(heartbeatRuns.status, AUTO_WAKE_ACTIVE_RUN_STATUSES), gt(heartbeatRuns.updatedAt, staleBefore))),
    db.select({
      issueId: wakeIssueId,
      lastAt: sql<string | null>`max(coalesce(${agentWakeupRequests.finishedAt}, ${agentWakeupRequests.updatedAt}, ${agentWakeupRequests.requestedAt}))::text`,
      active: sql<boolean>`coalesce(bool_or(${inArray(agentWakeupRequests.status, AUTO_WAKE_PENDING_WAKE_STATUSES)}
        and ${agentWakeupRequests.updatedAt} > ${staleBeforeSql}), false)`,
    }).from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), inArray(wakeIssueId, rowIds)))
      .groupBy(wakeIssueId),
    db.select({ issueId: wakeIssueId, idempotencyKey: agentWakeupRequests.idempotencyKey }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), inArray(wakeIssueId, rowIds),
        eq(agentWakeupRequests.reason, ISSUE_TERMINAL_BLOCKER_STRANDED_WAKE_REASON),
        or(...rowIds.map(id => sql`${agentWakeupRequests.idempotencyKey} like ${`${ISSUE_TERMINAL_BLOCKER_STRANDED_WAKE_REASON}:${id}:%`}`)))),
  ]);
  const agentsById = new Map(agentRows.map(agent => [agent.id, agent]));
  const blocking = new Set(blockingRows.map(row => row.id));
  const blockedParentIds = new Set(blockedParents.map(row => row.id));
  const runsByIssue = new Map(runRows.map(row => [row.issueId, row]));
  const activeLockRuns = new Set(lockRuns.map(row => row.id));
  const wakesByIssue = new Map(wakeRows.map(row => [row.issueId, row]));
  const time = (value: string | null | undefined) => value ? new Date(value).getTime() : 0;
  for (const row of rows) {
    const agent = row.assigneeAgentId ? agentsById.get(row.assigneeAgentId) : undefined;
    const runs = runsByIssue.get(row.id);
    const wakes = wakesByIssue.get(row.id);
    const prefix = terminalBlockerAutoWakeKey(row.id, terminalBlockerAutoWakeFingerprint(row), 0).slice(0, -1);
    const attempts = new Set(attemptRows.filter(wake => wake.issueId === row.id && wake.idempotencyKey?.startsWith(prefix))
      .map(wake => wake.idempotencyKey)).size;
    states.set(row.id, decideTerminalBlockerAutoWake({
      issue: row,
      agent: agent ? { id: agent.id, name: agent.name, status: agent.status, wakeOnDemand: isHeartbeatWakeOnDemandEnabled(agent) } : null,
      blocksOpenWork: blocking.has(row.id) || (row.parentId !== null && blockedParentIds.has(row.parentId)),
      active: Boolean(runs?.active) || Boolean(wakes?.active)
        || [row.executionRunId, row.checkoutRunId].some(id => id !== null && activeLockRuns.has(id)),
      lastActivityAt: Math.max(row.updatedAt.getTime(), time(runs?.lastAt), time(wakes?.lastAt)),
      attempts,
    }, now));
  }
  return states;
}
