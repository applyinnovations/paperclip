import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// APP-790/APP-799: a denied tasks:assign decision emits exactly one structured
// security event (authz.tasks_assign.denied) that Loki alerts on, with ids and
// enums only. Allowed assignments emit nothing.

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

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

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

const { issueRoutes, loggableOpaqueId, loggableUuid, TASKS_ASSIGN_DENIED_EVENT } = await import("../routes/issues.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres tasks:assign denial log tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

const EXPECTED_FIELDS = [
  "event",
  "action",
  "companyId",
  "actorType",
  "actorId",
  "actorAgentId",
  "actorUserId",
  "runId",
  "targetAssigneeAgentId",
  "targetAssigneeUserId",
  "issueId",
  "parentIssueId",
  "projectId",
  "reason",
  "code",
  "grantPermissionKey",
].sort();

function denialEvents() {
  return mockLogger.warn.mock.calls.filter(
    ([fields]) => (fields as { event?: unknown } | undefined)?.event === TASKS_ASSIGN_DENIED_EVENT,
  );
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error", details: err.details });
  });
  return app;
}

describeEmbeddedPostgres("denied tasks:assign decisions emit one security event (APP-799)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tasks-assign-denial-log-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  beforeEach(() => {
    mockLogger.warn.mockClear();
  });

  afterEach(async () => {
    // Issue creation also writes activity_log (and other) rows that reference
    // runs and issues; cascade from companies rather than tracking each table.
    await db.execute(sql`TRUNCATE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // A target agent with a protected assignment policy is "restricted": a
  // standard agent may assign to it only with a tasks:assign grant. This denies
  // a grantless actor regardless of the company-default assignment rule.
  const PROTECTED_TARGET = { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } };

  async function seed(label: string, targetPermissions: Record<string, unknown> = PROTECTED_TARGET) {
    const [company] = await db.insert(companies).values({
      name: `Assign denial log ${label}`,
      issuePrefix: `T${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    }).returning();
    const insertAgent = async (permissions: Record<string, unknown> = {}) => {
      const [agent] = await db.insert(agents).values({
        companyId: company!.id,
        name: `Agent ${randomUUID()}`,
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions,
      }).returning();
      return agent!;
    };
    const actorAgent = await insertAgent();
    const targetAgent = await insertAgent(targetPermissions);
    await db.insert(companyMemberships).values({
      companyId: company!.id,
      principalType: "agent",
      principalId: actorAgent.id,
      status: "active",
      membershipRole: "member",
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company!.id,
      agentId: actorAgent.id,
      status: "running",
    }).returning();
    return { companyId: company!.id, actorAgentId: actorAgent.id, targetAgentId: targetAgent.id, runId: run!.id };
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
  }

  it("logs exactly one id-only line when an agent without a grant assigns another agent", async () => {
    const { companyId, actorAgentId, targetAgentId, runId } = await seed("denied");
    const marker = `app-799-free-text-${randomUUID()}`;
    const app = createApp(db, agentActor(companyId, actorAgentId, runId));

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: `Title ${marker}`, description: `Description ${marker}`, assigneeAgentId: targetAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    // The logged reason/code are the decision's own, as exposed in the 403 details.
    expect(res.body.details?.reason).toBe("deny_policy_restricted");
    const events = denialEvents();
    expect(events).toHaveLength(1);
    const [fields, message] = events[0]!;
    expect(message).toBe("tasks assign denied");
    expect(Object.keys(fields).sort()).toEqual(EXPECTED_FIELDS);
    expect(fields).toEqual({
      event: "authz.tasks_assign.denied",
      action: "tasks:assign",
      companyId,
      actorType: "agent",
      actorId: actorAgentId,
      actorAgentId,
      actorUserId: null,
      runId,
      targetAssigneeAgentId: targetAgentId,
      targetAssigneeUserId: null,
      issueId: null,
      parentIssueId: null,
      projectId: null,
      reason: res.body.details.reason,
      code: res.body.details.code ?? null,
      grantPermissionKey: null,
    });
    expect(JSON.stringify(events)).not.toContain(marker);
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(marker);
  });

  it("logs nothing new for an allowed assignment", async () => {
    const { companyId, actorAgentId, targetAgentId, runId } = await seed("allowed");
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: actorAgentId,
      permissionKey: "tasks:assign",
      scope: null,
      grantedByUserId: null,
    });
    const app = createApp(db, agentActor(companyId, actorAgentId, runId));

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Allowed assignment", assigneeAgentId: targetAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(denialEvents()).toHaveLength(0);
  });
});

describe("tasks:assign denial log id sanitising", () => {
  it("keeps only canonical UUIDs and opaque id tokens", () => {
    const id = randomUUID();
    expect(loggableUuid(id)).toBe(id);
    expect(loggableUuid(` ${id}`)).toBeNull();
    expect(loggableUuid("not a uuid")).toBeNull();
    expect(loggableUuid(undefined)).toBeNull();
    expect(loggableOpaqueId("user_AbC-123")).toBe("user_AbC-123");
    expect(loggableOpaqueId("free text with spaces")).toBeNull();
    expect(loggableOpaqueId("x".repeat(129))).toBeNull();
    expect(loggableOpaqueId(null)).toBeNull();
  });
});
