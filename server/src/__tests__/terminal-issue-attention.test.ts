import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";
import { issueService } from "../services/issues.js";
import { OWNER_UNPROVABLE_CAUSE } from "../services/recovery/owner-gone-attestation.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ATTENTION_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalUrl ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminal attention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("terminal issues leave nothing in /attention", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!externalUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-attention-");
    db = createDb(externalUrl ?? tempDb!.connectionString, { maxConnections: 4 });
  }, 30_000);

  afterEach(async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL client_min_messages = warning`);
      await tx.execute(sql`TRUNCATE TABLE companies CASCADE`);
    });
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seed(prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `${prefix} Co`, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Worker", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertIssue(companyId: string, identifier: string, status: string, assigneeAgentId: string | null = null) {
    const [row] = await db.insert(issues).values({
      companyId, identifier, title: `Task ${identifier}`, status, priority: "medium", assigneeAgentId,
    }).returning();
    return row!;
  }

  async function insertConfirmation(companyId: string, issueId: string, title = "Connect GitHub") {
    const [row] = await db.insert(issueThreadInteractions).values({
      companyId, issueId, kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee",
      title, payload: { version: 1, prompt: title },
    }).returning();
    return row!;
  }

  async function insertBoardRecovery(companyId: string, sourceIssueId: string, cause = "missing_disposition") {
    const [row] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId, kind: "missing_disposition", status: "escalated", ownerType: "board",
      cause, fingerprint: `${cause}:${sourceIssueId}`, evidence: {}, nextAction: "Choose the final disposition.",
    }).returning();
    return row!;
  }

  async function attentionKinds(companyId: string) {
    const feed = await attentionService(db).list(companyId, { userId: "board-user" });
    return feed.items
      .filter((item) => item.sourceKind === "issue_thread_interaction" || item.sourceKind === "recovery_action")
      .map((item) => `${item.sourceKind}:${item.subject.id}`)
      .sort();
  }

  it.each(["done", "cancelled"] as const)("clears prompts and recovery at the source on %s and keeps them closed after reopen", async (status) => {
    const { companyId, agentId } = await seed(status === "done" ? "TAD" : "TAC");
    const issue = await insertIssue(companyId, "T-1", "in_progress", agentId);
    const confirmation = await insertConfirmation(companyId, issue.id);
    const recovery = await insertBoardRecovery(companyId, issue.id);
    expect(await attentionKinds(companyId)).toEqual([
      `issue_thread_interaction:${confirmation.id}`,
      `recovery_action:${recovery.id}`,
    ].sort());

    await issueService(db).update(issue.id, { status, actorUserId: "board-user" });

    const [interactionRow] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, confirmation.id));
    expect(interactionRow).toMatchObject({ status: "expired", result: { outcome: "issue_closed" } });
    const [recoveryRow] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, recovery.id));
    expect(recoveryRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: `Recovery action became stale because the source issue reached ${status}.`,
    });
    const activity = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, issue.id), eq(activityLog.action, "issue.recovery_action_resolved"),
    ));
    expect(activity).toHaveLength(1);
    expect(activity[0]?.details).toMatchObject({
      recoveryActionId: recovery.id,
      trigger: "issue_terminal_transition",
      sourceIssueStatus: status,
      closedByUserId: "board-user",
    });
    expect(await attentionKinds(companyId)).toEqual([]);

    // Reopening does not resurrect the closed prompts.
    await issueService(db).update(issue.id, { status: "todo", actorUserId: "board-user" });
    const [reopenedInteraction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, confirmation.id));
    expect(reopenedInteraction?.status).toBe("expired");
    const [reopenedRecovery] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, recovery.id));
    expect(reopenedRecovery?.status).toBe("cancelled");
    expect(await attentionKinds(companyId)).toEqual([]);
  });

  it("hides prompts and recovery already orphaned on closed issues without a backfill", async () => {
    const { companyId, agentId } = await seed("TAO");
    const done = await insertIssue(companyId, "T-1", "done", agentId);
    const cancelled = await insertIssue(companyId, "T-2", "cancelled", agentId);
    const open = await insertIssue(companyId, "T-3", "in_progress", agentId);
    await insertConfirmation(companyId, done.id, "CODEOWNERS approval");
    await insertConfirmation(companyId, cancelled.id);
    await insertBoardRecovery(companyId, done.id);
    await insertBoardRecovery(companyId, cancelled.id);
    const openConfirmation = await insertConfirmation(companyId, open.id, "Still needed");
    const openRecovery = await insertBoardRecovery(companyId, open.id);

    expect(await attentionKinds(companyId)).toEqual([
      `issue_thread_interaction:${openConfirmation.id}`,
      `recovery_action:${openRecovery.id}`,
    ].sort());
    const summary = await attentionService(db).summary(companyId, { userId: "board-user" });
    expect(summary.countsBySourceKind).toMatchObject({ issue_thread_interaction: 1, recovery_action: 1 });
  });

  it("keeps what a close does not settle: historical questions on done work and board stop confirmations", async () => {
    const { companyId, agentId } = await seed("TAK");
    const done = await insertIssue(companyId, "T-1", "done", agentId);
    const cancelled = await insertIssue(companyId, "T-2", "cancelled", agentId);
    const createdAt = new Date("2026-07-09T12:00:00.000Z");
    const [question] = await db.insert(issueThreadInteractions).values({
      companyId, issueId: done.id, kind: "ask_user_questions", status: "pending", continuationPolicy: "wake_assignee",
      title: "Which color?", payload: { version: 1, questions: [] }, createdAt, updatedAt: createdAt,
    }).returning();
    // A later human comment makes the question historical; it stays answerable.
    await db.insert(issueComments).values({
      companyId, issueId: done.id, authorType: "user", authorUserId: "board-user", body: "Moving on",
      createdAt: new Date(createdAt.getTime() + 1000),
    });
    const stopConfirmation = await insertBoardRecovery(companyId, cancelled.id, OWNER_UNPROVABLE_CAUSE);

    expect(await attentionKinds(companyId)).toEqual([
      `issue_thread_interaction:${question!.id}`,
      `recovery_action:${stopConfirmation.id}`,
    ].sort());
  });
});
