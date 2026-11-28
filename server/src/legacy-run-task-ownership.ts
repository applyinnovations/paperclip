import { forbidden } from "./errors.js";

export function assertLegacyRunTaskOwnership(
  run: {
    companyId: string;
    runtimeMode: string;
    contextSnapshot?: Record<string, unknown> | null;
    resultJson?: Record<string, unknown> | null;
  } | null | undefined,
  issue: {
    id: string;
    companyId: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  },
) {
  if (run?.runtimeMode === "legacy" && run.companyId === issue.companyId &&
      run.contextSnapshot?.issueId === issue.id &&
      issue.assigneeAgentId === null && issue.assigneeUserId) {
    throw forbidden("This task is assigned to a human; the outgoing run can no longer change it", {
      code: "issue_handed_off",
      issueId: issue.id,
    });
  }
  // The run handed this issue to an execution stage participant and was left
  // running to finish its turn; ownership has moved, so it may not change it.
  if (run && run.companyId === issue.companyId && run.resultJson?.issueHandoffIssueId === issue.id) {
    throw forbidden("This task was handed to its review or approval stage; the outgoing run can no longer change it. End the turn.", {
      code: "issue_handed_off",
      issueId: issue.id,
    });
  }
}
