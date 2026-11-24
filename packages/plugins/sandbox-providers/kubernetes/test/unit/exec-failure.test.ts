import { describe, expect, it, vi } from "vitest";
import {
  describeExecError,
  describePodState,
  diagnosePodAfterExecFailure,
  toExecError,
} from "../../src/exec-failure.js";

describe("describeExecError", () => {
  it("reads a ws ErrorEvent instead of printing [object Object]", () => {
    const event = { type: "error", message: "Unexpected server response: 404", error: new Error("Unexpected server response: 404") };
    expect(describeExecError(event)).toBe("Unexpected server response: 404");
  });

  it("uses the nested error when the event message is empty", () => {
    expect(describeExecError({ type: "error", message: "", error: new Error("socket hang up") })).toBe("socket hang up");
  });

  it("reads a V1Status", () => {
    expect(describeExecError({ status: "Failure", reason: "NotFound", message: 'pods "pc-1" not found', code: 404 }))
      .toBe('HTTP 404: NotFound: pods "pc-1" not found');
  });

  it("reads an ApiException with a JSON body", () => {
    const err = { code: 500, body: JSON.stringify({ reason: "InternalError", message: 'container not found ("agent")' }) };
    expect(describeExecError(err)).toBe('HTTP 500: InternalError: container not found ("agent")');
  });

  it("serialises an unknown object rather than stringifying it", () => {
    expect(describeExecError({ foo: "bar" })).toBe('{"foo":"bar"}');
    expect(describeExecError({})).toBe("unknown error");
    expect(describeExecError(null)).toBe("unknown error");
    expect(describeExecError("boom")).toBe("boom");
  });

  it("never returns [object Object]", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const value of [{}, circular, { message: {} }, { error: {} }, Object.create(null)]) {
      expect(describeExecError(value)).not.toContain("[object Object]");
    }
  });
});

describe("toExecError", () => {
  it("keeps a real Error and wraps anything else", () => {
    const original = new Error("watchdog");
    expect(toExecError(original)).toBe(original);
    const wrapped = toExecError({ type: "error", message: "ECONNRESET" });
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe("ECONNRESET");
  });
});

describe("describePodState", () => {
  it("names an OOMKilled container", () => {
    const pod = {
      status: {
        phase: "Running",
        containerStatuses: [{ name: "agent", restartCount: 1, lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } } }],
      },
    };
    expect(describePodState(pod, "pc-1", "agent")).toBe("container agent was OOMKilled (exit 137) and was restarted");
  });

  it("names a terminated container and a failed pod", () => {
    const pod = {
      status: {
        phase: "Failed",
        reason: "Evicted",
        containerStatuses: [{ name: "agent", state: { terminated: { reason: "OOMKilled", exitCode: 137 } } }],
      },
    };
    expect(describePodState(pod, "pc-1", "agent")).toBe("container agent was OOMKilled (exit 137); pod pc-1 is Failed (Evicted)");
  });

  it("names a terminating pod", () => {
    expect(describePodState({ metadata: { deletionTimestamp: "2026-11-24T00:00:00Z" }, status: { phase: "Running" } }, "pc-1", "agent"))
      .toBe("pod pc-1 is terminating");
  });

  it("returns null for a healthy pod", () => {
    expect(describePodState({ status: { phase: "Running", containerStatuses: [{ name: "agent", state: {} }] } }, "pc-1", "agent")).toBeNull();
  });
});

describe("diagnosePodAfterExecFailure", () => {
  it("reports a pod that no longer exists", async () => {
    const core = { readNamespacedPod: vi.fn(async () => { throw Object.assign(new Error("not found"), { code: 404 }); }) };
    await expect(diagnosePodAfterExecFailure({ core } as never, "ns", "pc-1", "agent"))
      .resolves.toBe("pod pc-1 no longer exists (deleted or evicted)");
  });

  it("returns null when the API server cannot be asked", async () => {
    const core = { readNamespacedPod: vi.fn(async () => { throw Object.assign(new Error("forbidden"), { code: 403 }); }) };
    await expect(diagnosePodAfterExecFailure({ core } as never, "ns", "pc-1", "agent")).resolves.toBeNull();
  });
});
