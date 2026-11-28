import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";
import { notifyDeferredExecutionWork } from "../deferred-execution-notifications.js";
import { PersistedExecutionWaitRefusal } from "../deferred-execution-wait.js";
import {
  queuedCommentIdsFromRunContext,
  queuedCommentIdsFromWakePayload,
  withQueuedCommentIdsInWakePayload,
} from "../issue-queued-comment-queue.js";
import { deliveredQueuedCommentIds } from "../queued-comment-delivery.js";
import { deferredWorkIntentWait } from "../work-intent-outbox.js";
import type { WakeupOptions } from "./run-preparation.js";

/**
 * Wakes refused because their agent is paused (work-intent outbox, invariant 4).
 *
 * Any issue-scoped wake that a pause refuses (an assignment, a comment, a
 * resolved blocker, an answered interaction, from a person or the system) is
 * saved as ONE deferred intent per (agent, issue). Later refusals for the same
 * task merge into it: their comment ids accumulate, and the strongest wake
 * (a person's, then an interaction answer, then the latest) supplies the
 * source and context. A run the pause stopped saves the same intent, so its
 * task continues once.
 *
 * When the pause lifts, `resumePauseWakeIntents` delivers each intent once
 * through normal admission. An intent ends without a run when its task was
 * reassigned, closed, or already ran again after the intent was saved.
 */

const INTENT_MARKER = "pauseWakeIntent";
const WAKE_CONTEXT_KEY = "_paperclipWakeContext";
/** A drain that claimed an intent and then died leaves it claimable again after this. */
const CLAIM_STALE_MS = 60_000;
const COMMENT_WAKE_REASONS = new Set(["issue_commented", "issue_reopened_via_comment", "issue_comment_mentioned"]);

type ActorType = NonNullable<WakeupOptions["requestedByActorType"]>;

export type PauseWakeIntentInput = {
  companyId: string;
  agentId: string;
  issueId: string;
  source: WakeupOptions["source"];
  triggerDetail: WakeupOptions["triggerDetail"] | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  contextSnapshot: Record<string, unknown>;
  wakeCommentId: string | null;
  requestedByActorType: ActorType | null;
  requestedByActorId: string | null;
  message: string;
  details?: Record<string, unknown>;
};

/** SQL: this row is a pause wake intent saved by this module. */
export const pauseWakeIntentSql = sql`coalesce(${agentWakeupRequests.payload}->'executionWait'->>${INTENT_MARKER}, '') = 'true'`;
/** SQL: no drain holds a live claim on this intent. */
const unclaimedSql = sql`coalesce((${agentWakeupRequests.payload}->'executionWait'->>'claimedAt')::timestamptz, 'epoch'::timestamptz)
  < now() - ${`${CLAIM_STALE_MS} milliseconds`}::interval`;

function isInteractionWake(payload: Record<string, unknown>, context: Record<string, unknown>) {
  return payload.mutation === "interaction" || typeof context.interactionId === "string";
}

/** A person's wake outranks an automatic one; an answered interaction keeps
 * its continuation context over a later plain signal. */
function wakeRank(actorType: string | null, payload: Record<string, unknown>, context: Record<string, unknown>) {
  return (actorType === "user" ? 2 : 0) + (isInteractionWake(payload, context) ? 1 : 0);
}

/**
 * Save a pause-refused wake, merging it into the task's existing intent.
 * Returns the refusal the caller throws: HTTP callers still see a 409, and
 * wake producers can tell a saved wake from a lost one.
 */
