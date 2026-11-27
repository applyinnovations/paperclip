import type { Db } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
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
 * Settle the open recovery action of a task that just closed, so nothing about
 * it stays in `/attention`. It records the same stale-source outcome the issue
 * routes' source revalidation records, so every close path reads alike. Causes
 * a close does not settle (board stop confirmation, a held saved result) and
 * running system recovery stay with their own owners, the same holds the
 * recovery reconciler applies to terminal sources.
 */
export async function settleRecoveryActionsForTerminalIssue(
  db: Db,
  issue: { id: string; companyId: string; status: string; identifier?: string | null },
  closedBy: { agentId: string | null; userId: string | null; runId: string | null },
) {
  if (issue.status !== "done" && issue.status !== "cancelled") return null;
  const recoveries = issueRecoveryActionService(db);
  const active = await recoveries.getActiveForIssue(issue.companyId, issue.id);
  if (!active) return null;
  if ((TERMINAL_SOURCE_RETAINED_RECOVERY_CAUSES as readonly string[]).includes(active.cause)) return null;
  if (systemRecoveryInFlight(active.evidence)) return null;
  const resolved = await recoveries.resolveActiveForIssue({
    companyId: issue.companyId,
    sourceIssueId: issue.id,
    actionId: active.id,
    status: "cancelled",
    outcome: "cancelled",
    resolutionNote: `Recovery action became stale because the source issue reached ${issue.status}.`,
  });
  if (!resolved) return null;
  await logActivity(db, {
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
  });
  return resolved;
}
