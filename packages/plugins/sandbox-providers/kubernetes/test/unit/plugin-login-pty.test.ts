import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";

// The plugin runs against fakes for everything that would touch a cluster: the
// orchestrators, the tenant and secret setup, the scoped egress policy and the
// pod execs. Each test reads what the plugin asked them to do.
const h = vi.hoisted(() => ({
  claimed: [] as Array<Record<string, unknown>>,
  scopedGrants: [] as Array<{ allowFqdns: string[]; allowCidrs: string[] }>,
  waitForReady: vi.fn(async () => ({ phase: "Running", active: 1 })),
  execInPod: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  openPodPty: vi.fn(),
}));

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
      claim: vi.fn(async (_c: unknown, _ns: string, manifest: Record<string, unknown>) => {
        h.claimed.push(manifest);
        return { uid: "uid-1" };
      }),
      findPod: vi.fn(async () => "pc-pod"),
      waitForCompletion: h.waitForReady,
      release: vi.fn(async () => undefined),
      getStatus: vi.fn(),
      streamLogs: vi.fn(),
    },
  };
});
vi.mock("../../src/job-orchestrator.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/job-orchestrator.js")>();
  return {
    ...actual,
    jobOrchestrator: {
      claim: vi.fn(async (_c: unknown, _ns: string, manifest: Record<string, unknown>) => {
        h.claimed.push(manifest);
        return { uid: "uid-job" };
      }),
      findPod: vi.fn(async () => "pc-job-pod"),
      waitForCompletion: vi.fn(),
      release: vi.fn(async () => undefined),
      getStatus: vi.fn(),
      streamLogs: vi.fn(),
    },
  };
});
vi.mock("../../src/scoped-network-egress.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/scoped-network-egress.js")>();
  return {
    ...actual,
    createScopedNetworkEgressPolicyOrReleaseWorkload: vi.fn(
      async (input: { grant: { allowFqdns: string[]; allowCidrs: string[] } }) => {
        h.scopedGrants.push(input.grant);
        return null;
      },
    ),
  };
});
vi.mock("../../src/pod-exec.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/pod-exec.js")>();
  return { ...actual, execInPod: h.execInPod, openPodPty: h.openPodPty };
});

import plugin from "../../src/plugin.js";
import manifest from "../../src/manifest.js";
import { startWorkerRpcHost } from "@paperclipai/plugin-sdk";

const HOME = "/tmp/paperclip-adapter-login/0b8f6a5e-3c1d-4f2a-9e7b-1a2b3c4d5e6f";

function acquire(overrides: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  return plugin.definition.onEnvironmentAcquireLease!({
    driverKey: "kubernetes",
    companyId: "company-1",
    environmentId: "env-1",
    runId: "run-1",
    config: { inCluster: true, ...config },
    ...overrides,
  } as never);
}

function openRequest(providerLeaseId: string, overrides: Record<string, unknown> = {}) {
  return {
    hostRouteId: "route-1",
    driverKey: "kubernetes",
    companyId: "company-1",
    environmentId: "env-1",
    providerLeaseId,
    loginCommandKey: "codex" as const,
    sessionHome: HOME,
    ...overrides,
  };
}

function shutdownTimeOf(m: Record<string, unknown>): string {
  return (m.spec as { shutdownTime: string }).shutdownTime;
}

beforeEach(async () => {
  h.claimed.length = 0;
  h.scopedGrants.length = 0;
  h.waitForReady.mockClear();
  h.execInPod.mockClear();
  h.openPodPty.mockReset();
  await plugin.definition.onShutdown!();
});

