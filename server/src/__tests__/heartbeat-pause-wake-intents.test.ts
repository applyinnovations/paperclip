import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments,
  issues } from "@paperclipai/db";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping pause wake intent tests: ${recoveryPostgresSupport.reason}`);

/**
 * APP-744: a wake that arrives while its agent is paused (an assignment, a
 * comment, a resolved blocker, from a person or the system) is saved as one
 * intent per task and delivered once when the agent resumes. A run the pause
 * stopped continues once. A task reassigned or closed during the pause gets
 * no run.
 */
describePostgres("wakes refused during an agent pause", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let driver: ReturnType<typeof createLifecycleDriver>;
  const adapterType = "codex_local";
  const dispatched: Array<{ runId: string; agentId: string; context: Record<string, unknown> }> = [];
  const oldHome = process.env.PAPERCLIP_HOME;
  let home: string;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("heartbeat-pause-wake-");
    db = createDb(temporary.connectionString);
    home = await mkdtemp(path.join(tmpdir(), "paperclip-pause-wake-"));
    process.env.PAPERCLIP_HOME = home;
    heartbeat = heartbeatService(db);
    driver = createLifecycleDriver(db, {} as never);
    registerServerAdapter({
      type: adapterType, supportsLocalAgentJwt: false,
      execute: async input => {
        dispatched.push({ runId: input.runId, agentId: input.agent.id, context: input.context as Record<string, unknown> });
        // The agent finishes the task, so no disposition repair follows.
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(input.context.issueId)));
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 240_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  /** A company with a paused assignee, another agent, and a task the assignee
   * already finished once (an earlier succeeded run). */
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), issueId = randomUUID();
    const userId = `board-user-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Pause wake fixture", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Paused agent", adapterType, status: "idle", adapterConfig: {} },
      { id: otherAgentId, companyId, name: "Other agent", adapterType, status: "idle", adapterConfig: {} },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Task", status: "todo",
      assigneeAgentId: null, responsibleUserId: userId, issueNumber: 1 });
    const [earlier] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "assignment",
      triggerDetail: "system", status: "succeeded", startedAt: new Date(Date.now() - 120_000), finishedAt: new Date(Date.now() - 60_000),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" } }).returning();
    return { companyId, agentId, otherAgentId, issueId, userId, earlierRunId: earlier.id };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  const pause = (f: Fixture) => db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
  /** Resume the agent the way the lifecycle does: the agent becomes ready,
   * then its ready hook promotes saved intents. Then let every worker run. */
  async function resume(f: Fixture) {
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    await driver.onReady!(agent as never);
    for (let pass = 0; pass < 3; pass += 1) {
      await heartbeat.resumeQueuedRuns();
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
      await heartbeat.drainActiveRunExecutions();
    }
  }
  const assign = (f: Fixture, agentId: string) => db.update(issues).set({ assigneeAgentId: agentId, status: "todo" })
    .where(eq(issues.id, f.issueId)).returning().then(rows => rows[0]!);
  const boardAssigns = async (f: Fixture, agentId: string) => {
    const issue = await assign(f, agentId);
    await queueIssueAssignmentWakeup({ heartbeat, issue, reason: "issue_assigned", mutation: "update",
      contextSource: "issue.update", requestedByActorType: "user", requestedByActorId: f.userId });
  };
  const newRuns = (f: Fixture, agentId = f.agentId) => (db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, agentId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`, sql`${heartbeatRuns.id} <> ${f.earlierRunId}`)))
    // A run that never started (the harness's missing-comment follow-up of a
    // finished task) is not a delivery.
    .then(runs => runs.filter(run => run.startedAt || run.status === "queued"));
  const savedIntents = (f: Fixture) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${f.issueId}`));

  it("(a) delivers a board assignment made during the pause once, on a task with an earlier succeeded run", async () => {
    const f = await seed();
    await pause(f);
    await boardAssigns(f, f.agentId);
    // The refusal is saved, never a terminal skip.
    const saved = await savedIntents(f);
    expect(saved).toEqual([expect.objectContaining({ agentId: f.agentId, requestedByActorType: "user",
      payload: expect.objectContaining({ executionWait: expect.objectContaining({
        reason: "agent.not_invokable", trigger: "pause_lifted", pauseWakeIntent: true }) }) })]);
    // While the pause holds, workers never start it.
    await heartbeat.resumeQueuedRuns();
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId });
    expect(await newRuns(f)).toHaveLength(0);

    await resume(f);
    const runs = await newRuns(f);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("succeeded");
    expect(await savedIntents(f)).toEqual([]);
    // A repeated resume (or reconciler pass) never delivers it again.
    await resume(f);
    expect(await newRuns(f)).toHaveLength(1);
  }, 180_000);

  it("(b) merges two comments and a resolved blocker into one run that carries both comments", async () => {
    const f = await seed();
    await assign(f, f.agentId);
    await pause(f);
    const comments = [];
    for (const body of ["First note during the pause.", "Second note during the pause."]) {
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorUserId: f.userId, body }).returning();
      comments.push(comment!);
      await expect(heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
        payload: { issueId: f.issueId, commentId: comment!.id, mutation: "comment" },
        contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId: comment!.id, wakeCommentId: comment!.id,
          source: "issue.comment", wakeReason: "issue_commented" },
        requestedByActorType: "user", requestedByActorId: f.userId })).rejects.toMatchObject({ status: 409 });
    }
    await expect(heartbeat.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved",
      payload: { issueId: f.issueId, mutation: "blockers_resolved", resolvedBlockerIssueId: randomUUID() },
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_blockers_resolved", source: "issue.blockers_resolved" },
      requestedByActorType: "system" })).rejects.toMatchObject({ status: 409 });
    const saved = await savedIntents(f);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.coalescedCount).toBe(2);

    await resume(f);
    const runs = await newRuns(f);
    expect(runs).toHaveLength(1);
    const delivered = dispatched.filter(turn => turn.runId === runs[0]!.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.context.wakeCommentIds).toEqual(comments.map(comment => comment.id));
  }, 180_000);

  it("(c) starts no run for the paused agent when the task was reassigned during the pause", async () => {
    const f = await seed();
    await pause(f);
    await boardAssigns(f, f.agentId);
    expect(await savedIntents(f)).toHaveLength(1);
    await assign(f, f.otherAgentId);
    await resume(f);
    expect(await newRuns(f)).toHaveLength(0);
    // The intent ended; it does not wait for the task to come back.
    expect(await savedIntents(f)).toEqual([]);
  }, 180_000);

  it("(c') starts no run when the task was cancelled during the pause", async () => {
    const f = await seed();
    await pause(f);
    await boardAssigns(f, f.agentId);
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    await resume(f);
    expect(await newRuns(f)).toHaveLength(0);
    expect(await savedIntents(f)).toEqual([]);
  }, 180_000);

  it("(d) continues a run the manual pause stopped, once, on resume", async () => {
    const f = await seed();
    await assign(f, f.agentId);
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    // The run in flight when the board pauses the agent.
    const [inFlight] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      invocationSource: "assignment", triggerDetail: "system", status: "queued",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_assigned" } }).returning();
    await pause(f);
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const pausing = { ...agent, lifecycleState: "pausing", lifecycleHolds: ["user"],
      lifecycleOperation: { id: randomUUID(), pauseCause: { holds: ["user"], companyPauseReason: null } } };
    expect(await driver.runHost(pausing as never)).toBe("complete");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, inFlight!.id)))[0]!.status).toBe("cancelled");
    expect(await savedIntents(f)).toHaveLength(1);

    await resume(f);
    const continued = (await newRuns(f)).filter(run => run.id !== inFlight!.id);
    expect(continued).toHaveLength(1);
    expect(continued[0]!.status).toBe("succeeded");
    await resume(f);
    expect((await newRuns(f)).filter(run => run.id !== inFlight!.id)).toHaveLength(1);
  }, 180_000);

  it("leaves a budget pause's stopped runs to the budget resume", async () => {
    const f = await seed();
    await assign(f, f.agentId);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      invocationSource: "assignment", triggerDetail: "system", status: "queued",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_assigned" } });
    await pause(f);
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const pausing = { ...agent, lifecycleState: "pausing", lifecycleHolds: ["budget"],
      lifecycleOperation: { id: randomUUID(), pauseCause: { holds: ["budget"], companyPauseReason: null } } };
    expect(await driver.runHost(pausing as never)).toBe("complete");
    expect(await savedIntents(f)).toEqual([]);
  }, 180_000);
});
