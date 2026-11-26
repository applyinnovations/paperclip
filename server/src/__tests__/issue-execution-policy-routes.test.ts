import express from "express";
import request from "supertest";
import { getTableName } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  findOpenAncestorCreatedByAgent: vi.fn(async () => null),
  assertCheckoutOwner: vi.fn(),
  count: vi.fn(async () => 1),
  create: vi.fn(),
  update: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));
const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async (): Promise<{ outcome: "triggered" } | { outcome: "skipped"; reason: string }> => ({ outcome: "triggered" })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  decide: vi.fn(),
  hasPermission: vi.fn(async () => false),
}));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  for: () => ({
    then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve([{
        id: "55555555-5555-4555-8555-555555555555",
        companyId: "company-1",
        agentId: "33333333-3333-4333-8333-333333333333",
        contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        permissions: null,
      }]).then(onFulfilled, onRejected),
  }),
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{
      id: "55555555-5555-4555-8555-555555555555",
      companyId: "company-1",
      agentId: "33333333-3333-4333-8333-333333333333",
      contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      permissions: null,
    }]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (callback: (tx: { select: typeof mockDbSelect }) => Promise<unknown>) =>
    callback({ select: mockDbSelect })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async (_db: unknown, _input: unknown) => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  listForIssue: vi.fn(async (): Promise<unknown[]> => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));
