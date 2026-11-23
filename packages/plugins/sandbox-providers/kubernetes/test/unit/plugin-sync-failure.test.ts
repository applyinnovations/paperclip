import { describe, it, expect, vi, beforeEach } from "vitest";

// APP-17 end to end at the plugin boundary: the kubelet evicts the sandbox pod
// (its /tmp emptyDir went over the limit), then teardown runs sync-out. The exec
// fails without an exit code, and the error must name the eviction rather than
// read "Kubernetes syncOut directory transfer failed (exit 1)".
const h = vi.hoisted(() => ({
  readNamespacedPod: vi.fn(),
  execInPodStreaming: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => ({ core: { readNamespacedPod: h.readNamespacedPod } })),
}));
vi.mock("../../src/sandbox-cr-orchestrator.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/sandbox-cr-orchestrator.js")>();
  return {
    ...actual,
    sandboxCrOrchestrator: {
      ...actual.sandboxCrOrchestrator,
      waitForCompletion: vi.fn(async () => ({ phase: "Running", active: 1 })),
      findPod: vi.fn(async () => "pc-pod"),
    },
  };
});
vi.mock("../../src/pod-exec.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/pod-exec.js")>();
  return { ...actual, execInPodStreaming: h.execInPodStreaming };
});

import plugin from "../../src/plugin.js";

function syncOut() {
  return plugin.definition.onEnvironmentSyncOut!({
    driverKey: "kubernetes",
    companyId: "company-1",
    environmentId: "env-1",
    issueId: "issue-1",
    config: { inCluster: true },
    lease: {
      providerLeaseId: "pc-lease",
      metadata: { namespace: "ns", backend: "sandbox-cr", podName: "pc-pod", remoteCwd: "/workspace/paperclip-workspace" },
    },
    operations: [{
      operationId: "op",
      files: [{ sourcePath: "/workspace/paperclip-workspace", targetPath: "/tmp/never-written", kind: "directory" }],
    }],
  } as never);
}

beforeEach(async () => {
  h.readNamespacedPod.mockReset();
  h.execInPodStreaming.mockReset();
  h.logError.mockReset();
  await plugin.definition.setup({ logger: { info: vi.fn(), warn: vi.fn(), error: h.logError, debug: vi.fn() } } as never);
});

describe("onEnvironmentSyncOut on an evicted sandbox", () => {
  it("names the eviction in the error and logs the failed direction", async () => {
    h.execInPodStreaming.mockRejectedValue(new Error(
      "execInPodStreaming: the exec failed without a command exit code (pod=pc-pod, container=agent): InternalError: container is not running",
    ));
    h.readNamespacedPod.mockResolvedValue({
      status: { phase: "Failed", reason: "Evicted", message: 'Usage of EmptyDir volume "tmp" exceeds the limit "2Gi". ' },
    });

    await expect(syncOut()).rejects.toThrow(
      'execInPodStreaming: the exec failed without a command exit code (pod=pc-pod, container=agent): InternalError: container is not running; sandbox pod pc-pod is Failed (Evicted: Usage of EmptyDir volume "tmp" exceeds the limit "2Gi".)',
    );
    expect(h.readNamespacedPod).toHaveBeenCalledWith({ namespace: "ns", name: "pc-pod" });
    expect(h.logError).toHaveBeenCalledWith("Kubernetes sandbox file sync failed", expect.objectContaining({
      direction: "syncOut",
      issueId: "issue-1",
      providerLeaseId: "pc-lease",
      error: expect.stringContaining("Evicted"),
    }));
  });

  it("leaves the error alone when the pod is healthy", async () => {
    h.execInPodStreaming.mockImplementation(async (_kc, _ns, _pod, _container, _command, io: { stdout?: NodeJS.WritableStream }) => {
      io.stdout?.end();
      return { exitCode: 43, stderr: "tar: x: Cannot open: Permission denied\ntar failed\n" };
    });
    h.readNamespacedPod.mockResolvedValue({ status: { phase: "Running" } });

    await expect(syncOut()).rejects.toThrow(
      /^Kubernetes syncOut directory transfer failed \(exit 43, 0 bytes received\): tar: x: Cannot open: Permission denied\ntar failed$/,
    );
  });
});