export async function savePauseWakeIntent(db: Db, input: PauseWakeIntentInput): Promise<PersistedExecutionWaitRefusal> {
  const incomingContext: Record<string, unknown> = { ...input.contextSnapshot, issueId: input.issueId };
  const incomingPayload = { ...(input.payload ?? {}), issueId: input.issueId };
  const incomingComments = [...new Set([
    ...queuedCommentIdsFromRunContext(incomingContext),
    ...(input.wakeCommentId ? [input.wakeCommentId] : []),
  ])];
  const incomingIsSignal = incomingComments.length === 0 ||
    !COMMENT_WAKE_REASONS.has(String(incomingContext.wakeReason ?? input.reason ?? ""));
  const details = input.details ?? {};
  await db.transaction(async tx => {
    await tx.execute(sql`select id from issues where id = ${input.issueId} and company_id = ${input.companyId} for update`);
    await notifyDeferredExecutionWork(tx, { companyId: input.companyId });
    const [existing] = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.agentId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`, pauseWakeIntentSql,
      // An intent a drain is delivering right now settles with that delivery;
      // a refusal of that delivery starts the next intent.
      unclaimedSql,
    )).orderBy(agentWakeupRequests.requestedAt).limit(1).for("update");
    const existingPayload = parseObject(existing?.payload);
    const existingWait = parseObject(existingPayload.executionWait);
    const existingContext = parseObject(existingPayload[WAKE_CONTEXT_KEY]);
    const { executionWait: _w, [WAKE_CONTEXT_KEY]: _c, ...existingWakePayload } = existingPayload;
    const keepExisting = Boolean(existing) &&
      wakeRank(existing!.requestedByActorType, existingWakePayload, existingContext) >
        wakeRank(input.requestedByActorType, incomingPayload, incomingContext);
    const merged = [...new Set([...(existing ? queuedCommentIdsFromWakePayload(existing.payload) : []), ...incomingComments])];
    const executionWait = {
      ...deferredWorkIntentWait("agent.not_invokable", `${input.message} The request is saved.`, details),
      [INTENT_MARKER]: true,
      // A non-comment signal (assignment, blocker, continuation) still needs
      // its run after every saved comment was delivered elsewhere. `signalAt`
      // is the latest signal: only a run that started after it received it.
      carriesSignal: existingWait.carriesSignal === true || incomingIsSignal,
      signalAt: incomingIsSignal ? new Date().toISOString()
        : typeof existingWait.signalAt === "string" ? existingWait.signalAt : null,
      // Every merge is a new version. Rebuilding executionWait drops any
      // stale drain claim, so that drain can no longer settle this row.
      version: (typeof existingWait.version === "number" ? existingWait.version : 0) + 1,
    };
    const basePayload = keepExisting
      ? { ...existingWakePayload, [WAKE_CONTEXT_KEY]: existingContext }
      : { ...incomingPayload, [WAKE_CONTEXT_KEY]: incomingContext };
    const payload = withQueuedCommentIdsInWakePayload({ ...basePayload, issueId: input.issueId, executionWait }, merged);
    if (existing) {
      await tx.update(agentWakeupRequests).set({
        payload,
        coalescedCount: sql`${agentWakeupRequests.coalescedCount} + 1`,
        updatedAt: new Date(),
        ...(keepExisting ? {} : {
          source: input.source ?? existing.source, triggerDetail: input.triggerDetail ?? existing.triggerDetail,
          reason: input.reason ?? existing.reason,
          requestedByActorType: input.requestedByActorType, requestedByActorId: input.requestedByActorId,
        }),
      }).where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, existing.id)));
      return;
    }
    await tx.insert(agentWakeupRequests).values({
      companyId: input.companyId, agentId: input.agentId, source: input.source ?? "on_demand",
      triggerDetail: input.triggerDetail, reason: input.reason, payload, status: "deferred_issue_execution",
      requestedByActorType: input.requestedByActorType, requestedByActorId: input.requestedByActorId,
    });
  });
  return new PersistedExecutionWaitRefusal(input.message, details);
}

/**
 * Save a continuation for every task run that this pause is stopping, so the
 * task continues once when the pause lifts. A budget stop is continued by the
 * budget resume (budget-resume-continuation.ts), never here.
 */
export async function savePauseStopContinuations(db: Db, input: {
  companyId: string; agentId: string; holds: readonly string[];
  /** The company pause reason the pause recorded; undefined reads the current one. */
  companyPauseReason: string | null | undefined;
  runStatuses: readonly string[];
}) {
  if (input.holds.includes("budget")) return 0;
  if (input.holds.includes("company_paused")) {
    const companyPauseReason = input.companyPauseReason !== undefined ? input.companyPauseReason
      : (await db.select({ pauseReason: companies.pauseReason }).from(companies).where(eq(companies.id, input.companyId)))[0]?.pauseReason;
    if (companyPauseReason === "budget") return 0;
  }
  const runIssueId = sql<string | null>`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.nativeIssueId}::text,
    ${heartbeatRuns.contextSnapshot}->>'issueId')`;
  const stopped = await db.select({ runId: heartbeatRuns.id, issueId: runIssueId }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
    inArray(heartbeatRuns.status, [...input.runStatuses]),
    sql`${runIssueId} is not null`,
  ));
  let saved = 0;
  for (const run of stopped) {
    if (!run.issueId || !isUuidLike(run.issueId)) continue;
    const [issue] = await db.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, input.companyId), eq(issues.id, run.issueId), eq(issues.assigneeAgentId, input.agentId),
      notInArray(issues.status, ["done", "cancelled"])));
    if (!issue) continue;
    await savePauseWakeIntent(db, {
      companyId: input.companyId, agentId: input.agentId, issueId: issue.id,
      source: "automation", triggerDetail: "system", reason: "issue_continuation_needed",
      payload: { issueId: issue.id },
      contextSnapshot: { issueId: issue.id, taskId: issue.id, wakeReason: "issue_continuation_needed",
        // The continuation names the run it continues: dispatch walks that
        // ancestry before an automatic continuation may start.
        source: "agent.pause_lifted", retryOfRunId: run.runId, pauseStoppedRunId: run.runId },
      wakeCommentId: null, requestedByActorType: "system", requestedByActorId: null,
      message: "The agent was paused while working on this task.",
    });
    saved += 1;
  }
  return saved;
}

export type PauseWakeIntentDrainDeps = {
  db: Db;
  enqueueWakeup: (agentId: string, opts: WakeupOptions) => Promise<{ id: string } | null | unknown>;
  onError?: (err: unknown) => void;
  logWarn: (fields: Record<string, unknown>, message: string) => void;
  /** Test seam: runs after the candidate read, before any intent is claimed. */
  afterCandidateRead?: (requestIds: string[]) => Promise<void>;
};

/**
 * Deliver each pause wake intent of an agent that can run again, once.
 * Each intent is claimed before any decision, and every decision reads the
 * claimed row, so a wake merged after the candidate read is never discarded.
 * Concurrent drains and repeated hold-release events never deliver it twice.
 */
export async function resumePauseWakeIntents(deps: PauseWakeIntentDrainDeps, scope: {
  companyId?: string; requestId?: string;
} = {}) {
  const { db } = deps;
  const candidates = await db.select({ id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId })
    .from(agentWakeupRequests)
    .innerJoin(agents, and(eq(agents.id, agentWakeupRequests.agentId), eq(agents.companyId, agentWakeupRequests.companyId)))
    .innerJoin(companies, and(eq(companies.id, agentWakeupRequests.companyId), eq(companies.status, "active")))
    .where(and(
      scope.companyId ? eq(agentWakeupRequests.companyId, scope.companyId) : undefined,
      scope.requestId ? eq(agentWakeupRequests.id, scope.requestId) : undefined,
      eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId),
      pauseWakeIntentSql,
      notInArray(agents.status, ["paused", "pending_approval"]),
      unclaimedSql,
    ))
    .orderBy(agentWakeupRequests.updatedAt).limit(50);
  await deps.afterCandidateRead?.(candidates.map(candidate => candidate.id));
  for (const candidate of candidates) {
    await resumeOne(deps, candidate).catch(err => {
      deps.onError?.(err);
      deps.logWarn({ err, requestId: candidate.id }, "a wake saved during an agent pause could not resume");
    });
  }
}

type Claim = { id: string; companyId: string; token: string };

/** SQL: this drain's claim still holds the row (no merge or other drain replaced it). */
function claimHeldSql(claim: Claim) {
  return and(eq(agentWakeupRequests.companyId, claim.companyId), eq(agentWakeupRequests.id, claim.id),
    eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId),
    sql`${agentWakeupRequests.payload}->'executionWait'->>'claimToken' = ${claim.token}`);
}

/** End the intent, only while this drain's claim on the exact version it read holds. */
async function settleIntent(db: Db, claim: Claim, status: "cancelled" | "coalesced",
  error: string | null, runId?: string | null) {
  const now = new Date();
  const settled = await db.update(agentWakeupRequests)
    .set({ status, error, finishedAt: now, updatedAt: now, ...(runId ? { runId } : {}) })
    .where(claimHeldSql(claim)).returning({ id: agentWakeupRequests.id });
  return settled.length > 0;
}

/** Give the intent back for the next drain, only while this drain still holds it. */
async function releaseClaim(db: Db, claim: Claim) {
  await db.update(agentWakeupRequests).set({
    payload: sql`${agentWakeupRequests.payload} #- '{executionWait,claimedAt}' #- '{executionWait,claimToken}'`,
    updatedAt: new Date(),
  }).where(claimHeldSql(claim));
}

