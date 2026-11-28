import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { issueService } from "../services/issues.js";
import { loadStageParticipantLoads } from "../services/stage-participant-loads.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("multi-participant review stage load balancing", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-stage-loads-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Load fixture", issuePrefix: `L${companyId.slice(0, 6)}` });
    const insertAgent = (name: string, status = "idle") => db.insert(agents).values({
      companyId, name, role: "worker", adapterType: "process", adapterConfig: {}, status,
    }).returning().then((rows) => rows[0]!);
    const first = await insertAgent("Code Reviewer");
    const second = await insertAgent("Code Reviewer 2");
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: first.id }, { type: "agent", agentId: second.id }] }],
    })!;
    return { companyId, first, second, policy };
  }

  it("sends a new review to the second reviewer when the first already has one open", async () => {
    const { companyId, first, second, policy } = await fixture();
    await db.insert(issues).values({ companyId, title: "Already in review", status: "in_review", assigneeAgentId: first.id });

    const created = await issueService(db).create(companyId, {
      title: "Needs review",
      status: "in_review",
      executionPolicy: policy as unknown as Record<string, unknown>,
    });
    expect(created.assigneeAgentId).toBe(second.id);
  });

  it("counts open reviews and queued or running runs, and flags paused agents", async () => {
    const { companyId, first, second, policy } = await fixture();
    await db.insert(issues).values({ companyId, title: "Open review", status: "in_review", assigneeAgentId: second.id });
    await db.insert(issues).values({ companyId, title: "Done", status: "done", assigneeAgentId: first.id });
    await db.insert(heartbeatRuns).values([
      { companyId, agentId: first.id, status: "queued" },
      { companyId, agentId: first.id, status: "running" },
      { companyId, agentId: first.id, status: "succeeded" },
    ]);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, second.id));

    const result = await loadStageParticipantLoads(db, companyId, policy);
    expect(result.participantLoads?.get(`agent:${first.id}`)).toBe(2);
    expect(result.participantLoads?.get(`agent:${second.id}`)).toBe(1);
    expect([...(result.ineligibleParticipants ?? [])]).toEqual([`agent:${second.id}`]);
  });

  it("skips the queries for single-participant stages", async () => {
    const { companyId, first } = await fixture();
    const single = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: first.id }] }],
    });
    expect(await loadStageParticipantLoads(db, companyId, single)).toEqual({});
    expect(await loadStageParticipantLoads(db, companyId, null)).toEqual({});
  });
});
