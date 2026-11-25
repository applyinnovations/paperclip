import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { authorizationService } from "../services/authorization.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

type Actor = Express.Request["actor"];

describeDatabase("PUT /api/agents/:id/grants", () => {
  let db!: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;

  const companyId = randomUUID();
  const foreignCompanyId = randomUUID();
  const ownerUserId = randomUUID();
  const operatorUserId = randomUUID();
  let intakeId = "";
  let reliabilityId = "";
  let otherId = "";
  let ceoId = "";
  let foreignId = "";

  function appFor(actor: Actor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const boardActor = (userId: string): Actor => ({
    type: "board",
    userId,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: false,
    source: "session",
  });
  const agentActor = (agentId: string): Actor => ({
    type: "agent",
    agentId,
    companyId,
    source: "agent_key",
  });

  async function grantKeys(agentId: string) {
    return (await db.select().from(principalPermissionGrants)
      .where(and(eq(principalPermissionGrants.principalType, "agent"), eq(principalPermissionGrants.principalId, agentId))))
      .map((grant) => grant.permissionKey)
      .sort();
  }

  async function canAssignTo(assigneeAgentId: string) {
    return authorizationService(db).decide({
      actor: { type: "agent", agentId: intakeId, companyId, source: "agent_key" },
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId,
        issueId: null,
        projectId: null,
        parentIssueId: null,
        assigneeAgentId,
        assigneeUserId: null,
      },
      scope: { assigneeAgentId },
    });
  }

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-grants-routes");
    db = createDb(started.connectionString);
    cleanup = started.cleanup;

    await db.insert(companies).values([
      { id: companyId, name: "Grants", issuePrefix: `GR${companyId.slice(0, 6).toUpperCase()}` },
      { id: foreignCompanyId, name: "Foreign", issuePrefix: `GF${foreignCompanyId.slice(0, 6).toUpperCase()}` },
    ]);
    await db.insert(authUsers).values([
      { id: ownerUserId, name: "Owner", email: `${ownerUserId}@example.test`, createdAt: new Date(), updatedAt: new Date() },
      { id: operatorUserId, name: "Operator", email: `${operatorUserId}@example.test`, createdAt: new Date(), updatedAt: new Date() },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: ownerUserId, membershipRole: "owner" },
      { companyId, principalType: "user", principalId: operatorUserId, membershipRole: "operator" },
    ]);
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "user", principalId: ownerUserId, permissionKey: "agents:create" },
      { companyId, principalType: "user", principalId: ownerUserId, permissionKey: "users:manage_permissions" },
      { companyId, principalType: "user", principalId: operatorUserId, permissionKey: "agents:create" },
    ]);

    const lifecycle = createAgentLifecycle(db);
    const hire = (name: string, role = "engineer", targetCompanyId = companyId) => lifecycle.requestHire(targetCompanyId, {
      name, role, adapterType: "process", adapterConfig: {}, runtimeConfig: {},
    });
    intakeId = (await hire("Alert Intake")).id;
    reliabilityId = (await hire("Platform Reliability")).id;
    otherId = (await hire("Other")).id;
    ceoId = (await hire("CEO", "ceo")).id;
    foreignId = (await hire("Foreign agent", "engineer", foreignCompanyId)).id;
    await db.insert(companyMemberships).values([
      { companyId, principalType: "agent", principalId: intakeId, membershipRole: "member" },
      { companyId, principalType: "agent", principalId: ceoId, membershipRole: "member" },
    ]);
  }, 60_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("lets the board replace an agent's grants with one scoped grant, audited", async () => {
    const before = await grantKeys(intakeId);
    expect(before).toContain("tasks:assign");
    expect((await canAssignTo(otherId)).allowed).toBe(true);

    const res = await request(appFor(boardActor(ownerUserId)))
      .put(`/api/agents/${intakeId}/grants`)
      .send({ grants: [{ permissionKey: "tasks:assign_scope", scope: { assigneeAgentIds: [reliabilityId] } }] });
    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe(intakeId);
    expect(res.body.grants).toHaveLength(1);
    expect(res.body.grants[0]).toMatchObject({
      permissionKey: "tasks:assign_scope",
      scope: { assigneeAgentIds: [reliabilityId] },
      grantedByUserId: ownerUserId,
    });
    expect(await grantKeys(intakeId)).toEqual(["tasks:assign_scope"]);

    // Task assignment by a standard-trust agent is default-open: grants are
    // consulted only when the target is protected or private. Pin that here so
    // a change to it is deliberate (see the PR for the APP-550 decision).
    expect((await canAssignTo(otherId)).allowed).toBe(true);
    const protectedPolicy = { canCreateAgents: false, authorizationPolicy: { assignmentPolicy: { mode: "protected" } } };
    await db.update(agents).set({ permissions: protectedPolicy }).where(eq(agents.id, reliabilityId));
    await db.update(agents).set({ permissions: protectedPolicy }).where(eq(agents.id, otherId));
    expect((await canAssignTo(reliabilityId)).allowed).toBe(true);
    expect((await canAssignTo(otherId)).allowed).toBe(false);
    await db.update(agents).set({ permissions: {} }).where(eq(agents.id, reliabilityId));
    await db.update(agents).set({ permissions: {} }).where(eq(agents.id, otherId));

    const rows = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, intakeId), eq(activityLog.action, "agent.grants_updated")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId, actorType: "user", actorId: ownerUserId, entityType: "agent" });
    expect(rows[0]!.details).toEqual({
      previousPermissionKeys: before,
      permissionKeys: ["tasks:assign_scope"],
      grantCount: 1,
    });

    const read = await request(appFor(boardActor(ownerUserId))).get(`/api/agents/${intakeId}/grants`);
    expect(read.status).toBe(200);
    expect(read.body.grants.map((grant: { permissionKey: string }) => grant.permissionKey)).toEqual(["tasks:assign_scope"]);
  });

  it("refuses every agent caller, the CEO included", async () => {
    const snapshot = await grantKeys(otherId);
    for (const actorId of [ceoId, intakeId, otherId]) {
      const app = appFor(agentActor(actorId));
      const put = await request(app)
        .put(`/api/agents/${otherId}/grants`)
        .send({ grants: [{ permissionKey: "agents:create" }] });
      expect(put.status).toBe(403);
      expect((await request(app).get(`/api/agents/${otherId}/grants`)).status).toBe(403);
    }
    const self = await request(appFor(agentActor(ceoId)))
      .put(`/api/agents/${ceoId}/grants`)
      .send({ grants: [{ permissionKey: "users:manage_permissions" }] });
    expect(self.status).toBe(403);
    expect(await grantKeys(otherId)).toEqual(snapshot);
    expect(await grantKeys(ceoId)).not.toContain("users:manage_permissions");
  });

  it("refuses a board user without users:manage_permissions", async () => {
    const res = await request(appFor(boardActor(operatorUserId)))
      .put(`/api/agents/${otherId}/grants`)
      .send({ grants: [] });
    expect(res.status).toBe(403);
    expect(await grantKeys(otherId)).toContain("tasks:assign");
  });

  it("does not reach an agent in another company", async () => {
    const before = await grantKeys(foreignId);
    const res = await request(appFor(boardActor(ownerUserId)))
      .put(`/api/agents/${foreignId}/grants`)
      .send({ grants: [] });
    expect(res.status).toBe(404);
    expect(await grantKeys(foreignId)).toEqual(before);
  });

  it("rejects an unknown or duplicated permissionKey with 400", async () => {
    const app = appFor(boardActor(ownerUserId));
    const unknown = await request(app)
      .put(`/api/agents/${otherId}/grants`)
      .send({ grants: [{ permissionKey: "agents:everything" }] });
    expect(unknown.status).toBe(400);
    const duplicate = await request(app)
      .put(`/api/agents/${otherId}/grants`)
      .send({ grants: [{ permissionKey: "tasks:assign" }, { permissionKey: "tasks:assign" }] });
    expect(duplicate.status).toBe(400);
    expect(await grantKeys(otherId)).toContain("agents:read");
  });

  it("keeps trimmed grants through config revision, pause and resume (no default re-seed)", async () => {
    expect(await grantKeys(intakeId)).toEqual(["tasks:assign_scope"]);
    const lifecycle = createAgentLifecycle(db);
    await lifecycle.updateConfiguration(intakeId, { title: "Alert intake bridge" });
    expect(await grantKeys(intakeId)).toEqual(["tasks:assign_scope"]);
    await lifecycle.pauseAgent(intakeId);
    await lifecycle.resumeAgent(intakeId);
    await lifecycle.updateAndTransition(intakeId, "pause", { title: "Paused bridge" });
    await lifecycle.updateAndTransition(intakeId, "resume", { title: "Alert intake bridge" });
    expect(await grantKeys(intakeId)).toEqual(["tasks:assign_scope"]);
    const [row] = await db.select({ title: agents.title }).from(agents).where(eq(agents.id, intakeId));
    expect(row!.title).toBe("Alert intake bridge");
  });
});
