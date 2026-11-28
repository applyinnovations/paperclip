import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

// APP-827: a denied project workspace write emits exactly one structured
// security event (authz.project_write_workspace.denied) that Loki alerts on,
// with ids and enums only. Allowed writes emit nothing.

const mockLogger = vi.hoisted(() => {
  const logger: Record<string, unknown> = {};
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
    logger[level] = vi.fn();
  }
  logger.child = vi.fn(() => logger);
  return logger as Record<string, ReturnType<typeof vi.fn>> & { child: ReturnType<typeof vi.fn> };
});

vi.mock("../middleware/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../middleware/logger.js")>()),
  logger: mockLogger,
}));

const { errorHandler } = await import("../middleware/index.js");
const { loggableRunId, projectRoutes, PROJECT_WORKSPACE_WRITE_DENIED_EVENT } = await import("../routes/projects.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project workspace denial log tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

const FREE_TEXT_MARKER = `app-827-free-text-${randomUUID()}`;

function denialEvents() {
  return mockLogger.warn.mock.calls.filter(
    ([fields]) => (fields as { event?: unknown } | undefined)?.event === PROJECT_WORKSPACE_WRITE_DENIED_EVENT,
  );
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

describeEmbeddedPostgres("denied project workspace writes emit one security event (APP-827)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-workspace-denial-log-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    mockLogger.warn.mockClear();
  });

  async function seed(label: string) {
    const [company] = await db.insert(companies).values({
      name: `Workspace denial log ${label}`,
      issuePrefix: `D${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      cwd: `/tmp/app-827-${randomUUID()}`,
    }).returning();
    return { projectId: project!.id, workspaceId: workspace!.id };
  }

  async function grant(companyId: string, agentId: string, permissionKey: "tasks:assign" | "tasks:assign_scope", scope: Record<string, unknown> | null = null) {
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey,
      scope,
      grantedByUserId: null,
    });
  }

  function expectNoFreeText(fields: Record<string, unknown>) {
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain(FREE_TEXT_MARKER);
    expect(serialized).not.toContain("Workspace write denied");
    expect(serialized).not.toContain("/api/");
    expect(serialized).not.toContain("/tmp/");
    for (const value of Object.values(fields)) {
      expect(["string", "object"]).toContain(typeof value);
      if (typeof value === "object") expect(value).toBeNull();
    }
  }

  it("emits exactly one event when an agent with no assignment grant writes a workspace", async () => {
    const { companyId, agentId } = await seed("NoGrant");
    const { projectId, workspaceId } = await seedProject(companyId, "Unprotected");
    const runId = randomUUID();
    const app = createApp(db, { type: "agent", agentId, companyId, runId, source: "agent_jwt" });

    const res = await request(app)
      .patch(`/api/projects/${projectId}/workspaces/${workspaceId}`)
      .send({ name: FREE_TEXT_MARKER, cwd: `/tmp/${FREE_TEXT_MARKER}` });
    expect(res.status, JSON.stringify(res.body)).toBe(403);

    const events = denialEvents();
    expect(events).toHaveLength(1);
    const [fields, message] = events[0]!;
    expect(message).toBe("project workspace write denied");
    expect(fields).toEqual({
      event: "authz.project_write_workspace.denied",
      action: "project:write_workspace",
      companyId,
      actorType: "agent",
      actorId: agentId,
      actorAgentId: agentId,
      actorUserId: null,
      runId,
      projectId,
      reason: "deny_missing_grant",
      code: null,
      grantPermissionKey: null,
    });
    expectNoFreeText(fields as Record<string, unknown>);
  });

  it("emits exactly one event when a scope-only agent writes outside its scope", async () => {
    const { companyId, agentId } = await seed("OutOfScope");
    const inside = await seedProject(companyId, "Inside scope");
    const outside = await seedProject(companyId, "Outside scope");
    await grant(companyId, agentId, "tasks:assign_scope", { projectId: inside.projectId, assigneeAgentId: agentId });
    const app = createApp(db, { type: "agent", agentId, companyId, source: "agent_jwt" });

    const res = await request(app)
      .delete(`/api/projects/${outside.projectId}/workspaces/${outside.workspaceId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(403);

    const events = denialEvents();
    expect(events).toHaveLength(1);
    const fields = events[0]![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      event: "authz.project_write_workspace.denied",
      companyId,
      actorType: "agent",
      actorId: agentId,
      runId: null,
      projectId: outside.projectId,
      reason: "deny_scope",
    });
    expectNoFreeText(fields);
  });

  it("logs a valid run id but never a malformed X-Paperclip-Run-Id value", async () => {
    // API-key auth copies X-Paperclip-Run-Id into actor.runId verbatim
    // (middleware/auth.ts), so the denial event must not trust it.
    const { companyId, agentId } = await seed("RunIdHeader");
    const { projectId, workspaceId } = await seedProject(companyId, "Run id header");
    // The route sees only req.actor; this is the actor shape agent-key auth
    // builds, with runId taken straight from the header.
    const keyActor = {
      type: "agent" as const,
      agentId,
      companyId,
      keyId: randomUUID(),
      keyScope: { kind: "standard" as const },
      source: "agent_key" as const,
    };
    const patch = (runId: string) =>
      request(createApp(db, { ...keyActor, runId }))
        .patch(`/api/projects/${projectId}/workspaces/${workspaceId}`)
        .send({ name: "run id header" });

    const validRunId = randomUUID();
    const valid = await patch(validRunId);
    expect(valid.status, JSON.stringify(valid.body)).toBe(403);

    // Non-canonical spellings Postgres still casts to uuid, so they get past
    // the read check and reach the workspace-write denial.
    const nonCanonical = [`{${validRunId}}`, validRunId.replaceAll("-", "")];
    for (const runId of nonCanonical) {
      const res = await patch(runId);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    }

    // Free text and paths never reach any log line through this route.
    const freeText = await patch(`${FREE_TEXT_MARKER} /tmp/${FREE_TEXT_MARKER}`);
    expect(freeText.status).not.toBe(200);

    const events = denialEvents().map(([fields]) => fields as Record<string, unknown>);
    expect(events).toHaveLength(1 + nonCanonical.length);
    expect(events[0]).toMatchObject({ actorId: agentId, runId: validRunId });
    for (const fields of events.slice(1)) {
      expect(fields).toMatchObject({ actorId: agentId, runId: null, reason: "deny_missing_grant" });
    }
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(FREE_TEXT_MARKER);
  });

  it("admits only a canonical run id into the event", () => {
    const id = randomUUID();
    expect(loggableRunId(id)).toBe(id);
    expect(loggableRunId(id.toUpperCase())).toBe(id.toUpperCase());
    for (const value of [
      undefined,
      null,
      "",
      FREE_TEXT_MARKER,
      `/tmp/${FREE_TEXT_MARKER}`,
      ` ${id} `,
      `${id}\n${FREE_TEXT_MARKER}`,
      `{${id}}`,
      id.replaceAll("-", ""),
    ]) {
      expect(loggableRunId(value)).toBeNull();
    }
  });

  it("emits nothing for allowed workspace writes", async () => {
    const { companyId, agentId } = await seed("Allowed");
    const broad = await seedProject(companyId, "Broad grant");
    await grant(companyId, agentId, "tasks:assign");
    const app = createApp(db, { type: "agent", agentId, companyId, source: "agent_jwt" });

    const update = await request(app)
      .patch(`/api/projects/${broad.projectId}/workspaces/${broad.workspaceId}`)
      .send({ name: "Renamed with grant" });
    expect(update.status, JSON.stringify(update.body)).toBe(200);

    const { companyId: scopedCompanyId, agentId: scopedAgentId } = await seed("AllowedScope");
    const inside = await seedProject(scopedCompanyId, "Inside scope");
    await grant(scopedCompanyId, scopedAgentId, "tasks:assign_scope", { projectId: inside.projectId, assigneeAgentId: scopedAgentId });
    const scopedApp = createApp(db, { type: "agent", agentId: scopedAgentId, companyId: scopedCompanyId, source: "agent_jwt" });
    const scopedUpdate = await request(scopedApp)
      .patch(`/api/projects/${inside.projectId}/workspaces/${inside.workspaceId}`)
      .send({ name: "Renamed in scope" });
    expect(scopedUpdate.status, JSON.stringify(scopedUpdate.body)).toBe(200);

    expect(denialEvents()).toHaveLength(0);
  });
});
