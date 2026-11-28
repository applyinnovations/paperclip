import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issueExecutionDecisions } from "@paperclipai/db";
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

/**
 * A Reviewed-SHA the decision's own actor attested after the decision was
 * recorded. The record is the decision's `issue.execution_decision_amended`
 * activity row: activity is append-only, carries who, when and the run, and
 * the `issue.execution_decision_*` actions are reserved, so only
 * `attestIssueExecutionDecisionReviewedSha` writes them.
 */
export interface ReviewedShaAttestation {
  reviewedSha: string;
  attestedAt: string;
}

const FULL_LOWERCASE_SHA_RE = /^[0-9a-f]{40}$/;

export function toPluginIssueExecutionDecision(
  row: DecisionRow,
  issueIdentifier: string | null,
  attestation: ReviewedShaAttestation | null = null,
): PluginIssueExecutionDecision {
  const bodySha = parseReviewedSha(row.body);
  const attested = bodySha === null ? attestation : null;
  return {
    issueId: row.issueId,
    issueIdentifier,
    decisionId: row.id,
    stageId: row.stageId,
    stageType: row.stageType as IssueExecutionStageType,
    outcome: row.outcome as IssueExecutionDecisionOutcome,
    actorAgentId: row.actorAgentId ?? null,
    actorUserId: row.actorUserId ?? null,
    reviewedSha: bodySha ?? attested?.reviewedSha ?? null,
    reviewedShaSource: bodySha !== null ? "body" : attested ? "attestation" : null,
    reviewedShaAttestedAt: attested?.attestedAt ?? null,
    createdAt: row.createdAt.toISOString(),
    body: row.body,
  };
}

/**
 * The attestation in effect for each decision: the earliest
 * `issue.execution_decision_amended` activity on the issue whose actor is
 * the decision's own actor and whose details name a valid SHA. Rows by any
 * other actor (including plugins) are ignored.
 */
async function loadReviewedShaAttestations(
  db: Db,
  companyId: string,
  issueId: string,
  decisions: DecisionRow[],
): Promise<Map<string, ReviewedShaAttestation>> {
  const result = new Map<string, ReviewedShaAttestation>();
  const candidates = decisions.filter((row) => row.outcome === "approved" && parseReviewedSha(row.body) === null);
  if (candidates.length === 0) return result;
  const byId = new Map(candidates.map((row) => [row.id, row]));
  const rows = await db
    .select()
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issueId),
      eq(activityLog.action, ISSUE_EXECUTION_DECISION_AMENDED_ACTION),
      inArray(activityLog.actorType, ["agent", "user"]),
    ))
    .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
  for (const activity of rows) {
    const details = activity.details ?? {};
    const decisionId = typeof details.decisionId === "string" ? details.decisionId : null;
    const decision = decisionId ? byId.get(decisionId) : undefined;
    if (!decision || result.has(decision.id)) continue;
    if (details.amendment !== "reviewed_sha_attested") continue;
    const reviewedSha = typeof details.reviewedSha === "string" ? details.reviewedSha : "";
    if (!FULL_LOWERCASE_SHA_RE.test(reviewedSha)) continue;
    const byOwnActor = activity.actorType === "agent"
      ? decision.actorAgentId !== null && activity.agentId === decision.actorAgentId
      : decision.actorAgentId === null && decision.actorUserId !== null && activity.actorId === decision.actorUserId;
    if (!byOwnActor) continue;
    const attestedAt = typeof details.reviewedShaAttestedAt === "string" && !Number.isNaN(Date.parse(details.reviewedShaAttestedAt))
      ? details.reviewedShaAttestedAt
      : activity.createdAt.toISOString();
    result.set(decision.id, { reviewedSha, attestedAt });
  }
  return result;
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
  const attestations = await loadReviewedShaAttestations(db, input.companyId, input.issueId, rows);
  return rows.map((row) => toPluginIssueExecutionDecision(row, input.issueIdentifier, attestations.get(row.id) ?? null));
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
 * The decision row and issue execution state are not touched. The
 * attestation is the `issue.execution_decision_amended` activity row (see
 * `ReviewedShaAttestation`), written at most once per decision; its
 * publication (the `issue.execution_decision.amended` plugin event) is sent
 * after commit.
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
    // The row lock above serializes attestations of one decision, so the
    // existence check and the insert below cannot interleave.
    const attestations = await loadReviewedShaAttestations(tx as unknown as Db, input.companyId, input.issueId, [existing]);
    const current = toPluginIssueExecutionDecision(existing, input.issueIdentifier, attestations.get(existing.id) ?? null);
    if (current.reviewedSha !== null) {
      throw conflict(
        "This decision already names a reviewed commit. Changing it is a re-review, not an attestation.",
        { code: "reviewed_sha_already_present", reviewedSha: current.reviewedSha, reviewedShaSource: current.reviewedShaSource },
      );
    }

    const amended = toPluginIssueExecutionDecision(existing, input.issueIdentifier, {
      reviewedSha: input.reviewedSha,
      attestedAt: new Date().toISOString(),
    });
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
