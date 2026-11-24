import { describe, it, expect, vi, beforeEach } from "vitest";

// acquireLease against fakes for everything that would touch a cluster. The
// Sandbox readiness wait and release are recorded so each test can check the
// lease is handed out only once its pod can take an exec.
const h = vi.hoisted(() => ({
  waitForReady: vi.fn(async () => ({ phase: "Running", active: 1 })),
  release: vi.fn(async () => undefined),
  jobWait: vi.fn(),
  claim: vi.fn(async (_clients: unknown, _namespace: string, _manifest: unknown) => ({ uid: "uid-1" })),
  createSecret: vi.fn(async () => undefined),
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => ({})),
}));
vi.mock("../../src/tenant-orchestrator.js", () => ({ ensureTenant: vi.fn(async () => undefined) }));
vi.mock("../../src/secret-manager.js", () => ({ createPerRunSecret: h.createSecret }));
vi.mock("../../src/sandbox-cr-orchestrator.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/sandbox-cr-orchestrator.js")>();
  return {
    ...actual,
    sandboxCrOrchestrator: {
      claim: h.claim,
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
      claim: vi.fn(async () => ({ uid: "uid-job" })),
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
import { SandboxAcquireDeadlineError } from "../../src/acquire-deadline.js";
import { SandboxCrTimeoutError } from "../../src/sandbox-cr-orchestrator.js";

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

beforeEach(() => {
  h.waitForReady.mockReset();
  h.waitForReady.mockImplementation(async () => ({ phase: "Running", active: 1 }));
  h.release.mockReset();
  h.release.mockImplementation(async () => undefined);
  h.jobWait.mockClear();
  h.claim.mockClear();
  h.createSecret.mockReset();
  h.createSecret.mockImplementation(async () => undefined);
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

describe("onEnvironmentAcquireLease and the host's acquire deadline", () => {
  const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

  it("labels the workload with the host's creation attempt", async () => {
    const attempt = "7b0c5f8e-1d2a-4c3b-9e4f-5a6b7c8d9e0f";
    await acquire({}, { creationOperationId: attempt });
    const manifest = h.claim.mock.calls[0]![2] as { metadata: { labels: Record<string, string> } };
    expect(manifest.metadata.labels["paperclip.io/create-attempt"]).toBe(attempt);
  });

  it("stops waiting before the deadline and deletes the Sandbox, so a lease timeout leaves nothing behind", async () => {
    // The pod is still Pending (quota full) when the host is about to give up.
    h.waitForReady.mockImplementationOnce(async (...args: unknown[]) => {
      const opts = args[3] as { timeoutMs: number };
      throw new SandboxCrTimeoutError("ns", String(args[2]), opts.timeoutMs);
    });
    const error = await acquire({}, { acquireDeadlineAt: inSeconds(30) }).catch(value => value);
    expect(error).toBeInstanceOf(SandboxAcquireDeadlineError);
    const [, , name, opts] = h.waitForReady.mock.calls[0]! as unknown as [unknown, string, string, { timeoutMs: number }];
    // 30 s deadline less the 5 s reserve for the delete; never the 300 s start-up budget.
    expect(opts.timeoutMs).toBeGreaterThan(20_000);
    expect(opts.timeoutMs).toBeLessThanOrEqual(25_000);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledWith(expect.anything(), expect.any(String), name);
  });

  it("does not create a Sandbox when the deadline leaves no time to hand it out", async () => {
    await expect(acquire({}, { acquireDeadlineAt: inSeconds(3) })).rejects.toBeInstanceOf(SandboxAcquireDeadlineError);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });

  it("keeps the start-up budget when the deadline is later", async () => {
    await acquire({ podStartTimeoutSec: 60 }, { acquireDeadlineAt: inSeconds(600) });
    expect(h.waitForReady).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.any(String),
      expect.objectContaining({ timeoutMs: 60_000 }));
  });

  it("deletes the workload when any step after creating it fails", async () => {
    const failure = new Error("secret create failed");
    h.createSecret.mockRejectedValueOnce(failure);
    await expect(acquire()).rejects.toBe(failure);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.waitForReady).not.toHaveBeenCalled();
  });

  it("deletes the job-backend workload too", async () => {
    h.createSecret.mockRejectedValueOnce(new Error("secret create failed"));
    await expect(acquire({ backend: "job" })).rejects.toThrow("secret create failed");
  });

  it("treats a workload that is already gone as released", async () => {
    h.waitForReady.mockRejectedValueOnce(new Error("Sandbox is Terminating"));
    h.release.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: 404 }));
    await expect(acquire()).rejects.toThrow("Sandbox is Terminating");
  });
});
