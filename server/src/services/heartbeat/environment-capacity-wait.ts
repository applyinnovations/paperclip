import { agents, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import {
  ENVIRONMENT_CAPACITY_RECHECK_MS,
  ENVIRONMENT_CAPACITY_WAIT_KEY,
  ENVIRONMENT_CAPACITY_WAIT_RETRY_REASON,
  environmentCapacityWaitKey,
  readEnvironmentCapacityWait,
  type EnvironmentCapacityWait,
} from "../../modules/run-dispatch/index.js";
import { parseObject } from "../../adapters/utils.js";
import {
  ENVIRONMENT_CAPACITY_WAIT_CODE,
  type EnvironmentCapacityUnavailableError,
} from "../environment-capacity-unavailable-error.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;

export const ENVIRONMENT_CAPACITY_WAKE_REASON = "environment_capacity_retry";

export interface EnvironmentCapacityWaitDependencies {
  setRunStatusIfRunning: (runId: string, status: "cancelled", patch: {
    error: string; errorCode: string; finishedAt: Date; resultJson: Record<string, unknown>;
    contextSnapshot: Record<string, unknown>;
  }) => Promise<{ updated: boolean; run?: HeartbeatRun | null }>;
  setWakeupStatus: (wakeupRequestId: string | null | undefined, status: "cancelled", patch: { finishedAt: Date; error: string }) => Promise<unknown>;
  appendRunEvent: (run: HeartbeatRun, event: {
    eventType: string; stream: "system"; level: "info" | "warn"; message: string; payload: Record<string, unknown>;
  }) => Promise<unknown>;
  scheduleBoundedRetryForRun: (run: HeartbeatRun, agent: Agent, opts: {
    now: Date; retryReason: string; wakeReason: string; maxAttempts: number; delayMs: number;
  }) => Promise<{ outcome: string }>;
  getAgent: (agentId: string) => Promise<Agent | null>;
  releaseIssueExecutionAndPromote: (run: HeartbeatRun) => Promise<unknown>;
  finalizeAgentStatus: (agentId: string, outcome: "cancelled") => Promise<unknown>;
}

/**
 * Holds a run whose environment has no room for a new sandbox (a full tenant
 * quota, no node with room, or older runs already waiting) as a scheduled
 * retry instead of failing it. The task keeps its execution lock and stays
 * in progress; the wait never spends the bounded transient-retry budget.
 * Admission is first in, first out per company and environment: a released
 * lease wakes the oldest waiter, and a timer re-checks in case that wake is
 * missed or capacity frees outside Paperclip.
 */
export function createEnvironmentCapacityWait(deps: EnvironmentCapacityWaitDependencies) {
  const {
    setRunStatusIfRunning, setWakeupStatus, appendRunEvent, scheduleBoundedRetryForRun, getAgent,
    releaseIssueExecutionAndPromote, finalizeAgentStatus,
  } = deps;

  async function deferRunForEnvironmentCapacity(run: HeartbeatRun, error: EnvironmentCapacityUnavailableError): Promise<void> {
    const now = new Date();
    const runContext = parseObject(run.contextSnapshot);
    // A re-deferral keeps its place in the queue.
    const key = environmentCapacityWaitKey(error.environmentId);
    const prior = readEnvironmentCapacityWait(run.scheduledRetryReason, runContext);
    const wait: EnvironmentCapacityWait = {
      key, environmentId: error.environmentId, reason: error.reason,
      waitingSince: prior?.key === key ? prior.waitingSince : now.toISOString(),
    };
    const issueId = typeof runContext.issueId === "string" ? runContext.issueId : null;
    const cancelled = await setRunStatusIfRunning(run.id, "cancelled", {
      error: error.message, errorCode: ENVIRONMENT_CAPACITY_WAIT_CODE, finishedAt: now,
      resultJson: {
        executionRecovery: { kind: "environment_capacity_wait", providerWorkStarted: false },
        environmentCapacityWait: { environmentId: wait.environmentId, reason: wait.reason, waitingSince: wait.waitingSince },
        cancellation: {
          source: "control_plane", expected: true, initiator: { type: "system" },
          reason: "Waiting for capacity in the execution environment", recordedAt: now.toISOString(),
        },
      },
      contextSnapshot: { ...runContext, [ENVIRONMENT_CAPACITY_WAIT_KEY]: wait },
    });
    if (!cancelled.updated) return;
    const deferred = cancelled.run ?? { ...run, contextSnapshot: { ...runContext, [ENVIRONMENT_CAPACITY_WAIT_KEY]: wait } };
    // The cancellation is committed. From here the run must either gain its
    // retry or release its task lock; diagnostics never decide that.
    let scheduled = false;
    try {
      const agent = await getAgent(run.agentId).catch(() => null);
      if (agent) {
        const retry = await scheduleBoundedRetryForRun(deferred, agent, {
          now, retryReason: ENVIRONMENT_CAPACITY_WAIT_RETRY_REASON, wakeReason: ENVIRONMENT_CAPACITY_WAKE_REASON,
          // Bounded by the queue draining, not by an attempt counter.
          maxAttempts: (run.scheduledRetryReason === ENVIRONMENT_CAPACITY_WAIT_RETRY_REASON ? run.scheduledRetryAttempt ?? 0 : 0) + 1,
          delayMs: ENVIRONMENT_CAPACITY_RECHECK_MS,
        }).catch((err: unknown) => {
          logger.error({ err, runId: run.id }, "failed to schedule the environment capacity retry");
          return null;
        });
        scheduled = retry?.outcome === "scheduled";
      }
      const waitingForMs = now.getTime() - Date.parse(wait.waitingSince);
      logger.info({ runId: run.id, companyId: run.companyId, agentId: run.agentId, issueId,
        environmentId: wait.environmentId, reason: wait.reason, waitingSince: wait.waitingSince, waitingForMs, retryScheduled: scheduled },
      scheduled ? "environment capacity wait: run queued" : "environment capacity wait: retry not scheduled, task released");
      await appendRunEvent(deferred, {
        eventType: "lifecycle", stream: "system", level: scheduled ? "info" : "warn",
        message: scheduled
          ? `${error.message} The run is queued and starts when there is room.`
          : `${error.message} No retry could be scheduled; releasing the task.`,
        payload: { environmentId: wait.environmentId, reason: wait.reason, waitingSince: wait.waitingSince, retryScheduled: scheduled },
      }).catch((err: unknown) => logger.warn({ err, runId: run.id }, "failed to record the environment capacity wait"));
      await setWakeupStatus(run.wakeupRequestId, "cancelled", { finishedAt: now, error: error.message })
        .catch((err: unknown) => logger.warn({ err, runId: run.id }, "failed to settle the environment capacity wakeup"));
    } finally {
      try {
        if (!scheduled) await releaseIssueExecutionAndPromote(deferred);
      } finally {
        await finalizeAgentStatus(run.agentId, "cancelled");
      }
    }
  }

  return { deferRunForEnvironmentCapacity };
}
