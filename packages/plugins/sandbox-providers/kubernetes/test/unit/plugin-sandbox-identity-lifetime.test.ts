import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// acquireLease and execute against fakes for everything that would touch a
// cluster. The built Sandbox manifest and every shutdown-time patch are
// recorded, so the tests can check the labels on a Sandbox and that a lease in
// use past its initial deadline keeps its Sandbox.
const h = vi.hoisted(() => ({
  manifests: [] as Array<Record<string, unknown>>,
  patches: [] as Array<{ namespace: string; name: string; shutdownTime: string }>,
  exec: null as null | (() => Promise<{ exitCode: number; stdout: string; stderr: string }>),
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => ({})),
}));
vi.mock("../../src/tenant-orchestrator.js", () => ({ ensureTenant: vi.fn(async () => undefined) }));
vi.mock("../../src/secret-manager.js", () => ({ createPerRunSecret: vi.fn(async () => undefined) }));
vi.mock("../../src/sandbox-cr-orchestrator.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/sandbox-cr-orchestrator.js")>();
  return {
    ...actual,
    patchSandboxShutdownTime: vi.fn(async (_clients: unknown, namespace: string, name: string, shutdownTime: string) => {
      h.patches.push({ namespace, name, shutdownTime });
    }),
    sandboxCrOrchestrator: {
      claim: vi.fn(async (_clients: unknown, _ns: string, manifest: Record<string, unknown>) => {
        h.manifests.push(manifest);
        return { uid: "uid-1" };
      }),
      findPod: vi.fn(async () => "pc-pod"),
      waitForCompletion: vi.fn(async () => ({ phase: "Running", active: 1 })),
      release: vi.fn(async () => undefined),
      getStatus: vi.fn(),
      streamLogs: vi.fn(),
    },
  };
});
vi.mock("../../src/scoped-network-egress.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/scoped-network-egress.js")>();
  return { ...actual, createScopedNetworkEgressPolicyOrReleaseWorkload: vi.fn(async () => null) };
});
vi.mock("../../src/lease-lifecycle.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/lease-lifecycle.js")>();
  return {
    ...actual,
    checkLeaseResumable: vi.fn(async () => ({ resumable: true, podName: "pc-pod", phase: "Running" })),
    confirmLeaseResourcesGone: vi.fn(async () => true),
  };
});
vi.mock("../../src/pod-exec.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/pod-exec.js")>();
  return {
    ...actual,
    execInPod: vi.fn(async () => (h.exec ? h.exec() : { exitCode: 0, stdout: "", stderr: "" })),
  };
});

import plugin from "../../src/plugin.js";

const HOUR = 3_600_000;
const MIN = 60_000;
const CONFIG = { inCluster: true, backend: "sandbox-cr" };

function acquire(extra: Record<string, unknown> = {}) {
  return plugin.definition.onEnvironmentAcquireLease!({
    driverKey: "kubernetes",
    companyId: "company-1",
    environmentId: "env-1",
    runId: "run-1",
    agentId: "agent-1",
    config: CONFIG,
    ...extra,
  } as never);
}

function execute(lease: { providerLeaseId: string | null; metadata?: Record<string, unknown> }) {
  return plugin.definition.onEnvironmentExecute!({
    driverKey: "kubernetes",
    companyId: "company-1",
    environmentId: "env-1",
    config: CONFIG,
    lease,
    command: "claude",
    args: ["--print", "-"],
    timeoutMs: 3 * HOUR,
  });
}

function release(lease: { providerLeaseId: string | null; metadata?: Record<string, unknown> }) {
  return plugin.definition.onEnvironmentReleaseLease!({
    driverKey: "kubernetes",
    companyId: "company-1",
    environmentId: "env-1",
    config: CONFIG,
    providerLeaseId: lease.providerLeaseId,
    leaseMetadata: lease.metadata,
  });
}

function sandboxShutdownMs(manifest: Record<string, unknown>): number {
  return Date.parse((manifest.spec as { shutdownTime: string }).shutdownTime);
}

beforeEach(() => {
  h.manifests.length = 0;
  h.patches.length = 0;
  h.exec = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Sandbox labels", () => {
  it("labels the Sandbox and its pod with the agent and the run", async () => {
    const lease = await acquire();
    const manifest = h.manifests[0]!;
    const labels = (manifest.metadata as { labels: Record<string, string> }).labels;
    expect(labels["paperclip.io/agent-id"]).toBe("agent-1");
    expect(labels["paperclip.io/run-id"]).toBe("run-1");
    const podLabels = (
      (manifest.spec as { podTemplate: { metadata: { labels: Record<string, string> } } }).podTemplate.metadata
    ).labels;
    expect(podLabels["paperclip.io/agent-id"]).toBe("agent-1");
    expect(podLabels["paperclip.io/run-id"]).toBe("run-1");
    await release(lease);
  });

  it("leaves out the agent label for a lease with no agent", async () => {
    const lease = await acquire({ agentId: undefined });
    const labels = (h.manifests[0]!.metadata as { labels: Record<string, string> }).labels;
    expect(labels).not.toHaveProperty("paperclip.io/agent-id");
    expect(labels["paperclip.io/run-id"]).toBe("run-1");
    await release(lease);
  });
});

