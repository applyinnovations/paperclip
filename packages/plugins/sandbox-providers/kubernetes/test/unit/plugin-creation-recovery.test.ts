import { describe, it, expect, vi, beforeEach } from "vitest";
import { readEnvironmentCreationCleanupError } from "@paperclipai/plugin-sdk";

// The host's creation recovery: after an acquire failed, it asks by attempt id
// whether a workload was created, then destroys it from the cleanup envelope.
const h = vi.hoisted(() => ({ clients: {} as Record<string, unknown> }));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({ getCurrentCluster: () => ({ server: "https://cluster.example:6443" }) })),
  makeKubeClients: vi.fn(() => h.clients),
}));

import plugin from "../../src/plugin.js";
import manifest from "../../src/manifest.js";

const ATTEMPT = "7b0c5f8e-1d2a-4c3b-9e4f-5a6b7c8d9e0f";
const RUN = "0f1e2d3c-4b5a-4968-8776-655443322110";
const COMPANY = "company-1";
const CONFIG = { inCluster: true, backend: "sandbox-cr" };

function sandbox(name: string, labels: Record<string, string>) {
  return { metadata: { name, labels } };
}
const ownLabels = {
  "paperclip.io/create-attempt": ATTEMPT,
  "paperclip.io/run-id": RUN,
  "paperclip.io/company-id": COMPANY,
};
function notFound(): Error {
  return Object.assign(new Error("not found"), { code: 404 });
}

function inspect(creationOperation?: { id: string; runId: string }) {
  return plugin.definition.onEnvironmentInspectLease!({
    driverKey: "kubernetes",
    companyId: COMPANY,
    environmentId: "env-1",
    config: CONFIG,
    providerLeaseId: ATTEMPT,
    ...(creationOperation ? { creationOperation } : {}),
  });
}

beforeEach(() => {
  h.clients = {};
});

describe("manifest", () => {
  it("opts the driver into creation recovery", () => {
    expect(manifest.environmentDrivers?.[0]?.creationOperationVersion).toBe(1);
  });
});

describe("onEnvironmentInspectLease", () => {
  it("finds the Sandbox a failed acquire created and returns a cleanup envelope the host accepts", async () => {
    const list = vi.fn().mockResolvedValue({ items: [sandbox("pc-leaked", ownLabels)] });
    h.clients = { custom: { listNamespacedCustomObject: list } };

    const observation = await inspect({ id: ATTEMPT, runId: RUN });

    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      plural: "sandboxes",
      labelSelector: `paperclip.io/create-attempt=${ATTEMPT}`,
    }));
    expect(observation).toMatchObject({ providerLeaseId: "pc-leaked", state: "active" });
    const cleanup = readEnvironmentCreationCleanupError({ data: {
      schema: "paperclip/environment-creation-cleanup/v1", cleanup: observation.creationCleanup,
    } });
    expect(cleanup).toMatchObject({
      providerLeaseId: "pc-leaked", companyId: COMPANY, environmentId: "env-1", runId: RUN, attemptId: ATTEMPT,
    });
  });

  it("looks up Jobs on the job backend", async () => {
    const listJobs = vi.fn().mockResolvedValue({ items: [sandbox("pc-job", ownLabels)] });
    h.clients = { batch: { listNamespacedJob: listJobs } };
    const observation = await plugin.definition.onEnvironmentInspectLease!({
      driverKey: "kubernetes", companyId: COMPANY, environmentId: "env-1", config: { ...CONFIG, backend: "job" },
      providerLeaseId: ATTEMPT, creationOperation: { id: ATTEMPT, runId: RUN },
    });
    expect(observation.creationCleanup?.providerLeaseId).toBe("pc-job");
  });

  it("reports unknown when the attempt created nothing", async () => {
    h.clients = { custom: { listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }) } };
    const observation = await inspect({ id: ATTEMPT, runId: RUN });
    expect(observation).toEqual({ providerLeaseId: ATTEMPT, state: "unknown" });
  });

  it("refuses a workload that carries the attempt id but belongs to another run", async () => {
    h.clients = { custom: { listNamespacedCustomObject: vi.fn().mockResolvedValue({
      items: [sandbox("pc-other", { ...ownLabels, "paperclip.io/run-id": "11111111-2222-4333-8444-555555555555" })],
    }) } };
    await expect(inspect({ id: ATTEMPT, runId: RUN })).rejects.toThrow("ownership does not match");
  });

  it("rejects an attempt id that is not a UUID before touching the cluster", async () => {
    const list = vi.fn();
    h.clients = { custom: { listNamespacedCustomObject: list } };
    await expect(inspect({ id: "pc-x,paperclip.io/run-id", runId: RUN })).rejects.toThrow("Invalid creation operation identity");
    expect(list).not.toHaveBeenCalled();
  });

  it("answers unknown to any other inspection, so it never proves a lease gone", async () => {
    const list = vi.fn();
    h.clients = { custom: { listNamespacedCustomObject: list, getNamespacedCustomObject: list } };
    expect(await inspect()).toEqual({ providerLeaseId: ATTEMPT, state: "unknown" });
    expect(list).not.toHaveBeenCalled();
  });
});

describe("onEnvironmentDestroyLease from a creation cleanup envelope", () => {
  async function envelope() {
    h.clients = { custom: { listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [sandbox("pc-leaked", ownLabels)] }) } };
    return (await inspect({ id: ATTEMPT, runId: RUN })).creationCleanup!;
  }
  function destroy(failedCreateCleanup: unknown) {
    return plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes", companyId: COMPANY, environmentId: "env-1", config: CONFIG,
      providerLeaseId: "pc-leaked", leaseMetadata: { failedCreateCleanup },
    });
  }

  it("deletes the leaked Sandbox and confirms it gone", async () => {
    const cleanup = await envelope();
    const deleteCr = vi.fn().mockResolvedValue({});
    const getCr = vi.fn()
      .mockResolvedValueOnce(sandbox("pc-leaked", ownLabels))
      .mockRejectedValue(notFound());
    h.clients = {
      custom: { getNamespacedCustomObject: getCr, deleteNamespacedCustomObject: deleteCr },
      core: { deleteNamespacedSecret: vi.fn().mockResolvedValue({}), deleteNamespacedPod: vi.fn(),
        readNamespacedPod: vi.fn().mockRejectedValue(notFound()) },
      batch: { deleteNamespacedJob: vi.fn() },
    };
    const receipt = await destroy(cleanup);
    expect(deleteCr).toHaveBeenCalledWith(expect.objectContaining({ name: "pc-leaked" }));
    expect(receipt).toEqual({ providerLeaseId: "pc-leaked", state: "destroyed" });
  });

  it("never deletes a workload whose labels no longer match the envelope", async () => {
    const cleanup = await envelope();
    const deleteCr = vi.fn();
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(sandbox("pc-leaked", { ...ownLabels,
          "paperclip.io/create-attempt": "99999999-8888-4777-8666-555555555555" })),
        deleteNamespacedCustomObject: deleteCr,
      },
    };
    await expect(destroy(cleanup)).rejects.toThrow("ownership does not match");
    expect(deleteCr).not.toHaveBeenCalled();
  });

  it("rejects a malformed envelope", async () => {
    h.clients = { custom: { deleteNamespacedCustomObject: vi.fn() } };
    await expect(destroy({ providerLeaseId: "pc-leaked" })).rejects.toThrow("Creation cleanup ownership is invalid");
  });
});
