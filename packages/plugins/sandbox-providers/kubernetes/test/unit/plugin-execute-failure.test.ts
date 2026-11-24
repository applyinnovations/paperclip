import { HttpMethod, RequestContext } from "@kubernetes/client-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { POD_DIAGNOSTIC_TIMEOUT_MS } from "../../src/exec-failure.js";
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

// A pod GET that never answers until its request is aborted, the way a stalled
// API server or network looks to the client.
type StalledGet = { calls: number; signals: AbortSignal[] };
function stallPodGet(): StalledGet {
  const state: StalledGet = { calls: 0, signals: [] };
  h.readPod = async (_param: unknown, options?: unknown) => {
    state.calls += 1;
    const middleware = (options as { middleware?: Array<{ pre(ctx: RequestContext): { toPromise(): Promise<RequestContext> } }> } | undefined)?.middleware ?? [];
    const ctx = new RequestContext("https://kube.invalid/api/v1/namespaces/paperclip-acme/pods/pc-fail-pod", HttpMethod.GET);
    for (const m of middleware) await m.pre(ctx).toPromise();
    const signal = ctx.getSignal();
    if (signal) state.signals.push(signal);
    return await new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  return state;
}

describe("onEnvironmentExecute with a stalled pod diagnostic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function settleWithin<T>(promise: Promise<T>): Promise<T> {
    let settled = false;
    void promise.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(POD_DIAGNOSTIC_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    return promise;
  }

  it("returns the exec setup error once the diagnostic budget runs out", async () => {
    h.execImpl = async () => { throw { type: "error", message: "Unexpected server response: 500" }; };
    const get = stallPodGet();
    const result = await settleWithin(execute());
    expect(get.calls).toBe(1);
    expect(get.signals.map((signal) => signal.aborted)).toEqual([true]);
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toBe("Kubernetes exec in pod pc-fail-pod failed: Unexpected server response: 500");
  });

  it("returns the missing-exit-code diagnostic once the diagnostic budget runs out", async () => {
    const { diagnostic } = exitFromExecStatus({ status: "Failure", reason: "InternalError", message: "container killed" });
    h.execImpl = async () => ({ exitCode: 1, stdout: "", stderr: diagnostic });
    const get = stallPodGet();
    const result = await settleWithin(execute());
    expect(get.calls).toBe(1);
    expect(get.signals.map((signal) => signal.aborted)).toEqual([true]);
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toBe(diagnostic);
  });
});
