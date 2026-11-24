import { describe, it, expect, vi, beforeEach } from "vitest";

// acquireLease against fakes for everything that would touch a cluster. The
// Sandbox readiness wait and release are recorded so each test can check the
// lease is handed out only once its pod can take an exec.
const h = vi.hoisted(() => ({
  waitForReady: vi.fn(async () => ({ phase: "Running", active: 1 })),
  sandboxClaim: vi.fn(async (..._args: unknown[]) => ({ uid: "uid-1" })),
  jobClaim: vi.fn(async (..._args: unknown[]) => ({ uid: "uid-job" })),
  release: vi.fn(async () => undefined),
  jobWait: vi.fn(),
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
    sandboxCrOrchestrator: {
      claim: h.sandboxClaim,
      findPod: vi.fn(async () => "pc-pod"),
      waitForCompletion: h.waitForReady,
      release: h.release,
      getStatus: vi.fn(),
      streamLogs: vi.fn(),
    },
  };
});
vi.mock("../../src/job-orchestrator.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/job-orchestrator.js")>();
  return {
    ...actual,
    jobOrchestrator: {
      claim: h.jobClaim,
      findPod: vi.fn(async () => "pc-job-pod"),
      waitForCompletion: h.jobWait,
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

import plugin from "../../src/plugin.js";

function acquire(config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return plugin.definition.onEnvironmentAcquireLease!({
    driverKey: "kubernetes",
    companyId: "company-1",
    environmentId: "env-1",
    runId: "run-1",
    config: { inCluster: true, ...config },
    ...extra,
  } as never);
}

type Manifest = {
  metadata: { labels: Record<string, string> };
  spec: { template?: { metadata: { labels: Record<string, string> } }; podTemplate?: { metadata: { labels: Record<string, string> } } };
};

function podLabels(claim: typeof h.sandboxClaim): Record<string, string> {
  const manifest = claim.mock.calls.at(-1)![2] as Manifest;
  return (manifest.spec.podTemplate ?? manifest.spec.template)!.metadata.labels;
}

beforeEach(() => {
  h.waitForReady.mockReset();
  h.waitForReady.mockImplementation(async () => ({ phase: "Running", active: 1 }));
  h.release.mockClear();
  h.jobWait.mockClear();
  h.sandboxClaim.mockClear();
  h.jobClaim.mockClear();
});

describe("onEnvironmentAcquireLease pod labels", () => {
  const agentId = "0d9c52f6-2f30-4d3e-9a01-aaaaaaaa0001";

  for (const backend of ["sandbox-cr", "job"] as const) {
    const claim = backend === "job" ? h.jobClaim : h.sandboxClaim;

    it(`labels the ${backend} pod with the run's agent id, not the run id`, async () => {
      await acquire({ backend }, { agentId });
      const labels = podLabels(claim);
      expect(labels["paperclip.io/agent-id"]).toBe(agentId);
      expect(labels["paperclip.io/run-id"]).toBe("run-1");
    });

    it(`omits the agent-id label on the ${backend} pod when the host sends no agent id`, async () => {
      await acquire({ backend });
      const labels = podLabels(claim);
      expect(labels).not.toHaveProperty("paperclip.io/agent-id");
      expect(labels["paperclip.io/run-id"]).toBe("run-1");
    });
  }
});

describe("onEnvironmentAcquireLease readiness", () => {
  it("waits for the Sandbox to be Ready on the start-up budget before handing out the lease", async () => {
    const lease = await acquire({ podStartTimeoutSec: 240 });
    expect(h.waitForReady).toHaveBeenCalledTimes(1);
    expect(h.waitForReady).toHaveBeenCalledWith(expect.anything(), expect.any(String), lease.providerLeaseId, {
      timeoutMs: 240_000,
      pollMs: 1000,
    });
    expect(h.release).not.toHaveBeenCalled();
    expect((lease.metadata as { podName?: string }).podName).toBe("pc-pod");
  });

  it("defaults the start-up budget to 300 s", async () => {
    await acquire();
    expect(h.waitForReady).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.any(String), {
      timeoutMs: 300_000,
      pollMs: 1000,
    });
  });

  it("releases the Sandbox and fails when it never becomes Ready", async () => {
    const notReady = new Error("Sandbox did not reach Ready phase");
    h.waitForReady.mockRejectedValueOnce(notReady);
    await expect(acquire()).rejects.toBe(notReady);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("reports both errors when the release also fails", async () => {
    h.waitForReady.mockRejectedValueOnce(new Error("not ready"));
    h.release.mockRejectedValueOnce(new Error("release failed"));
    await expect(acquire()).rejects.toBeInstanceOf(AggregateError);
  });

  it("does not wait on the job backend, whose pod is awaited per command", async () => {
    await acquire({ backend: "job" });
    expect(h.waitForReady).not.toHaveBeenCalled();
    expect(h.jobWait).not.toHaveBeenCalled();
  });
});
