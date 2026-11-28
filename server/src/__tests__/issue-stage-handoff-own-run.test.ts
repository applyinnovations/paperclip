import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { deliverReconciledExecutions } from "../services/execution-recovery-resolution.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stage handoff tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// APP-760: an executor's own run handing its issue to the review stage was
// cancelled mid-request, and the reviewer's stage wake was then stranded.
describeEmbeddedPostgres("agent stage handoff from its own run", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stage-handoff-own-run-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.delete(issueRecoveryActions);
    await db.delete(environmentLeases);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(prefix: string) {
    const companyId = randomUUID();
    const executorAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const executorRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([executorAgentId, reviewerAgentId].map((id, index) => ({
      id,
      companyId,
      name: `${prefix} ${index === 0 ? "Engineer" : "Reviewer"}`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${prefix}-1`,
      title: "Build the change",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: executorAgentId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: reviewerAgentId }],
        }],
      },
    });
    await db.insert(heartbeatRuns).values({
      id: executorRunId,
      companyId,
      agentId: executorAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      runtimeMode: "legacy",
      startedAt: new Date(),
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
    await db.update(issues).set({
      executionRunId: executorRunId,
      executionAgentNameKey: `${prefix.toLowerCase()} engineer`,
      executionLockedAt: new Date(),
      checkoutRunId: executorRunId,
    }).where(eq(issues.id, issueId));
    return { companyId, executorAgentId, reviewerAgentId, issueId, stageId, executorRunId };
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

  const ownRunActor = (s: Awaited<ReturnType<typeof seed>>) => ({
    type: "agent", source: "agent_jwt", companyId: s.companyId, agentId: s.executorAgentId, runId: s.executorRunId,
  });

  const runStatus = async (runId: string) =>
    (await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status;

  const reviewerWakes = (s: Awaited<ReturnType<typeof seed>>) =>
    db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, s.companyId),
      eq(agentWakeupRequests.agentId, s.reviewerAgentId),
    ));

  const reviewerRuns = (s: Awaited<ReturnType<typeof seed>>) =>
    db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, s.companyId),
      eq(heartbeatRuns.agentId, s.reviewerAgentId),
    ));

  async function submitForReview(s: Awaited<ReturnType<typeof seed>>) {
    const res = await request(app(ownRunActor(s)))
      .patch(`/api/issues/${s.issueId}`)
      .send({ status: "done", comment: "PR is open and green; ready for review." });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("in_review");
    expect(res.body.assigneeAgentId).toBe(s.reviewerAgentId);
    return res;
  }

  it.each([
    ["a legacy run", false],
    ["a sandboxed legacy run", true],
  ])("does not cancel %s that submits its own work, and wakes the reviewer exactly once", async (_label, sandboxed) => {
    const s = await seed(sandboxed ? "SHS" : "SHL");
    if (sandboxed) {
      await db.insert(environmentLeases).values({
        companyId: s.companyId,
        issueId: s.issueId,
        heartbeatRunId: s.executorRunId,
        status: "active",
        provider: "kubernetes",
        providerLeaseId: `sandbox-${s.executorRunId}`,
      });
    }

    await submitForReview(s);

    expect(await runStatus(s.executorRunId)).toBe("running");
    await vi.waitFor(async () => {
      const wakes = await reviewerWakes(s);
      expect(wakes.map(wake => [
        wake.status,
        (wake.payload?._paperclipWakeContext as Record<string, unknown> | undefined)?.wakeReason,
      ])).toEqual([["deferred_issue_execution", "execution_review_requested"]]);
    });
    expect(await reviewerRuns(s)).toHaveLength(0);
    // No reconciliation hold is created by the handoff itself.
    expect(await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, s.issueId))).toHaveLength(0);

    // The outgoing run can still comment but can no longer change the issue.
    const lateEdit = await request(app(ownRunActor(s)))
      .patch(`/api/issues/${s.issueId}`)
      .send({ title: "Late edit from the outgoing run" });
    expect(lateEdit.status, JSON.stringify(lateEdit.body)).toBe(403);
    expect(lateEdit.body.details).toMatchObject({ code: "issue_handed_off" });
    expect((await db.select({ title: issues.title }).from(issues).where(eq(issues.id, s.issueId)))[0]?.title)
      .toBe("Build the change");

    // The handing-off run exits; its release promotes the reviewer's wake.
    await heartbeatService(db).cancelRun(s.executorRunId, "Run exited after handoff");
    await vi.waitFor(async () => {
      const runs = await reviewerRuns(s);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.contextSnapshot).toMatchObject({ issueId: s.issueId, wakeReason: "execution_review_requested" });
    });
    const wakes = await reviewerWakes(s);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.status).not.toBe("deferred_issue_execution");
  });

  it("promotes a stage wake that was deferred behind a run cancelled after doing provider work", async () => {
    const s = await seed("SHP");
    // Provider work started, so the stopped run needs reconciliation of its own actions.
    await db.update(heartbeatRuns).set({ processStartedAt: new Date(), processPid: 4242 })
      .where(eq(heartbeatRuns.id, s.executorRunId));
    // Ownership moved to the reviewer while the executor's run still held the issue.
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: s.reviewerAgentId,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      checkoutRunId: null,
      executionState: {
        status: "pending",
        currentStageId: s.stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: s.reviewerAgentId },
        returnAssignee: { type: "agent", agentId: s.executorAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, s.issueId));
    const heartbeat = heartbeatService(db);
    const deferred = await heartbeat.wakeup(s.reviewerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "execution_review_requested",
      payload: { issueId: s.issueId, mutation: "update" },
      requestedByActorType: "agent",
      requestedByActorId: s.executorAgentId,
      contextSnapshot: { issueId: s.issueId, taskId: s.issueId, wakeReason: "execution_review_requested", source: "issue.execution_stage" },
    });
    expect(deferred).toBeNull();
    expect((await reviewerWakes(s)).map(wake => wake.status)).toEqual(["deferred_issue_execution"]);

    await heartbeat.cancelRun(s.executorRunId, "Stopped mid-flight");

    await vi.waitFor(async () => {
      expect(await reviewerRuns(s)).toHaveLength(1);
    });
    expect((await reviewerWakes(s)).filter(wake => wake.status === "deferred_issue_execution")).toHaveLength(0);
  });

  it("delivers the stage wake to the review participant when the previous owner's hold is reconciled", async () => {
    const s = await seed("SHR");
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "issue_reassigned" })
      .where(eq(heartbeatRuns.id, s.executorRunId));
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: s.reviewerAgentId,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      checkoutRunId: null,
      executionState: {
        status: "pending",
        currentStageId: s.stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: s.reviewerAgentId },
        returnAssignee: { type: "agent", agentId: s.executorAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, s.issueId));
    // The hold was raised for the executor's stopped run and reconciled after the handoff.
    const [hold] = await db.insert(issueRecoveryActions).values({
      companyId: s.companyId,
      sourceIssueId: s.issueId,
      kind: "active_run_watchdog",
      ownerType: "board",
      returnOwnerAgentId: s.executorAgentId,
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${s.executorRunId}`,
      status: "resolved",
      resolvedAt: new Date(),
      nextAction: "Reconcile the stopped run",
      evidence: {
        runId: s.executorRunId,
        executionReconciliation: { runId: s.executorRunId, outcome: "verified" },
        continuationDelivery: "pending",
      },
    }).returning();

    await deliverReconciledExecutions(db, heartbeatService(db).wakeup);

    await vi.waitFor(async () => {
      const runs = await reviewerRuns(s);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.contextSnapshot).toMatchObject({ issueId: s.issueId, wakeReason: "execution_review_requested" });
    });
    const [delivered] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold!.id));
    expect(delivered!.evidence).toMatchObject({ continuationDelivery: "delivered" });
    // The executor's stopped run is not replayed.
    expect(await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.agentId, s.executorAgentId), eq(heartbeatRuns.companyId, s.companyId),
    ))).toHaveLength(1);
  });

  // The handoff saved the reviewer's stage wake behind the executor's live
  // run. That run was then stopped mid-flight and left a hold, which the
  // operator has reconciled; nothing has promoted the saved wake yet.
  async function holdStageWakeBehindReconciliation(prefix: string) {
    const s = await seed(prefix);
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: s.reviewerAgentId,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      checkoutRunId: null,
      executionState: {
        status: "pending",
        currentStageId: s.stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: s.reviewerAgentId },
        returnAssignee: { type: "agent", agentId: s.executorAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, s.issueId));
    const heartbeat = heartbeatService(db);
    const deferred = await heartbeat.wakeup(s.reviewerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "execution_review_requested",
      payload: { issueId: s.issueId, mutation: "update" },
      requestedByActorType: "agent",
      requestedByActorId: s.executorAgentId,
      contextSnapshot: { issueId: s.issueId, taskId: s.issueId, wakeReason: "execution_review_requested", source: "issue.execution_stage" },
    });
    expect(deferred).toBeNull();
    const saved = await reviewerWakes(s);
    expect(saved.map(wake => wake.status)).toEqual(["deferred_issue_execution"]);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "issue_reassigned" })
      .where(eq(heartbeatRuns.id, s.executorRunId));
    const [hold] = await db.insert(issueRecoveryActions).values({
      companyId: s.companyId,
      sourceIssueId: s.issueId,
      kind: "active_run_watchdog",
      ownerType: "board",
      returnOwnerAgentId: s.executorAgentId,
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${s.executorRunId}`,
      status: "resolved",
      resolvedAt: new Date(),
      nextAction: "Reconcile the stopped run",
      evidence: {
        runId: s.executorRunId,
        executionReconciliation: { runId: s.executorRunId, outcome: "verified" },
        continuationDelivery: "pending",
      },
    }).returning();
    return { s, heartbeat, holdId: hold!.id, savedWakeId: saved[0]!.id };
  }

  // A wake saved behind a live run keeps its stage reason in the saved context.
  const isStageReviewWake = (wake: typeof agentWakeupRequests.$inferSelect) =>
    wake.reason === "execution_review_requested" ||
    (wake.payload?._paperclipWakeContext as Record<string, unknown> | undefined)?.wakeReason === "execution_review_requested";

  const holdEvidence = async (holdId: string) =>
    (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, holdId)))[0]!.evidence;

  it("delivers the saved stage wake itself when the hold is reconciled, so the reviewer runs once", async () => {
    const { s, heartbeat, holdId, savedWakeId } = await holdStageWakeBehindReconciliation("SHD");

    await deliverReconciledExecutions(db, heartbeat.wakeup, heartbeat.releaseIssueExecutionAndPromote);

    const [run] = await reviewerRuns(s);
    expect(run).toBeDefined();
    expect(run!.wakeupRequestId).toBe(savedWakeId);
    expect(await holdEvidence(holdId)).toMatchObject({ continuationDelivery: "delivered", continuationRunId: run!.id });
    // The reviewer's run releases without a decision; nothing is left to promote.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await heartbeat.releaseIssueExecutionAndPromote(run!, { suppressImmediateRecovery: true, resumeStrandedQueue: true });
    await deliverReconciledExecutions(db, heartbeat.wakeup, heartbeat.releaseIssueExecutionAndPromote);
    const wakes = await reviewerWakes(s);
    expect(wakes.filter(wake => wake.status === "deferred_issue_execution")).toHaveLength(0);
    expect(wakes.filter(isStageReviewWake)).toHaveLength(1);
    expect((await reviewerRuns(s)).filter(r => !r.retryOfRunId)).toHaveLength(1);
  });

  it("adopts the admitted stage run on retry after a failure before delivery was recorded", async () => {
    const { s, heartbeat, holdId, savedWakeId } = await holdStageWakeBehindReconciliation("SHF");
    const crashAfterAdmission: typeof heartbeat.releaseIssueExecutionAndPromote = async (...args) => {
      await heartbeat.releaseIssueExecutionAndPromote(...args);
      throw new Error("process exited after admission");
    };

    await deliverReconciledExecutions(db, heartbeat.wakeup, crashAfterAdmission);
    const [run] = await reviewerRuns(s);
    expect(run!.wakeupRequestId).toBe(savedWakeId);
    expect(await holdEvidence(holdId)).toMatchObject({ continuationDelivery: "pending" });

    // The admitted run finishes before the retry.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.id, run!.id), sql`${heartbeatRuns.finishedAt} is null`));

    await deliverReconciledExecutions(db, heartbeat.wakeup, heartbeat.releaseIssueExecutionAndPromote);
    expect(await holdEvidence(holdId)).toMatchObject({ continuationDelivery: "delivered", continuationRunId: run!.id });
    expect((await reviewerWakes(s)).filter(isStageReviewWake)).toHaveLength(1);
    expect((await reviewerRuns(s)).filter(r => !r.retryOfRunId)).toHaveLength(1);
  });

  it("still cancels an agent's active run when the board reassigns the issue away", async () => {
    const s = await seed("SHB");
    const res = await request(app({ type: "board", source: "local_implicit", userId: "board-user", isInstanceAdmin: true }))
      .patch(`/api/issues/${s.issueId}`)
      .send({ assigneeAgentId: s.reviewerAgentId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.executorRunId));
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
  });
});
