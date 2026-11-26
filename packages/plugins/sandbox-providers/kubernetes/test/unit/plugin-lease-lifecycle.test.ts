import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the kube-client module so the plugin handlers run against injected
// fake API clients instead of a real cluster. h.clients is swapped per test.
const h = vi.hoisted(() => ({ clients: {} as Record<string, unknown> }));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

import plugin from "../../src/plugin.js";

const CONFIG = { inCluster: true, backend: "sandbox-cr" };

function leaseMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    namespace: "paperclip-acme",
    jobName: "pc-abc",
    podName: "pc-abc-pod",
    secretName: "pc-abc-env",
    phase: "Pending",
    backend: "sandbox-cr",
    ...overrides,
  };
}

function notFound(): Error {
  return Object.assign(new Error("not found"), { code: 404 });
}

function readySandboxCr(podName: string): Record<string, unknown> {
  return {
    metadata: { uid: "uid-1" },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      podName,
    },
  };
}

beforeEach(() => {
  h.clients = {};
});

describe("onEnvironmentResumeLease", () => {
  it("is implemented (Daytona feature parity)", () => {
    expect(plugin.definition.onEnvironmentResumeLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentDestroyLease).toBeTypeOf("function");
  });

  it("returns a valid lease handle for a live sandbox-cr lease", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue({
          metadata: {},
          status: { phase: "Running" },
        }),
      },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBe("pc-abc");
    expect(lease.metadata).toEqual(
      expect.objectContaining({
        namespace: "paperclip-acme",
        jobName: "pc-abc",
        podName: "pc-abc-pod",
        secretName: "pc-abc-env",
        phase: "Running",
        backend: "sandbox-cr",
        resumedLease: true,
        // sandbox-cr has a pod-exec channel, so native file sync stays enabled.
        nativeFileSyncUnsupported: false,
      }),
    );
  });

  it("flags a resumed job-backend lease as native-sync-unsupported so the server keeps the base64 fallback", async () => {
    h.clients = {
      batch: {
        readNamespacedJobStatus: vi.fn().mockResolvedValue({ status: { active: 1 } }),
      },
      core: {
        listNamespacedPod: vi.fn().mockResolvedValue({
          items: [{ metadata: { name: "pc-job-pod" }, status: { phase: "Running" } }],
        }),
      },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: { inCluster: true, backend: "job" },
      providerLeaseId: "pc-job",
      leaseMetadata: leaseMetadata({ jobName: "pc-job", backend: "job", podName: "pc-job-pod" }),
    });

    expect(lease.providerLeaseId).toBe("pc-job");
    expect(lease.metadata).toEqual(
      expect.objectContaining({
        backend: "job",
        // The job backend has no exec channel; its native sync hook rejects, so
        // the lease must fall back to the byte-identical base64 transport.
        nativeFileSyncUnsupported: true,
      }),
    );
  });

  it("returns providerLeaseId null (expired) when the Sandbox CR is gone, so the caller falls back to acquireLease", async () => {
    h.clients = {
      custom: { getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()) },
      core: { readNamespacedPod: vi.fn() },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBeNull();
    expect(lease.metadata?.expired).toBe(true);
    expect(lease.metadata?.reason).toMatch(/no longer exists/);
  });

  it("returns providerLeaseId null when the backing pod is gone", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: { readNamespacedPod: vi.fn().mockRejectedValue(notFound()) },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBeNull();
    expect(lease.metadata?.expired).toBe(true);
  });
});

