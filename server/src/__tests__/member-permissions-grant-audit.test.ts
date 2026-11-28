import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
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

async function createApp(db: Db, companyId: string, userId: string) {
  const { accessRoutes } = await import("../routes/access.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId,
      source: "local_implicit",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", accessRoutes(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

describeEmbeddedPostgres("member permissions route grant audit", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    await import("../routes/access.js");
  }, 30_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-permissions-grant-audit-");
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

  async function setup(agentStatus = "idle") {
    const company = await db.insert(companies).values({
      name: `Grant Audit ${randomUUID()}`,
      issuePrefix: `GA${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const ownerUserId = `owner-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: ownerUserId,
      status: "active",
      membershipRole: "owner",
    });
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: "Audited agent",
      role: "engineer",
      status: agentStatus,
      adapterType: "process",
      adapterConfig: {},
    }).returning().then((rows) => rows[0]!);
    const member = await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      status: "active",
      membershipRole: "member",
    }).returning().then((rows) => rows[0]!);
    const app = await createApp(db, company.id, ownerUserId);
    const activity = async (action: string) =>
      db.select().from(activityLog)
        .where(and(eq(activityLog.companyId, company.id), eq(activityLog.action, action)));
    const updates: Array<Record<string, any>> = [];
    // Returns the route's own permissions_updated entry, so ordering by a
    // shared timestamp never matters.
    const putGrants = async (grants: Array<{ permissionKey: string; scope?: Record<string, unknown> | null }>) => {
      await request(app).patch(`/api/companies/${company.id}/members/${member.id}/permissions`).send({ grants });
      const seen = new Set(updates.map((entry) => entry.id));
      const fresh = (await activity("company_member.permissions_updated")).filter((entry) => !seen.has(entry.id));
      expect(fresh).toHaveLength(1);
      updates.push(fresh[0]!);
      return fresh[0]!;
    };
    return { company, ownerUserId, agent, member, putGrants, activity };
  }

  const ids = (overrides: Partial<Record<"projectIds" | "agentIds" | "userIds" | "subtreeRootAgentIds", string[]>>) => ({
    projectIds: [],
    agentIds: [],
    userIds: [],
    subtreeRootAgentIds: [],
    ...overrides,
  });

  it("records before and after grants, including scope-only edits", async () => {
    const { agent, member, putGrants, activity } = await setup();

    const entries = [
      await putGrants([{ permissionKey: "agents:read" }]),
      await putGrants([
        { permissionKey: "agents:read" },
        { permissionKey: "tasks:assign" },
        { permissionKey: "tasks:assign_scope", scope: { projectIds: ["project-b", "project-a"], secretNote: "x" } },
      ]),
      await putGrants([
        { permissionKey: "agents:read" },
        { permissionKey: "tasks:assign" },
        { permissionKey: "tasks:assign_scope", scope: { subtreeRootAgentId: agent.id, allow: ["project:project-c"] } },
      ]),
    ];
    expect(entries.every((entry) => entry.entityId === member.id)).toBe(true);
    expect(entries[1]!.details).toMatchObject({
      grantCount: 3,
      before: { permissionKeys: ["agents:read"], assignScope: null },
      after: {
        permissionKeys: ["agents:read", "tasks:assign", "tasks:assign_scope"],
        assignScope: {
          "tasks:assign": null,
          "tasks:assign_scope": ids({ projectIds: ["project-a", "project-b"] }),
        },
      },
    });
    // A scope-only change is visible: the keys match but the scope ids differ.
    expect(entries[2]!.details).toMatchObject({
      before: entries[1]!.details!.after,
      after: {
        permissionKeys: ["agents:read", "tasks:assign", "tasks:assign_scope"],
        assignScope: {
          "tasks:assign": null,
          "tasks:assign_scope": ids({ projectIds: ["project-c"], subtreeRootAgentIds: [agent.id] }),
        },
      },
    });
    expect(JSON.stringify(entries.map((entry) => entry.details))).not.toContain("secretNote");
    expect(await activity("agent.assignment_grants_removed")).toHaveLength(0);
  });

  it("records the removal of an agent's last assignment grant once", async () => {
    const { agent, ownerUserId, putGrants, activity } = await setup();

    await putGrants([
      { permissionKey: "tasks:assign" },
      { permissionKey: "tasks:assign_scope", scope: { subtreeRootAgentId: agent.id } },
    ]);
    await putGrants([{ permissionKey: "tasks:assign_scope", scope: { subtreeRootAgentId: agent.id } }]);
    expect(await activity("agent.assignment_grants_removed")).toHaveLength(0);

    await putGrants([{ permissionKey: "agents:read" }]);
    const removed = await activity("agent.assignment_grants_removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      actorType: "user",
      actorId: ownerUserId,
      entityType: "agent",
      entityId: agent.id,
      details: {
        before: {
          permissionKeys: ["tasks:assign_scope"],
          assignScope: { "tasks:assign_scope": ids({ subtreeRootAgentIds: [agent.id] }) },
        },
        after: { permissionKeys: ["agents:read"], assignScope: null },
        sourceAction: "company_member.permissions_updated",
      },
    });

    // A no-op and an unrelated update while the agent already has none.
    await putGrants([{ permissionKey: "agents:read" }]);
    await putGrants([]);
    expect(await activity("agent.assignment_grants_removed")).toHaveLength(1);
    expect(await activity("company_member.permissions_updated")).toHaveLength(5);
  });

  it.each(["pending_approval", "terminated"])("does not record a removal for a %s agent", async (status) => {
    const { putGrants, activity } = await setup(status);

    await putGrants([{ permissionKey: "tasks:assign" }]);
    const entry = await putGrants([]);

    expect(entry.details).toMatchObject({
      before: { permissionKeys: ["tasks:assign"] },
      after: { permissionKeys: [], assignScope: null },
    });
    expect(await activity("agent.assignment_grants_removed")).toHaveLength(0);
  });
});
