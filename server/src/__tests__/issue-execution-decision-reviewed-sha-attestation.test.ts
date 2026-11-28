import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { activityRoutes } from "../routes/activity.js";
import { setPluginEventBus } from "../services/activity-log.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import type { PluginEventBus } from "../services/plugin-event-bus.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Reviewed-SHA attestation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const REVIEWED_SHA = "89c28f89bc16781eef35a9e2a01c95a6d9ea7a9a";
const OTHER_SHA = "0123456789abcdef0123456789abcdef01234567";
const BOARD_USER_ID = "board-user";
const RECORDED = "issue.execution_decision.recorded";
const AMENDED = "issue.execution_decision.amended";

describeEmbeddedPostgres("POST /issues/:id/execution-decisions/:decisionId/reviewed-sha", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const emitted: PluginEvent[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reviewed-sha-attestation-");
    db = createDb(tempDb.connectionString);
    setPluginEventBus({
      emit: vi.fn(async (event: PluginEvent) => {
        emitted.push(event);
        return { errors: [] };
      }),
    } as unknown as PluginEventBus);
  }, 30_000);

  afterEach(async () => {
    emitted.length = 0;
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.delete(issueExecutionDecisions);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any));
    testApp.use("/api", activityRoutes(db));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seedRun(companyId: string, agentId: string, issueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    return runId;
  }

  /**
   * The APP-661 / APP-824 shape, built through the real routes: a review
   * stage (agent) then an approval stage (board user), the reviewer approves
   * with no Reviewed-SHA line, the board approves, and the policy completes.
   */
  async function seedCompletedReviewWithoutSha(prefix: string) {
    const companyId = randomUUID();
    const implementerAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values(
      [implementerAgentId, reviewerAgentId, otherAgentId].map((id, index) => ({
        id,
        companyId,
        name: `${prefix} agent ${index}`,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
    });
    const issueId = randomUUID();
    const reviewStageId = randomUUID();
    const approvalStageId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${prefix}-1`,
      title: `${prefix}-1`,
      status: "in_review",
      priority: "high",
      assigneeAgentId: reviewerAgentId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: reviewStageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: reviewerAgentId }],
          },
          {
            id: approvalStageId,
            type: "approval",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "user", userId: BOARD_USER_ID }],
          },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: implementerAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const reviewerRunId = await seedRun(companyId, reviewerAgentId, issueId);
    const reviewerActor = agentActor(companyId, reviewerAgentId, reviewerRunId);
    const reviewRes = await request(app(reviewerActor))
      .patch(`/api/issues/${issueId}`)
      .send({ decision: "approve", comment: "Approved. Checks green." });
    expect(reviewRes.status, JSON.stringify(reviewRes.body)).toBe(200);
    const reviewDecisionId = reviewRes.body.executionState.lastDecisionId as string;

    const boardActor = boardUserActor(companyId);
    const boardRes = await request(app(boardActor))
      .patch(`/api/issues/${issueId}`)
      .send({ decision: "approve", comment: "Board approves." });
    expect(boardRes.status, JSON.stringify(boardRes.body)).toBe(200);
    expect(boardRes.body.executionState).toMatchObject({
      status: "completed",
      completedStageIds: [reviewStageId, approvalStageId],
    });
    const boardDecisionId = boardRes.body.executionState.lastDecisionId as string;

    const otherRunId = await seedRun(companyId, otherAgentId, issueId);
    return {
      companyId,
      issueId,
      identifier: `${prefix}-1`,
      reviewStageId,
      approvalStageId,
      reviewDecisionId,
      boardDecisionId,
      reviewerAgentId,
      reviewerRunId,
      reviewerActor,
      boardActor,
      otherActor: agentActor(companyId, otherAgentId, otherRunId),
    };
  }

  function agentActor(companyId: string, agentId: string, runId: string) {
    return { type: "agent", source: "agent_key", companyId, agentId, runId };
  }

  function boardUserActor(companyId: string) {
    return {
      type: "board",
      userId: BOARD_USER_ID,
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
  }

  function attest(actor: Record<string, unknown>, issueId: string, decisionId: string, body: Record<string, unknown>) {
    return request(app(actor))
      .post(`/api/issues/${issueId}/execution-decisions/${decisionId}/reviewed-sha`)
      .send(body);
  }

  /** The decision as plugins see it: `listExecutionDecisions` through the host services. */
  async function effective(companyId: string, issueId: string, decisionId: string) {
    const services = buildHostServices(db, "plugin-record-id", "test.reviewed-sha-attestation", {
      forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }),
    } as any);
    const listed = await services.issues.listExecutionDecisions({ issueId, companyId });
    return listed.find((decision) => decision.decisionId === decisionId)!;
  }

  async function amendedActivity(issueId: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.execution_decision_amended")));
  }

  async function snapshot(issueId: string) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const decisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    return { issue: issue!, decisions };
  }

  it("lets the reviewer attest the missing SHA after both stages completed", async () => {
    const seeded = await seedCompletedReviewWithoutSha("XAT");
    const before = await snapshot(seeded.issueId);
    const reviewBefore = before.decisions.find((row) => row.id === seeded.reviewDecisionId)!;
    const boardBefore = before.decisions.find((row) => row.id === seeded.boardDecisionId)!;
    expect(await effective(seeded.companyId, seeded.issueId, seeded.reviewDecisionId)).toMatchObject({
      reviewedSha: null,
      reviewedShaSource: null,
    });
    await vi.waitFor(() => expect(emitted.filter((event) => event.eventType === RECORDED)).toHaveLength(2));
    emitted.length = 0;

    const res = await attest(seeded.reviewerActor, seeded.issueId, seeded.reviewDecisionId, {
      reviewedSha: REVIEWED_SHA,
      comment: "Approval comment omitted the Reviewed-SHA line; this is the head I reviewed.",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      decisionId: seeded.reviewDecisionId,
      stageId: seeded.reviewStageId,
      stageType: "review",
      outcome: "approved",
      reviewedSha: REVIEWED_SHA,
      reviewedShaSource: "attestation",
      createdAt: reviewBefore.createdAt.toISOString(),
      body: reviewBefore.body,
    });
    expect(Date.parse(res.body.reviewedShaAttestedAt)).toBeGreaterThanOrEqual(reviewBefore.createdAt.getTime());

    // Both decision rows and the stage state are untouched.
    const after = await snapshot(seeded.issueId);
    expect(after.issue.executionState).toEqual(before.issue.executionState);
    expect(after.issue.status).toBe(before.issue.status);
    expect(after.decisions.find((row) => row.id === seeded.boardDecisionId)).toEqual(boardBefore);
    expect(after.decisions.find((row) => row.id === seeded.reviewDecisionId)).toEqual(reviewBefore);

    // The attestation is the audited activity row: who, when, run and comment.
    const [activity] = await amendedActivity(seeded.issueId);
    expect(activity).toMatchObject({
      actorType: "agent",
      actorId: seeded.reviewerAgentId,
      agentId: seeded.reviewerAgentId,
      runId: seeded.reviewerRunId,
    });
    expect(activity!.details).toMatchObject({
      decisionId: seeded.reviewDecisionId,
      amendment: "reviewed_sha_attested",
      reviewedSha: REVIEWED_SHA,
      reviewedShaAttestedAt: res.body.reviewedShaAttestedAt,
      attestationComment: "Approval comment omitted the Reviewed-SHA line; this is the head I reviewed.",
    });

    // Plugins hear `amended`, not a second `recorded`.
    await vi.waitFor(() => expect(emitted.filter((event) => event.eventType === AMENDED)).toHaveLength(1));
    const amended = emitted.find((event) => event.eventType === AMENDED)!;
    expect(amended).toMatchObject({ entityType: "issue", entityId: seeded.issueId, actorId: seeded.reviewerAgentId });
    expect(amended.payload).toMatchObject({
      issueId: seeded.issueId,
      issueIdentifier: seeded.identifier,
      decisionId: seeded.reviewDecisionId,
      stageType: "review",
      outcome: "approved",
      reviewedSha: REVIEWED_SHA,
      reviewedShaSource: "attestation",
      reviewedShaAttestedAt: res.body.reviewedShaAttestedAt,
      amendment: "reviewed_sha_attested",
    });
    expect(amended.payload).not.toHaveProperty("body");
    expect(emitted.filter((event) => event.eventType === RECORDED)).toHaveLength(0);

    // The plugin read reports the effective SHA and its source.
    const services = buildHostServices(db, "plugin-record-id", "test.reviewed-sha-attestation", {
      forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }),
    } as any);
    const listed = await services.issues.listExecutionDecisions({ issueId: seeded.issueId, companyId: seeded.companyId });
    expect(listed.map((decision) => [decision.decisionId, decision.reviewedSha, decision.reviewedShaSource])).toEqual([
      [seeded.reviewDecisionId, REVIEWED_SHA, "attestation"],
      [seeded.boardDecisionId, null, null],
    ]);
  });

  it("rejects anyone but the decision's own actor, with no board override", async () => {
    const seeded = await seedCompletedReviewWithoutSha("XAF");
    const body = { reviewedSha: REVIEWED_SHA, comment: "Not mine to attest." };

    for (const actor of [seeded.otherActor, seeded.boardActor]) {
      const res = await attest(actor, seeded.issueId, seeded.reviewDecisionId, body);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({ code: "not_decision_actor" });
    }
    // The reviewer cannot attest the board's decision either.
    const crossRes = await attest(seeded.reviewerActor, seeded.issueId, seeded.boardDecisionId, body);
    expect(crossRes.status, JSON.stringify(crossRes.body)).toBe(403);
    // An agent from another company cannot even see the issue.
    const foreignRes = await attest(
      agentActor(randomUUID(), seeded.reviewerAgentId, seeded.reviewerRunId),
      seeded.issueId,
      seeded.reviewDecisionId,
      body,
    );
    expect(foreignRes.status).toBe(404);

    expect(await amendedActivity(seeded.issueId)).toHaveLength(0);
    expect((await effective(seeded.companyId, seeded.issueId, seeded.reviewDecisionId)).reviewedSha).toBeNull();
  });

  it("lets a board user attest their own approved decision", async () => {
    const seeded = await seedCompletedReviewWithoutSha("XAU");
    const res = await attest(seeded.boardActor, seeded.issueId, seeded.boardDecisionId, {
      reviewedSha: REVIEWED_SHA,
      comment: "Approved this head.",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ stageType: "approval", reviewedSha: REVIEWED_SHA, reviewedShaSource: "attestation" });
    const [activity] = await amendedActivity(seeded.issueId);
    expect(activity).toMatchObject({ actorType: "user", actorId: BOARD_USER_ID, agentId: null });
    expect(await effective(seeded.companyId, seeded.issueId, seeded.boardDecisionId)).toMatchObject({
      reviewedSha: REVIEWED_SHA,
      reviewedShaSource: "attestation",
    });
  });

  it("never replaces a SHA: a second attestation and a body SHA are both refused", async () => {
    const seeded = await seedCompletedReviewWithoutSha("XAD");
    const first = await attest(seeded.reviewerActor, seeded.issueId, seeded.reviewDecisionId, {
      reviewedSha: REVIEWED_SHA,
      comment: "First attestation.",
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await attest(seeded.reviewerActor, seeded.issueId, seeded.reviewDecisionId, {
      reviewedSha: OTHER_SHA,
      comment: "Trying to change it.",
    });
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body.details).toMatchObject({
      code: "reviewed_sha_already_present",
      reviewedSha: REVIEWED_SHA,
      reviewedShaSource: "attestation",
    });

    const bodyShaDecisionId = randomUUID();
    await db.insert(issueExecutionDecisions).values({
      id: bodyShaDecisionId,
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      stageId: seeded.reviewStageId,
      stageType: "review",
      actorAgentId: seeded.reviewerAgentId,
      outcome: "approved",
      body: `Approved.\n\nReviewed-SHA: ${OTHER_SHA}`,
    });
    const bodyRes = await attest(seeded.reviewerActor, seeded.issueId, bodyShaDecisionId, {
      reviewedSha: REVIEWED_SHA,
      comment: "Trying to override the body.",
    });
    expect(bodyRes.status, JSON.stringify(bodyRes.body)).toBe(409);
    expect(bodyRes.body.details).toMatchObject({ code: "reviewed_sha_already_present", reviewedShaSource: "body" });

    expect(await amendedActivity(seeded.issueId)).toHaveLength(1);
    expect((await effective(seeded.companyId, seeded.issueId, seeded.reviewDecisionId)).reviewedSha).toBe(REVIEWED_SHA);
  });

  it("refuses changes-requested decisions, bad SHAs, and decisions from another issue", async () => {
    const seeded = await seedCompletedReviewWithoutSha("XAV");
    const changesDecisionId = randomUUID();
    await db.insert(issueExecutionDecisions).values({
      id: changesDecisionId,
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      stageId: seeded.reviewStageId,
      stageType: "review",
      actorAgentId: seeded.reviewerAgentId,
      outcome: "changes_requested",
      body: "Please add tests.",
    });
    const changesRes = await attest(seeded.reviewerActor, seeded.issueId, changesDecisionId, {
      reviewedSha: REVIEWED_SHA,
      comment: "Attesting a rejection.",
    });
    expect(changesRes.status, JSON.stringify(changesRes.body)).toBe(422);
    expect(changesRes.body.details).toMatchObject({ code: "decision_not_approved" });

    for (const reviewedSha of [REVIEWED_SHA.toUpperCase(), REVIEWED_SHA.slice(0, 12), `${REVIEWED_SHA} `]) {
      const res = await attest(seeded.reviewerActor, seeded.issueId, seeded.reviewDecisionId, {
        reviewedSha,
        comment: "Bad SHA.",
      });
      expect(res.status, reviewedSha).toBe(400);
    }
    const noComment = await attest(seeded.reviewerActor, seeded.issueId, seeded.reviewDecisionId, {
      reviewedSha: REVIEWED_SHA,
      comment: "   ",
    });
    expect(noComment.status).toBe(400);

    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: seeded.companyId,
      identifier: "XAV-2",
      title: "XAV-2",
      status: "todo",
      priority: "medium",
    });
    const wrongIssue = await attest(seeded.reviewerActor, otherIssueId, seeded.reviewDecisionId, {
      reviewedSha: REVIEWED_SHA,
      comment: "Wrong issue.",
    });
    expect(wrongIssue.status).toBe(404);

    expect(await amendedActivity(seeded.issueId)).toHaveLength(0);
  });

  it("cannot be forged through generic activity writes", async () => {
    const seeded = await seedCompletedReviewWithoutSha("XAG");
    const forgedDetails = {
      decisionId: seeded.reviewDecisionId,
      amendment: "reviewed_sha_attested",
      reviewedSha: OTHER_SHA,
      reviewedShaAttestedAt: new Date().toISOString(),
      attestationComment: "forged",
    };

    // The board's generic activity route refuses the reserved actions,
    // including posing as the reviewer agent.
    for (const action of ["issue.execution_decision_amended", "issue.execution_decision.recorded", "Issue.Execution_Decision_Recorded"]) {
      const res = await request(app(seeded.boardActor))
        .post(`/api/companies/${seeded.companyId}/activity`)
        .send({
          actorType: "agent",
          actorId: seeded.reviewerAgentId,
          agentId: seeded.reviewerAgentId,
          action,
          entityType: "issue",
          entityId: seeded.issueId,
          details: forgedDetails,
        });
      expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.details).toMatchObject({ code: "reserved_activity_action" });
    }

    // Plugin ctx.activity.log refuses them too.
    const services = buildHostServices(db, "plugin-record-id", "test.reviewed-sha-attestation", {
      forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }),
    } as any);
    await expect(services.activity.log({
      companyId: seeded.companyId,
      message: "issue.execution_decision_amended",
      entityType: "issue",
      entityId: seeded.issueId,
      metadata: forgedDetails,
    })).rejects.toThrow(/reserved action/);

    // Rows written some other way by anyone but the decision's own actor are ignored.
    await db.insert(activityLog).values([
      { companyId: seeded.companyId, actorType: "plugin", actorId: "some-plugin", action: "issue.execution_decision_amended", entityType: "issue", entityId: seeded.issueId, details: forgedDetails },
      { companyId: seeded.companyId, actorType: "user", actorId: BOARD_USER_ID, action: "issue.execution_decision_amended", entityType: "issue", entityId: seeded.issueId, details: forgedDetails },
      { companyId: seeded.companyId, actorType: "system", actorId: "system", agentId: seeded.reviewerAgentId, action: "issue.execution_decision_amended", entityType: "issue", entityId: seeded.issueId, details: forgedDetails },
    ]);
    expect(await effective(seeded.companyId, seeded.issueId, seeded.reviewDecisionId)).toMatchObject({
      reviewedSha: null,
      reviewedShaSource: null,
    });

    // The real reviewer can still attest.
    const res = await attest(seeded.reviewerActor, seeded.issueId, seeded.reviewDecisionId, {
      reviewedSha: REVIEWED_SHA,
      comment: "The head I reviewed.",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await effective(seeded.companyId, seeded.issueId, seeded.reviewDecisionId)).reviewedSha).toBe(REVIEWED_SHA);
  });
});
