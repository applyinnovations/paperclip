import { createHmac, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, githubPushAttempts, githubRefUpdates, heartbeatRuns, issues } from "@paperclipai/db";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { errorHandler } from "../middleware/index.js";
import { createGitHubAppWebhookVerifier } from "../services/github-app-webhooks.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { canonicalGitHubRepository, canonicalGitRef } from "../services/github-push-provenance.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const SECRET = "push-webhook-secret";
const CONFIG_PATH = "/etc/paperclip/github-apps.json";
const sha = (seed: number | string) => createHmac("sha1", "fixture").update(String(seed)).digest("hex");
const ZERO = "0".repeat(40);

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("GitHub push provenance", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyA = randomUUID(), companyB = randomUUID();
  const appIds = { [companyA]: "5462605", [companyB]: "6000001" } as Record<string, string>;
  let app: express.Express;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-push-provenance-signing-secret");
    database = await startEmbeddedPostgresTestDatabase("paperclip-push-provenance-");
    db = createDb(database.connectionString);
    for (const companyId of [companyA, companyB]) {
      await db.insert(companies).values({ id: companyId, name: `Company ${companyId.slice(0, 4)}`, issuePrefix: `P${companyId.slice(0, 5)}` });
    }
    app = express();
    app.use(express.json());
    app.use(runtimeConnectionIntentRoutes(db));
    app.use(errorHandler);
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    vi.unstubAllEnvs();
  }, 60_000);

  async function agent(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name, role: "engineer", status: "running", adapterType: "codex_local" });
    return id;
  }
  async function issue(companyId: string, title: string) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title, status: "in_progress" });
    return id;
  }
  async function run(companyId: string, agentId: string, issueId: string) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, scopeKind: "issue", issueId, status: "running",
      contextSnapshot: { issueId } });
    return { companyId, agentId, runId: id, issueId };
  }
  const tokenFor = (r: { companyId: string; agentId: string; runId: string }) => createRuntimeToolsToken({
    ...r, responsibleUserId: "owner", scope: "github_credentials",
  })!.token;

  /** The launcher's report, through the real runtime route. */
  function report(r: { companyId: string; agentId: string; runId: string }, body: Record<string, unknown>) {
    return request(app)
      .post("/runtime-tools/github/push-attempts")
      .set("Authorization", `Bearer ${tokenFor(r)}`)
      .send(body);
  }
  const push = (r: Parameters<typeof report>[0], ref: string, before: string, after: string, result = "ok", extra: Record<string, unknown> = {}) =>
    report(r, { repository: "Acme/Widgets", exitCode: result === "ok" ? 0 : 1, updates: [{ ref, before, after, result }], ...extra });

  /** Host services as the GitHub plugin sees them, with real webhook signature verification. */
  const services = () => buildHostServices(db, "plugin-record-id", "paperclip.github",
    { forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn() }) } as never, undefined, {
      githubAppWebhooks: createGitHubAppWebhookVerifier({
        env: { PAPERCLIP_GITHUB_APPS_FILE: CONFIG_PATH },
        readConfigFile: () => JSON.stringify({ apps: [companyA, companyB].map((companyId) => ({
          companyId, appId: appIds[companyId], installationId: `${appIds[companyId]}9`,
          privateKeyFile: `/keys/${companyId}.pem`, webhookSecretFile: `/secrets/${companyId}`,
        })) }),
        readSecret: async () => SECRET,
      }),
    });
  const handlers = (svc = services()) => createHostClientHandlers({
    pluginId: "paperclip.github",
    capabilities: ["github.push-provenance.read", "github.push-provenance.record"] as never,
    services: svc,
  });
  const scope = (companyId: string) => ({ invocationScope: { companyId } });

  function delivery(companyId: string, payload: Record<string, unknown>, deliveryId = randomUUID(), event = "push") {
    const rawBody = JSON.stringify({ installation: { id: Number(`${appIds[companyId]}9`) }, ...payload });
    return {
      rawBody,
      headers: {
        "x-github-hook-installation-target-type": "integration",
        "x-github-hook-installation-target-id": appIds[companyId]!,
        "x-github-event": event,
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`,
      },
    };
  }
  const evidence = (companyId: string, ref: string, before: string, after: string, extra: Record<string, unknown> = {}, deliveryId?: string) =>
    handlers()["githubApp.recordPushEvidence"](delivery(companyId, {
      ref, before, after, forced: false, repository: { full_name: "acme/widgets" }, ...extra,
    }, deliveryId));
  async function readAll(companyId: string, ref: string, options: { afterSha?: string } = {}) {
    const call = handlers()["githubApp.listBranchUpdates"];
    const updates = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page = await call({ repository: "acme/widgets", ref, ...options, cursor }, scope(companyId));
      updates.push(...page.updates);
      pages += 1;
      expect(page.complete).toBe(page.nextCursor === null);
      if (page.complete) return { updates, pages };
      cursor = page.nextCursor;
    }
  }

  it("attributes concurrent pushes from runs on different issues to the run that sent each update", async () => {
    const engineer = await run(companyA, await agent(companyA, "Engineer"), await issue(companyA, "Issue A"));
    const reviewer = await run(companyA, await agent(companyA, "Reviewer"), await issue(companyA, "Issue B"));
    const bystander = await run(companyA, await agent(companyA, "Bystander"), engineer.issueId);
    const ref = "refs/heads/concurrent";
    const [a, b, c] = await Promise.all([
      push(engineer, ref, sha("c0"), sha("c1")),
      push(reviewer, ref, sha("c1"), sha("c2")),
      // Same repo, another branch, at the same time on the engineer's issue.
      push(bystander, "refs/heads/elsewhere", sha("e0"), sha("e1")),
    ]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    await Promise.all([evidence(companyA, ref, sha("c1"), sha("c2")), evidence(companyA, ref, sha("c0"), sha("c1"))]);

    const { updates } = await readAll(companyA, "concurrent");
    expect(updates.map((u) => [u.beforeSha, u.afterSha, u.state, u.runId, u.agentId, u.issueId])).toEqual([
      [sha("c0"), sha("c1"), "confirmed", engineer.runId, engineer.agentId, engineer.issueId],
      [sha("c1"), sha("c2"), "confirmed", reviewer.runId, reviewer.agentId, reviewer.issueId],
    ]);
    // The reviewer's head is not attributed to the engineer for overlapping in time.
    const head = await readAll(companyA, ref, { afterSha: sha("c2") });
    expect(head.updates.flatMap((u) => u.pushers.map((p) => p.agentId))).toEqual([reviewer.agentId]);
  });

  it("takes identity only from run authentication, and only while the run is active", async () => {
    const pusher = await run(companyA, await agent(companyA, "Pusher"), await issue(companyA, "Own issue"));
    const victim = await run(companyA, await agent(companyA, "Victim"), await issue(companyA, "Victim issue"));
    const ref = "refs/heads/identity";
    expect((await push(pusher, ref, sha("i0"), sha("i1"), "ok", {
      companyId: companyB, runId: victim.runId, agentId: victim.agentId, issueId: victim.issueId,
    })).status).toBe(200);
    await evidence(companyA, ref, sha("i0"), sha("i1"));
    const [update] = (await readAll(companyA, ref)).updates;
    expect(update).toMatchObject({ state: "confirmed", runId: pusher.runId, agentId: pusher.agentId, issueId: pusher.issueId });

    const browser = await request(app).post("/runtime-tools/github/push-attempts")
      .set("Authorization", `Bearer ${tokenFor(pusher)}`).set("Origin", "http://127.0.0.1").send({});
    expect(browser.status).toBe(403);
    const wrongScope = createRuntimeToolsToken({ ...pusher, responsibleUserId: "owner", scope: "connection_intents" })!.token;
    expect((await request(app).post("/runtime-tools/github/push-attempts").set("Authorization", `Bearer ${wrongScope}`)
      .send({})).status).toBe(401);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, pusher.runId));
    expect((await push(pusher, ref, sha("i1"), sha("i2"))).status).toBe(403);
  });

  it("handles duplicate, redelivered and out-of-order evidence without a transient confirmation", async () => {
    const pusher = await run(companyA, await agent(companyA, "Late reporter"), await issue(companyA, "Order"));
    const ref = "refs/heads/out-of-order";
    const deliveryId = randomUUID();
    // GitHub's evidence first: nobody has claimed it yet, so it is unattributed (pending).
    await expect(evidence(companyA, ref, sha("o0"), sha("o1"), {}, deliveryId)).resolves.toEqual({ recorded: true, duplicate: false });
    expect((await readAll(companyA, ref)).updates).toMatchObject([{ state: "unattributed", pushers: [], runId: null }]);
    // Redelivery of the same delivery, and a second delivery of the same transition.
    await expect(evidence(companyA, ref, sha("o0"), sha("o1"), {}, deliveryId)).resolves.toEqual({ recorded: true, duplicate: true });
    await expect(evidence(companyA, ref, sha("o0"), sha("o1"))).resolves.toEqual({ recorded: true, duplicate: true });
    // The attempt lands late, then the launcher retries it.
    await push(pusher, ref, sha("o0"), sha("o1"));
    await push(pusher, ref, sha("o0"), sha("o1"));
    const { updates } = await readAll(companyA, ref);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ state: "confirmed", runId: pusher.runId, pushers: [{ runId: pusher.runId, outcome: "succeeded" }] });
    expect(await db.select().from(githubRefUpdates).where(eq(githubRefUpdates.ref, ref))).toHaveLength(1);
  });

  it("never counts failed or no-op pushes, keeps force-pushed history, and marks competing claims ambiguous", async () => {
    const first = await run(companyA, await agent(companyA, "First"), await issue(companyA, "Force A"));
    const second = await run(companyA, await agent(companyA, "Second"), await issue(companyA, "Force B"));
    const ref = "refs/heads/force";
    // Rejected by the remote: recorded as failed and never listed as an update.
    expect((await push(first, ref, sha("f0"), sha("f-rejected"), "ng")).status).toBe(200);
    expect((await readAll(companyA, ref)).updates).toEqual([]);
    expect(await db.select().from(githubPushAttempts).where(eq(githubPushAttempts.runId, first.runId)))
      .toMatchObject([{ outcome: "failed" }]);
    // GitHub moving the ref anyway does not credit the failed attempt.
    await evidence(companyA, ref, sha("f0"), sha("f-rejected"));
    expect((await readAll(companyA, ref)).updates).toMatchObject([{ state: "unattributed", pushers: [] }]);
    // A no-op push sends no update: there is nothing to record, and an empty or self-referencing report is refused.
    expect((await report(first, { repository: "acme/widgets", updates: [] })).status).toBe(422);
    expect((await push(first, ref, sha("f1"), sha("f1"))).status).toBe(422);
    // A real push, then a force-push by another run that rewrites it.
    await push(first, ref, sha("f-rejected"), sha("f1"));
    await evidence(companyA, ref, sha("f-rejected"), sha("f1"));
    await push(second, ref, sha("f1"), sha("f2"), "ok", { forced: true });
    await evidence(companyA, ref, sha("f1"), sha("f2"), { forced: true });
    // A run that reports the same transition again makes it ambiguous rather than attributing it.
    await push(first, ref, sha("f1"), sha("f2"), "unknown");
    const { updates } = await readAll(companyA, ref);
    expect(updates.map((u) => [u.afterSha, u.state, u.forced, u.runId])).toEqual([
      [sha("f-rejected"), "unattributed", false, null],
      [sha("f1"), "confirmed", false, first.runId],
      [sha("f2"), "ambiguous", true, null],
    ]);
    expect(updates[2]!.pushers.map((p) => [p.runId, p.outcome])).toEqual([
      [second.runId, "succeeded"], [first.runId, "unknown"],
    ]);
    // A deleted branch is an update too.
    await evidence(companyA, ref, sha("f2"), ZERO);
    expect((await readAll(companyA, ref)).updates.at(-1)).toMatchObject({ afterSha: ZERO, state: "unattributed" });
  });

  it("survives run completion and a restart, and keeps credentials out of rows and responses", async () => {
    const pusher = await run(companyA, await agent(companyA, "Durable"), await issue(companyA, "Restart"));
    const ref = "refs/heads/restart";
    await push(pusher, ref, sha("r0"), sha("r1"), "ok", { token: "ghs_secret-token", url: "https://x-access-token:ghs_secret@github.com/acme/widgets" });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, pusher.runId));
    // A new client and new host services: nothing is held in memory.
    const restarted = createDb(database.connectionString);
    try {
      const page = await createHostClientHandlers({
        pluginId: "paperclip.github",
        capabilities: ["github.push-provenance.read"] as never,
        services: buildHostServices(restarted, "plugin-record-id", "paperclip.github",
          { forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn() }) } as never),
      })["githubApp.listBranchUpdates"]({ repository: "acme/widgets", ref }, scope(companyA));
      expect(page.updates).toMatchObject([{ state: "attempted", runId: null, pushers: [{ runId: pusher.runId }] }]);
    } finally {
      await restarted.$client.end({ timeout: 1 });
    }
    await evidence(companyA, ref, sha("r0"), sha("r1"));
    const { updates } = await readAll(companyA, ref);
    expect(updates).toMatchObject([{ state: "confirmed", runId: pusher.runId }]);
    const rows = JSON.stringify([
      await db.select().from(githubRefUpdates).where(eq(githubRefUpdates.ref, ref)),
      await db.select().from(githubPushAttempts).where(eq(githubPushAttempts.runId, pusher.runId)),
      updates,
    ]);
    expect(rows).not.toMatch(/secret|x-access-token|https:/);
  });

  it("keeps every company's provenance to itself", async () => {
    const pusherA = await run(companyA, await agent(companyA, "A pusher"), await issue(companyA, "Cross A"));
    const ref = "refs/heads/cross-company";
    await push(pusherA, ref, sha("x0"), sha("x1"));
    // Company B's App reports the same transition: it does not confirm company A's attempt.
    await evidence(companyB, ref, sha("x0"), sha("x1"));
    expect((await readAll(companyB, ref)).updates).toMatchObject([{ state: "unattributed", pushers: [] }]);
    expect((await readAll(companyA, ref)).updates).toMatchObject([{ state: "attempted", pushers: [{ runId: pusherA.runId }] }]);
    // A plugin invoked for company B cannot read company A.
    const call = handlers()["githubApp.listBranchUpdates"];
    await expect(call({ repository: "acme/widgets", ref, companyId: companyA }, scope(companyB))).rejects.toThrow(/scoped to company/);
    await expect(call({ repository: "acme/widgets", ref }, {})).rejects.toThrow(/company context is required/);
    // Without the capability there is no read or record at all.
    const noCapability = createHostClientHandlers({ pluginId: "paperclip.github", capabilities: ["github.app.webhooks.verify"] as never, services: services() });
    await expect(noCapability["githubApp.listBranchUpdates"]({ repository: "acme/widgets", ref }, scope(companyA))).rejects.toThrow(/github\.push-provenance\.read/);
    await expect(noCapability["githubApp.recordPushEvidence"](delivery(companyA, {}))).rejects.toThrow(/github\.push-provenance\.record/);
    // Unsigned or forged evidence, and other events, are not recorded.
    const forged = delivery(companyA, { ref, before: sha("x1"), after: sha("x2"), repository: { full_name: "acme/widgets" } });
    await expect(handlers()["githubApp.recordPushEvidence"]({ ...forged, headers: { ...forged.headers, "x-hub-signature-256": "sha256=00" } }))
      .resolves.toEqual({ recorded: false, reason: "bad_signature" });
    await expect(handlers()["githubApp.recordPushEvidence"](delivery(companyA, { action: "opened" }, randomUUID(), "pull_request")))
      .resolves.toEqual({ recorded: false, reason: "not_push_event" });
    expect((await readAll(companyA, ref)).updates).toHaveLength(1);
  });

  it("pages through more than 100 runs on one issue and says when the read is complete", async () => {
    const issueId = await issue(companyA, "Busy issue");
    const agentId = await agent(companyA, "Busy");
    const ref = "refs/heads/busy";
    const runs = [];
    for (let index = 0; index < 150; index++) runs.push(await run(companyA, agentId, issueId));
    for (let index = 0; index < runs.length; index++) {
      expect((await push(runs[index]!, ref, sha(`b${index}`), sha(`b${index + 1}`))).status).toBe(200);
      await evidence(companyA, ref, sha(`b${index}`), sha(`b${index + 1}`));
    }
    const first = await handlers()["githubApp.listBranchUpdates"]({ repository: "acme/widgets", ref }, scope(companyA));
    expect(first.updates).toHaveLength(100);
    expect(first.complete).toBe(false);
    expect(first.nextCursor).toEqual(expect.any(String));
    const { updates, pages } = await readAll(companyA, ref);
    expect(pages).toBe(2);
    expect(updates).toHaveLength(150);
    expect(updates.every((u) => u.state === "confirmed" && u.issueId === issueId)).toBe(true);
    expect(new Set(updates.map((u) => u.runId))).toEqual(new Set(runs.map((r) => r.runId)));
    // The exact head is found without paging, and bad paging input is refused rather than capped.
    const head = await handlers()["githubApp.listBranchUpdates"]({ repository: "acme/widgets", ref, afterSha: sha("b150") }, scope(companyA));
    expect(head).toMatchObject({ complete: true, updates: [{ runId: runs[149]!.runId, state: "confirmed" }] });
    await expect(handlers()["githubApp.listBranchUpdates"]({ repository: "acme/widgets", ref, limit: 500 }, scope(companyA))).rejects.toThrow(/limit/);
    await expect(handlers()["githubApp.listBranchUpdates"]({ repository: "acme/widgets", ref, cursor: "forged" }, scope(companyA))).rejects.toThrow(/cursor/);
  }, 60_000);
});

describe("push provenance names", () => {
  it.each([
    ["acme/widgets", "acme/widgets"],
    ["Acme/Widgets.git", "acme/widgets"],
    ["https://github.com/Acme/Widgets.git", "acme/widgets"],
    ["git@github.com:Acme/Widgets.git", "acme/widgets"],
    ["https://gitlab.com/acme/widgets", null],
    ["https://github.com/acme", null],
    ["acme/widgets/extra", null],
  ])("canonicalises repository %s", (input, expected) => {
    expect(canonicalGitHubRepository(input)).toBe(expected);
  });
  it.each([
    ["main", "refs/heads/main"],
    ["refs/heads/feature/x", "refs/heads/feature/x"],
    ["refs/tags/v1", "refs/tags/v1"],
    ["bad..ref", null],
    ["has space", null],
  ])("canonicalises ref %s", (input, expected) => {
    expect(canonicalGitRef(input)).toBe(expected);
  });
});
