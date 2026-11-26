import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { projectService } from "../services/projects.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) {
  console.warn(`Skipping project default execution policy tests on this host: ${support.reason ?? "unsupported environment"}`);
}

(support.supported ? describe : describe.skip)("project default execution policy", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-project-default-policy-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    const reviewerId = randomUUID();
    const engineerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Default policy fixture", issuePrefix: `D${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: reviewerId, companyId, name: "Code Reviewer", adapterType: "process", status: "idle" },
      { id: engineerId, companyId, name: "Engineer", adapterType: "process", status: "idle" },
    ]);
    return { companyId, reviewerId, engineerId };
  }

  const reviewBy = (agentId: string) => ({ stages: [{ type: "review" as const, participants: [{ type: "agent" as const, agentId }] }] });
  const policyWith = (defaults: unknown) => ({ enabled: false, defaultIssueExecutionPolicy: defaults }) as never;

  it("gives every issue created in the project the default stages", async () => {
    const { companyId, reviewerId, engineerId } = await fixture();
    const project = await projectService(db).create(companyId, {
      name: "Build",
      executionWorkspacePolicy: policyWith(reviewBy(reviewerId)),
    });
    expect(project.executionWorkspacePolicy?.defaultIssueExecutionPolicy).toMatchObject(reviewBy(reviewerId));

    const issues = issueService(db);
    const first = await issues.create(companyId, { title: "Build it", projectId: project.id, assigneeAgentId: engineerId, status: "todo" });
    const second = await issues.create(companyId, { title: "Build more", projectId: project.id, status: "backlog" });
    for (const issue of [first, second]) {
      const saved = await issues.getById(issue.id);
      expect(saved?.executionPolicy).toMatchObject({
        stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
      });
    }
    const [a, b] = await Promise.all([issues.getById(first.id), issues.getById(second.id)]);
    expect((a!.executionPolicy as { stages: Array<{ id: string }> }).stages[0]!.id)
      .not.toBe((b!.executionPolicy as { stages: Array<{ id: string }> }).stages[0]!.id);
  });

  it("keeps an issue's own stages", async () => {
    const { companyId, reviewerId, engineerId } = await fixture();
    const project = await projectService(db).create(companyId, { name: "Build", executionWorkspacePolicy: policyWith(reviewBy(reviewerId)) });
    const issues = issueService(db);
    const own = await issues.create(companyId, {
      title: "Own approval",
      projectId: project.id,
      executionPolicy: { stages: [{ type: "approval", participants: [{ type: "agent", agentId: engineerId }] }] } as never,
    });
    expect((await issues.getById(own.id))?.executionPolicy).toMatchObject({
      stages: [{ type: "approval", participants: [{ agentId: engineerId }] }],
    });
  });

  it("skips the default when a board caller asks for no stages, but never for an agent caller", async () => {
    const { companyId, reviewerId, engineerId } = await fixture();
    const project = await projectService(db).create(companyId, { name: "Build", executionWorkspacePolicy: policyWith(reviewBy(reviewerId)) });
    const issues = issueService(db);

    const boardRelease = await issues.create(companyId, {
      title: "Board release",
      projectId: project.id,
      createdByUserId: "board-user-1",
      skipProjectDefaultExecutionStages: true,
    });
    expect((await issues.getById(boardRelease.id))?.executionPolicy ?? null).toBeNull();

    const agentAttempt = await issues.create(companyId, {
      title: "Agent cannot bypass",
      projectId: project.id,
      createdByAgentId: engineerId,
      skipProjectDefaultExecutionStages: true,
    });
    expect((await issues.getById(agentAttempt.id))?.executionPolicy).toMatchObject(reviewBy(reviewerId));
  });

  it("initializes stage 0 cleanly when an issue is created directly in in_review", async () => {
    const { companyId, reviewerId, engineerId } = await fixture();
    const project = await projectService(db).create(companyId, {
      name: "Review Gated",
      executionWorkspacePolicy: policyWith({
        mode: "normal",
        maxReviewRounds: 4,
        ...reviewBy(reviewerId),
      }),
    });
    const issues = issueService(db);

    const created = await issues.create(companyId, {
      title: "Directly in review",
      projectId: project.id,
      status: "in_review",
      assigneeAgentId: engineerId,
      createdByAgentId: engineerId,
    });
    const saved = await issues.getById(created.id);
    expect(saved?.status).toBe("in_review");
    expect(saved?.assigneeAgentId).toBe(reviewerId);
    expect(saved?.executionPolicy).toMatchObject({
      maxReviewRounds: 4,
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
    });
    expect(saved?.executionState).toMatchObject({
      status: "pending",
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
      returnAssignee: { type: "agent", agentId: engineerId, userId: null },
      completedStageIds: [],
    });

    const assignedToReviewer = await issues.create(companyId, {
      title: "Created in review assigned to reviewer",
      projectId: project.id,
      status: "in_review",
      assigneeAgentId: reviewerId,
    });
    const savedReviewerIssue = await issues.getById(assignedToReviewer.id);
    expect(savedReviewerIssue?.status).toBe("in_review");
    expect(savedReviewerIssue?.assigneeAgentId).toBe(reviewerId);
    expect(savedReviewerIssue?.executionState).toMatchObject({
      status: "pending",
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
      returnAssignee: null,
    });
  });

  it("applies whether or not isolated workspaces are enabled", async () => {
    const { companyId, reviewerId } = await fixture();
    const project = await projectService(db).create(companyId, {
      name: "Isolated",
      executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace", defaultIssueExecutionPolicy: reviewBy(reviewerId) } as never,
    });
    expect(project.executionWorkspacePolicy).toMatchObject({ enabled: true, defaultMode: "isolated_workspace" });
    const issues = issueService(db);
    const issue = await issues.create(companyId, { title: "Isolated build", projectId: project.id });
    expect((await issues.getById(issue.id))?.executionPolicy).toMatchObject(reviewBy(reviewerId));
  });

  it("changes nothing for projects without a default", async () => {
    const { companyId } = await fixture();
    const project = await projectService(db).create(companyId, { name: "Plain" });
    expect(project.executionWorkspacePolicy?.defaultIssueExecutionPolicy ?? null).toBeNull();
    const issues = issueService(db);
    const issue = await issues.create(companyId, { title: "No stages", projectId: project.id });
    expect((await issues.getById(issue.id))?.executionPolicy ?? null).toBeNull();
  });

  it("is set and cleared through project updates, and only names agents of the company", async () => {
    const { companyId, reviewerId } = await fixture();
    const other = await fixture();
    const projects = projectService(db);
    const project = await projects.create(companyId, { name: "Build" });

    await expect(projects.update(project.id, { executionWorkspacePolicy: policyWith(reviewBy(other.reviewerId)) }))
      .rejects.toThrow(/outside this company/);

    const updated = await projects.update(project.id, { executionWorkspacePolicy: policyWith(reviewBy(reviewerId)) });
    expect(updated?.executionWorkspacePolicy?.defaultIssueExecutionPolicy).toMatchObject(reviewBy(reviewerId));
    const issues = issueService(db);
    const issue = await issues.create(companyId, { title: "After update", projectId: project.id });
    expect((await issues.getById(issue.id))?.executionPolicy).toMatchObject(reviewBy(reviewerId));

    const cleared = await projects.update(project.id, { executionWorkspacePolicy: policyWith(null) });
    expect(cleared?.executionWorkspacePolicy?.defaultIssueExecutionPolicy ?? null).toBeNull();
    const afterClear = await issues.create(companyId, { title: "After clear", projectId: project.id });
    expect((await issues.getById(afterClear.id))?.executionPolicy ?? null).toBeNull();
  });
});
