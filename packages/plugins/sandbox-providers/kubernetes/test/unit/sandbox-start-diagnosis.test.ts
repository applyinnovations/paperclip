import { describe, it, expect, vi } from "vitest";
import {
  classifySandboxStart,
  diagnoseSandboxStart,
  type SandboxStartEvent,
} from "../../src/sandbox-start-diagnosis.js";

// Messages as the agent-sandbox controller and scheduler reported them on
// 23 Nov 2026 (APP-114, APP-110, APP-155).
const QUOTA_CPU =
  'Error creating pod: pods "pc-01" is forbidden: exceeded quota: paperclip-quota, requested: requests.cpu=500m, used: requests.cpu=4, limited: requests.cpu=4';
const QUOTA_PODS =
  'Error creating pod: pods "pc-01" is forbidden: exceeded quota: paperclip-quota, requested: pods=1, used: pods=10, limited: pods=10';
const LIMIT_RANGE =
  'Error creating pod: pods "pc-01" is forbidden: maximum cpu usage per Container is 2, but limit is 4';

function warning(message: string, at: string, reason = "SandboxPodCreateFailed"): SandboxStartEvent {
  return { type: "Warning", reason, message, lastTimestamp: at };
}

describe("classifySandboxStart without a pod", () => {
  it("reports a full quota as capacity", () => {
    expect(classifySandboxStart({ pod: null, events: [warning(QUOTA_CPU, "2026-11-23T10:25:18Z")] })).toEqual({
      kind: "capacity",
      reason: "quota",
      message: `tenant quota is full: ${QUOTA_CPU}`,
    });
    expect(classifySandboxStart({ pod: null, events: [warning(QUOTA_PODS, "2026-11-23T21:30:00Z")] }))
      .toMatchObject({ kind: "capacity", reason: "quota" });
  });

  it("reports a LimitRange rejection as permanent, with the admission message", () => {
    expect(classifySandboxStart({ pod: null, events: [warning(LIMIT_RANGE, "2026-11-23T09:29:00Z")] })).toEqual({
      kind: "permanent",
      message: `the pod was refused at admission: ${LIMIT_RANGE}`,
    });
  });

  it("goes by the latest refusal", () => {
    const limitThenQuota = [warning(LIMIT_RANGE, "2026-11-23T09:29:00Z"), warning(QUOTA_CPU, "2026-11-23T09:30:00Z")];
    expect(classifySandboxStart({ pod: null, events: limitThenQuota })).toMatchObject({ kind: "capacity" });
    const quotaThenLimit = [warning(LIMIT_RANGE, "2026-11-23T09:32:00Z"), warning(QUOTA_CPU, "2026-11-23T09:30:00Z")];
    expect(classifySandboxStart({ pod: null, events: quotaThenLimit })).toMatchObject({ kind: "permanent" });
  });

  it("is pending with no refusal, or only Normal events", () => {
    expect(classifySandboxStart({ pod: null, events: [] })).toEqual({ kind: "pending" });
    expect(classifySandboxStart({
      pod: null,
      events: [{ type: "Normal", reason: "Created", message: "created pod", lastTimestamp: "2026-11-23T09:29:00Z" }],
    })).toEqual({ kind: "pending" });
  });

  it("keeps a long admission message to one bounded line", () => {
    const diagnosis = classifySandboxStart({
      pod: null,
      events: [warning(`forbidden: ${"x".repeat(2000)}\nsecond line`, "2026-11-23T09:29:00Z")],
    });
    expect(diagnosis.kind).toBe("permanent");
    if (diagnosis.kind !== "permanent") return;
    expect(diagnosis.message.length).toBeLessThanOrEqual(500);
    expect(diagnosis.message).not.toContain("\n");
  });
});

