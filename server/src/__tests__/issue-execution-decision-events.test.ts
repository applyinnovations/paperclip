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
});
