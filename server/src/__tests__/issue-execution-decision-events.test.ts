import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
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
import { setPluginEventBus } from "../services/activity-log.js";
import { assertAgentExecutionPolicyStagesSatisfied } from "../services/issue-execution-policy-guards.js";
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
    `Skipping embedded Postgres execution decision event tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const REVIEWED_SHA = "0123456789abcdef0123456789abcdef01234567";
const SECOND_REVIEWED_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const EVENT_TYPE = "issue.execution_decision.recorded";

describeEmbeddedPostgres("issue.execution_decision.recorded", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const emitted: PluginEvent[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-decision-events-");
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
    // Stage decisions wake the next participant in the background; let those
    // runs settle before deleting the rows they write.
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

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const implementerAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([implementerAgentId, reviewerAgentId].map((id, index) => ({
      id,
      companyId,
      name: `${prefix} ${index === 0 ? "Implementer" : "Reviewer"}`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })));
    return { companyId, implementerAgentId, reviewerAgentId };
  }

  /** An in_review issue whose single review stage is pending on the reviewer agent. */
  async function seedPendingReview(input: {
    companyId: string;
    implementerAgentId: string;
    reviewerAgentId: string;
    identifier: string;
  }) {
    const issueId = randomUUID();
    const stageId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: "in_review",
      priority: "medium",
      assigneeAgentId: input.reviewerAgentId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: input.reviewerAgentId }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: input.reviewerAgentId },
        returnAssignee: { type: "agent", agentId: input.implementerAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    return { issueId, stageId };
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

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any));
    testApp.use(errorHandler);
    return testApp;
  }

  function agentActor(companyId: string, agentId: string, runId: string) {
    return { type: "agent", source: "agent_key", companyId, agentId, runId };
  }

  function decisionEvents() {
    return emitted.filter((event) => event.eventType === EVENT_TYPE);
  }

  async function waitForDecisionEvents(count: number) {
    await vi.waitFor(() => expect(decisionEvents()).toHaveLength(count));
    return decisionEvents();
  }

  it("emits the event with the reviewed SHA when a reviewer approves the stage", async () => {
    const seeded = await seedCompany("XDA");
    const { issueId, stageId } = await seedPendingReview({ ...seeded, identifier: "XDA-1" });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);
    const body = `Looks good.\n\nReviewed-SHA: ${REVIEWED_SHA}`;

    const res = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: body });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [row] = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issueId));
    expect(row).toBeTruthy();
    const [event] = await waitForDecisionEvents(1);
    expect(event).toMatchObject({
      eventType: EVENT_TYPE,
      companyId: seeded.companyId,
      entityType: "issue",
      entityId: issueId,
      actorType: "agent",
      actorId: seeded.reviewerAgentId,
    });
    expect(event!.payload).toMatchObject({
      issueId,
      issueIdentifier: "XDA-1",
      decisionId: row!.id,
      stageId,
      stageType: "review",
      outcome: "approved",
      actorAgentId: seeded.reviewerAgentId,
      actorUserId: null,
      reviewedShas: [REVIEWED_SHA],
      reviewedSha: REVIEWED_SHA,
      createdAt: row!.createdAt.toISOString(),
    });
    expect(event!.payload).not.toHaveProperty("body");

    const services = buildHostServices(db, "plugin-record-id", "test.execution-decisions", {
      forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }),
    } as any);
    // The SDK read returns the same fields as the event, plus the body.
    await expect(services.issues.listExecutionDecisions({ issueId, companyId: seeded.companyId })).resolves.toEqual([{
      issueId,
      issueIdentifier: "XDA-1",
      decisionId: row!.id,
      stageId,
      stageType: "review",
      outcome: "approved",
      actorAgentId: seeded.reviewerAgentId,
      actorUserId: null,
      reviewedShas: [REVIEWED_SHA],
      reviewedSha: REVIEWED_SHA,
      createdAt: row!.createdAt.toISOString(),
      body,
    }]);
  });

  it("emits the event with a null reviewed SHA when a reviewer requests changes", async () => {
    const seeded = await seedCompany("XDC");
    const { issueId, stageId } = await seedPendingReview({ ...seeded, identifier: "XDC-1" });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);

    const res = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "Please add tests.\nReviewed-SHA: not-a-sha" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [event] = await waitForDecisionEvents(1);
    expect(event!.payload).toMatchObject({
      issueId,
      issueIdentifier: "XDC-1",
      stageId,
      stageType: "review",
      outcome: "changes_requested",
      actorAgentId: seeded.reviewerAgentId,
      actorUserId: null,
      reviewedShas: [],
      reviewedSha: null,
    });
  });

  it("emits the event when a review comment auto-approves the stage", async () => {
    const seeded = await seedCompany("XDM");
    const { issueId, stageId } = await seedPendingReview({ ...seeded, identifier: "XDM-1" });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);

    const res = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, runId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: `## Review: APPROVED\n\nReviewed-SHA: ${REVIEWED_SHA}` });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const [event] = await waitForDecisionEvents(1);
    expect(event!.payload).toMatchObject({
      issueId,
      issueIdentifier: "XDM-1",
      stageId,
      outcome: "approved",
      reviewedSha: REVIEWED_SHA,
    });
  });

  it("emits every reviewed SHA when one approval covers several pull requests", async () => {
    const seeded = await seedCompany("XDP");
    const { issueId, stageId } = await seedPendingReview({ ...seeded, identifier: "XDP-1" });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);
    const body = `Both PRs approved.\n\nReviewed-SHA: ${REVIEWED_SHA}\nReviewed-SHA: ${SECOND_REVIEWED_SHA}`;

    const res = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: body });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [event] = await waitForDecisionEvents(1);
    expect(event!.payload).toMatchObject({
      issueId,
      stageId,
      outcome: "approved",
      reviewedShas: [REVIEWED_SHA, SECOND_REVIEWED_SHA],
      // The single-value field keeps its last-line meaning for older plugins.
      reviewedSha: SECOND_REVIEWED_SHA,
    });
  });

  it("does not emit the event for a status change without a stage decision", async () => {
    const seeded = await seedCompany("XDN");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: seeded.companyId,
      identifier: "XDN-1",
      title: "No policy",
      status: "todo",
      priority: "medium",
      assigneeAgentId: seeded.implementerAgentId,
    });
    const runId = await seedRun(seeded.companyId, seeded.implementerAgentId, issueId);
    const res = await request(app(agentActor(seeded.companyId, seeded.implementerAgentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ priority: "high" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await vi.waitFor(() => expect(emitted.some((event) => event.eventType === "issue.updated")).toBe(true));
    expect(decisionEvents()).toHaveLength(0);
  });

  it("lists decisions oldest first and only within the issue's company", async () => {
    const seeded = await seedCompany("XDL");
    const foreign = await seedCompany("XDF");
    const { issueId, stageId } = await seedPendingReview({ ...seeded, identifier: "XDL-1" });
    const older = new Date("2026-11-01T00:00:00.000Z");
    const newer = new Date("2026-11-02T00:00:00.000Z");
    const [first, second] = [randomUUID(), randomUUID()];
    await db.insert(issueExecutionDecisions).values([
      {
        id: second, companyId: seeded.companyId, issueId, stageId, stageType: "review",
        actorAgentId: seeded.reviewerAgentId, outcome: "approved",
        body: `Reviewed-SHA: ${REVIEWED_SHA}`, createdAt: newer,
      },
      {
        id: first, companyId: seeded.companyId, issueId, stageId, stageType: "review",
        actorUserId: "board-user", outcome: "changes_requested", body: "Needs work", createdAt: older,
      },
    ]);

    const services = buildHostServices(db, "plugin-record-id", "test.execution-decisions", {
      forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }),
    } as any);
    const decisions = await services.issues.listExecutionDecisions({ issueId, companyId: seeded.companyId });
    expect(decisions).toEqual([
      {
        issueId, issueIdentifier: "XDL-1", decisionId: first, stageId, stageType: "review",
        outcome: "changes_requested", actorAgentId: null, actorUserId: "board-user",
        reviewedShas: [], reviewedSha: null, createdAt: older.toISOString(), body: "Needs work",
      },
      {
        issueId, issueIdentifier: "XDL-1", decisionId: second, stageId, stageType: "review",
        outcome: "approved", actorAgentId: seeded.reviewerAgentId, actorUserId: null,
        reviewedShas: [REVIEWED_SHA], reviewedSha: REVIEWED_SHA, createdAt: newer.toISOString(),
        body: `Reviewed-SHA: ${REVIEWED_SHA}`,
      },
    ]);

    // Another company's plugin invocation cannot read this issue's decisions.
    await expect(services.issues.listExecutionDecisions({ issueId, companyId: foreign.companyId })).resolves.toEqual([]);
    await expect(services.issues.listExecutionDecisions({ issueId: randomUUID(), companyId: seeded.companyId })).resolves.toEqual([]);
  });

  it("rejects agent PATCH status: done when executionState says completed without a recorded approved decision row", async () => {
    const seeded = await seedCompany("XDG");
    const issueId = randomUUID();
    const stageId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: seeded.companyId,
      identifier: "XDG-1",
      title: "Completed state with only changes_requested",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: seeded.implementerAgentId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: seeded.reviewerAgentId }],
        }],
      },
      executionState: {
        status: "completed",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: { type: "agent", agentId: seeded.implementerAgentId },
        completedStageIds: [stageId],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      issueId,
      stageId,
      stageType: "review",
      actorAgentId: seeded.reviewerAgentId,
      outcome: "changes_requested",
      body: "Earlier review requested changes",
    });

    const implRunId = await seedRun(seeded.companyId, seeded.implementerAgentId, issueId);
    const res = await request(app(agentActor(seeded.companyId, seeded.implementerAgentId, implRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("Reviewed-SHA");
    expect(res.body.details).toMatchObject({
      code: "unsatisfied_execution_policy_stages",
      unsatisfiedStages: [
        expect.objectContaining({
          stageId,
          approvalsRecorded: 0,
          lastOutcome: "changes_requested",
        }),
      ],
    });

    const [persisted] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(persisted?.status).toBe("in_progress");
  });

  it("records structured request_changes -> resubmit -> approve across a full cycle and lets executor close after approval", async () => {
    const seeded = await seedCompany("XDR");
    const { issueId, stageId } = await seedPendingReview({ ...seeded, identifier: "XDR-1" });
    const reviewerRun1 = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);

    // 1. Reviewer submits structured request_changes decision.
    const changesRes = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, reviewerRun1)))
      .patch(`/api/issues/${issueId}`)
      .send({
        decision: "request_changes",
        comment: "Please fix the edge case before merge.",
      });
    expect(changesRes.status, JSON.stringify(changesRes.body)).toBe(200);
    expect(changesRes.body.status).toBe("in_progress");
    expect(changesRes.body.assigneeAgentId).toBe(seeded.implementerAgentId);
    expect(changesRes.body.executionState).toMatchObject({
      status: "changes_requested",
      lastDecisionOutcome: "changes_requested",
      lastDecisionId: expect.any(String),
    });
    const [changesEvent] = await waitForDecisionEvents(1);
    expect(changesEvent!.payload).toMatchObject({
      issueId,
      stageId,
      outcome: "changes_requested",
    });

    // 2. Executor attempts to strip executionPolicy to bypass re-review -> 422.
    const implRunId = await seedRun(seeded.companyId, seeded.implementerAgentId, issueId);
    const stripRes = await request(app(agentActor(seeded.companyId, seeded.implementerAgentId, implRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ executionPolicy: null, status: "done" });
    expect(stripRes.status, JSON.stringify(stripRes.body)).toBe(422);

    // 3. Executor re-submits issue to in_review -> returns to pending on reviewer.
    const resubmitRes = await request(app(agentActor(seeded.companyId, seeded.implementerAgentId, implRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", comment: "Fixed edge case; ready for re-review." });
    expect(resubmitRes.status, JSON.stringify(resubmitRes.body)).toBe(200);
    expect(resubmitRes.body.status).toBe("in_review");
    expect(resubmitRes.body.assigneeAgentId).toBe(seeded.reviewerAgentId);
    expect(resubmitRes.body.executionState).toMatchObject({
      status: "pending",
      currentStageId: stageId,
      completionRequested: false,
    });

    // 4. Reviewer submits structured approve decision with Reviewed-SHA.
    const reviewerRun2 = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);
    const approveBody = `Looks great now.\n\nReviewed-SHA: ${REVIEWED_SHA}`;
    const approveRes = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, reviewerRun2)))
      .patch(`/api/issues/${issueId}`)
      .send({
        decision: "approve",
        comment: approveBody,
      });
    expect(approveRes.status, JSON.stringify(approveRes.body)).toBe(200);
    expect(approveRes.body.status).toBe("in_progress");
    expect(approveRes.body.assigneeAgentId).toBe(seeded.implementerAgentId);
    expect(approveRes.body.executionState).toMatchObject({
      status: "completed",
      completedStageIds: [stageId],
      lastDecisionOutcome: "approved",
      lastDecisionId: expect.any(String),
    });

    const rows = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(rows).toHaveLength(2);
    const approvedRow = rows.find((row) => row.outcome === "approved");
    expect(approvedRow).toBeTruthy();
    expect(approveRes.body.executionState.lastDecisionId).toBe(approvedRow!.id);

    const events = await waitForDecisionEvents(2);
    expect(events[1]!.payload).toMatchObject({
      issueId,
      issueIdentifier: "XDR-1",
      decisionId: approvedRow!.id,
      stageId,
      stageType: "review",
      outcome: "approved",
      reviewedSha: REVIEWED_SHA,
    });

    // 5. Executor now closes the issue as done -> allowed because approved row exists after changes_requested.
    const implRun2 = await seedRun(seeded.companyId, seeded.implementerAgentId, issueId);
    const closeRes = await request(app(agentActor(seeded.companyId, seeded.implementerAgentId, implRun2)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Merged and verified." });
    expect(closeRes.status, JSON.stringify(closeRes.body)).toBe(200);
    expect(closeRes.body.status).toBe("done");
  });

  it("rejects previous-cycle approvals after reopen and requires a fresh structured approval in the new cycle", async () => {
    const seeded = await seedCompany("XDO");
    const { issueId, stageId } = await seedPendingReview({ ...seeded, identifier: "XDO-1" });
    const boardActor = {
      type: "board",
      userId: "board-user",
      companyIds: [seeded.companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    };

    // Cycle 1: Reviewer approves the pending review stage, then executor closes the issue.
    const reviewerRun1 = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);
    const approve1Res = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, reviewerRun1)))
      .patch(`/api/issues/${issueId}`)
      .send({
        decision: "approve",
        comment: `Cycle 1 approved.\n\nReviewed-SHA: ${REVIEWED_SHA}`,
      });
    expect(approve1Res.status, JSON.stringify(approve1Res.body)).toBe(200);
    expect(approve1Res.body.executionState).toMatchObject({
      status: "completed",
      completedStageIds: [stageId],
      cycleDecisionIds: [approve1Res.body.executionState.lastDecisionId],
    });
    const cycle1DecisionId = approve1Res.body.executionState.lastDecisionId as string;

    const implRun1 = await seedRun(seeded.companyId, seeded.implementerAgentId, issueId);
    const close1Res = await request(app(agentActor(seeded.companyId, seeded.implementerAgentId, implRun1)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Cycle 1 delivered." });
    expect(close1Res.status, JSON.stringify(close1Res.body)).toBe(200);
    expect(close1Res.body.status).toBe("done");

    // Reopen the closed issue via board PATCH -> clears executionState while retaining policy & Cycle 1 decision row.
    const reopenRes = await request(app(boardActor))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo" });
    expect(reopenRes.status, JSON.stringify(reopenRes.body)).toBe(200);
    expect(reopenRes.body.status).toBe("todo");
    expect(reopenRes.body.executionState).toBeNull();

    const decisionsAfterReopen = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisionsAfterReopen).toHaveLength(1);
    expect(decisionsAfterReopen[0]?.id).toBe(cycle1DecisionId);

    // Agent bypass attempts after reopen must ALL fail against Cycle 1's historical approval.
    const implRun2 = await seedRun(seeded.companyId, seeded.implementerAgentId, issueId);

    const stripOnlyRes = await request(app(agentActor(seeded.companyId, seeded.implementerAgentId, implRun2)))
      .patch(`/api/issues/${issueId}`)
      .send({ executionPolicy: null });
    expect(stripOnlyRes.status, JSON.stringify(stripOnlyRes.body)).toBe(422);
    expect(stripOnlyRes.body.details).toMatchObject({ code: "execution_policy_stages_protected" });

    const stripAndDoneRes = await request(app(agentActor(seeded.companyId, seeded.implementerAgentId, implRun2)))
      .patch(`/api/issues/${issueId}`)
      .send({ executionPolicy: null, status: "done" });
    expect(stripAndDoneRes.status, JSON.stringify(stripAndDoneRes.body)).toBe(422);
    expect(stripAndDoneRes.body.details).toMatchObject({ code: "execution_policy_stages_protected" });

    // Even if the agent moves to done directly, the issue routes into a fresh pending review stage (never closes).
    const submitCycle2Res = await request(app(agentActor(seeded.companyId, seeded.implementerAgentId, implRun2)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Cycle 2 fix ready for review." });
    expect(submitCycle2Res.status, JSON.stringify(submitCycle2Res.body)).toBe(200);
    expect(submitCycle2Res.body.status).toBe("in_review");
    expect(submitCycle2Res.body.assigneeAgentId).toBe(seeded.reviewerAgentId);
    expect(submitCycle2Res.body.executionState).toMatchObject({
      status: "pending",
      currentStageId: stageId,
      completedStageIds: [],
      cycleDecisionIds: [],
      completionRequested: true,
    });

    // While pending in Cycle 2, agent still cannot strip executionPolicy.
    const stripWhilePendingRes = await request(app(agentActor(seeded.companyId, seeded.implementerAgentId, implRun2)))
      .patch(`/api/issues/${issueId}`)
      .send({ executionPolicy: null, status: "done" });
    expect(stripWhilePendingRes.status, JSON.stringify(stripWhilePendingRes.body)).toBe(422);

    // Cycle 2: Reviewer submits a fresh structured approval -> closes issue and records a 2nd approved row.
    const reviewerRun2 = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);
    const approve2Res = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, reviewerRun2)))
      .patch(`/api/issues/${issueId}`)
      .send({
        decision: "approve",
        comment: `Cycle 2 approved.\n\nReviewed-SHA: ${REVIEWED_SHA}`,
      });
    expect(approve2Res.status, JSON.stringify(approve2Res.body)).toBe(200);
    expect(approve2Res.body.status).toBe("done");
    expect(approve2Res.body.executionState).toMatchObject({
      status: "completed",
      completedStageIds: [stageId],
      lastDecisionOutcome: "approved",
    });
    const cycle2DecisionId = approve2Res.body.executionState.lastDecisionId as string;
    expect(cycle2DecisionId).not.toBe(cycle1DecisionId);
    expect(approve2Res.body.executionState.cycleDecisionIds).toEqual([cycle2DecisionId]);

    const decisionsAfterCycle2 = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisionsAfterCycle2).toHaveLength(2);

    // Reopening via human comment also resets executionState so Cycle 3 cannot reuse Cycle 2's approval.
    const commentReopenRes = await request(app(boardActor))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Found one more issue — reopening.", reopen: true });
    expect(commentReopenRes.status, JSON.stringify(commentReopenRes.body)).toBe(201);

    const [afterCommentReopen] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(afterCommentReopen?.status).toBe("todo");
    expect(afterCommentReopen?.executionState).toBeNull();

    const implRun3 = await seedRun(seeded.companyId, seeded.implementerAgentId, issueId);
    const cycle3BypassRes = await request(app(agentActor(seeded.companyId, seeded.implementerAgentId, implRun3)))
      .patch(`/api/issues/${issueId}`)
      .send({ executionPolicy: null, status: "done" });
    expect(cycle3BypassRes.status, JSON.stringify(cycle3BypassRes.body)).toBe(422);
    expect(cycle3BypassRes.body.details).toMatchObject({ code: "execution_policy_stages_protected" });
  });

  it("requires 2 fresh approvals for approvalsNeeded: 2 after reopen without mixing prior-cycle approvals", async () => {
    const seeded = await seedCompany("XDM2");
    const { issueId, stageId } = await seedPendingReview({ ...seeded, identifier: "XDM2-1" });
    const multiApprovalPolicy = {
      mode: "normal" as const,
      commentRequired: true,
      stages: [{
        id: stageId,
        type: "review" as const,
        approvalsNeeded: 2 as unknown as 1,
        participants: [{ id: randomUUID(), type: "agent" as const, agentId: seeded.reviewerAgentId, userId: null }],
      }],
    };

    // Seed 2 historical Cycle 1 approvals in Postgres.
    const cycle1Ids = [randomUUID(), randomUUID()];
    await db.insert(issueExecutionDecisions).values(
      cycle1Ids.map((id, idx) => ({
        id,
        companyId: seeded.companyId,
        issueId,
        stageId,
        stageType: "review",
        actorAgentId: seeded.reviewerAgentId,
        outcome: "approved",
        body: `Cycle 1 approval #${idx + 1}\n\nReviewed-SHA: ${REVIEWED_SHA}`,
        createdAt: new Date(`2026-11-25T0${idx + 1}:00:00.000Z`),
      })),
    );

    const freshCycle2State = {
      status: "pending" as const,
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review" as const,
      currentParticipant: { type: "agent" as const, agentId: seeded.reviewerAgentId, userId: null },
      returnAssignee: { type: "agent" as const, agentId: seeded.implementerAgentId, userId: null },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      cycleDecisionIds: [],
    };

    // Reopened issue with null executionState -> 0 approvals recorded.
    await expect(
      assertAgentExecutionPolicyStagesSatisfied(db, {
        companyId: seeded.companyId,
        issueId,
        policy: multiApprovalPolicy,
        executionState: null,
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "unsatisfied_execution_policy_stages",
        unsatisfiedStages: [expect.objectContaining({ stageId, approvalsNeeded: 2, approvalsRecorded: 0 })],
      },
    });

    // 1 fresh pending approval in Cycle 2 does NOT mix with Cycle 1's 2 historical approvals -> 1 < 2 -> 422.
    await expect(
      assertAgentExecutionPolicyStagesSatisfied(db, {
        companyId: seeded.companyId,
        issueId,
        policy: multiApprovalPolicy,
        executionState: freshCycle2State,
        pendingDecision: { stageId, stageType: "review", outcome: "approved" },
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "unsatisfied_execution_policy_stages",
        unsatisfiedStages: [expect.objectContaining({ stageId, approvalsNeeded: 2, approvalsRecorded: 1 })],
      },
    });

    // Persist 1st fresh Cycle 2 approval -> still 1 < 2 without a 2nd Cycle 2 approval.
    const cycle2Id1 = randomUUID();
    await db.insert(issueExecutionDecisions).values({
      id: cycle2Id1,
      companyId: seeded.companyId,
      issueId,
      stageId,
      stageType: "review",
      actorAgentId: seeded.reviewerAgentId,
      outcome: "approved",
      body: `Cycle 2 approval #1\n\nReviewed-SHA: ${REVIEWED_SHA}`,
      createdAt: new Date("2026-11-26T01:00:00.000Z"),
    });
    const oneCycle2ApprovalState = {
      ...freshCycle2State,
      cycleDecisionIds: [cycle2Id1],
    };

    await expect(
      assertAgentExecutionPolicyStagesSatisfied(db, {
        companyId: seeded.companyId,
        issueId,
        policy: multiApprovalPolicy,
        executionState: oneCycle2ApprovalState,
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        code: "unsatisfied_execution_policy_stages",
        unsatisfiedStages: [expect.objectContaining({ stageId, approvalsNeeded: 2, approvalsRecorded: 1 })],
      },
    });

    // 2nd fresh Cycle 2 approval (pending) satisfies approvalsNeeded: 2 -> resolves!
    await expect(
      assertAgentExecutionPolicyStagesSatisfied(db, {
        companyId: seeded.companyId,
        issueId,
        policy: multiApprovalPolicy,
        executionState: oneCycle2ApprovalState,
        pendingDecision: { stageId, stageType: "review", outcome: "approved" },
      }),
    ).resolves.toBeUndefined();
  });

  it("upgrades a legacy two-stage executionState across stage-2 changes_requested -> resubmit -> approve without replaying stage 1", async () => {
    const seeded = await seedCompany("XDL2");
    const approverAgentId = randomUUID();
    await db.insert(agents).values({
      id: approverAgentId,
      companyId: seeded.companyId,
      name: "XDL2 Approver",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const issueId = randomUUID();
    const reviewStageId = randomUUID();
    const approvalStageId = randomUUID();
    const priorCycleApprovalId = randomUUID();
    const reviewDecisionId = randomUUID();

    // Seed a legacy pre-deploy two-stage issue where review is already completed
    // and approval is pending, with NO `cycleDecisionIds` persisted yet.
    await db.insert(issues).values({
      id: issueId,
      companyId: seeded.companyId,
      identifier: "XDL2-1",
      title: "Legacy two-stage review then approval",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: approverAgentId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: reviewStageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: seeded.reviewerAgentId }],
          },
          {
            id: approvalStageId,
            type: "approval",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: approverAgentId }],
          },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: approvalStageId,
        currentStageIndex: 1,
        currentStageType: "approval",
        currentParticipant: { type: "agent", agentId: approverAgentId },
        returnAssignee: { type: "agent", agentId: seeded.implementerAgentId },
        completedStageIds: [reviewStageId],
        lastDecisionId: reviewDecisionId,
        lastDecisionOutcome: "approved",
        completionRequested: true,
      },
    });

    // Seed both a historical prior-cycle approval on stage 2 (must NOT leak into
    // this cycle) and the current-cycle approval on stage 1 (MUST be preserved).
    await db.insert(issueExecutionDecisions).values([
      {
        id: priorCycleApprovalId,
        companyId: seeded.companyId,
        issueId,
        stageId: approvalStageId,
        stageType: "approval",
        actorAgentId: approverAgentId,
        outcome: "approved",
        body: `Prior cycle approval.\n\nReviewed-SHA: ${REVIEWED_SHA}`,
        createdAt: new Date("2026-11-24T01:00:00.000Z"),
      },
      {
        id: reviewDecisionId,
        companyId: seeded.companyId,
        issueId,
        stageId: reviewStageId,
        stageType: "review",
        actorAgentId: seeded.reviewerAgentId,
        outcome: "approved",
        body: `Stage 1 review approved.\n\nReviewed-SHA: ${REVIEWED_SHA}`,
        createdAt: new Date("2026-11-25T01:00:00.000Z"),
      },
    ]);

    // 1. Approver requests changes at stage 2 (approval).
    const approverRun1 = await seedRun(seeded.companyId, approverAgentId, issueId);
    const changesRes = await request(app(agentActor(seeded.companyId, approverAgentId, approverRun1)))
      .patch(`/api/issues/${issueId}`)
      .send({
        decision: "request_changes",
        comment: "Please update release notes before final approval.",
      });
    expect(changesRes.status, JSON.stringify(changesRes.body)).toBe(200);
    expect(changesRes.body.status).toBe("in_progress");
    expect(changesRes.body.assigneeAgentId).toBe(seeded.implementerAgentId);
    const changesDecisionId = changesRes.body.executionState.lastDecisionId as string;
    expect(changesDecisionId).toBeTruthy();
    expect(changesRes.body.executionState).toMatchObject({
      status: "changes_requested",
      currentStageId: approvalStageId,
      completedStageIds: [reviewStageId],
      lastDecisionOutcome: "changes_requested",
      cycleDecisionIds: [reviewDecisionId, changesDecisionId],
    });
    expect(changesRes.body.executionState.cycleDecisionIds).not.toContain(priorCycleApprovalId);

    // 2. Implementer fixes and resubmits -> routes directly back to stage 2 (does NOT replay stage 1).
    const implRun1 = await seedRun(seeded.companyId, seeded.implementerAgentId, issueId);
    const resubmitRes = await request(app(agentActor(seeded.companyId, seeded.implementerAgentId, implRun1)))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "done",
        comment: "Updated release notes; ready for final approval.",
      });
    expect(resubmitRes.status, JSON.stringify(resubmitRes.body)).toBe(200);
    expect(resubmitRes.body.status).toBe("in_review");
    expect(resubmitRes.body.assigneeAgentId).toBe(approverAgentId);
    expect(resubmitRes.body.executionState).toMatchObject({
      status: "pending",
      currentStageId: approvalStageId,
      currentStageType: "approval",
      completedStageIds: [reviewStageId],
      completionRequested: true,
      cycleDecisionIds: [reviewDecisionId, changesDecisionId],
    });

    // 3. Implementer still cannot strip the policy while stage 2 is unsatisfied
    // (the historical prior-cycle approval on stage 2 must not satisfy it).
    const stripRes = await request(app(agentActor(seeded.companyId, seeded.implementerAgentId, implRun1)))
      .patch(`/api/issues/${issueId}`)
      .send({ executionPolicy: null, status: "done" });
    expect(stripRes.status, JSON.stringify(stripRes.body)).toBe(422);
    expect(stripRes.body.details).toMatchObject({ code: "execution_policy_stages_protected" });

    // 4. Approver approves stage 2 -> issue completes directly to `done` without replaying stage 1!
    const approverRun2 = await seedRun(seeded.companyId, approverAgentId, issueId);
    const approveRes = await request(app(agentActor(seeded.companyId, approverAgentId, approverRun2)))
      .patch(`/api/issues/${issueId}`)
      .send({
        decision: "approve",
        comment: `Release notes look good.\n\nReviewed-SHA: ${REVIEWED_SHA}`,
      });
    expect(approveRes.status, JSON.stringify(approveRes.body)).toBe(200);
    expect(approveRes.body.status).toBe("done");
    const finalApprovalDecisionId = approveRes.body.executionState.lastDecisionId as string;
    expect(approveRes.body.executionState).toMatchObject({
      status: "completed",
      completedStageIds: [reviewStageId, approvalStageId],
      lastDecisionOutcome: "approved",
      cycleDecisionIds: [reviewDecisionId, changesDecisionId, finalApprovalDecisionId],
    });

    const [persistedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(persistedIssue?.status).toBe("done");
    const allDecisions = await db
      .select()
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(allDecisions.filter((row) => row.stageId === reviewStageId)).toHaveLength(1);
    expect(allDecisions.filter((row) => row.stageId === approvalStageId)).toHaveLength(3);

    // 5. Reopening after completion still resets executionState and isolates the new cycle.
    const boardActor = {
      type: "board",
      userId: "board-user",
      companyIds: [seeded.companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    const reopenRes = await request(app(boardActor))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo" });
    expect(reopenRes.status, JSON.stringify(reopenRes.body)).toBe(200);
    expect(reopenRes.body.executionState).toBeNull();

    const implRun2 = await seedRun(seeded.companyId, seeded.implementerAgentId, issueId);
    const postReopenStripRes = await request(app(agentActor(seeded.companyId, seeded.implementerAgentId, implRun2)))
      .patch(`/api/issues/${issueId}`)
      .send({ executionPolicy: null, status: "done" });
    expect(postReopenStripRes.status, JSON.stringify(postReopenStripRes.body)).toBe(422);
    expect(postReopenStripRes.body.details).toMatchObject({ code: "execution_policy_stages_protected" });
  });
});