describe("Sandbox shutdown time", () => {
  it("keeps the Sandbox of a lease in use past the initial deadline", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 24, 3, 0, 0), toFake: ["Date", "setInterval", "clearInterval"] });
    const lease = await acquire();
    expect(lease.metadata).toMatchObject({ renewShutdownTime: true });
    expect(lease.expiresAt).toBeUndefined();
    let shutdownMs = sandboxShutdownMs(h.manifests[0]!);
    expect(shutdownMs).toBe(Date.now() + HOUR);

    // The agent's run is one command lasting 90 minutes.
    let finish!: () => void;
    h.exec = () =>
      new Promise((resolve) => {
        finish = () => resolve({ exitCode: 0, stdout: "ok", stderr: "" });
      });
    const run = execute(lease);
    for (let elapsed = 0; elapsed < 90 * MIN; elapsed += MIN) {
      await vi.advanceTimersByTimeAsync(MIN);
      const last = h.patches.at(-1);
      if (last) shutdownMs = Date.parse(last.shutdownTime);
      // The controller deletes the Sandbox once now passes its shutdown time.
      expect(shutdownMs).toBeGreaterThan(Date.now());
    }
    finish();
    await expect(run).resolves.toMatchObject({ exitCode: 0 });
    expect(Date.now()).toBeGreaterThan(sandboxShutdownMs(h.manifests[0]!));
    expect(h.patches.length).toBeGreaterThan(0);
    expect(new Set(h.patches.map((p) => p.name))).toEqual(new Set([lease.providerLeaseId]));

    // Released: no more renewals.
    await release(lease);
    const patchesAtRelease = h.patches.length;
    h.exec = null;
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(h.patches).toHaveLength(patchesAtRelease);
  });

  it("keeps the shortest deadline ahead of a command on a lease acquired mid-second", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 24, 3, 0, 0, 750), toFake: ["Date", "setInterval", "clearInterval"] });
    const config = { ...CONFIG, podActivityDeadlineSec: 1 };
    const lease = await acquire({ config });
    let shutdownMs = sandboxShutdownMs(h.manifests[0]!);
    // Created 250 ms from expiry: 03:00:01.750 rounded down.
    expect(shutdownMs - Date.now()).toBe(250);

    let finish!: () => void;
    h.exec = () =>
      new Promise((resolve) => {
        finish = () => resolve({ exitCode: 0, stdout: "", stderr: "" });
      });
    const run = plugin.definition.onEnvironmentExecute!({
      driverKey: "kubernetes",
      companyId: "company-1",
      environmentId: "env-1",
      config,
      lease,
      command: "claude",
      args: [],
      timeoutMs: HOUR,
    });
    await vi.advanceTimersByTimeAsync(0);
    for (let elapsed = 0; elapsed < 10_000; elapsed += 10) {
      const last = h.patches.at(-1);
      if (last) shutdownMs = Math.max(shutdownMs, Date.parse(last.shutdownTime));
      expect(shutdownMs).toBeGreaterThan(Date.now());
      await vi.advanceTimersByTimeAsync(10);
    }
    finish();
    await run;
    await release(lease);
  });

  it("never moves the attested deadline of a lease with a caller deadline", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 24, 3, 0, 0), toFake: ["Date", "setInterval", "clearInterval"] });
    const requestedExpiresAt = new Date(Date.now() + 20 * MIN).toISOString();
    const lease = await acquire({ requestedExpiresAt });
    expect(lease.metadata).toMatchObject({ renewShutdownTime: false });
    expect(lease.expiresAt).toBe(requestedExpiresAt);

    let finish!: () => void;
    h.exec = () =>
      new Promise((resolve) => {
        finish = () => resolve({ exitCode: 0, stdout: "", stderr: "" });
      });
    const run = execute(lease);
    await vi.advanceTimersByTimeAsync(15 * MIN);
    finish();
    await run;
    expect(h.patches).toEqual([]);
    await release(lease);
  });

  it("gives a resumed lease a full deadline from now", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 24, 3, 0, 0), toFake: ["Date", "setInterval", "clearInterval"] });
    const resumed = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "company-1",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-resumed",
      leaseMetadata: { namespace: "paperclip-company-1", backend: "sandbox-cr", renewShutdownTime: true },
    });
    expect(resumed.metadata).toMatchObject({ renewShutdownTime: true });
    expect(h.patches).toEqual([
      { namespace: "paperclip-company-1", name: "pc-resumed", shutdownTime: new Date(Date.now() + HOUR).toISOString() },
    ]);
    await release(resumed);
  });

  it("does not renew a resumed lease created before renewal existed", async () => {
    const resumed = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "company-1",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-legacy",
      leaseMetadata: { namespace: "paperclip-company-1", backend: "sandbox-cr" },
    });
    expect(resumed.metadata).toMatchObject({ renewShutdownTime: false });
    expect(h.patches).toEqual([]);
    await release(resumed);
  });
});
