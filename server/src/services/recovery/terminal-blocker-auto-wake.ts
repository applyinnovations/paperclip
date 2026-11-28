/**
 * Wake the owner of a stranded terminal blocker before the board hears about it
 * (APP-761, `issue_terminal_blocker_stranded`).
 *
 * Overnight 2026-11-27/28, 17 blocker_attention cards reached the board. Every
 * terminal blocker was `in_review` or `todo` on an idle, unpaused agent with no
 * run; each owner just needed a wake. The per-blocked-issue dependency sweep
 * (reconcileResolvedDependencyWakeBackstop) calls this for the issue it visits:
 * it finds that issue's terminal blocker the same way the Inbox does, and wakes
 * the blocker's agent when the shared gate in attention-source-eligibility.ts
 * says a wake is due. The gate keeps the board card back until a human is
 * needed or the attempts are used up.
 *
 * Bounded and debounced: at most `maxAttempts` wakes per stall fingerprint, one
 * idempotency key per terminal blocker + fingerprint + attempt, so N blocked
 * issues behind one blocker cost one wake. A partial unique index on that key
 * makes admission atomic: concurrent sweeps that compute the same attempt
 * cannot both deliver, and the loser treats the attempt as admitted. Blocked
 * issues the woken agent cannot read are redacted. State lives in wake rows, so a
 * restart rebuilds it. A pending wake registers its real deadline with the
 * sweep; an exhausted or human-owned blocker registers none.
 */
import { and, eq, gt, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, issueRelations, issues, type Db } from "@paperclipai/db";
import {
  ISSUE_TERMINAL_BLOCKER_STRANDED_WAKE_REASON,
  type IssueTerminalBlockerStrandedWakeContext,
} from "@paperclipai/shared";
import { logActivity } from "../activity-log.js";
import { authorizationService } from "../authorization.js";
import { isUniqueViolation } from "../../db-errors.js";
import {
  loadTerminalBlockerAutoWakeStates,
  TERMINAL_BLOCKER_AUTO_WAKE,
  terminalBlockerAutoWakeKey,
  terminalBlockerIsStranded,
} from "../attention-source-eligibility.js";
import { issueService } from "../issues.js";
import { logger } from "../../middleware/logger.js";

const ACTOR_ID = "issue-terminal-blocker-auto-wake";
const BLOCKED_ISSUE_SAMPLE = 5;
/** Partial unique index on (company_id, idempotency_key): one admitted wake per blocker, fingerprint and attempt. */
const TERMINAL_BLOCKER_STRANDED_WAKE_INDEX = "agent_wakeup_requests_issue_terminal_blocker_stranded_uq";
/**
 * While an auto-wake runs, the blocked tree reads as live and names no
 * terminal blocker, so the pass cannot see which blocker it waits on. Keep
 * re-checking while any auto-wake in the company is this recent (longest run
 * still counted as active, plus the backoff), so attempt 2 or exhaustion is
 * noticed without waiting for an unrelated event.
 */
const FOLLOW_UP_WINDOW_MS = TERMINAL_BLOCKER_AUTO_WAKE.activeStaleMs + TERMINAL_BLOCKER_AUTO_WAKE.backoffMs;

export type TerminalBlockerAutoWakeup = (agentId: string, input: {
  source: "automation";
  triggerDetail: "system";
  reason: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  requestedByActorType: "system";
  requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
  allowRunCoalescing: false;
  issueStateGuard: { statuses: string[]; assigneeAgentId: string; statusVersion: number };
}) => Promise<unknown>;

export type TerminalBlockerAutoWakeResult = {
  terminalIssueId: string | null;
  woken: boolean;
  exhausted: boolean;
  failed: boolean;
  /** When the sweep must look at this blocked issue again; null when nothing is pending. */
  retryAt: number | null;
};

const sampleColumns = {
  id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status, projectId: issues.projectId,
  parentId: issues.parentId, assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
};
type SampledIssue = { id: string; identifier: string | null; title: string; status: string; projectId: string | null;
  parentId: string | null; assigneeAgentId: string | null; assigneeUserId: string | null };

/** What the woken agent may see of a blocked issue it cannot read: that it exists, nothing more. */
const REDACTED_BLOCKED_ISSUE_TITLE = "A task you cannot read";

async function blockedIssueSample(db: Db, companyId: string, terminalIssueId: string, parentId: string | null) {
  const open = sql`${issues.status} not in ('done', 'cancelled') and ${issues.hiddenAt} is null`;
  const blocked = await db.select({ ...sampleColumns, total: sql<number>`count(*) over()::int` }).from(issueRelations)
    .innerJoin(issues, and(eq(issues.id, issueRelations.relatedIssueId), eq(issues.companyId, issueRelations.companyId)))
    .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks"),
      eq(issueRelations.issueId, terminalIssueId), open))
    .orderBy(issues.id).limit(BLOCKED_ISSUE_SAMPLE);
  const sample: SampledIssue[] = blocked.map(({ total: _total, ...row }) => row);
  let count = blocked[0]?.total ?? 0;
  if (parentId) {
    const [parent] = await db.select(sampleColumns).from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, parentId), eq(issues.status, "blocked")));
    if (parent && !sample.some(row => row.id === parent.id)) { sample.unshift(parent); count += 1; }
  }
  return { sample: sample.slice(0, BLOCKED_ISSUE_SAMPLE), count };
}

