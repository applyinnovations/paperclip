import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueRelations, issues, type Db,
} from "@paperclipai/db";
import { ISSUE_TERMINAL_BLOCKER_STRANDED_WAKE_REASON } from "@paperclipai/shared";
import { attentionService } from "../services/attention.js";
import { loadTerminalBlockerAutoWakeStates, terminalBlockerAutoWakeKey } from "../services/attention-source-eligibility.js";
import { decisionRetentionService } from "../services/decision-retention.js";
import { recoveryService } from "../services/recovery/service.js";
import { wakeStrandedTerminalBlocker } from "../services/recovery/terminal-blocker-auto-wake.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_RECOVERY_ACTION_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const MINUTE = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE);

// APP-761: overnight 2026-11-27/28 the board got 17 blocker_attention cards for
// terminal blockers that sat in_review/todo on an idle, unpaused agent. Each
// owner only needed a wake; Paperclip now sends it before asking the board.
(support.supported ? describe : describe.skip)("issue_terminal_blocker_stranded auto-wake", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("terminal-blocker-auto-wake-");
    db = createDb(external ?? temporary!.connectionString);
    db.$client.options.onnotice = () => {};
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  /** Records each wake the way the queue does, so later passes see it. */
  function wakeRecorder(companyId: string) {
    const calls: Array<{ agentId: string; input: Record<string, any> }> = [];
    const enqueueWakeup = vi.fn(async (agentId: string, input: Record<string, any>) => {
      calls.push({ agentId, input });
      const [row] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: input.source,
        triggerDetail: input.triggerDetail, reason: input.reason, payload: input.payload,
        idempotencyKey: input.idempotencyKey, status: "queued" }).returning();
      return { id: row.id };
    });
    return { calls, enqueueWakeup };
  }

  async function fixture(options: {
    terminalStatus?: "todo" | "in_review"; reviewerStatus?: string; assigned?: boolean; quietMinutes?: number; dependents?: number;
  } = {}) {
    const companyId = randomUUID(), developer = randomUUID(), reviewer = randomUUID();
    const prefix = `T${companyId.slice(0, 5).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Auto-wake", issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: developer, companyId, name: "Engineer", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: reviewer, companyId, name: "Code Reviewer", role: "engineer", status: options.reviewerStatus ?? "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    const updatedAt = ago(options.quietMinutes ?? 10);
    const [terminal] = await db.insert(issues).values({ companyId, identifier: `${prefix}-1`, title: "Review the fix",
      status: options.terminalStatus ?? "in_review", assigneeAgentId: options.assigned === false ? null : reviewer,
      createdAt: updatedAt, updatedAt }).returning();
    const dependents = await db.insert(issues).values(Array.from({ length: options.dependents ?? 1 }, (_, index) => ({
      companyId, identifier: `${prefix}-${index + 2}`, title: `Blocked follow-up ${index + 1}`, status: "blocked",
      assigneeAgentId: developer, createdAt: updatedAt, updatedAt,
    }))).returning();
    await db.insert(issueRelations).values(dependents.map(dependent => ({ companyId, issueId: terminal.id,
      relatedIssueId: dependent.id, type: "blocks" as const })));
    return { companyId, developer, reviewer, terminal, dependents };
  }

  const sweep = (f: Awaited<ReturnType<typeof fixture>>, enqueue: ReturnType<typeof wakeRecorder>["enqueueWakeup"], index = 0) =>
    wakeStrandedTerminalBlocker(db, enqueue as never, { companyId: f.companyId, blockedIssueId: f.dependents[index]!.id });
  const cards = async (companyId: string, terminalId: string) => (await attentionService(db).list(companyId, { userId: "board-user" }))
    .items.filter(item => item.subject.id === terminalId && ["blocker_attention", "review"].includes(item.sourceKind));
  /** The wake and its run ended `minutes` ago with the blocker unchanged. */
  const endWakes = (companyId: string, minutes: number) => db.update(agentWakeupRequests)
    .set({ status: "completed", requestedAt: ago(minutes + 1), finishedAt: ago(minutes), updatedAt: ago(minutes) })
    .where(eq(agentWakeupRequests.companyId, companyId));
  const activity = (companyId: string, action: string) => db.select().from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)));

  it("waits out the quiet threshold, then wakes the owner once for every issue it blocks, and holds the card", async () => {
    const f = await fixture({ quietMinutes: 2, dependents: 3 });
    const { calls, enqueueWakeup } = wakeRecorder(f.companyId);

    const early = await sweep(f, enqueueWakeup);
    expect(calls).toHaveLength(0);
    // The real deadline (quiet since + 5 min) is registered, not a fixed interval.
    expect(early.retryAt).toBe(f.terminal.updatedAt.getTime() + 5 * MINUTE);
    expect(await cards(f.companyId, f.terminal.id)).toEqual([]);

    await db.update(issues).set({ updatedAt: ago(6) }).where(eq(issues.id, f.terminal.id));
    const passes = [];
    for (const index of [0, 1, 2, 0]) passes.push(await sweep(f, enqueueWakeup, index));
    expect(calls).toHaveLength(1);
    // The wake in flight makes the tree read as live; every blocked issue keeps
    // a re-check deadline so attempt 2 or exhaustion is still noticed.
    for (const pass of passes) expect(pass.retryAt).not.toBeNull();
    const fingerprint = `in_review.0.${f.reviewer}`;
    expect(calls[0]).toMatchObject({ agentId: f.reviewer, input: {
      reason: ISSUE_TERMINAL_BLOCKER_STRANDED_WAKE_REASON,
      idempotencyKey: terminalBlockerAutoWakeKey(f.terminal.id, fingerprint, 1),
      issueStateGuard: { statuses: ["in_review"], assigneeAgentId: f.reviewer, statusVersion: 0 },
      contextSnapshot: { issueId: f.terminal.id, wakeReason: ISSUE_TERMINAL_BLOCKER_STRANDED_WAKE_REASON,
        terminalBlockerStranded: { terminalIssueId: f.terminal.id, blockedIssueCount: 3, attempt: 1, maxAttempts: 2 } },
    } });
    expect(await activity(f.companyId, "issue.terminal_blocker_auto_wake")).toEqual([
      expect.objectContaining({ entityId: f.terminal.id, agentId: f.reviewer, details: expect.objectContaining({ attempt: 1 }) }),
    ]);
    // The wake is in flight: neither the blocker card nor the stalled-review card.
    expect(await cards(f.companyId, f.terminal.id)).toEqual([]);
  });

  it("withholds blocked issues the woken agent cannot read, including the parent fallback", async () => {
    const f = await fixture({ quietMinutes: 30, dependents: 2 });
    // The reviewer can read the blocker but not the private work waiting on it.
    await db.update(issues).set({ visibility: "private", title: "Secret acquisition" }).where(eq(issues.id, f.dependents[1]!.id));
    const [parent] = await db.insert(issues).values({ companyId: f.companyId, identifier: `${f.terminal.identifier}-P`,
      title: "Secret parent plan", status: "blocked", visibility: "private", assigneeAgentId: f.developer }).returning();
    await db.update(issues).set({ parentId: parent.id }).where(eq(issues.id, f.terminal.id));
    const { calls, enqueueWakeup } = wakeRecorder(f.companyId);
    await sweep(f, enqueueWakeup);
    expect(calls).toHaveLength(1);
    for (const field of ["payload", "contextSnapshot"] as const) {
      const text = JSON.stringify(calls[0]!.input[field]);
      expect(text).not.toContain("Secret acquisition");
      expect(text).not.toContain("Secret parent plan");
      expect(text).not.toContain(f.dependents[1]!.identifier);
      expect(text).not.toContain(parent.identifier);
    }
    const blocked = calls[0]!.input.contextSnapshot.terminalBlockerStranded.blockedIssues as Array<Record<string, unknown>>;
    expect(blocked).toEqual(expect.arrayContaining([
      { id: f.dependents[0]!.id, identifier: f.dependents[0]!.identifier, title: "Blocked follow-up 1" },
      { id: f.dependents[1]!.id, identifier: null, title: "A task you cannot read" },
      { id: parent.id, identifier: null, title: "A task you cannot read" },
    ]));
    expect(calls[0]!.input.contextSnapshot.terminalBlockerStranded.blockedIssueCount).toBe(3);
    expect(await activity(f.companyId, "issue.terminal_blocker_auto_wake")).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ blockedIssuesWithheld: 2 }) }),
    ]);
  });

  it("admits one wake when concurrent sweeps reach admission for the same attempt together", async () => {
    const f = await fixture({ quietMinutes: 30, dependents: 2 });
    const calls: string[] = [];
    // Both callers pass the existing-row check, then wait here so neither has
    // inserted before the other reaches the insert.
    let arrive!: () => void;
    const bothArrived = new Promise<void>(resolve => { let arrived = 0; arrive = () => { arrived += 1; if (arrived === 2) resolve(); }; });
    const enqueueWakeup = vi.fn(async (agentId: string, input: Record<string, any>) => {
      calls.push(input.idempotencyKey);
      arrive();
      await bothArrived;
      const [row] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId, source: input.source,
        triggerDetail: input.triggerDetail, reason: input.reason, payload: input.payload,
        idempotencyKey: input.idempotencyKey, status: "queued" }).returning();
      return { id: row.id };
    });
    const results = await Promise.all([sweep(f, enqueueWakeup as never, 0), sweep(f, enqueueWakeup as never, 1)]);
    expect(calls).toEqual([calls[0], calls[0]]);
    const rows = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.reason, ISSUE_TERMINAL_BLOCKER_STRANDED_WAKE_REASON)));
    expect(rows).toHaveLength(1);
    // The loser counts the attempt as admitted, not as a failed enqueue.
    expect(results.filter(result => result.woken)).toHaveLength(1);
    expect(results.filter(result => result.failed)).toHaveLength(0);
    for (const result of results) expect(result.retryAt).not.toBeNull();
    expect(await activity(f.companyId, "issue.terminal_blocker_auto_wake")).toHaveLength(1);
  });

  it("retries once after the backoff, then gives the board a card that says so", async () => {
    const f = await fixture({ quietMinutes: 30 });
    const { calls, enqueueWakeup } = wakeRecorder(f.companyId);
    await sweep(f, enqueueWakeup);
    expect(calls).toHaveLength(1);

    // Attempt 1 ended five minutes ago with no progress: the backoff is 15 minutes.
    await endWakes(f.companyId, 5);
    const waiting = await sweep(f, enqueueWakeup);
    expect(calls).toHaveLength(1);
    expect(waiting.retryAt).toBeGreaterThan(Date.now() + 9 * MINUTE);
    expect(await cards(f.companyId, f.terminal.id)).toEqual([]);

    await endWakes(f.companyId, 16);
    await sweep(f, enqueueWakeup);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input.idempotencyKey).toBe(terminalBlockerAutoWakeKey(f.terminal.id, `in_review.0.${f.reviewer}`, 2));

    await endWakes(f.companyId, 1);
    const exhausted = await sweep(f, enqueueWakeup);
    await sweep(f, enqueueWakeup);
    expect(calls).toHaveLength(2);
    expect(exhausted).toMatchObject({ exhausted: true, retryAt: null });
    expect(await activity(f.companyId, "issue.terminal_blocker_auto_wake_exhausted")).toHaveLength(1);
    const shown = await cards(f.companyId, f.terminal.id);
    expect(shown.map(card => card.sourceKind).sort()).toEqual(["blocker_attention", "review"]);
    for (const card of shown) expect(card.whyNow).toMatch(/^Auto-woke Code Reviewer 2×, no progress\./);
  });

  it("starts fresh attempts when the blocker moves on", async () => {
    const f = await fixture({ quietMinutes: 30 });
    const { calls, enqueueWakeup } = wakeRecorder(f.companyId);
    await sweep(f, enqueueWakeup);
    await endWakes(f.companyId, 16);
    await db.update(issues).set({ status: "todo", statusVersion: 1, updatedAt: ago(6) }).where(eq(issues.id, f.terminal.id));
    await sweep(f, enqueueWakeup);
    expect(calls.map(call => call.input.idempotencyKey)).toEqual([
      terminalBlockerAutoWakeKey(f.terminal.id, `in_review.0.${f.reviewer}`, 1),
      terminalBlockerAutoWakeKey(f.terminal.id, `todo.1.${f.reviewer}`, 1),
    ]);
  });

  it.each([
    ["a paused agent", { reviewerStatus: "paused" }],
    ["an errored agent", { reviewerStatus: "error" }],
    ["an unassigned blocker", { assigned: false, terminalStatus: "todo" as const }],
  ])("shows the card right away and sends no wake for %s", async (_label, options) => {
    const f = await fixture(options);
    const { calls, enqueueWakeup } = wakeRecorder(f.companyId);
    expect(await sweep(f, enqueueWakeup)).toMatchObject({ woken: false, retryAt: null });
    expect(calls).toHaveLength(0);
    expect((await cards(f.companyId, f.terminal.id)).map(card => card.sourceKind)).toContain("blocker_attention");
  });

  it("does nothing while a run for the blocker is queued", async () => {
    const f = await fixture();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.reviewer, status: "queued",
      contextSnapshot: { issueId: f.terminal.id } });
    const { calls, enqueueWakeup } = wakeRecorder(f.companyId);
    expect((await sweep(f, enqueueWakeup)).woken).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await cards(f.companyId, f.terminal.id)).toEqual([]);
  });

  it("stops holding the card when a due wake never ran", async () => {
    // No sweep reached this blocker (for example every dependent is user-owned).
    const f = await fixture({ quietMinutes: 30 });
    const state = (await loadTerminalBlockerAutoWakeStates(db, f.companyId, [f.terminal.id])).get(f.terminal.id);
    expect(state).toMatchObject({ kind: "pending", attempt: 1, overdue: true });
    const shown = await cards(f.companyId, f.terminal.id);
    expect(shown.find(card => card.sourceKind === "blocker_attention")?.whyNow).toMatch(/^Auto-wake of Code Reviewer is overdue\./);
  });

  it("agrees with decision retention: no keep while auto-wake holds the review card", async () => {
    const f = await fixture({ quietMinutes: 2 });
    const authActor = { type: "board" as const, source: "local_implicit" as const, userId: "board-user", companyIds: [f.companyId], isInstanceAdmin: true };
    const actor = { actorType: "user" as const, actorId: "board-user", agentId: null, userId: "board-user", runId: null, agentApiKeyId: null, responsibleUserId: "board-user" };
    const keep = () => decisionRetentionService(db).setKeep({ companyId: f.companyId, sourceKind: "review", sourceId: f.terminal.id,
      keep: true, authActor, actor });
    await expect(keep()).rejects.toMatchObject({ status: 404 });
    await db.update(issues).set({ updatedAt: ago(30) }).where(eq(issues.id, f.terminal.id));
    await expect(keep()).resolves.toMatchObject({ keep: true });
  });

  it("runs from the recovery sweep's per-blocked-issue pass and registers the next deadline", async () => {
    const f = await fixture();
    const { calls, enqueueWakeup } = wakeRecorder(f.companyId);
    const deadlines: number[] = [];
    await recoveryService(db, { enqueueWakeup: enqueueWakeup as never }).reconcileResolvedDependencyWakeBackstop({
      companyId: f.companyId, issueId: f.dependents[0]!.id, onDeferredDeadline: at => deadlines.push(at) });
    expect(calls.filter(call => call.input.reason === ISSUE_TERMINAL_BLOCKER_STRANDED_WAKE_REASON)).toHaveLength(1);
    expect(deadlines.length).toBeGreaterThan(0);
  });
});
