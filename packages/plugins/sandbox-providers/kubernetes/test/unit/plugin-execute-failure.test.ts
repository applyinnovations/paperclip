import { beforeEach, describe, expect, it, vi } from "vitest";

// When an exec cannot start or ends without an exit code (the pod was deleted,
// evicted or OOM-killed), the run error must name the cause, not print the
// client's error object as "[object Object]".
const h = vi.hoisted(() => ({
  execImpl: (async () => ({ exitCode: 0, stdout: "", stderr: "" })) as (...args: unknown[]) => Promise<unknown>,
  readPod: (async () => ({ status: { phase: "Running" } })) as (...args: unknown[]) => Promise<unknown>,
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => ({ core: { readNamespacedPod: (...args: unknown[]) => h.readPod(...args) } })),
}));

vi.mock("../../src/sandbox-cr-orchestrator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sandbox-cr-orchestrator.js")>();
  return {
    ...actual,
    sandboxCrOrchestrator: {
      ...actual.sandboxCrOrchestrator,
      waitForCompletion: vi.fn(async () => undefined),
      findPod: vi.fn(async () => "pc-fail-pod"),
    },
  };
});

vi.mock("../../src/pod-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pod-exec.js")>();
  return { ...actual, execInPod: vi.fn((...args: unknown[]) => h.execImpl(...args)) };
});

import plugin from "../../src/plugin.js";
import { exitFromExecStatus } from "../../src/pod-exec.js";

function execute() {
  return plugin.definition.onEnvironmentExecute!({
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    config: { inCluster: true, backend: "sandbox-cr" },
    lease: {
      providerLeaseId: "pc-fail",
      metadata: { namespace: "paperclip-acme", podName: "pc-fail-pod", backend: "sandbox-cr" },
    },
    command: "sh",
    args: ["-c", "git bundle create x"],
    cwd: "/workspace",
    timeoutMs: 10_000,
  });
}

beforeEach(() => {
  h.readPod = async () => ({ status: { phase: "Running" } });
});

describe("onEnvironmentExecute failure detail", () => {
  it("names the exec error and an OOMKilled container when the exec cannot start", async () => {
    h.execImpl = async () => { throw { type: "error", message: "Unexpected server response: 500" }; };
    h.readPod = async () => ({
      status: {
        phase: "Running",
        containerStatuses: [{ name: "agent", lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } } }],
      },
    });
    const result = await execute();
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.stderr).not.toContain("[object Object]");
    expect(result.stderr).toContain("Kubernetes exec in pod pc-fail-pod failed: Unexpected server response: 500");
    expect(result.stderr).toContain("container agent was OOMKilled (exit 137)");
  });

  it("says the pod is gone when it no longer exists", async () => {
    h.execImpl = async () => { throw { status: "Failure", reason: "NotFound", code: 404, message: 'pods "pc-fail-pod" not found' }; };
    h.readPod = async () => { throw Object.assign(new Error("not found"), { code: 404 }); };
    const result = await execute();
    expect(result.stderr).toContain('HTTP 404: NotFound: pods "pc-fail-pod" not found');
    expect(result.stderr).toContain("pod pc-fail-pod no longer exists");
  });

  it("adds the pod state when the exec ends without a command exit code", async () => {
    const { diagnostic } = exitFromExecStatus({ status: "Failure", reason: "InternalError", message: "container killed" });
    h.execImpl = async () => ({ exitCode: 1, stdout: "", stderr: diagnostic });
    h.readPod = async () => ({
      status: { phase: "Running", containerStatuses: [{ name: "agent", state: { terminated: { reason: "OOMKilled", exitCode: 137 } } }] },
    });
    const result = await execute();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("container killed");
    expect(result.stderr).toContain("Pod state: container agent was OOMKilled (exit 137)");
  });

  it("does not read the pod when the command itself failed", async () => {
    const readPod = vi.fn(async () => ({}));
    h.readPod = readPod;
    h.execImpl = async () => ({ exitCode: 128, stdout: "", stderr: "fatal: bad object\n" });
    const result = await execute();
    expect(result.stderr).toBe("fatal: bad object\n");
    expect(readPod).not.toHaveBeenCalled();
  });
});
