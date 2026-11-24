import { describe, it, expect, vi } from "vitest";
import {
  createQuotaGate,
  parseQuantity,
  quotaShortfall,
  QUOTA_SHORTFALL_POLLS,
  sandboxQuotaDemand,
  SandboxQuotaExceededError,
} from "../../src/quota.js";

const GI = 2 ** 30;

function manifest(resources: Record<string, Record<string, string>>) {
  return { spec: { podTemplate: { spec: { containers: [{ name: "agent", resources }] } } } };
}

// The live tenant quota on 2026-11-24, with pods at the limit.
const fullPods = {
  status: {
    hard: { pods: "16", "requests.cpu": "8", "requests.memory": "16Gi", "limits.cpu": "32", "limits.memory": "128Gi" },
    used: { pods: "16", "requests.cpu": "4", "requests.memory": "16Gi", "limits.cpu": "32", "limits.memory": "128Gi" },
  },
};
const roomy = {
  status: {
    hard: { pods: "16", "requests.cpu": "8", "requests.memory": "16Gi", "limits.cpu": "32", "limits.memory": "128Gi" },
    used: { pods: "13", "requests.cpu": "3250m", "requests.memory": "13Gi", "limits.cpu": "26", "limits.memory": "104Gi" },
  },
};
const notFound = () => Object.assign(new Error("not found"), { code: 404 });

function clients(opts: { quota?: unknown; quotaError?: unknown; podExists?: boolean }) {
  return {
    core: {
      readNamespacedResourceQuota: vi.fn(async () => {
        if (opts.quotaError) throw opts.quotaError;
        return opts.quota;
      }),
      readNamespacedPod: vi.fn(async () => {
        if (!opts.podExists) throw notFound();
        return { metadata: { name: "pc-1" } };
      }),
    },
  };
}

describe("parseQuantity", () => {
  it("parses the quantities a quota reports", () => {
    expect(parseQuantity("16")).toBe(16);
    expect(parseQuantity("3250m")).toBeCloseTo(3.25);
    expect(parseQuantity("13Gi")).toBe(13 * GI);
    expect(parseQuantity("1k")).toBe(1000);
    expect(parseQuantity("nonsense")).toBeNaN();
  });
});

describe("sandboxQuotaDemand", () => {
  it("counts one pod plus the container's requests and limits", () => {
    const demand = sandboxQuotaDemand(manifest({
      requests: { cpu: "250m", memory: "1Gi" },
      limits: { cpu: "2", memory: "8Gi" },
    }));
    expect(demand).toEqual({
      pods: 1,
      "requests.cpu": 0.25,
      cpu: 0.25,
      "requests.memory": GI,
      memory: GI,
      "limits.cpu": 2,
      "limits.memory": 8 * GI,
    });
  });
});

describe("quotaShortfall", () => {
  const demand = { pods: 1, "requests.memory": 4 * GI, "limits.memory": 8 * GI };

  it("names a resource at its limit", () => {
    expect(quotaShortfall(fullPods, { pods: 1 })).toEqual(["pods 16/16"]);
  });

  it("names a resource that has room, but not enough for this pod", () => {
    // 13Gi of 16Gi requested; a pod asking 4Gi does not fit.
    expect(quotaShortfall(roomy, demand)).toEqual(["requests.memory 13Gi/16Gi"]);
  });

  it("is empty when the pod fits", () => {
    expect(quotaShortfall(roomy, { pods: 1, "requests.memory": GI, "limits.memory": 8 * GI })).toEqual([]);
  });

  it("ignores resources the quota does not cap or reports unreadably", () => {
    expect(quotaShortfall({ status: { hard: { pods: "lots" }, used: { pods: "16" } } }, { pods: 1, cpu: 1 })).toEqual([]);
  });
});

