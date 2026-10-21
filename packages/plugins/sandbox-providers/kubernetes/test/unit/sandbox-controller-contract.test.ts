import { afterEach, describe, expect, it, vi } from "vitest";
import { getSandboxCrStatus, waitForSandboxReady } from "../../src/sandbox-cr-orchestrator.js";
import { buildSandboxCrManifest } from "../../src/sandbox-cr-builder.js";

afterEach(() => vi.restoreAllMocks());

// Match the published agent-sandbox v1.0.7 API: v1beta1, Ready conditions,
// metadata.generation and absolute shutdownTime. It has no status.phase.
describe("published agent-sandbox controller contract", () => {
  it("requests the served beta API and maps a current Ready condition to Running", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { generation: 2 },
      status: { conditions: [{ type: "Ready", status: "True", observedGeneration: 2 }] },
    });
    const status = await getSandboxCrStatus({ custom: { getNamespacedCustomObject: get } } as never, "tenant", "pc-run");
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ version: "v1beta1" }));
    expect(status).toMatchObject({ phase: "Running", active: 1 });
  });

  it("returns Running from the readiness wait when the controller omits phase", async () => {
    const get = vi.fn().mockResolvedValue({ status: { conditions: [{ type: "Ready", status: "True" }] } });
    const status = await waitForSandboxReady({ custom: { getNamespacedCustomObject: get } } as never, "tenant", "pc-run", { timeoutMs: 100 });
    expect(status).toMatchObject({ phase: "Running", active: 1 });
  });

  it("does not accept a Ready condition from an older generation", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { generation: 3 },
      status: { phase: "Ready", conditions: [{ type: "Ready", status: "True", observedGeneration: 2 }] },
    });
    const status = await getSandboxCrStatus({ custom: { getNamespacedCustomObject: get } } as never, "tenant", "pc-run");
    expect(status).toMatchObject({ phase: "Pending", active: 0 });
  });

  it("fails the wait when a deleting Sandbox still has a Ready condition", async () => {
    const get = vi.fn().mockResolvedValue({
      metadata: { deletionTimestamp: "2026-10-21T00:00:00Z" },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    });
    await expect(waitForSandboxReady({ custom: { getNamespacedCustomObject: get } } as never, "tenant", "pc-run", { timeoutMs: 100 })).rejects.toThrow(/Terminating/);
  });

  it("preserves the controller's pending reason without treating it as ready", async () => {
    const get = vi.fn().mockResolvedValue({
      status: { conditions: [{ type: "Ready", status: "False", reason: "PodNotReady", message: "Waiting for image" }] },
    });
    const status = await getSandboxCrStatus({ custom: { getNamespacedCustomObject: get } } as never, "tenant", "pc-run");
    expect(status).toMatchObject({ phase: "Pending", active: 0, reason: "PodNotReady", message: "Waiting for image" });
  });

  it("sets a native absolute delete deadline so a lost server cannot leave a sandbox indefinitely", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T00:00:00Z"));
    const manifest = buildSandboxCrManifest({
      namespace: "tenant", sandboxName: "pc-run", adapterType: "claude_local",
      image: "runtime@sha256:" + "0".repeat(64), envSecretName: "pc-run-env",
      serviceAccountName: "paperclip-tenant-sa", labels: {}, resources: {},
      activeDeadlineSec: 60,
    });
    expect(manifest.apiVersion).toBe("agents.x-k8s.io/v1beta1");
    expect(manifest.spec).toMatchObject({ shutdownPolicy: "Delete", shutdownTime: "2026-10-21T00:01:00.000Z" });
    expect(manifest.spec.podTemplate.spec.automountServiceAccountToken).toBe(false);
  });
});