describe("login PTY capability", () => {
  it("advertises supportsLoginPty on the kubernetes driver and bumps the package version with the manifest", () => {
    expect(manifest.environmentDrivers?.[0]?.supportsLoginPty).toBe(true);
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.version).toBe(manifest.version);
  });

  it("reports the four login PTY methods as supported when the worker initializes", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const host = startWorkerRpcHost({ plugin, stdin, stdout });
    const lines: string[] = [];
    let buffer = "";
    stdout.on("data", (d: Buffer) => {
      buffer += d.toString();
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        lines.push(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    });
    stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        manifest,
        config: {},
        instanceInfo: { instanceId: "00000000-0000-0000-0000-000000000000", hostVersion: "0.0.0" },
        apiVersion: 1,
      },
    })}\n`);
    await vi.waitFor(() => expect(lines.some((l) => l.includes('"id":1'))).toBe(true));
    const reply = JSON.parse(lines.find((l) => l.includes('"id":1'))!);
    expect(reply.result.supportedMethods).toEqual(
      expect.arrayContaining(["loginPtyOpen", "loginPtyInput", "loginPtyStop", "loginPtyClose", "shutdown"]),
    );
    host.stop();
  });
});

describe("login PTY hooks", () => {
  it("fails closed for a lease this worker did not acquire", async () => {
    await expect(plugin.definition.onLoginPtyOpen!(openRequest("pc-unknown"))).rejects.toThrow(
      /holds no lease/,
    );
    expect(h.openPodPty).not.toHaveBeenCalled();
  });

  it("refuses a job-backend lease", async () => {
    const lease = await acquire({}, { backend: "job" });
    await expect(plugin.definition.onLoginPtyOpen!(openRequest(lease.providerLeaseId!))).rejects.toThrow(
      /sandbox-cr backend/,
    );
    expect(h.openPodPty).not.toHaveBeenCalled();
  });

  it("opens the fixed command in the lease's pod after waiting for it", async () => {
    const session = { onData: vi.fn(), write: vi.fn(), wait: vi.fn(() => new Promise(() => {})), kill: vi.fn(), close: vi.fn(async () => {}) };
    h.openPodPty.mockResolvedValue(session);
    const lease = await acquire({ adapterType: "codex_local" });
    const { workerSessionId } = await plugin.definition.onLoginPtyOpen!(openRequest(lease.providerLeaseId!));
    expect(workerSessionId).toMatch(/^pty-/);
    expect(h.waitForReady).toHaveBeenCalledTimes(1);
    expect(h.execInPod).toHaveBeenCalledWith(
      {}, expect.any(String), "pc-pod", "agent",
      ["mkdir", "-m", "700", "-p", HOME], undefined, expect.any(Number), expect.any(Number), expect.any(Number),
    );
    expect(h.openPodPty).toHaveBeenCalledWith(
      {}, expect.any(String), "pc-pod", "agent",
      ["/bin/sh", "-c", `exec env CODEX_HOME='${HOME}' codex login --device-auth`],
    );
    await plugin.definition.onLoginPtyInput!({ workerSessionId, data: "\r" });
    expect(session.write).toHaveBeenCalledWith("\r");
    await plugin.definition.onLoginPtyStop!({ workerSessionId });
    expect(session.kill).toHaveBeenCalledTimes(1);
    await expect(plugin.definition.onLoginPtyClose!({ hostRouteId: "route-1" })).resolves.toEqual({ hostRouteId: "route-1" });
    await expect(plugin.definition.onLoginPtyClose!({ hostRouteId: "route-1" })).resolves.toEqual({ hostRouteId: "route-1" });
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("closes an open terminal when its lease is released", async () => {
    const session = { onData: vi.fn(), write: vi.fn(), wait: vi.fn(() => new Promise(() => {})), kill: vi.fn(), close: vi.fn(async () => {}) };
    h.openPodPty.mockResolvedValue(session);
    const lease = await acquire();
    await plugin.definition.onLoginPtyOpen!(openRequest(lease.providerLeaseId!, { loginCommandKey: "claude" }));
    await plugin.definition.onEnvironmentReleaseLease!({
      driverKey: "kubernetes",
      companyId: "company-1",
      environmentId: "env-1",
      config: { inCluster: true },
      providerLeaseId: lease.providerLeaseId!,
      leaseMetadata: lease.metadata,
    } as never);
    expect(session.close).toHaveBeenCalledTimes(1);
  });
});

describe("lease expiry", () => {
  it("bounds the Sandbox at the requested deadline and attests it", async () => {
    const requested = new Date(Date.now() + 10 * 60_000);
    const lease = await acquire({ requestedExpiresAt: requested.toISOString() });
    const shutdownTime = shutdownTimeOf(h.claimed[0]!);
    expect(lease.expiresAt).toBe(shutdownTime);
    expect(Date.parse(shutdownTime)).toBeLessThanOrEqual(requested.getTime());
    expect(requested.getTime() - Date.parse(shutdownTime)).toBeLessThan(1000);
  });

  it("keeps the configured lifetime when it ends before the requested deadline", async () => {
    const requested = new Date(Date.now() + 5 * 3600_000);
    const lease = await acquire({ requestedExpiresAt: requested.toISOString() }, { podActivityDeadlineSec: 600 });
    const shutdownMs = Date.parse(shutdownTimeOf(h.claimed[0]!));
    expect(lease.expiresAt).toBe(shutdownTimeOf(h.claimed[0]!));
    expect(shutdownMs).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  it("attests no expiry when none was requested", async () => {
    const lease = await acquire();
    expect(lease.expiresAt).toBeUndefined();
    expect(shutdownTimeOf(h.claimed[0]!)).toEqual(expect.any(String));
  });

  it("rejects a requested deadline that has passed before creating anything", async () => {
    await expect(acquire({ requestedExpiresAt: new Date(Date.now() - 1000).toISOString() })).rejects.toThrow(
      /already passed/,
    );
    expect(h.claimed).toHaveLength(0);
  });

  it("attests no expiry on the job backend, so a caller with a deadline fails closed", async () => {
    const lease = await acquire(
      { requestedExpiresAt: new Date(Date.now() + 600_000).toISOString() },
      { backend: "job" },
    );
    expect(lease.expiresAt).toBeUndefined();
  });
});

describe("sign-in egress", () => {
  it("adds the adapter's sign-in hosts to the run's scoped policy in cilium mode", async () => {
    await acquire({ adapterType: "codex_local" }, { egressMode: "cilium" });
    expect(h.scopedGrants[0]?.allowFqdns).toEqual(["auth.openai.com"]);
    await acquire({ adapterType: "claude_local" }, { egressMode: "cilium" });
    expect(h.scopedGrants[1]?.allowFqdns).toEqual(["platform.claude.com"]);
  });

  it("keeps the task grant and de-duplicates", async () => {
    await acquire(
      {
        adapterType: "codex_local",
        executionWorkspaceSettings: { networkEgress: { allowFqdns: ["auth.openai.com", "github.com"], allowCidrs: [] } },
      },
      { egressMode: "cilium" },
    );
    expect(h.scopedGrants[0]?.allowFqdns).toEqual(["auth.openai.com", "github.com"]);
  });

  it("adds nothing when the host says the lease is a run, or in standard mode", async () => {
    await acquire({ adapterType: "codex_local", purpose: "run" }, { egressMode: "cilium" });
    await acquire({ adapterType: "codex_local" }, { egressMode: "standard" });
    expect(h.scopedGrants[0]?.allowFqdns).toEqual([]);
    expect(h.scopedGrants[1]?.allowFqdns).toEqual([]);
  });

  it("takes the sign-in hosts from a configured adapter registry", async () => {
    await acquire(
      { adapterType: "codex_local" },
      {
        egressMode: "cilium",
        adapters: [{ adapterType: "codex_local", runtimeImage: "example.com/codex:1", loginAllowFqdns: ["login.example.com"] }],
      },
    );
    expect(h.scopedGrants[0]?.allowFqdns).toEqual(["login.example.com"]);
  });
});