describe("createQuotaGate", () => {
  const gate = (c: ReturnType<typeof clients>, logger = { warn: vi.fn() }) =>
    createQuotaGate({ clients: c as never, namespace: "ns", sandboxName: "pc-1", demand: { pods: 1 }, logger });

  it("fails, naming the quota and usage, once the pod-less Sandbox has seen no room on consecutive polls", async () => {
    const check = gate(clients({ quota: fullPods }));
    for (let poll = 1; poll < QUOTA_SHORTFALL_POLLS; poll++) await expect(check()).resolves.toBeUndefined();
    const error = await check().catch(value => value);
    expect(error).toBeInstanceOf(SandboxQuotaExceededError);
    expect(error.message).toContain("quota paperclip-quota exhausted: pods 16/16");
  });

  it("does not fail when the quota has room", async () => {
    const check = gate(clients({ quota: roomy }));
    for (let poll = 0; poll < 5; poll++) await expect(check()).resolves.toBeUndefined();
  });

  it("does not fail once the Sandbox has its pod (which itself fills the quota)", async () => {
    const check = gate(clients({ quota: fullPods, podExists: true }));
    for (let poll = 0; poll < 5; poll++) await expect(check()).resolves.toBeUndefined();
  });

  it.each([
    ["forbidden", Object.assign(new Error("forbidden"), { code: 403 })],
    ["missing", notFound()],
    ["unreachable", new Error("ECONNRESET")],
  ])("leaves the wait as it was when the quota is %s, and stops reading it", async (_label, quotaError) => {
    const c = clients({ quotaError });
    const logger = { warn: vi.fn() };
    const check = gate(c, logger);
    for (let poll = 0; poll < 5; poll++) await expect(check()).resolves.toBeUndefined();
    expect(c.core.readNamespacedResourceQuota).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("counts an unreadable pod as present rather than guess a quota error", async () => {
    const c = clients({ quota: fullPods });
    c.core.readNamespacedPod.mockRejectedValue(Object.assign(new Error("forbidden"), { code: 403 }));
    const check = gate(c);
    for (let poll = 0; poll < 5; poll++) await expect(check()).resolves.toBeUndefined();
  });

  // A read that never answers, like an API proxy that accepts the connection
  // and then hangs; it settles only when aborted.
  const stalled = (_param: unknown, options?: { middleware?: Array<{ pre(c: unknown): Promise<unknown> }> }) =>
    new Promise((_resolve, reject) => {
      let signal: AbortSignal | undefined;
      void options?.middleware?.[0]?.pre({ setSignal: (s: AbortSignal) => { signal = s; } });
      signal?.addEventListener("abort", () => reject(signal!.reason));
    });

  it.each(["quota", "pod"] as const)(
    "stops at the wait's deadline, cancels the request and turns off when the %s read stalls",
    async (which) => {
      const c = clients({ quota: fullPods });
      if (which === "quota") c.core.readNamespacedResourceQuota.mockImplementation(stalled as never);
      else c.core.readNamespacedPod.mockImplementation(stalled as never);
      const logger = { warn: vi.fn() };
      const check = createQuotaGate({
        clients: c as never, namespace: "ns", sandboxName: "pc-1", demand: { pods: 1 }, logger,
      });
      const started = Date.now();
      await expect(check({ signal: AbortSignal.timeout(30) })).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      // Turned off: later polls read nothing and never fail.
      const reads = c.core.readNamespacedResourceQuota.mock.calls.length;
      for (let poll = 0; poll < 3; poll++) await expect(check()).resolves.toBeUndefined();
      expect(c.core.readNamespacedResourceQuota).toHaveBeenCalledTimes(reads);
    },
  );

  it("bounds a stalled read by its own timeout when the wait has time left", async () => {
    const c = clients({ quota: fullPods });
    c.core.readNamespacedResourceQuota.mockImplementation(stalled as never);
    const logger = { warn: vi.fn() };
    const check = createQuotaGate({
      clients: c as never, namespace: "ns", sandboxName: "pc-1", demand: { pods: 1 }, logger, probeTimeoutMs: 30,
    });
    await expect(check({ signal: new AbortController().signal })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