async function resumeOne(deps: PauseWakeIntentDrainDeps, candidate: { id: string; companyId: string }) {
  const { db } = deps;
  // Claim first, and decide only from the claimed row: a producer that merged
  // a wake after the candidate read either committed before this claim (the
  // claim returns its merge) or finds the row claimed and saves a new intent.
  const claim: Claim = { id: candidate.id, companyId: candidate.companyId, token: randomUUID() };
  const claimedAt = new Date().toISOString();
  const [wake] = await db.update(agentWakeupRequests).set({
    payload: sql`jsonb_set(jsonb_set(${agentWakeupRequests.payload}, '{executionWait,claimedAt}', to_jsonb(${claimedAt}::text)),
      '{executionWait,claimToken}', to_jsonb(${claim.token}::text))`,
  }).where(and(eq(agentWakeupRequests.companyId, claim.companyId), eq(agentWakeupRequests.id, claim.id),
    eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId),
    pauseWakeIntentSql, unclaimedSql,
  )).returning();
  if (!wake) return;
  const issueId = String(parseObject(wake.payload).issueId ?? "");
  const context = parseObject(parseObject(wake.payload)[WAKE_CONTEXT_KEY]);
  const executionWait = parseObject(parseObject(wake.payload).executionWait);
  const [agent] = await db.select({ status: agents.status }).from(agents)
    .where(and(eq(agents.companyId, wake.companyId), eq(agents.id, wake.agentId)));
  if (!agent || agent.status === "terminated") {
    await settleIntent(db, claim, "cancelled", "The agent was terminated before its pause lifted");
    return;
  }
  // Paused again since the candidate read: the next hold release delivers it.
  if (agent.status === "paused" || agent.status === "pending_approval") {
    await releaseClaim(db, claim);
    return;
  }
  const [issue] = isUuidLike(issueId) ? await db.select({
    status: issues.status, assigneeAgentId: issues.assigneeAgentId, executionRunId: issues.executionRunId,
  }).from(issues).where(and(eq(issues.companyId, wake.companyId), eq(issues.id, issueId))) : [];
  const mention = context.wakeReason === "issue_comment_mentioned";
  // Terminal: the pause outlived the task's claim on this agent.
  if (!issue || ["done", "cancelled"].includes(issue.status) || (!mention && issue.assigneeAgentId !== wake.agentId)) {
    await settleIntent(db, claim, "cancelled", "The task was reassigned or closed while the agent was paused");
    return;
  }
  // Keep only what no run received. A comment is delivered by the per-comment
  // receipt rules. The signal is delivered only by a run of this agent on the
  // task that actually started after the latest signal merged into the intent,
  // and was not cancelled: a run cancelled before its first turn (for example
  // by the pause itself) received nothing.
  const commentIds = queuedCommentIdsFromWakePayload(wake.payload);
  const delivered = await deliveredQueuedCommentIds(db, { companyId: wake.companyId, issueId,
    agentId: wake.agentId, commentIds: commentIds.filter(isUuidLike) });
  const remaining = commentIds.filter(id => !delivered.has(id));
  const carriesSignal = executionWait.carriesSignal === true;
  const signalAt = typeof executionWait.signalAt === "string" ? new Date(executionWait.signalAt) : wake.requestedAt;
  const [signalRun] = carriesSignal ? await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, wake.companyId), eq(heartbeatRuns.agentId, wake.agentId),
    sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId} or ${heartbeatRuns.nativeIssueId}::text = ${issueId})`,
    isNotNull(heartbeatRuns.startedAt), gt(heartbeatRuns.startedAt, signalAt),
    notInArray(heartbeatRuns.status, ["queued", "scheduled_retry", "cancelled"]),
  )).orderBy(heartbeatRuns.startedAt).limit(1) : [];
  if (remaining.length === 0 && (!carriesSignal || signalRun)) {
    await settleIntent(db, claim, "coalesced", "A later run of the task already received this request", signalRun?.id);
    return;
  }
  // The task is busy: the intent waits for the next hold-release or run end.
  const [live] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, wake.companyId), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
    sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId} or ${heartbeatRuns.nativeIssueId}::text = ${issueId})`,
  )).limit(1);
  if (live || issue.executionRunId) {
    await releaseClaim(db, claim);
    return;
  }

  const payload = withQueuedCommentIdsInWakePayload(parseObject(wake.payload), remaining);
  const { executionWait: _wait, [WAKE_CONTEXT_KEY]: savedContext, ...wakePayload } = payload;
  let run: unknown = null;
  try {
    run = await deps.enqueueWakeup(wake.agentId, {
      source: wake.source as WakeupOptions["source"],
      triggerDetail: (wake.triggerDetail ?? undefined) as WakeupOptions["triggerDetail"],
      reason: wake.reason ?? undefined, payload: wakePayload, contextSnapshot: parseObject(savedContext),
      requestedByActorType: (wake.requestedByActorType ?? undefined) as WakeupOptions["requestedByActorType"],
      requestedByActorId: wake.requestedByActorId ?? undefined,
    });
  } catch (err) {
    // A refusal that saved the request (paused again, or another hold) owns it now.
    if (!(err instanceof PersistedExecutionWaitRefusal)) {
      await releaseClaim(db, claim);
      throw err;
    }
  }
  const runId = run && typeof run === "object" && typeof (run as { id?: unknown }).id === "string"
    ? (run as { id: string }).id : null;
  // Admission may already have adopted this intent's comments into the run.
  // When a merge replaced this claim meanwhile, the row stays pending: the
  // next drain delivers what this run did not receive, by the rules above.
  await settleIntent(db, claim, "coalesced", null, runId);
}
