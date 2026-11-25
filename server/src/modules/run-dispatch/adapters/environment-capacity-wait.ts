import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { notifyScheduledRetryDispatch } from "../../../services/run-dispatch-notifications.js";
import { notifyScheduledRetryCancellation } from "../../../services/scheduled-retry-cancellation-notifications.js";
import {
  ENVIRONMENT_CAPACITY_RECHECK_MS,
  ENVIRONMENT_CAPACITY_WAIT_KEY,
  ENVIRONMENT_CAPACITY_WAIT_RETRY_REASON,
  environmentCapacityWaitKey,
  readEnvironmentCapacityWait,
} from "../domain/wake-context.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

const waitKeySql = sql<string>`${heartbeatRuns.contextSnapshot} -> ${ENVIRONMENT_CAPACITY_WAIT_KEY} ->> 'key'`;
const waitingSinceSql = sql<string>`(${heartbeatRuns.contextSnapshot} -> ${ENVIRONMENT_CAPACITY_WAIT_KEY} ->> 'waitingSince')::timestamptz`;

/**
 * Waiters for one environment in one company, in arrival order: the first
 * deferral time (carried across re-deferrals), then the run id.
 */
function waitersFor(companyId: string, environmentId: string) {
  return and(
    eq(heartbeatRuns.companyId, companyId),
    eq(heartbeatRuns.status, "scheduled_retry"),
    eq(heartbeatRuns.scheduledRetryReason, ENVIRONMENT_CAPACITY_WAIT_RETRY_REASON),
    sql`${waitKeySql} = ${environmentCapacityWaitKey(environmentId)}`,
  );
}

function aheadOf(position: { waitingSince: string; runId: string } | null) {
  return position
    ? sql`(${waitingSinceSql}, ${heartbeatRuns.id}::text) < (${position.waitingSince}::timestamptz, ${position.runId}::text)`
    : undefined;
}

/**
 * Keeps a due environment-capacity retry parked, in place, while an earlier
 * waiter for the same environment is still parked. Only the head of the queue
 * tries the provider; dispatching the others would only be refused again,
 * each refusal creating another retry run. A lease released on the
 * environment, or the head starting, wakes the next waiter
 * (wakeNextEnvironmentCapacityWaiter). The new deadline only bounds a missed
 * wake. Returns true when the run stays parked.
 */
export async function parkEnvironmentCapacityRetryInTx(tx: Db, run: HeartbeatRun, now: Date): Promise<boolean> {
  if (run.status !== "scheduled_retry") return false;
  const wait = readEnvironmentCapacityWait(run.scheduledRetryReason, run.contextSnapshot);
  if (!wait) return false;
  // A waiter that is already due is about to be dispatched; it does not hold
  // back the run behind it. That keeps two wakes from admitting only one run.
  const [earlier] = await tx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      waitersFor(run.companyId, wait.environmentId),
      ne(heartbeatRuns.id, run.id),
      gt(heartbeatRuns.scheduledRetryAt, now),
      aheadOf({ waitingSince: wait.waitingSince, runId: run.id }),
    ))
    .limit(1);
  if (!earlier) return false;

  const recheckAt = new Date(now.getTime() + ENVIRONMENT_CAPACITY_RECHECK_MS);
  await notifyScheduledRetryCancellation(tx, { companyId: run.companyId, runId: run.id });
  const [parked] = await tx
    .update(heartbeatRuns)
    .set({
      scheduledRetryAt: recheckAt,
      updatedAt: now,
      contextSnapshot: sql`jsonb_set(coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb), '{scheduledRetryAt}', to_jsonb(${recheckAt.toISOString()}::text))`,
    })
    .where(and(
      eq(heartbeatRuns.id, run.id),
      eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.status, "scheduled_retry"),
    ))
    .returning({ id: heartbeatRuns.id });
  return Boolean(parked);
}

/**
 * True when older runs of this company are waiting for capacity in this
 * environment, so a run about to acquire a lease must join the back of the
 * queue instead of taking room that frees up ahead of them. A run that is
 * itself a waiter compares its own place in the queue.
 */
export async function hasEarlierEnvironmentCapacityWaiter(db: Db, input: {
  companyId: string;
  environmentId: string;
  runId: string;
}): Promise<boolean> {
  const [own] = await db
    .select({ scheduledRetryReason: heartbeatRuns.scheduledRetryReason, contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  const ownWait = own ? readEnvironmentCapacityWait(own.scheduledRetryReason, own.contextSnapshot) : null;
  const position = ownWait?.environmentId === input.environmentId
    ? { waitingSince: ownWait.waitingSince, runId: input.runId } : null;
  const [earlier] = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      waitersFor(input.companyId, input.environmentId),
      ne(heartbeatRuns.id, input.runId),
      aheadOf(position),
    ))
    .limit(1);
  return Boolean(earlier);
}

/**
 * Makes the oldest parked waiter for this environment due now, so the
 * promotion sweep admits it. Called once per lease released on the
 * environment (one slot freed), and when a waiter's lease is acquired (the
 * next may fit too). Returns the woken run id, if any.
 */
export async function wakeNextEnvironmentCapacityWaiter(db: Db, input: {
  companyId: string;
  environmentId: string;
  now?: Date;
}): Promise<string | null> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [next] = await tx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(waitersFor(input.companyId, input.environmentId), gt(heartbeatRuns.scheduledRetryAt, now)))
      .orderBy(asc(waitingSinceSql), asc(heartbeatRuns.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!next) return null;
    const [woken] = await tx
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: now, updatedAt: now })
      .where(and(eq(heartbeatRuns.id, next.id), eq(heartbeatRuns.status, "scheduled_retry")))
      .returning({ id: heartbeatRuns.id });
    if (!woken) return null;
    await notifyScheduledRetryDispatch(tx, { companyId: input.companyId });
    return woken.id;
  });
}
