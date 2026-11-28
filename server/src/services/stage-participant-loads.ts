import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { isAgentInvokable, type IssueExecutionPolicy } from "@paperclipai/shared";
import { and, count, eq, inArray } from "drizzle-orm";
import { stageParticipantKey } from "./issue-execution-policy.js";

export type StageParticipantLoads = {
  participantLoads?: Map<string, number>;
  ineligibleParticipants?: Set<string>;
};

/**
 * Agents in `error` can still be woken by the platform, but we would rather
 * not route new review work to them while a healthy reviewer is available.
 */
const AVOID_FOR_NEW_STAGE_WORK_STATUSES = new Set(["error"]);

/**
 * Loads the inputs `applyIssueExecutionPolicyTransition` needs to spread work
 * across multi-participant stages: per participant, the open `in_review` issues
 * assigned to it plus (for agents) its queued and running heartbeat runs, and
 * which agent participants cannot be woken. Returns `{}` (today's first-
 * participant behaviour, no queries) unless some stage has several participants.
 *
 * Spread the result into the transition input.
 */
export async function loadStageParticipantLoads(
  db: Db,
  companyId: string,
  policy: IssueExecutionPolicy | null | undefined,
): Promise<StageParticipantLoads> {
  const multiStages = (policy?.stages ?? []).filter((stage) => stage.participants.length > 1);
  if (multiStages.length === 0) return {};

  const agentIds = new Set<string>();
  const userIds = new Set<string>();
  for (const stage of multiStages) {
    for (const participant of stage.participants) {
      if (participant.type === "agent" && participant.agentId) agentIds.add(participant.agentId);
      if (participant.type === "user" && participant.userId) userIds.add(participant.userId);
    }
  }

  const participantLoads = new Map<string, number>();
  const add = (key: string, value: number) => participantLoads.set(key, (participantLoads.get(key) ?? 0) + Number(value));
  const ineligibleParticipants = new Set<string>();

  if (agentIds.size > 0) {
    const ids = [...agentIds];
    const [reviewRows, runRows, companyAgents] = await Promise.all([
      db
        .select({ agentId: issues.assigneeAgentId, value: count() })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.status, "in_review"), inArray(issues.assigneeAgentId, ids)))
        .groupBy(issues.assigneeAgentId),
      db
        .select({ agentId: heartbeatRuns.agentId, value: count() })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          inArray(heartbeatRuns.agentId, ids),
        ))
        .groupBy(heartbeatRuns.agentId),
      db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          status: agents.status,
          reportsTo: agents.reportsTo,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId)),
    ]);
    for (const row of reviewRows) if (row.agentId) add(`agent:${row.agentId}`, row.value);
    for (const row of runRows) add(`agent:${row.agentId}`, row.value);

    const byId = new Map(companyAgents.map((row) => [row.id, row]));
    for (const agentId of ids) {
      const agent = byId.get(agentId);
      const wakeable = agent
        && !AVOID_FOR_NEW_STAGE_WORK_STATUSES.has(agent.status)
        && isAgentInvokable({ agent, agents: companyAgents });
      if (!wakeable) {
        ineligibleParticipants.add(stageParticipantKey({ type: "agent", agentId, userId: null }));
      }
    }
  }

  if (userIds.size > 0) {
    const rows = await db
      .select({ userId: issues.assigneeUserId, value: count() })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.status, "in_review"), inArray(issues.assigneeUserId, [...userIds])))
      .groupBy(issues.assigneeUserId);
    for (const row of rows) if (row.userId) add(`user:${row.userId}`, row.value);
  }

  return { participantLoads, ineligibleParticipants };
}