describe("onEnvironmentDestroyLease", () => {
  it("deletes the Sandbox CR, pod, and per-run Secret", async () => {
    const deleteCr = vi.fn().mockResolvedValue({});
    const deletePod = vi.fn().mockResolvedValue({});
    const deleteSecret = vi.fn().mockResolvedValue({});
    h.clients = {
      custom: { deleteNamespacedCustomObject: deleteCr, getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()) },
      core: { deleteNamespacedPod: deletePod, deleteNamespacedSecret: deleteSecret, readNamespacedPod: vi.fn().mockRejectedValue(notFound()) },
      batch: { deleteNamespacedJob: vi.fn() },
    };

    const receipt = await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(deleteCr).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-abc" }),
    );
    expect(deletePod).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: "pc-abc-pod",
    });
    expect(deleteSecret).toHaveBeenCalledWith({
      namespace: "paperclip-acme",
      name: "pc-abc-env",
    });
    // The Sandbox CR and pod are confirmed gone, so execution has ended.
    expect(receipt).toEqual({ providerLeaseId: "pc-abc", state: "destroyed" });
  });

  it("is idempotent: resolves cleanly when every resource is already gone (404)", async () => {
    h.clients = {
      custom: {
        deleteNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()),
        getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()),
      },
      core: {
        deleteNamespacedPod: vi.fn().mockRejectedValue(notFound()),
        deleteNamespacedSecret: vi.fn().mockRejectedValue(notFound()),
        readNamespacedPod: vi.fn().mockRejectedValue(notFound()),
      },
      batch: { deleteNamespacedJob: vi.fn() },
    };

    await expect(
      plugin.definition.onEnvironmentDestroyLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: CONFIG,
        providerLeaseId: "pc-abc",
        leaseMetadata: leaseMetadata(),
      }),
    ).resolves.toEqual({ providerLeaseId: "pc-abc", state: "destroyed" });
  });

  it("gives no receipt while the pod still exists", async () => {
    vi.useFakeTimers();
    try {
      h.clients = {
        custom: {
          deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
          getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()),
        },
        core: {
          deleteNamespacedPod: vi.fn().mockResolvedValue({}),
          deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
          readNamespacedPod: vi.fn().mockResolvedValue({}),
        },
        batch: { deleteNamespacedJob: vi.fn() },
      };
      const pending = plugin.definition.onEnvironmentDestroyLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: CONFIG,
        providerLeaseId: "pc-abc",
        leaseMetadata: leaseMetadata(),
      });
      await vi.advanceTimersByTimeAsync(61_000);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op when providerLeaseId is null", async () => {
    const deleteCr = vi.fn();
    h.clients = {
      custom: { deleteNamespacedCustomObject: deleteCr },
      core: { deleteNamespacedPod: vi.fn(), deleteNamespacedSecret: vi.fn() },
      batch: { deleteNamespacedJob: vi.fn() },
    };

    await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: null,
      leaseMetadata: undefined,
    });

    expect(deleteCr).not.toHaveBeenCalled();
  });

  it("deletes the Job for job-backend leases", async () => {
    const deleteJob = vi.fn().mockResolvedValue({});
    const deleteCr = vi.fn();
    h.clients = {
      custom: { deleteNamespacedCustomObject: deleteCr },
      core: {
        deleteNamespacedPod: vi.fn().mockResolvedValue({}),
        deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
        readNamespacedPod: vi.fn().mockRejectedValue(notFound()),
      },
      batch: { deleteNamespacedJob: deleteJob, readNamespacedJobStatus: vi.fn().mockRejectedValue(notFound()) },
    };

    await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: { inCluster: true, backend: "job" },
      providerLeaseId: "pc-job",
      leaseMetadata: leaseMetadata({ jobName: "pc-job", backend: "job", podName: "pc-job-pod", secretName: "pc-job-env" }),
    });

    expect(deleteJob).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-job" }),
    );
    expect(deleteCr).not.toHaveBeenCalled();
  });
});

