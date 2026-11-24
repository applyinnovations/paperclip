import { beforeEach, describe, expect, it, vi } from "vitest";

// acquireLease against fakes for everything that would touch a cluster; the
// built Sandbox manifest is recorded so its labels can be checked.
const h = vi.hoisted(() => ({ manifests: [] as Array<Record<string, unknown>> }));

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
      ...actual.sandboxCrOrchestrator,
      claim: vi.fn(async (_clients: unknown, _ns: string, manifest: Record<string, unknown>) => {
        h.manifests.push(manifest);
        return { uid: "uid-1" };
      }),
      findPod: vi.fn(async () => "pc-pod"),
      release: vi.fn(async () => undefined),
    },
  };
});
vi.mock("../../src/scoped-network-egress.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/scoped-network-egress.js")>();
  return { ...actual, createScopedNetworkEgressPolicyOrReleaseWorkload: vi.fn(async () => null) };
});

import plugin from "../../src/plugin.js";

function acquire(agentId: string | undefined) {
  return plugin.definition.onEnvironmentAcquireLease!({
    driverKey: "kubernetes",
    companyId: "company-1",
    environmentId: "env-1",
    runId: "run-1",
    agentId,
    config: { inCluster: true, backend: "sandbox-cr" },
  } as never);
}

beforeEach(() => {
  h.manifests.length = 0;
});

describe("Sandbox labels", () => {
  it("labels the Sandbox and its pod with the agent and the run", async () => {
    await acquire("agent-1");
    const manifest = h.manifests[0]!;
    const labels = (manifest.metadata as { labels: Record<string, string> }).labels;
    const podLabels = (manifest.spec as { podTemplate: { metadata: { labels: Record<string, string> } } })
      .podTemplate.metadata.labels;
    for (const set of [labels, podLabels]) {
      expect(set["paperclip.io/agent-id"]).toBe("agent-1");
      expect(set["paperclip.io/run-id"]).toBe("run-1");
    }
  });

  it("leaves out the agent label for a lease with no agent", async () => {
    await acquire(undefined);
    const labels = (h.manifests[0]!.metadata as { labels: Record<string, string> }).labels;
    expect(labels).not.toHaveProperty("paperclip.io/agent-id");
    expect(labels["paperclip.io/run-id"]).toBe("run-1");
  });
});