/**
 * The sampled blocked issues as the woken agent may see them. A blocker can be
 * readable by an agent that cannot read the private work waiting on it, so
 * each entry is checked with issue:read under the wake's execution identity
 * (the agent, on behalf of the blocker's responsible user) and an unreadable
 * one keeps only its id, as blocker-stall-wakeups.ts does.
 */
async function readableBlockedIssues(db: Db, input: {
  companyId: string; agentId: string; onBehalfOfUserId: string | null; sample: SampledIssue[];
}) {
  const access = authorizationService(db);
  let withheld = 0;
  const entries = await Promise.all(input.sample.map(async (issue) => {
    const readable = (await access.decide({
      actor: { type: "agent", agentId: input.agentId, companyId: input.companyId, onBehalfOfUserId: input.onBehalfOfUserId },
      action: "issue:read",
      resource: { type: "issue", companyId: input.companyId, issueId: issue.id, projectId: issue.projectId,
        parentIssueId: issue.parentId, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
        status: issue.status },
    })).allowed;
    if (!readable) withheld += 1;
    return readable ? { id: issue.id, identifier: issue.identifier, title: issue.title }
      : { id: issue.id, identifier: null, title: REDACTED_BLOCKED_ISSUE_TITLE };
  }));
  return { entries, withheld };
}

/**
 * Check the terminal blocker of one blocked issue and wake its owner if a wake
 * is due. Safe to call for every blocked issue on every pass.
 */
