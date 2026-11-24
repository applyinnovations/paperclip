import { describe, it, expect, vi, beforeEach } from "vitest";
import { readEnvironmentCreationCleanupError } from "@paperclipai/plugin-sdk";

// Creation-operation recovery (creationOperationVersion: 1) against an
// in-memory cluster: acquire really creates a Sandbox CR in the fake store,
// inspect reads it back, destroy really deletes it.
const h = vi.hoisted(() => ({
  sandboxes: new Map<string, Record<string, unknown>>(),
  jobs: new Map<string, Record<string, unknown>>(),
  secrets: new Set<string>(),
  claimed: [] as Array<Record<string, unknown>>,
  clients: {} as Record<string, unknown>,
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));
vi.mock("../../src/tenant-orchestrator.js", () => ({ ensureTenant: vi.fn(async () => undefined) }));
vi.mock("../../src/secret-manager.js", () => ({
  createPerRunSecret: vi.fn(async (_clients: unknown, input: { secretName: string }) => {
    h.secrets.add(input.secretName);
  }),
}));
vi.mock("../../src/scoped-network-egress.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/scoped-network-egress.js")>();
  return { ...actual, createScopedNetworkEgressPolicyOrReleaseWorkload: vi.fn(async () => null) };
});

import plugin from "../../src/plugin.js";
import manifest, { DEFAULT_ACQUIRE_TIMEOUT_MS } from "../../src/manifest.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const OPERATION = "44444444-4444-4444-8444-444444444444";
const CONFIG = { inCluster: true, backend: "sandbox-cr" };

function notFound(): Error {
  return Object.assign(new Error("not found"), { code: 404 });
}

function fakeCluster(): Record<string, unknown> {
  return {
    custom: {
      createNamespacedCustomObject: vi.fn(async ({ body }: { body: Record<string, unknown> }) => {
        const metadata = body.metadata as { name: string };
        h.claimed.push(body);
        const cr = {
          ...body,
          metadata: { ...metadata, uid: `uid-${metadata.name}` },
          status: { conditions: [{ type: "Ready", status: "True" }], podName: metadata.name },
        };
        h.sandboxes.set(metadata.name, cr);
        return cr;
      }),
      getNamespacedCustomObject: vi.fn(async ({ name }: { name: string }) => {
        const cr = h.sandboxes.get(name);
        if (!cr) throw notFound();
        return cr;
      }),
      deleteNamespacedCustomObject: vi.fn(async ({ name }: { name: string }) => {
        if (!h.sandboxes.delete(name)) throw notFound();
      }),
    },
    batch: {
      readNamespacedJob: vi.fn(async ({ name }: { name: string }) => {
        const job = h.jobs.get(name);
        if (!job) throw notFound();
        return job;
      }),
    },
    core: {
      readNamespacedPod: vi.fn(async ({ name }: { name: string }) => {
        if (!h.sandboxes.has(name)) throw notFound();
        return { metadata: {}, status: { phase: "Running" } };
      }),
      deleteNamespacedPod: vi.fn(async () => {
        throw notFound();
      }),
      deleteNamespacedSecret: vi.fn(async ({ name }: { name: string }) => {
        if (!h.secrets.delete(name)) throw notFound();
      }),
    },
  };
}

function acquire(creationOperationId: string | null = OPERATION) {
  return plugin.definition.onEnvironmentAcquireLease!({
    driverKey: "kubernetes",
    companyId: COMPANY,
    environmentId: ENVIRONMENT,
    runId: RUN,
    ...(creationOperationId !== null ? { creationOperationId } : {}),
    config: CONFIG,
  } as never);
}

/** What the host's recoverSandboxCreations sends for a pending operation. */
function inspectCreation(overrides: { companyId?: string; environmentId?: string; runId?: string } = {}) {
  return plugin.definition.onEnvironmentInspectLease!({
    driverKey: "kubernetes",
    companyId: overrides.companyId ?? COMPANY,
    environmentId: overrides.environmentId ?? ENVIRONMENT,
    config: CONFIG,
    providerLeaseId: OPERATION,
    creationOperation: { id: OPERATION, runId: overrides.runId ?? RUN },
  });
}

/**
 * The host's side of recovery (sandbox-creation-operations.ts): validate the
 * envelope against the operation, then destroy with it as failedCreateCleanup.
 */
async function recover() {
  const observation = await inspectCreation();
  const cleanup = readEnvironmentCreationCleanupError({ data: {
    schema: "paperclip/environment-creation-cleanup/v1", cleanup: observation.creationCleanup,
  } });
  expect(cleanup).not.toBeNull();
  expect(cleanup).toMatchObject({
    companyId: COMPANY, environmentId: ENVIRONMENT, runId: RUN, attemptId: OPERATION,
    providerLeaseId: observation.providerLeaseId,
  });
  const receipt = await plugin.definition.onEnvironmentDestroyLease!({
    driverKey: "kubernetes",
    companyId: COMPANY,
    environmentId: ENVIRONMENT,
    config: CONFIG,
    providerLeaseId: cleanup!.providerLeaseId,
    leaseMetadata: { failedCreateCleanup: cleanup },
  });
  return { observation, receipt };
}

beforeEach(() => {
  h.sandboxes.clear();
  h.jobs.clear();
  h.secrets.clear();
  h.claimed.length = 0;
  h.clients = fakeCluster();
});