const mockRunnerGoalService = vi.hoisted(() => ({
  projection: vi.fn(async () => null),
  act: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/queued-interaction-response.js", () => ({
    hasQueuedInteractionResponse: vi.fn(async () => false),
  }));
  vi.doMock("../services/runner-goals.js", () => ({
    runnerGoalService: () => mockRunnerGoalService,
    RunnerGoalActionError: class RunnerGoalActionError extends Error {},
    RunnerGoalConflictError: class RunnerGoalConflictError extends Error {},
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1" })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async (agentId: string) => ({
        id: agentId,
        companyId: "company-1",
        permissions: null,
      })),
      resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: {
          id: reference,
          companyId: "company-1",
          status: "idle",
          orgChainHealth: { status: "healthy" },
        },
      })),
    }),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({
      getById: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      source: "local_implicit";
      isInstanceAdmin: boolean;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      runId: string | null;
    };

function loadAppModules() {
  return Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
}

async function createApp(actor?: TestActor) {
  const [{ errorHandler }, { issueRoutes }] = await loadAppModules();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue execution policy routes", () => {
  beforeAll(async () => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    await loadAppModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelectWhere.mockImplementation(() => ({
      for: () => ({
        then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve([{
            id: "55555555-5555-4555-8555-555555555555",
            companyId: "company-1",
            agentId: "33333333-3333-4333-8333-333333333333",
            contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
            permissions: null,
          }]).then(onFulfilled, onRejected),
      }),
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{
          id: "55555555-5555-4555-8555-555555555555",
          companyId: "company-1",
          agentId: "33333333-3333-4333-8333-333333333333",
          contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          permissions: null,
        }]).then(onFulfilled, onRejected),
    }));
    mockIssueService.create.mockResolvedValue({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      companyId: "company-1",
      identifier: "PAP-1003",
      title: "Created issue",
      status: "todo",
      projectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdAt: new Date(),
    });
    mockProjectService.getById.mockResolvedValue({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      companyId: "company-1",
      name: "Gated project",
      visibility: "open",
      executionWorkspacePolicy: null,
    });
    mockIssueService.createChild.mockResolvedValue({
      issue: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        companyId: "company-1",
        identifier: "PAP-1002",
        title: "Child issue",
      },
      parentBlockerAdded: false,
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
      const allowed = input.actor?.type === "board" && input.actor.source === "local_implicit"
        ? true
        : input.actor?.type === "agent" && [
            "company_scope:read",
            "project:read",
            "issue:read",
            "issue:mutate",
            "runtime:manage",
          ].includes(input.action ?? "")
          ? true
          : Boolean(await mockAccessService.canUser() || await mockAccessService.hasPermission());
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it.each([
    { status: "done" },
    { status: "cancelled" },
    { assigneeAgentId: "33333333-3333-4333-8333-333333333333" },
    { assigneeUserId: "operator" },
    { interrupt: true },
    { comment: "Continue now" },
  ])("rejects mixed snapshot-guarded updates before execution side effects: %j", async (controlFields) => {
    const res = await request(await createApp({ type: "board", source: "local_implicit", userId: "local-board", companyIds: ["company-1"], isInstanceAdmin: false }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ expectedExecutionPolicy: null, executionPolicy: null, ...controlFields });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("policy-only");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockRunnerGoalService.act).not.toHaveBeenCalled();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("rejects a snapshot without a policy update", async () => {
    const res = await request(await createApp({ type: "board", source: "local_implicit", userId: "local-board", companyIds: ["company-1"], isInstanceAdmin: false }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ expectedExecutionPolicy: null });
    expect(res.status).toBe(422);
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects a stale status version before changing or waking a task", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", companyId: "company-1",
      status: "backlog", statusVersion: 8, title: "Prepared task", identifier: "TEST-1",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333", assigneeUserId: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "todo", statusVersion: 9 });
    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`).send({ status: "todo", expectedStatusVersion: 7 });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ code: "issue_status_version_changed" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("does not adopt a checkout when a prepared task became active before promotion", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", companyId: "company-1",
      status: "in_progress", statusVersion: 8, title: "Active task", identifier: "TEST-1",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333", assigneeUserId: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.assertCheckoutOwner.mockResolvedValueOnce({ adoptedFromRunId: "previous-run" });
    const res = await request(await createApp({
      type: "agent", agentId: issue.assigneeAgentId, companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    })).patch(`/api/issues/${issue.id}`).send({ status: "todo", expectedStatusVersion: 7 });
    expect(res.status).toBe(409);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("forwards a matching status version to the locked update", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", companyId: "company-1",
      status: "backlog", statusVersion: 7, title: "Prepared task", identifier: "TEST-1",
      assigneeAgentId: null, assigneeUserId: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "todo", statusVersion: 8 });
    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`).send({ status: "todo", expectedStatusVersion: 7 });
    expect(res.status).toBe(200);
    expect(mockIssueService.update.mock.calls[0]?.[1]).toMatchObject({
      status: "todo", expectedStatusVersion: 7,
    });
  });

  it("does not audit or wake a promotion rejected by the locked version check", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", companyId: "company-1",
      status: "backlog", statusVersion: 7, title: "Prepared task", identifier: "TEST-1",
      assigneeAgentId: null, assigneeUserId: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    const { conflict } = await import("../errors.js");
    mockIssueService.update.mockRejectedValueOnce(conflict("The task changed", { code: "issue_status_version_changed" }));
    const res = await request(await createApp())
      .patch(`/api/issues/${issue.id}`).send({ status: "todo", expectedStatusVersion: 7 });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ code: "issue_status_version_changed" });
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it.each([
    { status: "done" }, { status: "cancelled" }, { title: "Changed" },
    { assigneeAgentId: "33333333-3333-4333-8333-333333333333" },
    { comment: "Start work" }, { interrupt: true }, { executionPolicy: null },
  ])("rejects mixed version-guarded promotions before execution effects: %j", async (fields) => {
    const res = await request(await createApp()).patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "todo", expectedStatusVersion: 0, ...fields });
    expect(res.status).toBe(422);
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("reauthorizes a terminal verdict against the review policy held under the update lock", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      reviewPolicy: "anyone",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1002",
      title: "Concurrent policy update",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.getByIdForUpdate.mockResolvedValue({
      ...issue,
      reviewPolicy: "human_only",
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "done" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      details: {
        code: "review_policy_denied",
        policy: "human_only",
      },
    });
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(mockIssueService.getByIdForUpdate).toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects an agent-authored in_review transition without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1003",
      title: "Missing review path",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid_issue_disposition");
    expect(res.body.error).toContain("request_confirmation");
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "review_path",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows an agent-authored in_review transition with a pending confirmation interaction", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
      {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "request_confirmation",
        status: "pending",
        createdByAgentId: "33333333-3333-4333-8333-333333333333",
        sourceRunId: "55555555-5555-4555-8555-555555555555",
      },
    ]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ status: "in_review" }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.not.objectContaining({ reviewInteractionId: expect.anything() }),
      }),
      expect.any(Array),
    );
    expect(mockLogActivity.mock.calls[0]?.[0]).toBe(mockIssueService.update.mock.calls[0]?.[2]);
  });

  it("binds an explicitly designated same-run confirmation to the review transition", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
      sourceRunId: "55555555-5555-4555-8555-555555555555",
      payload: { version: 1, prompt: "Approve this review?" },
    }]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        reviewInteractionId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.not.objectContaining({ reviewInteractionId: expect.anything() }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          reviewInteractionId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      expect.any(Array),
    );
  });

  it("binds a user-designated confirmation to the review transition activity", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: null,
      createdByUserId: "local-board",
      sourceRunId: null,
      payload: { version: 1, prompt: "Approve this review?" },
    }]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      changes: { status: { from: "todo", to: "in_review" } },
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        reviewInteractionId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.not.objectContaining({ reviewInteractionId: expect.anything() }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        actorType: "user",
        actorId: "local-board",
        details: expect.objectContaining({
          reviewInteractionId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
      expect.any(Array),
    );
  });

  it("keeps a review transition and its confirmation binding in one rollback boundary", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
      sourceRunId: "55555555-5555-4555-8555-555555555555",
      payload: { version: 1, prompt: "Approve this review?" },
    }]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      changes: { status: { from: "todo", to: "in_review" } },
      updatedAt: new Date(),
    }));
    mockLogActivity.mockRejectedValueOnce(new Error("activity insert failed"));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        reviewInteractionId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(500);
    expect(mockDb.transaction).toHaveBeenCalled();
    const updateTx = mockIssueService.update.mock.calls[0]?.[2];
    const activityTx = mockLogActivity.mock.calls[0]?.[0];
    expect(activityTx).toBe(updateTx);
  });

  it("rejects a review binding to a confirmation from another run", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "request_confirmation",
      status: "pending",
      createdByAgentId: "33333333-3333-4333-8333-333333333333",
      sourceRunId: "44444444-4444-4444-8444-444444444444",
      payload: { version: 1, prompt: "Approve another run's request?" },
    }]);

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        reviewInteractionId: "11111111-1111-4111-8111-111111111111",
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("created by this agent run"),
      details: { code: "invalid_review_interaction" },
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows an agent-authored in_review transition with a typed execution participant", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1005",
      title: "Execution participant",
      executionPolicy: null,
      executionState: null,
    };
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
        },
      ],
    })!;
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        executionState: expect.objectContaining({
          status: "pending",
          currentParticipant: expect.objectContaining({
            type: "agent",
            agentId: "44444444-4444-4444-8444-444444444444",
          }),
        }),
      }),
      expect.anything(),
    );
  });

  it("allows an agent-authored in_review transition with a scheduled monitor", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1006",
      title: "External review monitor",
      executionPolicy: null,
      executionState: null,
      monitorAttemptCount: 0,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
      monitorNotes: null,
      monitorScheduledBy: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-12-01T12:00:00.000Z",
            scheduledBy: "assignee",
            notes: "Wait for external QA report.",
          },
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        monitorNextCheckAt: new Date("2026-12-01T12:00:00.000Z"),
      }),
      expect.anything(),
    );
  });

  it("allows board-authored in_review repair updates without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1007",
      title: "Board repair",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockDb.transaction).toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        actorType: "user",
        actorId: "local-board",
        details: expect.objectContaining({ status: "in_review" }),
      }),
      expect.any(Array),
    );
    expect(mockLogActivity.mock.calls[0]?.[0]).toBe(mockIssueService.update.mock.calls[0]?.[2]);
    expect(mockIssueThreadInteractionService.listForIssue).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });

  it("allows a board user to cancel an active agent review task", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1008",
      title: "Active review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "cancelled",
        executionState: null,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
      expect.anything(),
      undefined,
      expect.any(Array),
    );
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("allows a board user to cancel a drifted pending agent review task", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "blocked",
      assigneeAgentId: "44444444-4444-4444-8444-444444444444",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1009",
      title: "Drifted active review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "cancelled",
        executionState: null,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
      expect.anything(),
      undefined,
      expect.any(Array),
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBe("cancelled");
    expect(updatePatch.assigneeAgentId).toBeUndefined();
    expect(updatePatch.assigneeUserId).toBeUndefined();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("keeps the review stage pending when a board user reassigns to an eligible participant", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [
            { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
            { type: "agent", agentId: "55555555-5555-4555-8555-555555555555" },
          ],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1010",
      title: "Reassigned review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ assigneeAgentId: "55555555-5555-4555-8555-555555555555" });

    expect(res.status).toBe(200);
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBe("in_review");
    expect(updatePatch.assigneeAgentId).toBe("55555555-5555-4555-8555-555555555555");
    expect(updatePatch.assigneeUserId).toBeNull();
    expect(updatePatch.executionState).toMatchObject({
      status: "pending",
      currentStageId: "11111111-1111-4111-8111-111111111111",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: "55555555-5555-4555-8555-555555555555" },
      returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
    });
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("lets the pending review participant schedule a monitor without dissolving the review stage", async () => {
    // APP-448: a reviewer waiting on CI for the new head leaves a monitor on
    // the review stage. A monitor-only policy body must merge onto the stored
    // policy, not replace it and drop the stage the review is pending on.
    const policy = normalizeIssueExecutionPolicy({
      commentRequired: true,
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1012",
      title: "Review waiting on CI",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
      monitorAttemptCount: 0,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
      monitorNotes: null,
      monitorScheduledBy: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-12-01T12:00:00.000Z",
            kind: "external_service",
            serviceName: "tekton",
            externalRef: "image-build-all-lpbbg",
            notes: "Approve once CI is green on head ab0a5d8.",
          },
        },
      });

    expect(res.status).toBe(200);
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status ?? "in_review").toBe("in_review");
    expect(updatePatch.assigneeAgentId ?? issue.assigneeAgentId).toBe("33333333-3333-4333-8333-333333333333");
    expect(updatePatch.monitorNextCheckAt).toEqual(new Date("2026-12-01T12:00:00.000Z"));
    expect(updatePatch.executionPolicy).toMatchObject({
      commentRequired: true,
      stages: [expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111", type: "review" })],
      monitor: expect.objectContaining({ nextCheckAt: "2026-12-01T12:00:00.000Z", scheduledBy: "assignee" }),
    });
    expect(updatePatch.executionState).toMatchObject({
      status: "pending",
      currentStageId: "11111111-1111-4111-8111-111111111111",
      currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
      monitor: expect.objectContaining({ status: "scheduled" }),
    });
  });

  it("points a pending review participant at a monitor when it tries an unblock descriptor", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1013",
      title: "Review waiting on CI",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        unblockDescriptor: {
          owner: { agentId: "33333333-3333-4333-8333-333333333333" },
          action: "Approve once CI is green.",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("unblockDescriptor requires blocked status");
    expect(res.body.error).toContain("executionPolicy.monitor");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("dissolves the review when a board user reassigns an in_review task to a non-participant", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1011",
      title: "Reassigned away from review",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
        returnAssignee: { type: "agent", agentId: "44444444-4444-4444-8444-444444444444" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ assigneeAgentId: "55555555-5555-4555-8555-555555555555" });

    expect(res.status).toBe(200);
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBe("in_progress");
    expect(updatePatch.executionState).toBeNull();
    expect(updatePatch.assigneeAgentId).toBe("55555555-5555-4555-8555-555555555555");
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("does not auto-start execution review when reviewers are added to an already in_review issue", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-999",
      title: "Execution policy edit",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: policy,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBeUndefined();
    expect(updatePatch.assigneeAgentId).toBeUndefined();
    expect(updatePatch.assigneeUserId).toBeUndefined();
    expect(updatePatch.executionState).toBeUndefined();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it.each(["in_progress", "blocked"])("triggers a scheduled monitor on an %s task from the dedicated route", async (status) => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status,
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Manual monitor trigger",
      executionPolicy: normalizeIssueExecutionPolicy({
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      }),
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/monitor/check-now")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockHeartbeatService.triggerIssueMonitor).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        actorType: "user",
        actorId: "local-board",
        agentId: null,
      }),
    );
  });

  it.each(["execution_reconciliation_required", "monitor_dispatch_deferred", "monitor_replaced"])("does not claim success for a skipped monitor check: %s", async (reason) => {
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", companyId: "company-1", status: "blocked",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333", assigneeUserId: null,
    });
    mockHeartbeatService.triggerIssueMonitor.mockResolvedValueOnce({ outcome: "skipped", reason });
    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/monitor/check-now").send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ details: { code: "issue_monitor_check_deferred", reason } });
    if (reason === "monitor_replaced") expect(res.body.error).toContain("monitor changed");
    expect(res.body.ok).toBeUndefined();
  });

  it("lets a board user create a child issue with a scheduled monitor", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "assignee",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("board");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        details: expect.objectContaining({
          scheduledBy: "board",
        }),
      }),
    );
  });

  it.each([
    ["a board user's explicit null policy opts out of", undefined, { executionPolicy: null }, true],
    ["a board user's omitted policy keeps", undefined, {}, false],
    [
      "a non-board agent's explicit null policy still keeps",
      {
        type: "agent" as const,
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "55555555-5555-4555-8555-555555555555",
      },
      { executionPolicy: null },
      false,
    ],
    [
      "a non-board agent's omitted policy keeps",
      {
        type: "agent" as const,
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "55555555-5555-4555-8555-555555555555",
      },
      {},
      false,
    ],
  ])("%s the project's default stages on child creation", async (_label, actor, policyField, skip) => {
    if (actor) mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp(actor))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({ title: "Release", ...policyField });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.createChild.mock.calls[0]?.[1]).toMatchObject({ skipProjectDefaultExecutionStages: skip });
  });

  it.each([
    ["a board user's explicit null policy opts out of", undefined, { executionPolicy: null }, true],
    ["a board user's omitted policy keeps", undefined, {}, false],
    [
      "a non-board agent's explicit null policy still keeps",
      {
        type: "agent" as const,
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: null,
      },
      { executionPolicy: null },
      false,
    ],
    [
      "a non-board agent's omitted policy keeps",
      {
        type: "agent" as const,
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: null,
      },
      {},
      false,
    ],
  ])("%s the project's default stages on issue creation", async (_label, actor, policyField, skip) => {
    if (actor) mockAccessService.hasPermission.mockResolvedValue(true);
    const res = await request(await createApp(actor))
      .post("/api/companies/company-1/issues")
      .send({
        title: "Project task",
        projectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        ...policyField,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create.mock.calls[0]?.[1]).toMatchObject({
      projectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      skipProjectDefaultExecutionStages: skip,
    });
  });

  it("honors a board user's custom executionPolicy on issue creation", async () => {
    const customPolicy = {
      stages: [
        {
          type: "approval" as const,
          participants: [{ type: "agent" as const, agentId: "44444444-4444-4444-8444-444444444444" }],
        },
      ],
    };

    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Board custom policy task",
        projectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        executionPolicy: customPolicy,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create.mock.calls[0]?.[1]).toMatchObject({
      skipProjectDefaultExecutionStages: false,
      executionPolicy: expect.objectContaining({
        stages: [
          expect.objectContaining({
            type: "approval",
            participants: [expect.objectContaining({ agentId: "44444444-4444-4444-8444-444444444444" })],
          }),
        ],
      }),
    });
  });

  it("rejects child monitor scheduling by a non-assignee agent even with task assignment permission", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the assignee agent or a board user can manage issue monitors");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("normalizes spoofed child monitor scheduledBy to the assignee actor", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
            externalRef: "https://example.test/deploy?token=secret",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string; externalRef: string | null } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("assignee");
    expect(createPayload.executionPolicy.monitor.externalRef).toBe("[redacted]");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        entityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        details: expect.not.objectContaining({ externalRef: expect.anything() }),
      }),
    );
  });

  describe("mandatory structured review decisions", () => {
    const executorAgentId = "33333333-3333-4333-8333-333333333333";
    const reviewerAgentId = "44444444-4444-4444-8444-444444444444";
    const reviewStageId = "11111111-1111-4111-8111-111111111111";

    function reviewStagePolicy() {
      return normalizeIssueExecutionPolicy({
        stages: [
          {
            id: reviewStageId,
            type: "review",
            participants: [{ type: "agent", agentId: reviewerAgentId }],
          },
        ],
      })!;
    }

    function mockAgentRunAndDecisions(agentId: string, decisionRows: unknown[] = []) {
      const makeWhere = (rows: unknown[]) => ({
        for: () => ({
          then: (onFulfilled: (r: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve(rows).then(onFulfilled, onRejected),
        }),
        then: (onFulfilled: (r: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(onFulfilled, onRejected),
      });
      mockDbSelectFrom.mockImplementation(((table?: unknown) => {
        const tableName = table && typeof table === "object" ? getTableName(table as any) : null;
        if (tableName === "issue_execution_decisions") {
          return { where: () => makeWhere(decisionRows) };
        }
        return {
          where: () => makeWhere([{
            id: "55555555-5555-4555-8555-555555555555",
            companyId: "company-1",
            agentId,
            contextSnapshot: { issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
            permissions: null,
          }]),
        };
      }) as any);
    }

    it("rejects an agent patching status: done when executionState says completed but issue_execution_decisions has no approved row", async () => {
      const policy = reviewStagePolicy();
      const issue = {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: "company-1",
        status: "in_progress",
        assigneeAgentId: executorAgentId,
        assigneeUserId: null,
        createdByUserId: "local-board",
        identifier: "PAP-1020",
        title: "Stale completed state without approved row",
        executionPolicy: policy,
        executionState: {
          status: "completed",
          currentStageId: null,
          currentStageIndex: null,
          currentStageType: null,
          currentParticipant: null,
          returnAssignee: { type: "agent", agentId: executorAgentId },
          completedStageIds: [reviewStageId],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockAgentRunAndDecisions(executorAgentId, [
        {
          id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          stageId: reviewStageId,
          outcome: "changes_requested",
          createdAt: new Date("2026-11-26T00:00:00.000Z"),
        },
      ]);

      const res = await request(await createApp({
        type: "agent",
        agentId: executorAgentId,
        companyId: "company-1",
        runId: "55555555-5555-4555-8555-555555555555",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({ status: "done" });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("Reviewed-SHA");
      expect(res.body.error).toContain('decision: "approve"');
      expect(res.body.details).toMatchObject({
        code: "unsatisfied_execution_policy_stages",
        unsatisfiedStages: [
          expect.objectContaining({
            stageId: reviewStageId,
            stageType: "review",
            approvalsRecorded: 0,
            lastOutcome: "changes_requested",
          }),
        ],
      });
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("rejects an agent self-skipping an unsatisfied review stage via PATCH status: done", async () => {
      const policy = reviewStagePolicy();
      const issue = {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: "company-1",
        status: "in_progress",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        createdByUserId: "local-board",
        identifier: "PAP-1021",
        title: "Self-review auto-skip attempt",
        executionPolicy: policy,
        executionState: null,
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockAgentRunAndDecisions(reviewerAgentId, []);

      const res = await request(await createApp({
        type: "agent",
        agentId: reviewerAgentId,
        companyId: "company-1",
        runId: "55555555-5555-4555-8555-555555555555",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({ status: "done" });

      expect(res.status).toBe(422);
      expect(res.body.details).toMatchObject({
        code: "unsatisfied_execution_policy_stages",
      });
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("rejects an agent attempting to strip unsatisfied executionPolicy stages", async () => {
      const policy = reviewStagePolicy();
      const issue = {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: "company-1",
        status: "in_progress",
        assigneeAgentId: executorAgentId,
        assigneeUserId: null,
        createdByUserId: "local-board",
        identifier: "PAP-1022",
        title: "Policy strip bypass attempt",
        executionPolicy: policy,
        executionState: null,
      };
      mockIssueService.getById.mockResolvedValue(issue);

      const res = await request(await createApp({
        type: "agent",
        agentId: executorAgentId,
        companyId: "company-1",
        runId: "55555555-5555-4555-8555-555555555555",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({ executionPolicy: null, status: "done" });

      expect(res.status).toBe(422);
      expect(res.body.details).toMatchObject({
        code: "execution_policy_stages_protected",
      });
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("rejects an agent patching status out of an active pending review stage without a structured decision while allowing monitor scheduling", async () => {
      const policy = reviewStagePolicy();
      const issue = {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: "company-1",
        status: "in_review",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        createdByUserId: "local-board",
        identifier: "PAP-1023",
        title: "Active pending review stage",
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId },
          returnAssignee: { type: "agent", agentId: executorAgentId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
        monitorAttemptCount: 0,
        monitorNextCheckAt: null,
        monitorLastTriggeredAt: null,
        monitorNotes: null,
        monitorScheduledBy: null,
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockAgentRunAndDecisions(reviewerAgentId, []);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      // Active reviewer trying to move directly to blocked without a structured decision -> 422.
      const blockedRes = await request(await createApp({
        type: "agent",
        agentId: reviewerAgentId,
        companyId: "company-1",
        runId: "55555555-5555-4555-8555-555555555555",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({ status: "blocked", comment: "Waiting on CI" });

      expect(blockedRes.status).toBe(422);
      expect(blockedRes.body.details).toMatchObject({
        code: "structured_review_decision_required",
      });

      // Active reviewer trying to patch status: done without a comment -> 422.
      const doneNoCommentRes = await request(await createApp({
        type: "agent",
        agentId: reviewerAgentId,
        companyId: "company-1",
        runId: "55555555-5555-4555-8555-555555555555",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({ status: "done" });

      expect(doneNoCommentRes.status).toBe(422);
      expect(doneNoCommentRes.body.error).toContain("Reviewed-SHA");

      // Active reviewer scheduling a monitor while preserving stages and staying in_review -> 200.
      const monitorRes = await request(await createApp({
        type: "agent",
        agentId: reviewerAgentId,
        companyId: "company-1",
        runId: "55555555-5555-4555-8555-555555555555",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({
          executionPolicy: {
            ...policy,
            monitor: {
              nextCheckAt: "2099-01-01T12:00:00.000Z",
              notes: "Approve once CI passes",
            },
          },
        });

      expect(monitorRes.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expect.objectContaining({
          monitorNextCheckAt: new Date("2099-01-01T12:00:00.000Z"),
        }),
      );
    });

    it("still allows a board user to override and close an issue with an unsatisfied review stage", async () => {
      const policy = reviewStagePolicy();
      const issue = {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: "company-1",
        status: "in_review",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        createdByUserId: "local-board",
        identifier: "PAP-1024",
        title: "Board override close",
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId },
          returnAssignee: { type: "agent", agentId: executorAgentId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp())
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({ status: "done" });

      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expect.objectContaining({
          status: "done",
          executionState: null,
          actorUserId: "local-board",
        }),
        expect.anything(),
        expect.any(Array),
        expect.any(Array),
      );
    });
  });
});
