import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/activity-log.js", async () => ({
    ...await vi.importActual<typeof import("../services/activity-log.js")>("../services/activity-log.js"),
    persistActivity: async (db: unknown, input: unknown) => {
      await mockLogActivity(db, input);
      return { activity: { id: "activity" }, publication: null };
    },
    publishActivity: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    environmentService: () => mockEnvironmentService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    secretService: () => mockSecretService,
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));
  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));
  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));
  vi.doMock("../services/workspace-runtime.js", () => ({
    startRuntimeServicesForWorkspaceControl: vi.fn(),
    stopRuntimeServicesForProjectWorkspace: vi.fn(),
  }));
}

async function createApp() {
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/projects.js")>("../routes/projects.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", projectRoutes({ transaction: async (effect: (tx: unknown) => unknown) => effect({}) } as any));
  app.use(errorHandler);
  return app;
}

function buildProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project",
    description: null,
    status: "backlog",
    leadAgentId: null,
    targetDate: null,
    color: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/project",
      effectiveLocalFolder: "/tmp/project",
      origin: "managed_checkout",
    },
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const reviewerId = "11111111-1111-4111-8111-111111111111";

describe("project defaultIssueExecutionPolicy route validation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/projects.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/secrets.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "project:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockProjectService.update.mockImplementation(async (_id, body) => buildProject({ ...body }));
    mockProjectService.create.mockImplementation(async (_companyId, body) => buildProject({ ...body }));
  });

  it("accepts valid defaultIssueExecutionPolicy (stages-only and full policy fields) on project PATCH", async () => {
    const app = await createApp();
    const policy = {
      enabled: true,
      defaultIssueExecutionPolicy: {
        mode: "normal",
        commentRequired: true,
        maxReviewRounds: 4,
        stages: [
          {
            type: "review",
            participants: [{ type: "agent", agentId: reviewerId }],
          },
        ],
      },
    };

    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({ executionWorkspacePolicy: policy });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockProjectService.update).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        executionWorkspacePolicy: expect.objectContaining({
          enabled: true,
          defaultIssueExecutionPolicy: expect.objectContaining({
            mode: "normal",
            maxReviewRounds: 4,
          }),
        }),
      }),
    );
  });

  it.each([
    ["non-array stages", { stages: "not-an-array" }],
    ["invalid stage type", { stages: [{ type: "invalid_stage", participants: [{ type: "agent", agentId: reviewerId }] }] }],
    ["agent participant without agentId", { stages: [{ type: "review", participants: [{ type: "agent" }] }] }],
    ["negative maxReviewRounds", { maxReviewRounds: -1, stages: [] }],
    ["unknown extra field", { stages: [], unknownField: true }],
    [
      "more than 10 stages",
      {
        stages: Array.from({ length: 11 }, () => ({
          type: "review",
          participants: [{ type: "agent", agentId: reviewerId }],
        })),
      },
    ],
  ])("rejects invalid defaultIssueExecutionPolicy on project PATCH (%s) with 400", async (_label, invalidPolicy) => {
    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({
        executionWorkspacePolicy: {
          enabled: true,
          defaultIssueExecutionPolicy: invalidPolicy,
        },
      });

    expect(res.status).toBe(400);
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("rejects invalid defaultIssueExecutionPolicy on project POST with 400", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Invalid Default Policy",
        executionWorkspacePolicy: {
          enabled: false,
          defaultIssueExecutionPolicy: {
            stages: [{ type: "review", participants: [{ type: "user" }] }],
          },
        },
      });

    expect(res.status).toBe(400);
    expect(mockProjectService.create).not.toHaveBeenCalled();
  });
});
