import type { Db } from "@paperclipai/db";
import { logActivity, type ActivityPublication } from "./activity-log.js";
import { TERMINAL_SOURCE_RETAINED_RECOVERY_CAUSES } from "./attention-source-eligibility.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";

/** System recovery work that is still running owns its action until it settles. */
const IN_FLIGHT_SYSTEM_RECOVERY_STATES = new Set(["scheduled", "running", "awaiting_evidence"]);

function systemRecoveryInFlight(evidence: Record<string, unknown> | null | undefined) {
  const systemRecovery = evidence?.systemRecovery;
  if (!systemRecovery || typeof systemRecovery !== "object") return false;
  const state = (systemRecovery as Record<string, unknown>).state;
  return typeof state === "string" && IN_FLIGHT_SYSTEM_RECOVERY_STATES.has(state);
}

/**
 * Settle the open recovery action of a task that is closing, so nothing about
 * it stays in `/attention`. Call it with the transaction that writes the
 * terminal status: the action it resolves is the one open at that moment, and
 * the resolution and its activity entry commit or roll back with the close.
 * It records the same stale-source outcome the issue routes' source
 * revalidation records, so every close path reads alike. Causes a close does
 * not settle (board stop confirmation, a held saved result) and running system
 * recovery stay with their own owners, the same holds the recovery reconciler
 * applies to terminal sources; the attention feed hides them instead.
 */
export async function settleRecoveryActionsForTerminalIssue(
  tx: Db,
  issue: { id: string; companyId: string; status: string; identifier?: string | null },
  closedBy: { agentId: string | null; userId: string | null; runId: string | null },
  options: {
    /** A caller that resolves this action itself in the same transaction. */
    callerResolvesActionId?: string | null;
    publications?: ActivityPublication[];
  } = {},
) {
  if (issue.status !== "done" && issue.status !== "cancelled") return null;
  const recoveries = issueRecoveryActionService(tx);
  const active = await recoveries.getActiveForIssue(issue.companyId, issue.id, tx);
  if (!active) return null;
  if (options.callerResolvesActionId && active.id === options.callerResolvesActionId) return null;
  if ((TERMINAL_SOURCE_RETAINED_RECOVERY_CAUSES as readonly string[]).includes(active.cause)) return null;
  if (systemRecoveryInFlight(active.evidence)) return null;
  const resolved = await recoveries.resolveActiveForIssue({
    companyId: issue.companyId,
    sourceIssueId: issue.id,
    actionId: active.id,
    status: "cancelled",
    outcome: "cancelled",
    resolutionNote: `Recovery action became stale because the source issue reached ${issue.status}.`,
  }, tx);
  if (!resolved) return null;
  await logActivity(tx, {
    companyId: issue.companyId,
    actorType: "system",
    actorId: "recovery",
    agentId: null,
    runId: closedBy.runId,
    action: "issue.recovery_action_resolved",
    entityType: "issue",
    entityId: issue.id,
    details: {
      identifier: issue.identifier ?? null,
      recoveryActionId: resolved.id,
      recoveryActionStatus: resolved.status,
      outcome: resolved.outcome,
      sourceIssueStatus: issue.status,
      resolutionNote: resolved.resolutionNote,
      source: "source_revalidation",
      trigger: "issue_terminal_transition",
      closedByAgentId: closedBy.agentId,
      closedByUserId: closedBy.userId,
    },
  }, options.publications);
  return resolved;
}
