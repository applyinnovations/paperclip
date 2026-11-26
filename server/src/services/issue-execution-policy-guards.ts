import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueExecutionDecisions } from "@paperclipai/db";
import type {
  IssueExecutionDecision,
  IssueExecutionPolicy,
  IssueExecutionState,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import {
  evaluateExecutionPolicyStageSatisfaction,
  getRequiredExecutionStages,
  hasRemovedRequiredExecutionStages,
  type ExecutionPolicyDecisionLike,
} from "./issue-execution-policy.js";

const UNSATISFIED_EXECUTION_POLICY_STAGES_MESSAGE =
  "Cannot transition this issue to done or complete its execution policy while required review or approval stages " +
  "lack a recorded approved decision for the current review cycle. Submit a structured review decision " +
  '(decision: "approve" or "request_changes" with a comment including Reviewed-SHA) instead of patching status: "done" directly.';

const PROTECTED_EXECUTION_POLICY_STAGES_MESSAGE =
  "Agents cannot remove or replace unsatisfied review or approval stages in executionPolicy. " +
  'Submit a structured review decision (decision: "approve" or "request_changes" with a comment including Reviewed-SHA) instead.';

async function loadRecordedStageDecisions(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<ExecutionPolicyDecisionLike[]> {
  const rows = await db
    .select({
      id: issueExecutionDecisions.id,
      stageId: issueExecutionDecisions.stageId,
      outcome: issueExecutionDecisions.outcome,
      createdAt: issueExecutionDecisions.createdAt,
    })
    .from(issueExecutionDecisions)
    .where(
      and(
        eq(issueExecutionDecisions.companyId, input.companyId),
        eq(issueExecutionDecisions.issueId, input.issueId),
      ),
    );
  if (!Array.isArray(rows)) return [];
  const decisions: ExecutionPolicyDecisionLike[] = [];
  for (const row of rows) {
    if (
      row &&
      typeof row.stageId === "string" &&
      (row.outcome === "approved" || row.outcome === "changes_requested")
    ) {
      decisions.push({
        id: row.id ?? null,
        stageId: row.stageId,
        outcome: row.outcome,
        createdAt: row.createdAt ?? null,
      });
    }
  }
  return decisions;
}

/**
 * Enforce that a non-board actor (agent) cannot move a stage-gated issue to `done`
 * or `executionState.status = "completed"` unless every required review/approval
 * stage has its required count of recorded `approved` rows in
 * `issue_execution_decisions` for the current review cycle.
 */
export async function assertAgentExecutionPolicyStagesSatisfied(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    policy: IssueExecutionPolicy | null;
    executionState: IssueExecutionState | null;
    pendingDecision?: Pick<IssueExecutionDecision, "stageId" | "stageType" | "outcome"> | null;
  },
): Promise<void> {
  if (getRequiredExecutionStages(input.policy).length === 0) return;

  const recorded = await loadRecordedStageDecisions(db, {
    companyId: input.companyId,
    issueId: input.issueId,
  });

  const evaluation = evaluateExecutionPolicyStageSatisfaction({
    policy: input.policy,
    decisions: recorded,
    executionState: input.executionState,
    pendingDecision: input.pendingDecision ?? null,
  });

  if (!evaluation.satisfied) {
    throw unprocessable(UNSATISFIED_EXECUTION_POLICY_STAGES_MESSAGE, {
      code: "unsatisfied_execution_policy_stages",
      unsatisfiedStages: evaluation.unsatisfiedStages,
    });
  }
}

/**
 * Enforce that an agent cannot bypass required review/approval stages by stripping
 * or replacing unsatisfied stages from `executionPolicy`.
 */
export async function assertAgentExecutionPolicyStagesNotRemoved(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    previousPolicy: IssueExecutionPolicy | null;
    nextPolicy: IssueExecutionPolicy | null;
    executionState: IssueExecutionState | null;
  },
): Promise<void> {
  const removedStages = hasRemovedRequiredExecutionStages(
    input.previousPolicy,
    input.nextPolicy,
  );
  if (removedStages.length === 0 || !input.previousPolicy) return;

  const recorded = await loadRecordedStageDecisions(db, {
    companyId: input.companyId,
    issueId: input.issueId,
  });

  const evaluation = evaluateExecutionPolicyStageSatisfaction({
    policy: { ...input.previousPolicy, stages: removedStages },
    decisions: recorded,
    executionState: input.executionState,
  });

  if (!evaluation.satisfied) {
    throw unprocessable(PROTECTED_EXECUTION_POLICY_STAGES_MESSAGE, {
      code: "execution_policy_stages_protected",
      unsatisfiedStages: evaluation.unsatisfiedStages,
    });
  }
}
