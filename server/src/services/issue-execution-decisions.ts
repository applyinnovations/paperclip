import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueExecutionDecisions } from "@paperclipai/db";
import {
  parseReviewedSha,
  type IssueExecutionDecisionOutcome,
  type IssueExecutionStageType,
} from "@paperclipai/shared";
import type {
  PluginIssueExecutionDecision,
  PluginIssueExecutionDecisionAmendedPayload,
  PluginIssueExecutionDecisionRecordedPayload,
} from "@paperclipai/plugin-sdk";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

/**
 * Activity action written for every recorded execution-policy stage decision.
 * The activity log maps it to the `issue.execution_decision.recorded` plugin
 * event.
 */
export const ISSUE_EXECUTION_DECISION_RECORDED_ACTION = "issue.execution_decision_recorded";

/**
 * Activity action written when a recorded decision is amended after the fact
 * (today only by a Reviewed-SHA attestation). The activity log maps it to the
 * `issue.execution_decision.amended` plugin event.
 */
export const ISSUE_EXECUTION_DECISION_AMENDED_ACTION = "issue.execution_decision_amended";

type DecisionRow = typeof issueExecutionDecisions.$inferSelect;

export function toPluginIssueExecutionDecision(
  row: DecisionRow,
  issueIdentifier: string | null,
): PluginIssueExecutionDecision {
  const bodySha = parseReviewedSha(row.body);
  const attestedSha = bodySha === null ? row.reviewedShaAttested ?? null : null;
  return {
    issueId: row.issueId,
    issueIdentifier,
    decisionId: row.id,
    stageId: row.stageId,
    stageType: row.stageType as IssueExecutionStageType,
    outcome: row.outcome as IssueExecutionDecisionOutcome,
    actorAgentId: row.actorAgentId ?? null,
    actorUserId: row.actorUserId ?? null,
    reviewedSha: bodySha ?? attestedSha,
    reviewedShaSource: bodySha !== null ? "body" : attestedSha !== null ? "attestation" : null,
    reviewedShaAttestedAt: attestedSha !== null ? row.reviewedShaAttestedAt?.toISOString() ?? null : null,
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

export interface AttestIssueExecutionDecisionReviewedShaInput {
  companyId: string;
  issueId: string;
  issueIdentifier: string | null;
  decisionId: string;
  /** Already validated as 40 lowercase hex characters. */
  reviewedSha: string;
  comment: string;
  actor: RecordIssueExecutionDecisionInput["actor"];
}

/**
 * Fill a missing Reviewed-SHA on an approved decision, as its own actor.
 *
 * The decision row keeps its body, timestamps and stage linkage; issue
 * execution state is not touched. The attestation is written to the
 * row's `reviewed_sha_attested*` columns at most once, with an
 * `issue.execution_decision_amended` activity whose publication (the
 * `issue.execution_decision.amended` plugin event) is sent after commit.
 */
export async function attestIssueExecutionDecisionReviewedSha(
  db: Db,
  input: AttestIssueExecutionDecisionReviewedShaInput,
): Promise<PluginIssueExecutionDecision> {
  const { actor } = input;
  const publications: ActivityPublication[] = [];
  const decision = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(issueExecutionDecisions)
      .where(and(
        eq(issueExecutionDecisions.id, input.decisionId),
        eq(issueExecutionDecisions.companyId, input.companyId),
        eq(issueExecutionDecisions.issueId, input.issueId),
      ))
      .for("update");
    if (!existing) throw notFound("Execution decision not found on this issue");

    const isOwnDecision = actor.actorType === "agent"
      ? actor.agentId !== null && existing.actorAgentId === actor.agentId
      : existing.actorAgentId === null && existing.actorUserId === actor.actorId;
    if (!isOwnDecision) {
      throw forbidden("Only the actor who recorded this decision can attest its Reviewed-SHA", {
        code: "not_decision_actor",
      });
    }
    if (existing.outcome !== "approved") {
      throw unprocessable("Only approved decisions can carry a Reviewed-SHA attestation", {
        code: "decision_not_approved",
        outcome: existing.outcome,
      });
    }
    const current = toPluginIssueExecutionDecision(existing, input.issueIdentifier);
    if (current.reviewedSha !== null) {
      throw conflict(
        "This decision already names a reviewed commit. Changing it is a re-review, not an attestation.",
        { code: "reviewed_sha_already_present", reviewedSha: current.reviewedSha, reviewedShaSource: current.reviewedShaSource },
      );
    }

    const [row] = await tx
      .update(issueExecutionDecisions)
      .set({
        reviewedShaAttested: input.reviewedSha,
        reviewedShaAttestedAt: new Date(),
        reviewedShaAttestedByAgentId: actor.agentId ?? null,
        reviewedShaAttestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        reviewedShaAttestedByRunId: actor.runId ?? null,
        reviewedShaAttestationComment: input.comment,
      })
      .where(and(eq(issueExecutionDecisions.id, existing.id), isNull(issueExecutionDecisions.reviewedShaAttested)))
      .returning();
    if (!row) {
      throw conflict("This decision already names a reviewed commit.", { code: "reviewed_sha_already_present" });
    }
    const amended = toPluginIssueExecutionDecision(row, input.issueIdentifier);
    const { body: _body, ...rest } = amended;
    const details: PluginIssueExecutionDecisionAmendedPayload = {
      ...rest,
      amendment: "reviewed_sha_attested",
      attestationComment: input.comment,
    };
    const { publication } = await persistActivity(tx as unknown as Db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId ?? null,
      action: ISSUE_EXECUTION_DECISION_AMENDED_ACTION,
      entityType: "issue",
      entityId: input.issueId,
      details: { ...details },
    });
    publications.push(publication);
    return amended;
  });
  for (const publication of publications) publishActivity(publication);
  return decision;
}
