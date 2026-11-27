/**
 * Whether leaving `blocked` for in-progress or review work should wake the
 * unchanged assignee agent. `blocked -> todo` keeps its own long-standing
 * rule in the issue routes. An assignee agent moving its own issue is already
 * running, so it is not woken again.
 */
export function shouldWakeAssigneeLeavingBlocked(input: {
  previousStatus: string;
  nextStatus: string;
  statusRequested: boolean;
  actorAgentId: string | null;
  assigneeAgentId: string | null;
}): boolean {
  return input.previousStatus === "blocked" &&
    (input.nextStatus === "in_progress" || input.nextStatus === "in_review") &&
    input.statusRequested &&
    input.assigneeAgentId !== null &&
    input.actorAgentId !== input.assigneeAgentId;
}
