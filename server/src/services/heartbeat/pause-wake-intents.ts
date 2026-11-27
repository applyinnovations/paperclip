import { and, eq, gt, inArray, isNull, notInArray, sql } from "drizzle-orm";
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
  const incomingContext = { ...input.contextSnapshot, issueId: input.issueId };
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
      // its run after every saved comment was delivered elsewhere.
      carriesSignal: existingWait.carriesSignal === true || incomingIsSignal,
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
};

/**
 * Deliver each pause wake intent of an agent that can run again, once.
 * Claims each intent before admission, so concurrent drains and repeated
 * hold-release events never deliver it twice.
 */
export async function resumePauseWakeIntents(deps: PauseWakeIntentDrainDeps, scope: {
  companyId?: string; requestId?: string;
} = {}) {
  const { db } = deps;
  const candidates = await db.select({ wake: agentWakeupRequests }).from(agentWakeupRequests)
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
  for (const { wake } of candidates) {
    await resumeOne(deps, wake).catch(err => {
      deps.onError?.(err);
      deps.logWarn({ err, requestId: wake.id }, "a wake saved during an agent pause could not resume");
    });
  }
}

async function settleIntent(db: Db, wake: { id: string; companyId: string }, status: "cancelled" | "coalesced",
  error: string | null, runId?: string | null) {
  const now = new Date();
  await db.update(agentWakeupRequests).set({ status, error, finishedAt: now, updatedAt: now, ...(runId ? { runId } : {}) })
    .where(and(eq(agentWakeupRequests.companyId, wake.companyId), eq(agentWakeupRequests.id, wake.id),
      eq(agentWakeupRequests.status, "deferred_issue_execution")));
}

async function resumeOne(deps: PauseWakeIntentDrainDeps, wake: typeof agentWakeupRequests.$inferSelect) {
  const { db } = deps;
  const issueId = String(parseObject(wake.payload).issueId ?? "");
  const context = parseObject(parseObject(wake.payload)[WAKE_CONTEXT_KEY]);
  const [agent] = await db.select({ status: agents.status }).from(agents)
    .where(and(eq(agents.companyId, wake.companyId), eq(agents.id, wake.agentId)));
  if (!agent || agent.status === "terminated") {
    await settleIntent(db, wake, "cancelled", "The agent was terminated before its pause lifted");
    return;
  }
  const [issue] = isUuidLike(issueId) ? await db.select({
    status: issues.status, assigneeAgentId: issues.assigneeAgentId, executionRunId: issues.executionRunId,
  }).from(issues).where(and(eq(issues.companyId, wake.companyId), eq(issues.id, issueId))) : [];
  const mention = context.wakeReason === "issue_comment_mentioned";
  // Terminal: the pause outlived the task's claim on this agent.
  if (!issue || ["done", "cancelled"].includes(issue.status) || (!mention && issue.assigneeAgentId !== wake.agentId)) {
    await settleIntent(db, wake, "cancelled", "The task was reassigned or closed while the agent was paused");
    return;
  }
  // A run of this agent on the task since the intent was saved received the
  // task (and adopted any saved comment it could). Keep only what it missed.
  const commentIds = queuedCommentIdsFromWakePayload(wake.payload);
  const delivered = await deliveredQueuedCommentIds(db, { companyId: wake.companyId, issueId,
    agentId: wake.agentId, commentIds: commentIds.filter(isUuidLike) });
  const remaining = commentIds.filter(id => !delivered.has(id));
  const [laterRun] = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, wake.companyId), eq(heartbeatRuns.agentId, wake.agentId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`, gt(heartbeatRuns.createdAt, wake.requestedAt),
  )).limit(1);
  const carriesSignal = parseObject(parseObject(wake.payload).executionWait).carriesSignal === true;
  if (remaining.length === 0 && (laterRun || !carriesSignal)) {
    await settleIntent(db, wake, "coalesced", "A later run of the task already received this request", laterRun?.id);
    return;
  }
  // The task is busy: the intent waits for the next hold-release or run end.
  const [live] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, wake.companyId), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
    sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId} or ${heartbeatRuns.nativeIssueId}::text = ${issueId})`,
  )).limit(1);
  if (live || issue.executionRunId) return;

  const claimedAt = new Date().toISOString();
  const [claimed] = await db.update(agentWakeupRequests).set({
    payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{executionWait,claimedAt}', to_jsonb(${claimedAt}::text))`,
  }).where(and(eq(agentWakeupRequests.companyId, wake.companyId), eq(agentWakeupRequests.id, wake.id),
    eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId),
    unclaimedSql,
  )).returning({ payload: agentWakeupRequests.payload });
  if (!claimed) return;
  const payload = withQueuedCommentIdsInWakePayload(parseObject(claimed.payload), remaining);
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
      await db.update(agentWakeupRequests).set({
        payload: sql`${agentWakeupRequests.payload} #- '{executionWait,claimedAt}'`, updatedAt: new Date(),
      }).where(and(eq(agentWakeupRequests.companyId, wake.companyId), eq(agentWakeupRequests.id, wake.id),
        eq(agentWakeupRequests.status, "deferred_issue_execution")));
      throw err;
    }
  }
  const runId = run && typeof run === "object" && typeof (run as { id?: unknown }).id === "string"
    ? (run as { id: string }).id : null;
  // Admission may already have adopted this intent's comments into the run.
  await settleIntent(db, wake, "coalesced", null, runId);
}
