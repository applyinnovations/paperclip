import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";

// APP-794: project workspace writes are authorised by the tasks:assign
// permission, so they must follow the same grant confinement as task
// assignment. Removing both assignment grants revokes workspace writes, and a
// tasks:assign_scope-only agent writes only inside the projects its scope
// covers. These exercise the real routes against a real database.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project workspace write grant tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

function agentActor(companyId: string, agentId: string, onBehalfOfUserId?: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, runId: undefined, source: "agent_jwt", onBehalfOfUserId };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", projectRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("project workspace writes follow assignment grants (APP-794)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-workspace-write-grants-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(label: string) {
    const [company] = await db.insert(companies).values({
      name: `Workspace grants ${label}`,
      issuePrefix: `W${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    await db.insert(companyMemberships).values({
      companyId: company!.id,
      principalType: "agent",
      principalId: agent!.id,
      status: "active",
      membershipRole: "member",
    });
    return { companyId: company!.id, agentId: agent!.id };
  }

  async function seedProject(companyId: string, name: string) {
    const [project] = await db.insert(projects).values({ companyId, name, status: "in_progress" }).returning();
    const [workspace] = await db.insert(projectWorkspaces).values({
      companyId,
      projectId: project!.id,
      name: "Original name",
      sourceType: "local_path",
      cwd: `/tmp/app-794-${randomUUID()}`,
    }).returning();
    return { projectId: project!.id, workspaceId: workspace!.id };
  }

  async function grant(companyId: string, agentId: string, permissionKey: "tasks:assign" | "tasks:assign_scope", scope: Record<string, unknown> | null = null) {
    const [row] = await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey,
      scope,
      grantedByUserId: null,
    }).returning();
    return row!;
  }

  async function workspaceRow(workspaceId: string) {
    return db.select().from(projectWorkspaces).where(eq(projectWorkspaces.id, workspaceId)).then((rows) => rows[0] ?? null);
  }

  it("denies workspace update and delete on an unprotected project once both assignment grants are removed", async () => {
    const { companyId, agentId } = await seed("Revoked");
    const { projectId, workspaceId } = await seedProject(companyId, "Unprotected");
    const broad = await grant(companyId, agentId, "tasks:assign");
    const scoped = await grant(companyId, agentId, "tasks:assign_scope", { projectId, assigneeAgentId: agentId });
    const app = createApp(db, agentActor(companyId, agentId));

    const allowed = await request(app)
      .patch(`/api/projects/${projectId}/workspaces/${workspaceId}`)
      .send({ name: "Renamed with grants" });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);

    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.id, broad.id));
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.id, scoped.id));

    const update = await request(app)
      .patch(`/api/projects/${projectId}/workspaces/${workspaceId}`)
      .send({ name: "Renamed without grants" });
    expect(update.status, JSON.stringify(update.body)).toBe(403);
    expect(update.body.error).toContain("Workspace write denied");
    expect(update.body.error).toContain("neither tasks:assign nor tasks:assign_scope");

    const remove = await request(app).delete(`/api/projects/${projectId}/workspaces/${workspaceId}`);
    expect(remove.status, JSON.stringify(remove.body)).toBe(403);

    expect(await workspaceRow(workspaceId)).toMatchObject({ name: "Renamed with grants" });
  });

  it("confines a tasks:assign_scope-only agent to the projects in its scope", async () => {
    const { companyId, agentId } = await seed("ScopeOnly");
    const inside = await seedProject(companyId, "Inside scope");
    const outside = await seedProject(companyId, "Outside scope");
    await grant(companyId, agentId, "tasks:assign_scope", { projectId: inside.projectId, assigneeAgentId: agentId });
    const app = createApp(db, agentActor(companyId, agentId));

    const allowed = await request(app)
      .patch(`/api/projects/${inside.projectId}/workspaces/${inside.workspaceId}`)
      .send({ name: "Renamed in scope" });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);

    const update = await request(app)
      .patch(`/api/projects/${outside.projectId}/workspaces/${outside.workspaceId}`)
      .send({ name: "Renamed out of scope" });
    expect(update.status, JSON.stringify(update.body)).toBe(403);
    expect(update.body.error).toContain("this project is outside that scope");

    const remove = await request(app).delete(`/api/projects/${outside.projectId}/workspaces/${outside.workspaceId}`);
    expect(remove.status, JSON.stringify(remove.body)).toBe(403);

    expect(await workspaceRow(inside.workspaceId)).toMatchObject({ name: "Renamed in scope" });
    expect(await workspaceRow(outside.workspaceId)).toMatchObject({ name: "Original name" });
  });

  it("keeps workspace writes for a new agent's default self-subtree grant", async () => {
    // New agents get tasks:assign_scope { subtreeRootAgentId: self } (agent-permissions.ts).
    // The route passes the actor as the assignee, so that default must keep
    // allowing the agent's own workspace writes on unprotected projects.
    const { companyId, agentId } = await seed("DefaultScope");
    const { projectId, workspaceId } = await seedProject(companyId, "Unprotected");
    await grant(companyId, agentId, "tasks:assign_scope", { subtreeRootAgentId: agentId });
    const app = createApp(db, agentActor(companyId, agentId));

    const update = await request(app)
      .patch(`/api/projects/${projectId}/workspaces/${workspaceId}`)
      .send({ name: "Renamed with default grant" });
    expect(update.status, JSON.stringify(update.body)).toBe(200);
    expect(await workspaceRow(workspaceId)).toMatchObject({ name: "Renamed with default grant" });
  });

  it("keeps the responsible-user ceiling for agents that hold tasks:assign", async () => {
    const { companyId, agentId } = await seed("Ceiling");
    const { projectId, workspaceId } = await seedProject(companyId, "Unprotected");
    await grant(companyId, agentId, "tasks:assign");
    const app = createApp(db, agentActor(companyId, agentId, `missing-${randomUUID()}`));

    const update = await request(app)
      .patch(`/api/projects/${projectId}/workspaces/${workspaceId}`)
      .send({ name: "Renamed by unavailable user" });
    expect(update.status, JSON.stringify(update.body)).toBe(403);
    expect(await workspaceRow(workspaceId)).toMatchObject({ name: "Original name" });
  });
});