describe("manifest", () => {
  const driver = manifest.environmentDrivers![0]!;

  it("gives an acquire at least the provider's own pod start-up wait plus a margin", () => {
    // The host otherwise gives up at its 30 s RPC default while the provider
    // keeps waiting up to podStartTimeoutSec (300 s) and creates the Sandbox.
    expect(driver.defaultAcquireTimeoutMs).toBe(DEFAULT_ACQUIRE_TIMEOUT_MS);
    expect(DEFAULT_ACQUIRE_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000 + 30_000);
  });

  it("opts in to host creation-operation recovery", () => {
    expect(driver.creationOperationVersion).toBe(1);
    expect(plugin.definition.onEnvironmentInspectLease).toBeTypeOf("function");
  });
});

describe("acquire with a creation operation", () => {
  it("names the Sandbox after the operation and labels its owner", async () => {
    const lease = await acquire();
    expect(lease.providerLeaseId).toBe(`pc-${OPERATION}`);
    const labels = (h.claimed[0]!.metadata as { labels: Record<string, string> }).labels;
    expect(labels).toMatchObject({
      "paperclip.io/creation-operation-id": OPERATION,
      "paperclip.io/company-id": COMPANY,
      "paperclip.io/environment-id": ENVIRONMENT,
      "paperclip.io/run-id": RUN,
    });
  });

  it("keeps a random name when the host sends no operation", async () => {
    const lease = await acquire(null);
    expect(lease.providerLeaseId).toMatch(/^pc-[0-9a-z]{26}$/);
    const labels = (h.claimed[0]!.metadata as { labels: Record<string, string> }).labels;
    expect(labels["paperclip.io/creation-operation-id"]).toBeUndefined();
  });

  it("rejects a malformed operation identity before creating anything", async () => {
    await expect(acquire("not-a-uuid")).rejects.toThrow("Invalid creation operation identity");
    expect(h.claimed).toHaveLength(0);
  });
});

describe("creation recovery", () => {
  it("leaves no Sandbox once recovery runs after the acquire caller gave up", async () => {
    // The provider finished creating the Sandbox, but the host had already
    // timed out, so the lease was never recorded: an orphan.
    await acquire();
    expect(h.sandboxes.has(`pc-${OPERATION}`)).toBe(true);
    expect(h.secrets.has(`pc-${OPERATION}-env`)).toBe(true);

    const { observation, receipt } = await recover();
    expect(observation.state).toBe("active");
    expect(receipt).toEqual({ providerLeaseId: `pc-${OPERATION}`, state: "destroyed" });
    expect(h.sandboxes.size).toBe(0);
    expect(h.secrets.size).toBe(0);
  });

  it("finds the Sandbox by its operation label and reports it gone once it is not there", async () => {
    await acquire();
    expect(await inspectCreation()).toMatchObject({ providerLeaseId: `pc-${OPERATION}`, state: "active" });
    h.sandboxes.clear();
    const gone = await inspectCreation();
    expect(gone).toMatchObject({ providerLeaseId: `pc-${OPERATION}`, state: "destroyed" });
    // Absence still carries the envelope, so the host resolves the operation
    // with an idempotent destroy rather than parking it for an operator.
    expect(gone.creationCleanup?.providerLeaseId).toBe(`pc-${OPERATION}`);
  });

  it("resolves an operation whose acquire failed before creating anything", async () => {
    const { observation, receipt } = await recover();
    expect(observation.state).toBe("destroyed");
    expect(receipt).toEqual({ providerLeaseId: `pc-${OPERATION}`, state: "destroyed" });
  });

  it("refuses to report a Sandbox owned by another run", async () => {
    await acquire();
    await expect(inspectCreation({ runId: "55555555-5555-4555-8555-555555555555" }))
      .rejects.toThrow("ownership does not match");
    expect(h.sandboxes.size).toBe(1);
  });

  it("rejects a malformed operation identity", async () => {
    await expect(plugin.definition.onEnvironmentInspectLease!({
      driverKey: "kubernetes", companyId: COMPANY, environmentId: ENVIRONMENT, config: CONFIG,
      providerLeaseId: "x", creationOperation: { id: "../x", runId: RUN },
    })).rejects.toThrow("Invalid creation operation identity");
  });

  it("refuses a cleanup envelope from another cluster account", async () => {
    await acquire();
    const observation = await inspectCreation();
    await expect(plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes", companyId: COMPANY, environmentId: ENVIRONMENT, config: CONFIG,
      providerLeaseId: observation.providerLeaseId,
      leaseMetadata: { failedCreateCleanup: { ...observation.creationCleanup, accountFingerprint: "0".repeat(64) } },
    })).rejects.toThrow("cleanup scope does not match");
    expect(h.sandboxes.size).toBe(1);
  });
});

describe("inspect an ordinary lease", () => {
  it("reports a live Sandbox active and a deleted one destroyed", async () => {
    const lease = await acquire(null);
    const inspect = () => plugin.definition.onEnvironmentInspectLease!({
      driverKey: "kubernetes", companyId: COMPANY, environmentId: ENVIRONMENT, config: CONFIG,
      providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata,
    });
    expect(await inspect()).toEqual({ providerLeaseId: lease.providerLeaseId, state: "active" });
    h.sandboxes.clear();
    expect(await inspect()).toEqual({ providerLeaseId: lease.providerLeaseId, state: "destroyed" });
  });

  it("propagates errors other than not-found instead of guessing", async () => {
    (h.clients.custom as { getNamespacedCustomObject: ReturnType<typeof vi.fn> }).getNamespacedCustomObject
      .mockRejectedValueOnce(Object.assign(new Error("forbidden"), { code: 403 }));
    await expect(plugin.definition.onEnvironmentInspectLease!({
      driverKey: "kubernetes", companyId: COMPANY, environmentId: ENVIRONMENT, config: CONFIG,
      providerLeaseId: "pc-x",
    })).rejects.toThrow("forbidden");
  });
});
