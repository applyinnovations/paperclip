import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueExecutionDecisions } from "@paperclipai/db";
import {
  parseReviewedSha,
  parseReviewedShas,
  type IssueExecutionDecisionOutcome,
  type IssueExecutionStageType,
} from "@paperclipai/shared";
import type {
  PluginIssueExecutionDecision,
  PluginIssueExecutionDecisionRecordedPayload,
} from "@paperclipai/plugin-sdk";
import { persistActivity, type ActivityPublication } from "./activity-log.js";

/**
 * Activity action written for every recorded execution-policy stage decision.
 * The activity log maps it to the `issue.execution_decision.recorded` plugin
 * event.
 */
export const ISSUE_EXECUTION_DECISION_RECORDED_ACTION = "issue.execution_decision_recorded";

type DecisionRow = typeof issueExecutionDecisions.$inferSelect;

export function toPluginIssueExecutionDecision(
  row: DecisionRow,
  issueIdentifier: string | null,
): PluginIssueExecutionDecision {
  return {
    issueId: row.issueId,
    issueIdentifier,
    decisionId: row.id,
    stageId: row.stageId,
    stageType: row.stageType as IssueExecutionStageType,
    outcome: row.outcome as IssueExecutionDecisionOutcome,
    actorAgentId: row.actorAgentId ?? null,
    actorUserId: row.actorUserId ?? null,
    reviewedShas: parseReviewedShas(row.body),
    reviewedSha: parseReviewedSha(row.body),
    createdAt: row.createdAt.toISOString(),
    body: row.body,
  };
}

export interface RecordIssueExecutionDecisionInput {
  id: string;
  companyId: string;
  issueId: string;
  issueIdentifier: string | null;
  stageId: string;
  stageType: IssueExecutionStageType;
  outcome: IssueExecutionDecisionOutcome;
  body: string;
  actor: {
    actorType: "agent" | "user";
    actorId: string;
    agentId: string | null;
    runId: string | null;
    agentApiKeyId?: string | null;
  };
}

/**
 * Insert an execution-policy stage decision and its audit activity inside the
 * caller's transaction. The activity's publication (which carries the
 * `issue.execution_decision.recorded` plugin event) is appended to
 * `postCommitPublications`, so plugins only hear about committed decisions.
 */
export async function recordIssueExecutionDecision(
  tx: Db,
  input: RecordIssueExecutionDecisionInput,
  postCommitPublications: ActivityPublication[],
): Promise<PluginIssueExecutionDecision> {
  const { actor } = input;
  const [row] = await tx
    .insert(issueExecutionDecisions)
    .values({
      id: input.id,
      companyId: input.companyId,
      issueId: input.issueId,
      stageId: input.stageId,
      stageType: input.stageType,
      actorAgentId: actor.agentId ?? null,
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
      outcome: input.outcome,
      body: input.body,
      createdByRunId: actor.runId ?? null,
    })
    .returning();
  const decision = toPluginIssueExecutionDecision(row!, input.issueIdentifier);
  const { body: _body, ...payload } = decision;
  const details: PluginIssueExecutionDecisionRecordedPayload = payload;
  const { publication } = await persistActivity(tx, {
    companyId: input.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    agentApiKeyId: actor.agentApiKeyId ?? null,
    action: ISSUE_EXECUTION_DECISION_RECORDED_ACTION,
    entityType: "issue",
    entityId: input.issueId,
    details: { ...details },
  });
  postCommitPublications.push(publication);
  return decision;
}

/** Decisions recorded on one issue, oldest first. */
export async function listIssueExecutionDecisions(
  db: Db,
  input: { companyId: string; issueId: string; issueIdentifier: string | null },
): Promise<PluginIssueExecutionDecision[]> {
  const rows = await db
    .select()
    .from(issueExecutionDecisions)
    .where(and(
      eq(issueExecutionDecisions.companyId, input.companyId),
      eq(issueExecutionDecisions.issueId, input.issueId),
    ))
    .orderBy(asc(issueExecutionDecisions.createdAt), asc(issueExecutionDecisions.id));
  return rows.map((row) => toPluginIssueExecutionDecision(row, input.issueIdentifier));
}