describe("onEnvironmentReleaseLease termination receipt", () => {
  it("returns a destroyed receipt once the Sandbox and its pod are gone", async () => {
    const deleteCr = vi.fn().mockResolvedValue({});
    const readCr = vi.fn()
      .mockResolvedValueOnce({ metadata: { deletionTimestamp: "2026-11-23T00:00:00Z" }, status: {} })
      .mockRejectedValue(notFound());
    h.clients = {
      custom: { deleteNamespacedCustomObject: deleteCr, getNamespacedCustomObject: readCr },
      core: { readNamespacedPod: vi.fn().mockRejectedValue(notFound()) },
      batch: {},
    };
    vi.useFakeTimers();
    try {
      const pending = plugin.definition.onEnvironmentReleaseLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: CONFIG,
        providerLeaseId: "pc-abc",
        leaseMetadata: leaseMetadata(),
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toEqual({ providerLeaseId: "pc-abc", state: "destroyed" });
    } finally {
      vi.useRealTimers();
    }
    expect(deleteCr).toHaveBeenCalledWith(expect.objectContaining({ name: "pc-abc", propagationPolicy: "Foreground" }));
    expect(readCr.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("propagates a read error other than 404 instead of guessing", async () => {
    h.clients = {
      custom: {
        deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
        getNamespacedCustomObject: vi.fn().mockRejectedValue(Object.assign(new Error("forbidden"), { code: 403 })),
      },
      core: {},
      batch: {},
    };
    await expect(plugin.definition.onEnvironmentReleaseLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    })).rejects.toThrow("forbidden");
  });
});

describe("onEnvironmentInspectLease", () => {
  it("reports destroyed when both the Sandbox CR and its backing pod return 404", async () => {
    h.clients = {
      custom: { getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()) },
      core: { readNamespacedPod: vi.fn().mockRejectedValue(notFound()) },
      batch: {},
    };

    await expect(plugin.definition.onEnvironmentInspectLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    })).resolves.toEqual({ providerLeaseId: "pc-abc", state: "destroyed" });
  });

  it("reports active while the Sandbox CR still exists", async () => {
    h.clients = {
      custom: { getNamespacedCustomObject: vi.fn().mockResolvedValue(readySandboxCr("pc-abc-pod")) },
      core: {},
      batch: {},
    };

    await expect(plugin.definition.onEnvironmentInspectLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    })).resolves.toEqual({ providerLeaseId: "pc-abc", state: "active" });
  });

  it("reports active when the Sandbox CR is gone but the backing pod still exists", async () => {
    h.clients = {
      custom: { getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()) },
      core: { readNamespacedPod: vi.fn().mockResolvedValue({ status: { phase: "Running" } }) },
      batch: {},
    };

    await expect(plugin.definition.onEnvironmentInspectLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    })).resolves.toEqual({ providerLeaseId: "pc-abc", state: "active" });
  });

  it("propagates non-404 API errors instead of claiming destruction", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockRejectedValue(Object.assign(new Error("forbidden"), { code: 403 })),
      },
      core: {},
      batch: {},
    };

    await expect(plugin.definition.onEnvironmentInspectLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    })).rejects.toThrow("forbidden");
  });

  describe("job backend", () => {
    const JOB_CONFIG = { inCluster: true, backend: "job" };
    const jobLeaseMetadata = (overrides: Record<string, unknown> = {}) =>
      leaseMetadata({
        jobName: "pc-job",
        podName: "pc-job-pod",
        secretName: "pc-job-env",
        backend: "job",
        ...overrides,
      });

    it("reports active for a retrying Job with { active: 1, failed: 1 } and a Running pod", async () => {
      h.clients = {
        batch: {
          readNamespacedJobStatus: vi.fn().mockResolvedValue({
            status: { active: 1, failed: 1 },
          }),
        },
        core: {
          listNamespacedPod: vi.fn().mockResolvedValue({
            items: [{ metadata: { name: "pc-job-pod" }, status: { phase: "Running" } }],
          }),
          readNamespacedPod: vi.fn().mockResolvedValue({
            metadata: { name: "pc-job-pod" },
            status: { phase: "Running" },
          }),
        },
      };

      await expect(plugin.definition.onEnvironmentInspectLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: JOB_CONFIG,
        providerLeaseId: "pc-job",
        leaseMetadata: jobLeaseMetadata(),
      })).resolves.toEqual({ providerLeaseId: "pc-job", state: "active" });
    });

    it("reports active for a Job with { active: 1, succeeded: 1 } and no authoritative Complete condition", async () => {
      h.clients = {
        batch: {
          readNamespacedJobStatus: vi.fn().mockResolvedValue({
            status: { active: 1, succeeded: 1, conditions: [] },
          }),
        },
        core: {
          listNamespacedPod: vi.fn().mockResolvedValue({
            items: [{ metadata: { name: "pc-job-pod" }, status: { phase: "Running" } }],
          }),
          readNamespacedPod: vi.fn().mockResolvedValue({
            metadata: { name: "pc-job-pod" },
            status: { phase: "Running" },
          }),
        },
      };

      await expect(plugin.definition.onEnvironmentInspectLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: JOB_CONFIG,
        providerLeaseId: "pc-job",
        leaseMetadata: jobLeaseMetadata(),
      })).resolves.toEqual({ providerLeaseId: "pc-job", state: "active" });
    });

    it("reports active for a Job with { active: 0, failed: 1 } and no authoritative terminal condition (backoff pending)", async () => {
      h.clients = {
        batch: {
          readNamespacedJobStatus: vi.fn().mockResolvedValue({
            status: { active: 0, failed: 1, conditions: [] },
          }),
        },
        core: {
          listNamespacedPod: vi.fn().mockResolvedValue({
            items: [{ metadata: { name: "pc-job-pod" }, status: { phase: "Failed" } }],
          }),
          readNamespacedPod: vi.fn().mockResolvedValue({
            metadata: { name: "pc-job-pod" },
            status: { phase: "Failed" },
          }),
        },
      };

      await expect(plugin.definition.onEnvironmentInspectLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: JOB_CONFIG,
        providerLeaseId: "pc-job",
        leaseMetadata: jobLeaseMetadata(),
      })).resolves.toEqual({ providerLeaseId: "pc-job", state: "active" });
    });

    it("reports active when Job has Failed=True and active: 0 but terminating > 0", async () => {
      h.clients = {
        batch: {
          readNamespacedJobStatus: vi.fn().mockResolvedValue({
            status: {
              active: 0,
              terminating: 1,
              failed: 1,
              conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }],
            },
          }),
        },
        core: {
          listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
          readNamespacedPod: vi.fn().mockRejectedValue(notFound()),
        },
      };

      await expect(plugin.definition.onEnvironmentInspectLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: JOB_CONFIG,
        providerLeaseId: "pc-job",
        leaseMetadata: jobLeaseMetadata(),
      })).resolves.toEqual({ providerLeaseId: "pc-job", state: "active" });
    });

    it("reports active when Job has Failed=True and active: 0 but a backing pod is still Running/Terminating", async () => {
      h.clients = {
        batch: {
          readNamespacedJobStatus: vi.fn().mockResolvedValue({
            status: {
              active: 0,
              failed: 1,
              conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }],
            },
          }),
        },
        core: {
          listNamespacedPod: vi.fn().mockResolvedValue({
            items: [
              {
                metadata: { name: "pc-job-pod", deletionTimestamp: "2026-11-26T00:00:00Z" },
                status: { phase: "Running" },
              },
            ],
          }),
          readNamespacedPod: vi.fn().mockResolvedValue({
            metadata: { name: "pc-job-pod", deletionTimestamp: "2026-11-26T00:00:00Z" },
            status: { phase: "Running" },
          }),
        },
      };

      await expect(plugin.definition.onEnvironmentInspectLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: JOB_CONFIG,
        providerLeaseId: "pc-job",
        leaseMetadata: jobLeaseMetadata(),
      })).resolves.toEqual({ providerLeaseId: "pc-job", state: "active" });
    });

    it("reports active when Job has Failed=True and active: 0 but the recorded pod (not in label list) is still Pending or Unknown", async () => {
      h.clients = {
        batch: {
          readNamespacedJobStatus: vi.fn().mockResolvedValue({
            status: {
              active: 0,
              failed: 1,
              conditions: [{ type: "Failed", status: "True" }],
            },
          }),
        },
        core: {
          listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
          readNamespacedPod: vi.fn().mockResolvedValue({
            metadata: { name: "pc-job-pod" },
            status: { phase: "Unknown" },
          }),
        },
      };

      await expect(plugin.definition.onEnvironmentInspectLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: JOB_CONFIG,
        providerLeaseId: "pc-job",
        leaseMetadata: jobLeaseMetadata(),
      })).resolves.toEqual({ providerLeaseId: "pc-job", state: "active" });
    });

    it("reports stopped when Job has Complete=True, active: 0, and backing pod is Succeeded", async () => {
      h.clients = {
        batch: {
          readNamespacedJobStatus: vi.fn().mockResolvedValue({
            status: {
              active: 0,
              succeeded: 1,
              conditions: [{ type: "Complete", status: "True" }],
            },
          }),
        },
        core: {
          listNamespacedPod: vi.fn().mockResolvedValue({
            items: [{ metadata: { name: "pc-job-pod" }, status: { phase: "Succeeded" } }],
          }),
          readNamespacedPod: vi.fn(),
        },
      };

      await expect(plugin.definition.onEnvironmentInspectLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: JOB_CONFIG,
        providerLeaseId: "pc-job",
        leaseMetadata: jobLeaseMetadata(),
      })).resolves.toEqual({ providerLeaseId: "pc-job", state: "stopped" });
    });

    it("reports stopped when Job has Failed=True, active: 0, and backing pods are Failed or already 404", async () => {
      h.clients = {
        batch: {
          readNamespacedJobStatus: vi.fn().mockResolvedValue({
            status: {
              failed: 1,
              conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded" }],
            },
          }),
        },
        core: {
          listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
          readNamespacedPod: vi.fn().mockRejectedValue(notFound()),
        },
      };

      await expect(plugin.definition.onEnvironmentInspectLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: JOB_CONFIG,
        providerLeaseId: "pc-job",
        leaseMetadata: jobLeaseMetadata(),
      })).resolves.toEqual({ providerLeaseId: "pc-job", state: "stopped" });
    });

    it("reports destroyed when both the Job and its backing pods are gone (404 / empty)", async () => {
      h.clients = {
        batch: {
          readNamespacedJobStatus: vi.fn().mockRejectedValue(notFound()),
        },
        core: {
          listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
          readNamespacedPod: vi.fn().mockRejectedValue(notFound()),
        },
      };

      await expect(plugin.definition.onEnvironmentInspectLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: JOB_CONFIG,
        providerLeaseId: "pc-job",
        leaseMetadata: jobLeaseMetadata(),
      })).resolves.toEqual({ providerLeaseId: "pc-job", state: "destroyed" });
    });

    it("reports active when the Job returns 404 but a backing pod still exists", async () => {
      h.clients = {
        batch: {
          readNamespacedJobStatus: vi.fn().mockRejectedValue(notFound()),
        },
        core: {
          listNamespacedPod: vi.fn().mockResolvedValue({
            items: [{ metadata: { name: "pc-job-retry" }, status: { phase: "Running" } }],
          }),
          readNamespacedPod: vi.fn().mockRejectedValue(notFound()),
        },
      };

      await expect(plugin.definition.onEnvironmentInspectLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: JOB_CONFIG,
        providerLeaseId: "pc-job",
        leaseMetadata: jobLeaseMetadata(),
      })).resolves.toEqual({ providerLeaseId: "pc-job", state: "active" });
    });
  });
});
