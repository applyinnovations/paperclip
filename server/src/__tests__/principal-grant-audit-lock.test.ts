import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Overlapping grant changes for one principal must each record only their own
// before/after, so one last-grant removal yields one removal event.
describeEmbeddedPostgres("principal grant audit lock", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-principal-grant-audit-lock-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    return db.insert(companies).values({
      name: `Grant Lock ${randomUUID()}`,
      issuePrefix: `GL${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
  }

  // Resolves once another session waits on an advisory lock, which proves the
  // second change has started and is blocked behind the first.
  async function waitForAdvisoryLockWaiter() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await db.execute(sql`select 1 from pg_locks where locktype = 'advisory' and not granted`);
      if ((rows as unknown as unknown[]).length > 0) return;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error("second grant change never waited on the principal grant lock");
  }

  it("records one assignment-grant removal for overlapping agent removals", async () => {
    const { accessService } = await import("../services/access.js");
    const { logActivity } = await import("../services/activity-log.js");
    const { assignmentGrantsRemovedActivity, summarizeAssignmentGrants } = await import("../lib/assignment-grant-audit.js");
    const access = accessService(db);
    const company = await createCompany();
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: "Locked agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
    }).returning().then((rows) => rows[0]!);
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      permissionKey: "tasks:assign",
    });

    const recorded: Array<{ actorId: string; before: string[]; after: string[] }> = [];
    const firstWrote = deferred();
    const releaseFirst = deferred();
    const removeAssign = (actorId: string, hold?: () => Promise<void>) =>
      access.changePrincipalGrantsAudited(
        company.id,
        "agent",
        agent.id,
        async (grants) => {
          await grants.setPrincipalPermission(company.id, "agent", agent.id, "tasks:assign", false, null);
          if (hold) await hold();
        },
        async ({ tx, before, after }) => {
          const summaryBefore = summarizeAssignmentGrants(before);
          const summaryAfter = summarizeAssignmentGrants(after);
          recorded.push({ actorId, before: summaryBefore.permissionKeys, after: summaryAfter.permissionKeys });
          const removed = assignmentGrantsRemovedActivity({
            actor: { companyId: company.id, actorType: "user", actorId },
            agent,
            before: summaryBefore,
            after: summaryAfter,
            sourceAction: "agent.permissions_updated",
          });
          if (removed) await logActivity(tx as unknown as Db, removed, []);
        },
      );

    const first = removeAssign("first", async () => {
      firstWrote.resolve();
      await releaseFirst.promise;
    });
    await firstWrote.promise;
    const second = removeAssign("second");
    await waitForAdvisoryLockWaiter();
    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(recorded).toEqual([
      { actorId: "first", before: ["tasks:assign"], after: [] },
      { actorId: "second", before: [], after: [] },
    ]);
    const removals = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, company.id),
      eq(activityLog.action, "agent.assignment_grants_removed"),
    ));
    expect(removals.map((row) => row.actorId)).toEqual(["first"]);
  });

  it("gives overlapping member permission writes their own before and after", async () => {
    const { accessService } = await import("../services/access.js");
    const access = accessService(db);
    const company = await createCompany();
    const member = await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: `operator-${randomUUID()}`,
      status: "active",
      membershipRole: "operator",
    }).returning().then((rows) => rows[0]!);
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: member.principalId,
      permissionKey: "agents:read",
    });

    const recorded: Array<{ writer: string; before: string[]; after: string[] }> = [];
    const firstWrote = deferred();
    const releaseFirst = deferred();
    const keys = (rows: Array<{ permissionKey: string }>) => rows.map((row) => row.permissionKey).sort();

    const first = access.setMemberPermissions(company.id, member.id, [
      { permissionKey: "agents:read" },
      { permissionKey: "tasks:assign" },
    ], null, async ({ before, after }) => {
      recorded.push({ writer: "first", before: keys(before), after: keys(after) });
      firstWrote.resolve();
      await releaseFirst.promise;
    });
    await firstWrote.promise;
    const second = access.setMemberPermissions(company.id, member.id, [], null, async ({ before, after }) => {
      recorded.push({ writer: "second", before: keys(before), after: keys(after) });
    });
    await waitForAdvisoryLockWaiter();
    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(recorded).toEqual([
      { writer: "first", before: ["agents:read"], after: ["agents:read", "tasks:assign"] },
      { writer: "second", before: ["agents:read", "tasks:assign"], after: [] },
    ]);
  });
});