export async function wakeStrandedTerminalBlocker(db: Db, enqueueWakeup: TerminalBlockerAutoWakeup,
  input: { companyId: string; blockedIssueId: string; now?: number }): Promise<TerminalBlockerAutoWakeResult> {
  const now = input.now ?? Date.now();
  const result: TerminalBlockerAutoWakeResult = { terminalIssueId: null, woken: false, exhausted: false, failed: false, retryAt: null };
  const [blocked] = await db.select({ id: issues.id, companyId: issues.companyId, parentId: issues.parentId,
    identifier: issues.identifier, title: issues.title, status: issues.status, executionRunId: issues.executionRunId,
    assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId }).from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.blockedIssueId), eq(issues.status, "blocked")));
  if (!blocked) return result;
  const attention = (await issueService(db).listBlockerAttention(input.companyId, [blocked])).get(blocked.id);
  if (!terminalBlockerIsStranded(attention)) {
    const [recent] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.reason, ISSUE_TERMINAL_BLOCKER_STRANDED_WAKE_REASON),
      gt(agentWakeupRequests.requestedAt, new Date(now - FOLLOW_UP_WINDOW_MS)))).limit(1);
    if (recent) result.retryAt = now + TERMINAL_BLOCKER_AUTO_WAKE.quietMs;
    return result;
  }
  const terminalIssueId = attention.terminalBlockerIssueId;
  if (!terminalIssueId || terminalIssueId === blocked.id) return result;
  result.terminalIssueId = terminalIssueId;

  const state = (await loadTerminalBlockerAutoWakeStates(db, input.companyId, [terminalIssueId], now)).get(terminalIssueId);
  if (!state || state.kind === "human") return result;
  if (state.kind === "active") {
    // A run or wake is in flight. Look again after it could have ended.
    result.retryAt = now + TERMINAL_BLOCKER_AUTO_WAKE.quietMs;
    return result;
  }
  if (state.kind === "exhausted") {
    result.exhausted = true;
    await recordExhaustion(db, { companyId: input.companyId, terminalIssueId, agentId: state.agentId,
      fingerprint: state.fingerprint, attempts: state.attempts, blockedIssueId: blocked.id });
    return result;
  }
  if (now < state.dueAt) { result.retryAt = state.dueAt; return result; }

  const [terminal] = await db.select({ id: issues.id, identifier: issues.identifier, title: issues.title,
    status: issues.status, statusVersion: issues.statusVersion, parentId: issues.parentId,
    responsibleUserId: issues.responsibleUserId }).from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, terminalIssueId)));
  if (!terminal) return result;
  const idempotencyKey = terminalBlockerAutoWakeKey(terminal.id, state.fingerprint, state.attempt);
  // Another blocked issue behind the same blocker may have sent this attempt already.
  const [existing] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, input.companyId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${terminal.id}`,
      eq(agentWakeupRequests.idempotencyKey, idempotencyKey))).limit(1);
  if (existing) { result.retryAt = now + TERMINAL_BLOCKER_AUTO_WAKE.quietMs; return result; }

  const blockedIssues = await blockedIssueSample(db, input.companyId, terminal.id, terminal.parentId);
  const visible = await readableBlockedIssues(db, { companyId: input.companyId, agentId: state.agentId,
    onBehalfOfUserId: terminal.responsibleUserId, sample: blockedIssues.sample });
  const context: IssueTerminalBlockerStrandedWakeContext = {
    terminalIssueId: terminal.id,
    terminalIssueIdentifier: terminal.identifier,
    terminalIssueStatus: terminal.status,
    blockedIssues: visible.entries,
    blockedIssueCount: blockedIssues.count,
    attempt: state.attempt,
    maxAttempts: TERMINAL_BLOCKER_AUTO_WAKE.maxAttempts,
  };
  const log = { issueId: terminal.id, issueIdentifier: terminal.identifier, agentId: state.agentId, attempt: state.attempt,
    maxAttempts: TERMINAL_BLOCKER_AUTO_WAKE.maxAttempts, fingerprint: state.fingerprint, blockedIssueCount: blockedIssues.count,
    blockedIssuesWithheld: visible.withheld, companyId: input.companyId };
  try {
    const wake = await enqueueWakeup(state.agentId, {
      source: "automation", triggerDetail: "system", reason: ISSUE_TERMINAL_BLOCKER_STRANDED_WAKE_REASON,
      payload: { issueId: terminal.id, terminalBlockerStranded: context }, idempotencyKey,
      requestedByActorType: "system", requestedByActorId: ACTOR_ID,
      contextSnapshot: { issueId: terminal.id, taskId: terminal.id, wakeReason: ISSUE_TERMINAL_BLOCKER_STRANDED_WAKE_REASON,
        source: "issue.terminal_blocker_stranded", terminalBlockerStranded: context },
      allowRunCoalescing: false,
      // A blocker that moved on (new status, version or owner) drops the wake.
      issueStateGuard: { statuses: [terminal.status], assigneeAgentId: state.agentId, statusVersion: terminal.statusVersion },
    });
    // Null is a deferral with no wake row; the next pass tries again.
    if (!wake) { result.retryAt = now + TERMINAL_BLOCKER_AUTO_WAKE.quietMs; return result; }
    await logActivity(db, {
      companyId: input.companyId, actorType: "system", actorId: ACTOR_ID,
      action: "issue.terminal_blocker_auto_wake", entityType: "issue", entityId: terminal.id,
      agentId: state.agentId, issueId: terminal.id,
      details: { attempt: state.attempt, maxAttempts: TERMINAL_BLOCKER_AUTO_WAKE.maxAttempts, fingerprint: state.fingerprint,
        blockedIssueCount: blockedIssues.count, blockedIssuesWithheld: visible.withheld, visitedBlockedIssueId: blocked.id },
    });
    logger.info({ event: "terminal_blocker_auto_wake", ...log }, "auto-woke owner of stranded terminal blocker");
    result.woken = true;
    // Come back when the next attempt could be due, or to record exhaustion.
    result.retryAt = now + TERMINAL_BLOCKER_AUTO_WAKE.quietMs;
  } catch (err) {
    // A concurrent sweep (another blocked issue, worker or replica) admitted
    // this attempt first: the unique key held, so the wake is already sent.
    if (isUniqueViolation(err, TERMINAL_BLOCKER_STRANDED_WAKE_INDEX)) {
      logger.info({ event: "terminal_blocker_auto_wake_already_admitted", ...log },
        "auto-wake attempt for stranded terminal blocker already admitted by a concurrent sweep");
      result.retryAt = now + TERMINAL_BLOCKER_AUTO_WAKE.quietMs;
      return result;
    }
    result.failed = true;
    logger.warn({ err, event: "terminal_blocker_auto_wake_failed", ...log }, "failed to auto-wake owner of stranded terminal blocker");
  }
  return result;
}

/** Record once per fingerprint that auto-wake gave up, so the board card's cause is on the blocker. */
async function recordExhaustion(db: Db, input: {
  companyId: string; terminalIssueId: string; agentId: string; fingerprint: string; attempts: number; blockedIssueId: string;
}) {
  const [recorded] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, input.companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, input.terminalIssueId),
    eq(activityLog.action, "issue.terminal_blocker_auto_wake_exhausted"),
    sql`${activityLog.details}->>'fingerprint' = ${input.fingerprint}`)).limit(1);
  if (recorded) return;
  await logActivity(db, {
    companyId: input.companyId, actorType: "system", actorId: ACTOR_ID,
    action: "issue.terminal_blocker_auto_wake_exhausted", entityType: "issue", entityId: input.terminalIssueId,
    agentId: input.agentId, issueId: input.terminalIssueId,
    details: { attempts: input.attempts, maxAttempts: TERMINAL_BLOCKER_AUTO_WAKE.maxAttempts, fingerprint: input.fingerprint,
      visitedBlockedIssueId: input.blockedIssueId },
  });
  logger.warn({ event: "terminal_blocker_auto_wake_exhausted", companyId: input.companyId, issueId: input.terminalIssueId,
    agentId: input.agentId, attempts: input.attempts, fingerprint: input.fingerprint },
  "auto-wake of stranded terminal blocker exhausted; surfacing to the board");
}
