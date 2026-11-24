// Hot restart with runs the new server cannot adopt (APP-276).
//
// A legacy run of a local-child adapter with no persisted pid or process group
// (every run on a remote sandbox target, whose process lives in another pod)
// cannot be adopted after a hot restart: startup reports it lost
// (`missing_process_metadata`). The shutting-down server drains those runs to
// the normal interrupted-and-retried path instead and keeps the rest adoptable.
//
// Kept apart from heartbeat-process-recovery.test.ts so pull-request CI, which
// runs only changed test files, does not have to run that whole file.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  closeRegisteredClients,
  companies,
  companyMemberships,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_input: AdapterExecutionContext): Promise<AdapterExecutionResult> => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Retried after a hot restart.",
    provider: "test",
    model: "test-model",
  })),
);

// The drain schedules a retry run; never let it start a real agent CLI.
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: vi.fn(() => "test-private-reference") }),
}));

import { heartbeatService } from "../services/heartbeat.ts";
import {
  readHotRestartIntent,
  resolveHotRestartReportPath,
  writeHotRestartIntent,
  writeHotRestartShutdownSnapshot,
} from "../services/hot-restart.ts";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres hot-restart drain tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

function isPidAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

describeEmbeddedPostgres("hot restart drains runs it cannot adopt", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const childProcesses = new Set<ChildProcess>();

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hot-restart-drain-");
      db = createDb(tempDb.connectionString);
    }
    const now = new Date();
    await db.insert(authUsers).values({
      id: "responsible-user",
      name: "Responsible User",
      email: "responsible-user@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    for (const child of childProcesses) child.kill("SIGKILL");
    childProcesses.clear();
    // Every test seeds its own company, so rows need no cleanup; only let the
    // scheduled retry runs settle before the next test.
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    vi.clearAllMocks();
  });

  afterAll(async () => {
    for (const child of childProcesses) child.kill("SIGKILL");
    childProcesses.clear();
    if (externalTestDatabaseUrl) await closeRegisteredClients(externalTestDatabaseUrl);
    await tempDb?.cleanup();
  });

  async function seedRunningRun(input: {
    processPid: number | null;
    contextSnapshot: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-11-24T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "member",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Run through a hot restart",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: { ...input.contextSnapshot, issueId },
      processPid: input.processPid,
      processGroupId: null,
      nextEventSeq: 2,
      startedAt: now,
      updatedAt: now,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      agentId,
      runId,
      seq: 1,
      eventType: "adapter.invoke",
      payload: { adapterType: "codex_local" },
    });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issueId));
    return { companyId, agentId, runId };
  }

  function selectRunsByAgent(agentId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
  }

  async function withTempPaperclipHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hot-restart-drain-"));
    const previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = home;
    try {
      return await fn(home);
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  }

  async function seedAliveDetachedRun() {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeGreaterThan(0);
    const run = await seedRunningRun({
      processPid: child.pid ?? null,
      contextSnapshot: { executionEngine: "cli", processTopology: "detached" },
    });
    return { ...run, child };
  }

  // A run on a remote sandbox target: its process lives in another pod, so the
  // server never records a pid for it.
  function seedRemoteRun() {
    return seedRunningRun({
      processPid: null,
      contextSnapshot: { executionEngine: "cli", processTopology: "detached" },
    });
  }

  it("drains a run without a local process identity to retry and adopts the detached local run", async () => {
    const local = await seedAliveDetachedRun();
    const remote = await seedRemoteRun();

    await withTempPaperclipHome(async (home) => {
      await writeHotRestartIntent({
        previousServerPid: process.pid,
        previousServerVersion: "old-version",
        requestedAt: new Date("2026-11-24T00:05:00.000Z"),
        preflightActiveRunIds: [local.runId, remote.runId],
      });
      const heartbeat = heartbeatService(db);

      const prepared = await heartbeat.prepareHotRestartShutdown("SIGTERM", new Date("2026-11-24T00:06:00.000Z"));
      expect(prepared).toMatchObject({
        mode: "non_adoptable_drain_required",
        skipDrain: false,
        drainRunIds: [remote.runId],
        drainReason: "non_adoptable_run",
      });
      expect([...(prepared as { activeRunIds: string[] }).activeRunIds].sort())
        .toEqual([local.runId, remote.runId].sort());
      await expect(readHotRestartIntent()).resolves.toMatchObject({
        drainRequired: true,
        drainReason: "non_adoptable_run",
        drainRunIds: [remote.runId],
      });

      const drain = await heartbeat.drainRunningRunsForShutdown(
        "SIGTERM",
        new Date("2026-11-24T00:06:01.000Z"),
        [remote.runId],
      );
      expect(drain.interruptedRunIds).toEqual([remote.runId]);
      expect(drain.retryRunIds).toHaveLength(1);
      expect(isPidAlive(local.child.pid)).toBe(true);

      const reconciliation = await heartbeat.reconcileHotRestartAdoption(new Date("2026-11-24T00:07:00.000Z"));
      expect(reconciliation).toMatchObject({
        mode: "reported",
        adoptedRunIds: [local.runId],
        finalizedWhileDownRunIds: [remote.runId],
        lostRunIds: [],
        skippedRunIds: [],
      });
      const remoteRuns = await selectRunsByAgent(remote.agentId);
      expect(remoteRuns.find((run) => run.id === remote.runId)).toMatchObject({
        status: "interrupted",
        errorCode: "server_shutdown_interrupted",
      });
      expect(remoteRuns).toHaveLength(2);
      expect((await selectRunsByAgent(local.agentId)).find((run) => run.id === local.runId)).toMatchObject({
        status: "running",
      });

      const report = JSON.parse(await fs.readFile(resolveHotRestartReportPath(home), "utf8")) as Record<string, unknown>;
      expect(report).toMatchObject({
        drainRequired: true,
        drainReason: "non_adoptable_run",
        adoptedRunIds: [local.runId],
        lostRunIds: [],
      });
    });
  });

  it("drains a run without a local process identity together with a server-stdio ACP run", async () => {
    const acpChild = spawnAliveProcess();
    childProcesses.add(acpChild);
    expect(acpChild.pid).toBeGreaterThan(0);
    const acp = await seedRunningRun({
      processPid: acpChild.pid ?? null,
      contextSnapshot: { executionEngine: "acp", processTopology: "server_stdio" },
    });
    const remote = await seedRemoteRun();
    const local = await seedAliveDetachedRun();

    await withTempPaperclipHome(async (home) => {
      await writeHotRestartIntent({
        previousServerPid: process.pid,
        previousServerVersion: "old-version",
        requestedAt: new Date("2026-11-24T00:05:00.000Z"),
        preflightActiveRunIds: [acp.runId, remote.runId, local.runId],
      });
      const heartbeat = heartbeatService(db);

      const prepared = await heartbeat.prepareHotRestartShutdown("SIGTERM", new Date("2026-11-24T00:06:00.000Z"));
      expect(prepared).toMatchObject({
        mode: "acp_drain_required",
        skipDrain: false,
        activeAcpRunIds: [acp.runId],
        drainReason: "active_acp_run",
      });
      const drainRunIds = [...(prepared as { drainRunIds: string[] }).drainRunIds].sort();
      expect(drainRunIds).toEqual([acp.runId, remote.runId].sort());
      const intent = await readHotRestartIntent();
      expect(intent).toMatchObject({ drainRequired: true, drainReason: "active_acp_run" });
      expect([...(intent?.drainRunIds ?? [])].sort()).toEqual(drainRunIds);

      const drain = await heartbeat.drainRunningRunsForShutdown(
        "SIGTERM",
        new Date("2026-11-24T00:06:01.000Z"),
        drainRunIds,
      );
      expect([...drain.interruptedRunIds].sort()).toEqual(drainRunIds);
      expect(drain.retryRunIds).toHaveLength(2);
      await waitForPidExit(acpChild.pid!);
      expect(isPidAlive(local.child.pid)).toBe(true);

      const reconciliation = await heartbeat.reconcileHotRestartAdoption(new Date("2026-11-24T00:07:00.000Z"));
      expect(reconciliation).toMatchObject({
        mode: "reported",
        adoptedRunIds: [local.runId],
        lostRunIds: [],
        skippedRunIds: [],
      });
      expect([...(reconciliation as { finalizedWhileDownRunIds: string[] }).finalizedWhileDownRunIds].sort())
        .toEqual(drainRunIds);
      for (const drained of [acp, remote]) {
        expect((await selectRunsByAgent(drained.agentId)).find((run) => run.id === drained.runId)).toMatchObject({
          status: "interrupted",
          errorCode: "server_shutdown_interrupted",
        });
      }

      const report = JSON.parse(await fs.readFile(resolveHotRestartReportPath(home), "utf8")) as Record<string, unknown>;
      expect(report).toMatchObject({ drainRequired: true, drainReason: "active_acp_run", lostRunIds: [] });
    });
  });

  it("without the drain, a run without a local process identity is reported lost", async () => {
    // Guards the reason for the drain above: startup cannot adopt such a run.
    const remote = await seedRemoteRun();
    await withTempPaperclipHome(async () => {
      const intent = await writeHotRestartIntent({
        previousServerPid: process.pid,
        previousServerVersion: "old-version",
        requestedAt: new Date("2026-11-24T00:05:00.000Z"),
        preflightActiveRunIds: [remote.runId],
      });
      await writeHotRestartShutdownSnapshot({
        intent,
        signal: "SIGTERM",
        activeRuns: [{
          runId: remote.runId,
          companyId: remote.companyId,
          agentId: remote.agentId,
          adapterType: "codex_local",
          status: "running",
          processPid: null,
          processGroupId: null,
          issueId: null,
        }],
        capturedAt: new Date("2026-11-24T00:06:00.000Z"),
      });
      const reconciliation = await heartbeatService(db).reconcileHotRestartAdoption(
        new Date("2026-11-24T00:07:00.000Z"),
      );
      expect(reconciliation).toMatchObject({ adoptedRunIds: [], lostRunIds: [remote.runId] });
    });
  });
});