describe("classifySandboxStart with a pod", () => {
  it("reports an unschedulable pod as capacity", () => {
    const pod = {
      status: {
        conditions: [{
          type: "PodScheduled",
          status: "False",
          reason: "Unschedulable",
          message: "0/3 nodes are available: 1 Insufficient memory.",
        }],
      },
    };
    expect(classifySandboxStart({ pod, events: [] })).toEqual({
      kind: "capacity",
      reason: "scheduling",
      message: "no node can take the pod: 0/3 nodes are available: 1 Insufficient memory.",
    });
  });

  it.each(["ImagePullBackOff", "ErrImageNeverPull", "InvalidImageName", "CreateContainerConfigError"])(
    "reports a container waiting on %s as permanent",
    (reason) => {
      const pod = {
        status: { containerStatuses: [{ name: "agent", state: { waiting: { reason, message: "details" } } }] },
      };
      expect(classifySandboxStart({ pod, events: [] })).toEqual({
        kind: "permanent",
        message: `container agent cannot start: ${reason}: details`,
      });
    },
  );

  it("checks init containers too", () => {
    const pod = {
      status: { initContainerStatuses: [{ name: "init", state: { waiting: { reason: "ImagePullBackOff" } } }] },
    };
    expect(classifySandboxStart({ pod, events: [] }))
      .toEqual({ kind: "permanent", message: "container init cannot start: ImagePullBackOff" });
  });

  it("keeps waiting on a first ErrImagePull, a pulling image, or a scheduled pod", () => {
    for (const reason of ["ErrImagePull", "ContainerCreating", "PodInitializing"]) {
      const pod = { status: { containerStatuses: [{ name: "agent", state: { waiting: { reason } } }] } };
      expect(classifySandboxStart({ pod, events: [] })).toEqual({ kind: "pending" });
    }
    const scheduled = { status: { conditions: [{ type: "PodScheduled", status: "True" }] } };
    expect(classifySandboxStart({ pod: scheduled, events: [] })).toEqual({ kind: "pending" });
  });

  it("ignores quota refusals from before the pod existed", () => {
    expect(classifySandboxStart({ pod: { status: {} }, events: [warning(QUOTA_CPU, "2026-11-23T10:25:18Z")] }))
      .toEqual({ kind: "pending" });
  });
});

describe("diagnoseSandboxStart", () => {
  const notFound = Object.assign(new Error("not found"), { code: 404 });

  it("lists the Sandbox's events by name when it has no pod", async () => {
    const listNamespacedEvent = vi.fn(async () => ({ items: [warning(QUOTA_CPU, "2026-11-23T10:25:18Z")] }));
    const clients = { core: { readNamespacedPod: vi.fn(async () => { throw notFound; }), listNamespacedEvent } };
    await expect(diagnoseSandboxStart(clients as never, "paperclip-acme", "pc-01"))
      .resolves.toMatchObject({ kind: "capacity", reason: "quota" });
    expect(listNamespacedEvent).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      fieldSelector: "involvedObject.name=pc-01",
    });
  });

  it("reads the pod and skips events when the pod exists", async () => {
    const listNamespacedEvent = vi.fn();
    const pod = { status: { conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable" }] } };
    const clients = { core: { readNamespacedPod: vi.fn(async () => pod), listNamespacedEvent } };
    await expect(diagnoseSandboxStart(clients as never, "ns", "pc-01"))
      .resolves.toMatchObject({ kind: "capacity", reason: "scheduling" });
    expect(listNamespacedEvent).not.toHaveBeenCalled();
  });

  it("stays pending when events cannot be read (no RBAC) or the pod read fails", async () => {
    const forbidden = Object.assign(new Error("forbidden"), { code: 403 });
    const noEvents = { core: {
      readNamespacedPod: vi.fn(async () => { throw notFound; }),
      listNamespacedEvent: vi.fn(async () => { throw forbidden; }),
    } };
    await expect(diagnoseSandboxStart(noEvents as never, "ns", "pc-01")).resolves.toEqual({ kind: "pending" });
    const podReadFails = { core: { readNamespacedPod: vi.fn(async () => { throw forbidden; }), listNamespacedEvent: vi.fn() } };
    await expect(diagnoseSandboxStart(podReadFails as never, "ns", "pc-01")).resolves.toEqual({ kind: "pending" });
  });
});
