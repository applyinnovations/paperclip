import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  applyPendingMigrations,
  companies,
  connectionGrants,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  externalObjectMentions,
  externalObjects,
  issueComments,
  issueRelations,
  issues,
  issueThreadInteractions,
  issueWorkProducts,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  BOARD_ITEM_AUTO_RESOLUTION_ACTOR_ID,
  BOARD_ITEM_AUTO_RESOLUTION_SKIPPED_ACTION,
  BOARD_ITEM_AUTO_RESOLVED_ACTION,
  boardItemAutoResolutionService,
  decideBoardItemResolution,
} from "../services/board-item-auto-resolution.js";
import { githubConnectionEventService } from "../services/github-connection-events.js";
import { issueService, type IssuePostCommitAction } from "../services/issues.js";
import type { PaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("decideBoardItemResolution", () => {
  const merged = { state: "merged" as const };
  const closed = { state: "closed" as const };
  const open = { state: "open" as const };
  const done = { status: "done" };
  const blocked = { status: "in_progress" };

  it("waits while a person still has input pending, a PR is open, or a blocker is open", () => {
    expect(decideBoardItemResolution({ pullRequests: [merged], blockers: [], pendingHumanInputs: 1 }))
      .toEqual({ kind: "wait", reason: "pending_human_input" });
    expect(decideBoardItemResolution({ pullRequests: [merged, open], blockers: [], pendingHumanInputs: 0 }))
      .toEqual({ kind: "wait", reason: "pull_request_open" });
    expect(decideBoardItemResolution({ pullRequests: [{ state: "unknown" }], blockers: [], pendingHumanInputs: 0 }))
      .toEqual({ kind: "wait", reason: "pull_request_open" });
    expect(decideBoardItemResolution({ pullRequests: [merged], blockers: [blocked], pendingHumanInputs: 0 }))
      .toEqual({ kind: "wait", reason: "blocker_open" });
    expect(decideBoardItemResolution({ pullRequests: [], blockers: [], pendingHumanInputs: 0 }))
      .toEqual({ kind: "wait", reason: "no_linked_work" });
  });

  it("closes when every PR merged and returns to the agent otherwise", () => {
    expect(decideBoardItemResolution({ pullRequests: [merged, merged], blockers: [done], pendingHumanInputs: 0 }))
      .toEqual({ kind: "done" });
    expect(decideBoardItemResolution({ pullRequests: [merged, closed], blockers: [], pendingHumanInputs: 0 }))
      .toEqual({ kind: "return_to_agent", reason: "pull_request_closed_unmerged" });
    expect(decideBoardItemResolution({ pullRequests: [], blockers: [done, { status: "cancelled" }], pendingHumanInputs: 0 }))
      .toEqual({ kind: "return_to_agent", reason: "blockers_resolved" });
  });
});

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_BOARD_ITEM_AUTO_RESOLUTION_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("board item auto-resolution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalTestDatabaseUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-item-auto-resolution-");
    if (externalTestDatabaseUrl) await applyPendingMigrations(externalTestDatabaseUrl);
    db = createDb(externalTestDatabaseUrl ?? tempDb!.connectionString, { maxConnections: 2 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = `board-user-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Board", issuePrefix: `B${companyId.slice(0, 4).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Builder", role: "engineer", status: "idle", adapterType: "codex_local" });
    return { companyId, agentId, userId };
  }

  async function boardItem(input: { companyId: string; userId: string; agentId: string; title?: string; status?: string }) {
    const [issue] = await db.insert(issues).values({
      companyId: input.companyId,
      title: input.title ?? "Merge the release",
      status: input.status ?? "in_review",
      assigneeUserId: input.userId,
      createdByAgentId: input.agentId,
    }).returning();
    return issue!;
  }

  async function linkPullRequest(companyId: string, issueId: string, number: number, state: "open" | "merged" | "closed") {
    const [object] = await db.insert(externalObjects).values({
      companyId,
      providerKey: "github",
      objectType: "pull_request",
      externalId: `acme/app#pull/${number}`,
      statusKey: state,
      statusCategory: state === "merged" ? "succeeded" : state === "closed" ? "closed" : "open",
      statusTone: "neutral",
      isTerminal: state !== "open",
      data: { provider: "github", merged: state === "merged", ...(state === "merged" ? { mergeCommitSha: "c".repeat(40) } : {}) },
    }).returning();
    await db.insert(externalObjectMentions).values({
      companyId,
      sourceIssueId: issueId,
      sourceKind: "description",
      canonicalIdentityHash: `hash-${randomUUID()}`,
      objectId: object!.id,
      providerKey: "github",
      objectType: "pull_request",
    });
    return object!;
  }

  async function setPullRequestState(objectId: string, state: "merged" | "closed") {
    await db.update(externalObjects).set({
      statusKey: state,
      isTerminal: true,
      data: { provider: "github", merged: state === "merged", ...(state === "merged" ? { mergeCommitSha: "d".repeat(40) } : {}) },
    }).where(eq(externalObjects.id, objectId));
  }

  async function read(issueId: string) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const activity = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, issueId),
      eq(activityLog.action, BOARD_ITEM_AUTO_RESOLVED_ACTION),
    ));
    return { issue: issue!, comments, activity };
  }

  it("closes the item once when its PR merges, even if the webhook is delivered again", async () => {
    const { companyId, agentId, userId } = await fixture();
    // An in_review item's confirmation is a review verdict the system cannot
    // give, so the webhook path is exercised on an in_progress item.
    const issue = await boardItem({ companyId, userId, agentId, status: "in_progress" });
    const pr = await linkPullRequest(companyId, issue.id, 41, "open");
    // A merge confirmation the merged-PR sweep accepts must not hold the item.
    await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id,
      kind: "request_confirmation", title: "Confirm pull request merged", continuationPolicy: "none",
      payload: { version: 1, prompt: "Confirm https://github.com/acme/app/pull/41 is merged" } });

    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `github-${randomUUID()}`,
      name: "GitHub", type: "mcp_http", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "GitHub",
      uid: `github-${randomUUID()}`, transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user",
      status: "active", enabled: true, config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } },
      transportConfig: {} });
    await db.insert(connectionGrants).values({ id: grantId, companyId, connectionId, kind: "user", subjectUserId: userId,
      status: "active", isDefault: false, providerTenant: {
        oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null },
        github: { userId: "42", login: "octocat", installationCount: 1, repositoryCount: 1, repositorySelection: "selected",
          installationIds: ["101"], installationOwnerLogins: ["acme"], webhookHealth: "healthy" },
      } });
    const event = (id: string) => ({
      id, provider: "github" as const, event: "pull_request", action: "closed", installationId: "101", repositoryId: "99",
      createdAt: "2026-11-25T12:00:00.000Z", bindingIds: [`${grantId}_101`],
      payload: { repository: "acme/app", number: 41, state: "closed", merged: true, mergedAt: "2026-11-25T11:59:00.000Z",
        updatedAt: "2026-11-25T11:59:01.000Z", url: "https://github.com/acme/app/pull/41", headSha: "a".repeat(40),
        mergeCommitSha: "e".repeat(40) },
    });
    const batches = [[event("delivery-1")], [event("delivery-1")], [event("delivery-2")]];
    const connector = {
      getCapabilities: vi.fn(async () => ["github.code" as const]),
      setWebhookBinding: vi.fn(async () => undefined),
      leaseEvents: vi.fn(async () => {
        const events = batches.shift();
        return events ? { leaseId: randomUUID(), events, failedEventIds: [] } : null;
      }),
      acknowledgeEvents: vi.fn(async () => 1),
    } as unknown as PaperclipCloudConnector;
    let time = new Date("2026-11-25T12:00:05.000Z");
    const service = githubConnectionEventService(db, { connector, now: () => time });
    for (let i = 0; i < 3; i += 1) {
      await service.pollOnce();
      time = new Date(time.getTime() + 60_000);
    }

    const after = await read(issue.id);
    expect(after.issue.status).toBe("done");
    expect(after.issue.assigneeUserId).toBe(userId);
    expect(after.comments).toHaveLength(1);
    expect(after.comments[0]!.body).toContain("acme/app#41");
    expect(after.comments[0]!.body).toContain("e".repeat(12));
    expect(after.activity).toHaveLength(1);
    expect(after.activity[0]).toMatchObject({
      actorType: "system",
      actorId: BOARD_ITEM_AUTO_RESOLUTION_ACTOR_ID,
      details: expect.objectContaining({ decision: "done", trigger: "pull_request_closed", triggerPullRequest: "acme/app#41" }),
    });
    expect((await db.select().from(externalObjects).where(eq(externalObjects.id, pr.id)))[0]!.isTerminal).toBe(true);
  });

  it("returns the item to the agent as todo when a PR closes without merging", async () => {
    const { companyId, agentId, userId } = await fixture();
    const issue = await boardItem({ companyId, userId, agentId });
    const pr = await linkPullRequest(companyId, issue.id, 42, "open");
    await setPullRequestState(pr.id, "closed");
    const wakeup = vi.fn(async () => null);

    const results = await boardItemAutoResolutionService(db, { wakeup })
      .onPullRequestClosed(companyId, { owner: "acme", repo: "app", number: 42, merged: false });

    expect(results).toEqual([expect.objectContaining({ issueId: issue.id, outcome: "returned_to_agent", agentId })]);
    const after = await read(issue.id);
    expect(after.issue).toMatchObject({ status: "todo", assigneeAgentId: agentId, assigneeUserId: null });
    expect(after.comments).toHaveLength(1);
    expect(after.comments[0]!.body).toContain("closed without merging");
    expect(after.activity[0]!.details).toMatchObject({ decision: "return_to_agent", reason: "pull_request_closed_unmerged" });
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_assigned",
      payload: expect.objectContaining({ issueId: issue.id, mutation: "board_item_auto_resolved" }),
    }));

    // A replayed event finds nothing left to do.
    await boardItemAutoResolutionService(db, { wakeup })
      .onPullRequestClosed(companyId, { owner: "acme", repo: "app", number: 42, merged: false });
    expect((await read(issue.id)).comments).toHaveLength(1);
  });

  it("uses the webhook state for a PR linked only as a work product", async () => {
    const { companyId, agentId, userId } = await fixture();
    const issue = await boardItem({ companyId, userId, agentId });
    await db.insert(issueWorkProducts).values({ companyId, issueId: issue.id, type: "pull_request", provider: "github",
      title: "PR", url: "https://github.com/acme/app/pull/45", status: "active", metadata: { state: "open" } });

    await boardItemAutoResolutionService(db, { wakeup: vi.fn(async () => null) })
      .onPullRequestClosed(companyId, { owner: "acme", repo: "app", number: 45, merged: true, mergeCommitSha: "f".repeat(40) });

    const after = await read(issue.id);
    expect(after.issue.status).toBe("done");
    expect(after.comments[0]!.body).toContain("f".repeat(12));
  });

  it("does nothing while another linked PR is still open", async () => {
    const { companyId, agentId, userId } = await fixture();
    const issue = await boardItem({ companyId, userId, agentId });
    const first = await linkPullRequest(companyId, issue.id, 43, "open");
    await linkPullRequest(companyId, issue.id, 44, "open");
    await setPullRequestState(first.id, "merged");

    const results = await boardItemAutoResolutionService(db, { wakeup: vi.fn(async () => null) })
      .onPullRequestClosed(companyId, { owner: "acme", repo: "app", number: 43, merged: true });

    expect(results).toEqual([expect.objectContaining({ outcome: "waiting", reason: "pull_request_open" })]);
    const after = await read(issue.id);
    expect(after.issue).toMatchObject({ status: "in_review", assigneeUserId: userId });
    expect(after.comments).toHaveLength(0);
  });

  it("does nothing while a person still has a pending interaction on the item", async () => {
    const { companyId, agentId, userId } = await fixture();
    const issue = await boardItem({ companyId, userId, agentId });
    await linkPullRequest(companyId, issue.id, 46, "merged");
    await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id, kind: "ask_user_questions",
      title: "Which region?", continuationPolicy: "wake_assignee",
      payload: { version: 1, questions: [{ id: "region", prompt: "Which region?", selectionMode: "single",
        options: [{ id: "eu", label: "EU" }] }] } });

    const results = await boardItemAutoResolutionService(db, { wakeup: vi.fn(async () => null) })
      .onPullRequestClosed(companyId, { owner: "acme", repo: "app", number: 46, merged: true });

    expect(results).toEqual([expect.objectContaining({ outcome: "waiting", reason: "pending_human_input" })]);
    expect((await read(issue.id)).issue).toMatchObject({ status: "in_review", assigneeUserId: userId });
  });

  it("queues blocked board items when a blocker finishes and returns them to their agent", async () => {
    const { companyId, agentId, userId } = await fixture();
    const handoverAgentId = randomUUID();
    await db.insert(agents).values({ id: handoverAgentId, companyId, name: "Handover", role: "engineer", status: "idle", adapterType: "codex_local" });
    const [blocker] = await db.insert(issues).values({ companyId, title: "Upstream", status: "in_progress", assigneeAgentId: agentId }).returning();
    const issue = await boardItem({ companyId, userId, agentId, title: "Waiting on upstream" });
    await db.update(issues).set({
      executionState: { returnAssignee: { type: "agent", agentId: handoverAgentId, userId: null } } as never,
    }).where(eq(issues.id, issue.id));
    await db.insert(issueRelations).values({ companyId, issueId: blocker!.id, relatedIssueId: issue.id, type: "blocks" });

    // Every terminal transition through issueService.update queues the evaluation.
    const actions: IssuePostCommitAction[] = [];
    await issueService(db).update(blocker!.id, { status: "done" }, db, undefined, actions);
    expect(actions).toContainEqual({ type: "resolve_blocked_board_items", companyId, issueId: blocker!.id });

    const wakeup = vi.fn(async () => null);
    const results = await boardItemAutoResolutionService(db, { wakeup }).onBlockerResolved(companyId, blocker!.id);

    expect(results).toEqual([expect.objectContaining({ issueId: issue.id, outcome: "returned_to_agent", agentId: handoverAgentId })]);
    const after = await read(issue.id);
    expect(after.issue).toMatchObject({ status: "todo", assigneeAgentId: handoverAgentId, assigneeUserId: null });
    expect(after.comments).toHaveLength(1);
    expect(after.comments[0]!.body).toContain("every blocker this task was waiting on is resolved");
    expect(after.activity[0]!.details).toMatchObject({ decision: "return_to_agent", reason: "blockers_resolved", trigger: "blocker_resolved" });
  });

  it("falls back to the last agent assignee in the activity log", async () => {
    const { companyId, agentId, userId } = await fixture();
    const [blocker] = await db.insert(issues).values({ companyId, title: "Upstream", status: "done" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Handed over", status: "blocked", assigneeUserId: userId }).returning();
    await db.insert(issueRelations).values({ companyId, issueId: blocker!.id, relatedIssueId: issue!.id, type: "blocks" });
    await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentId, agentId, action: "issue.updated",
      entityType: "issue", entityId: issue!.id,
      details: { assigneeUserId: userId, changes: { assigneeAgentId: { from: agentId, to: null }, assigneeUserId: { from: null, to: userId } } } });

    const results = await boardItemAutoResolutionService(db, { wakeup: vi.fn(async () => null) }).onBlockerResolved(companyId, blocker!.id);

    expect(results).toEqual([expect.objectContaining({ outcome: "returned_to_agent", agentId })]);
    expect((await read(issue!.id)).issue).toMatchObject({ status: "todo", assigneeAgentId: agentId, assigneeUserId: null });
  });

  it("records once, and leaves the item, when no agent can take it back", async () => {
    const { companyId, userId } = await fixture();
    const [blocker] = await db.insert(issues).values({ companyId, title: "Upstream", status: "cancelled" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Human-created wait", status: "blocked", assigneeUserId: userId }).returning();
    await db.insert(issueRelations).values({ companyId, issueId: blocker!.id, relatedIssueId: issue!.id, type: "blocks" });
    const service = boardItemAutoResolutionService(db, { wakeup: vi.fn(async () => null) });

    expect(await service.onBlockerResolved(companyId, blocker!.id))
      .toEqual([expect.objectContaining({ outcome: "no_return_agent", alreadyRecorded: false })]);
    expect(await service.onBlockerResolved(companyId, blocker!.id))
      .toEqual([expect.objectContaining({ outcome: "no_return_agent", alreadyRecorded: true })]);
    const skipped = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, issue!.id), eq(activityLog.action, BOARD_ITEM_AUTO_RESOLUTION_SKIPPED_ACTION)));
    expect(skipped).toHaveLength(1);
    expect((await read(issue!.id)).issue).toMatchObject({ status: "blocked", assigneeUserId: userId });
  });

  it("backfills existing items, with a dry run that changes nothing", async () => {
    const { companyId, agentId, userId } = await fixture();
    const issue = await boardItem({ companyId, userId, agentId });
    await linkPullRequest(companyId, issue.id, 47, "merged");
    const service = boardItemAutoResolutionService(db, { wakeup: vi.fn(async () => null) });

    expect(await service.backfill({ companyId, dryRun: true }))
      .toEqual([expect.objectContaining({ issueId: issue.id, outcome: "would_resolve", decision: { kind: "done" } })]);
    expect((await read(issue.id)).issue.status).toBe("in_review");

    expect(await service.backfill({ companyId })).toEqual([expect.objectContaining({ issueId: issue.id, outcome: "done" })]);
    expect(await service.backfill({ companyId })).toEqual([]);
    const after = await read(issue.id);
    expect(after.issue.status).toBe("done");
    expect(after.comments).toHaveLength(1);
    expect(after.activity[0]!.details).toMatchObject({ trigger: "backfill" });
  });
});
