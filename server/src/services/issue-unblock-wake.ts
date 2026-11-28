const UNBLOCK_WAKE_STATUSES = new Set(["todo", "in_progress", "in_review"]);

/**
 * Whether leaving `blocked` for `todo`, in-progress or review work should wake
 * the unchanged assignee agent. `statusRequested` covers an explicit status
 * and an implicit reopen (a comment that moves a blocked issue to `todo`). An
 * assignee agent moving its own issue is already running, so it is not woken
 * again, whichever of the three statuses it moves to.
 */
export function shouldWakeAssigneeLeavingBlocked(input: {
  previousStatus: string;
  nextStatus: string;
  statusRequested: boolean;
  actorAgentId: string | null;
  assigneeAgentId: string | null;
}): boolean {
  return input.previousStatus === "blocked" &&
    UNBLOCK_WAKE_STATUSES.has(input.nextStatus) &&
    input.statusRequested &&
    input.assigneeAgentId !== null &&
    input.actorAgentId !== input.assigneeAgentId;
}
