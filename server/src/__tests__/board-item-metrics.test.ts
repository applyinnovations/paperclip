import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  externalObjectMentions,
  externalObjects,
  issueRelations,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  cachedLoader,
  countResolvedStaleBoardItems,
  staleBoardItemDaysFromEnv,
} from "../services/board-item-metrics.ts";
import { createProcessMetricsRegistry } from "../process-metrics.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres board item metric tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = new Date("2026-11-25T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const OWNER = "board-owner";

describe("board item metric config and cache", () => {
  it("defaults to 3 days and rejects a non-positive threshold", () => {
    expect(staleBoardItemDaysFromEnv({})).toBe(3);
    expect(staleBoardItemDaysFromEnv({ PAPERCLIP_METRICS_STALE_BOARD_ITEM_DAYS: "7" })).toBe(7);
    expect(() => staleBoardItemDaysFromEnv({ PAPERCLIP_METRICS_STALE_BOARD_ITEM_DAYS: "0" })).toThrow(/positive/);
    expect(() => staleBoardItemDaysFromEnv({ PAPERCLIP_METRICS_STALE_BOARD_ITEM_DAYS: "soon" })).toThrow(/positive/);
  });

  it("runs the query once per cache window and shares concurrent scrapes", async () => {
    let clock = 0;
    let calls = 0;
    const load = cachedLoader(async () => ++calls, { ttlMs: 60_000, now: () => clock });
    expect(await Promise.all([load(), load(), load()])).toEqual([1, 1, 1]);
    clock = 59_999;
    expect(await load()).toBe(1);
    clock = 60_000;
    expect(await load()).toBe(2);
  });

  it("does not cache a failed query", async () => {
    let fail = true;
    const load = cachedLoader(async () => {
      if (fail) throw new Error("db down");
      return "ok";
    }, { ttlMs: 60_000 });
    await expect(load()).rejects.toThrow("db down");
    fail = false;
    expect(await load()).toBe("ok");
  });

  it("drops only this series when its source fails", async () => {
    const errors: string[] = [];
    const registry = createProcessMetricsRegistry({
      resolvedStaleBoardItems: async () => {
        throw new Error("db down");
      },
      onSourceError: (metric) => errors.push(metric),
    });
    const text = await registry.metrics();
    expect(text).toContain("nodejs_heap_size_used_bytes");
    expect(text).not.toMatch(/^paperclip_board_items_resolved_stale\{/m);
    expect(errors).toEqual(["paperclip_board_items_resolved_stale"]);
  });

  it("exports the count labelled by company prefix and id", async () => {
    const registry = createProcessMetricsRegistry({
      resolvedStaleBoardItems: async () => [{ companyId: "c-1", issuePrefix: "APP", count: 2 }],
    });
    expect(await registry.metrics()).toContain(
      'paperclip_board_items_resolved_stale{company="APP",company_id="c-1"} 2',
    );
  });
});

describeEmbeddedPostgres("countResolvedStaleBoardItems", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-item-metrics-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issueWorkProducts);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string, status = "active") {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: `Company ${prefix}`, issuePrefix: prefix, status });
    return id;
  }

  let issueNumber = 0;
  async function seedIssue(
    companyId: string,
    overrides: Partial<typeof issues.$inferInsert> = {},
  ) {
    const id = randomUUID();
    issueNumber += 1;
    await db.insert(issues).values({
      id,
      companyId,
      title: `Issue ${issueNumber}`,
      status: "in_review",
      priority: "medium",
      assigneeUserId: OWNER,
      updatedAt: daysAgo(5),
      ...overrides,
    });
    return id;
  }

  async function seedPullRequest(companyId: string, issueId: string, status: string) {
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      title: "PR",
      status,
    });
  }

  async function seedExternalPullRequest(companyId: string, issueId: string, isTerminal: boolean | null) {
    let objectId: string | null = null;
    if (isTerminal !== null) {
      objectId = randomUUID();
      await db.insert(externalObjects).values({
        id: objectId,
        companyId,
        providerKey: "github",
        objectType: "pull_request",
        externalId: `org/repo#${randomUUID()}`,
        isTerminal,
        statusCategory: isTerminal ? "succeeded" : "open",
      });
    }
    await db.insert(externalObjectMentions).values({
      companyId,
      sourceIssueId: issueId,
      sourceKind: "description",
      providerKey: "github",
      objectType: "pull_request",
      objectId,
    });
  }

  async function seedBlocker(companyId: string, blockedIssueId: string, blockerStatus: string) {
    const blockerId = await seedIssue(companyId, {
      status: blockerStatus,
      assigneeUserId: null,
      updatedAt: NOW,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
  }

  async function counts(staleAfterDays = 3) {
    const rows = await countResolvedStaleBoardItems(db, { staleAfterDays, now: NOW });
    return Object.fromEntries(rows.map((row) => [row.issuePrefix, row.count]));
  }

  it("counts a stale board item whose PR merged", async () => {
    const companyId = await seedCompany("BIA");
    await seedPullRequest(companyId, await seedIssue(companyId), "merged");
    expect(await counts()).toEqual({ BIA: 1 });
  });

  it("counts a stale board item whose external PR closed and whose blocker is done", async () => {
    const companyId = await seedCompany("BIB");
    const issueId = await seedIssue(companyId, { status: "blocked" });
    await seedExternalPullRequest(companyId, issueId, true);
    await seedBlocker(companyId, issueId, "done");
    const cancelledBlockerOnly = await seedIssue(companyId);
    await seedBlocker(companyId, cancelledBlockerOnly, "cancelled");
    expect(await counts()).toEqual({ BIB: 2 });
  });

  it("does not count a fresh item, an item with an open link, or an item with no links", async () => {
    const companyId = await seedCompany("BIC");
    // Fresh: updated 2 days ago with a 3-day threshold.
    await seedPullRequest(companyId, await seedIssue(companyId, { updatedAt: daysAgo(2) }), "merged");
    // One PR merged, another still open.
    const mixed = await seedIssue(companyId);
    await seedPullRequest(companyId, mixed, "merged");
    await seedPullRequest(companyId, mixed, "ready_for_review");
    // External PR still open, and one whose object was never resolved.
    await seedExternalPullRequest(companyId, await seedIssue(companyId), false);
    await seedExternalPullRequest(companyId, await seedIssue(companyId), null);
    // Blocker still in progress.
    await seedBlocker(companyId, await seedIssue(companyId), "in_progress");
    // No links at all: nothing says the work resolved.
    await seedIssue(companyId);
    expect(await counts()).toEqual({ BIC: 0 });
  });

  it("only counts open, visible, user-assigned items", async () => {
    const companyId = await seedCompany("BID");
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Eng", role: "engineer", status: "idle", adapterType: "codex_local" });
    await seedPullRequest(companyId, await seedIssue(companyId, { status: "done" }), "merged");
    await seedPullRequest(companyId, await seedIssue(companyId, { hiddenAt: daysAgo(1) }), "merged");
    await seedPullRequest(
      companyId,
      await seedIssue(companyId, { assigneeUserId: null, assigneeAgentId: agentId }),
      "merged",
    );
    expect(await counts()).toEqual({ BID: 0 });
  });

  it("reports zero for every active company, skips archived ones, and honours the threshold", async () => {
    const active = await seedCompany("BIE");
    const quiet = await seedCompany("BIF");
    const archived = await seedCompany("BIG", "archived");
    await seedPullRequest(active, await seedIssue(active, { updatedAt: daysAgo(4) }), "closed");
    await seedPullRequest(archived, await seedIssue(archived), "merged");
    expect(quiet).toBeTruthy();
    expect(await counts(3)).toEqual({ BIE: 1, BIF: 0 });
    expect(await counts(7)).toEqual({ BIE: 0, BIF: 0 });
  });
});
