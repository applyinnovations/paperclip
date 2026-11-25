import { describe, it, expect, vi, beforeEach } from "vitest";

// APP-464 / APP-528: proxy egress mode and fail-closed hostname validation.
// acquireLease runs against fakes for everything that would touch a cluster,
// so each test can see whether anything was created and which env the
// sandbox would get.
const h = vi.hoisted(() => ({
  ensureTenant: vi.fn(async (..._args: unknown[]) => undefined),
  createPerRunSecret: vi.fn(async (..._args: unknown[]) => undefined),
  claim: vi.fn(async (..._args: unknown[]) => ({ uid: "uid-1" })),
  scopedPolicy: vi.fn(async (..._args: unknown[]) => null),
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => ({})),
}));
vi.mock("../../src/tenant-orchestrator.js", () => ({ ensureTenant: h.ensureTenant }));
vi.mock("../../src/secret-manager.js", () => ({ createPerRunSecret: h.createPerRunSecret }));
vi.mock("../../src/sandbox-cr-orchestrator.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/sandbox-cr-orchestrator.js")>();
  return {
    ...actual,
    sandboxCrOrchestrator: {
      claim: h.claim,
      findPod: vi.fn(async () => "pc-pod"),
      waitForCompletion: vi.fn(async () => ({ phase: "Running", active: 1 })),
      release: vi.fn(async () => undefined),
      getStatus: vi.fn(),
      streamLogs: vi.fn(),
    },
  };
});
vi.mock("../../src/scoped-network-egress.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/scoped-network-egress.js")>();
  return { ...actual, createScopedNetworkEgressPolicyOrReleaseWorkload: h.scopedPolicy };
});

import plugin from "../../src/plugin.js";
import { assessEgressPosture, buildEgressProxyEnv, EgressModeCannotEnforceError } from "../../src/egress-mode.js";
import { parseKubernetesProviderConfig } from "../../src/types.js";

const PROXY_URL = "http://paperclip-egress-proxy.paperclip.svc:3128";
const proxy = (enforcement: "observe" | "enforce", extra: Record<string, unknown> = {}) => ({
  egressMode: "proxy",
  egressProxy: { url: PROXY_URL, enforcement, ...extra },
});

function acquire(config: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return plugin.definition.onEnvironmentAcquireLease!({
    driverKey: "kubernetes",
    companyId: "company-1",
    environmentId: "env-1",
    runId: "run-1",
    config: { inCluster: true, ...config },
    ...overrides,
  } as never);
}

function sandboxEnv(): Record<string, string> {
  expect(h.createPerRunSecret).toHaveBeenCalledTimes(1);
  return (h.createPerRunSecret.mock.calls[0]![1] as { adapterEnv: Record<string, string> }).adapterEnv;
}

function expectNothingProvisioned() {
  expect(h.ensureTenant).not.toHaveBeenCalled();
  expect(h.claim).not.toHaveBeenCalled();
  expect(h.createPerRunSecret).not.toHaveBeenCalled();
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.ensureTenant.mockClear();
  h.createPerRunSecret.mockClear();
  h.claim.mockClear();
  h.scopedPolicy.mockClear();
  warn?.mockRestore();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("fail closed: a hostname list the mode can't enforce refuses new sandboxes", () => {
  it("standard + adapter hostnames rejects before touching the cluster, naming the mode and the fix", async () => {
    const err = await acquire({ egressMode: "standard" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressModeCannotEnforceError);
    const message = (err as Error).message;
    expect(message).toContain("egressMode=standard");
    expect(message).toContain("api.anthropic.com");
    expect(message).toMatch(/egressMode to "proxy"/);
    expect(message).toContain("egressProxy.enforcement");
    expectNothingProvisioned();
  });

  it("standard is the default mode, so an unmigrated config fails closed too", async () => {
    await expect(acquire({})).rejects.toBeInstanceOf(EgressModeCannotEnforceError);
    expectNothingProvisioned();
  });

  it("standard + operator CIDRs still rejects: CIDRs do not enforce hostnames", async () => {
    await expect(
      acquire({ egressMode: "standard", egressAllowCidrs: ["203.0.113.0/24"] }),
    ).rejects.toBeInstanceOf(EgressModeCannotEnforceError);
    expectNothingProvisioned();
  });

  it("standard + a task-scoped hostname grant rejects", async () => {
    const noAdapterHosts = {
      egressMode: "standard",
      adapters: [{ adapterType: "claude_local", runtimeImage: "example.com/claude:1", allowFqdns: [] }],
    };
    await expect(
      acquire(noAdapterHosts, { executionWorkspaceSettings: { networkEgress: { allowFqdns: ["github.com"] } } }),
    ).rejects.toThrow(/github\.com/);
    expectNothingProvisioned();
  });

  it("standard with no hostname list at all still provisions (nothing to enforce)", async () => {
    await acquire({
      egressMode: "standard",
      adapters: [{ adapterType: "claude_local", runtimeImage: "example.com/claude:1", allowFqdns: [] }],
    });
    expect(h.claim).toHaveBeenCalledTimes(1);
    const env = sandboxEnv();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.PAPERCLIP_NETWORK_EGRESS_MODE).toBe("standard");
  });

  it("never re-checks running sandboxes: resume does not apply the hostname check", async () => {
    const outcome = await plugin.definition.onEnvironmentResumeLease!({
        driverKey: "kubernetes",
        companyId: "company-1",
        environmentId: "env-1",
        providerLeaseId: "pc-existing",
        config: { inCluster: true, egressMode: "standard" },
        leaseMetadata: { namespace: "paperclip-company-1", backend: "sandbox-cr" },
      } as never).catch((e: unknown) => e);
    expect(outcome).not.toBeInstanceOf(EgressModeCannotEnforceError);
  });
});

describe("proxy egress mode", () => {
  it("observe provisions and routes HTTP(S) through the configured proxy", async () => {
    await acquire(proxy("observe"));
    expect(h.claim).toHaveBeenCalledTimes(1);
    const env = sandboxEnv();
    for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      expect(env[key]).toBe(PROXY_URL);
    }
    expect(env.PAPERCLIP_NETWORK_EGRESS_MODE).toBe("proxy");
    expect(env.PAPERCLIP_NETWORK_EGRESS_PROXY_ENFORCEMENT).toBe("observe");
  });

  it("observe says plainly that the hostname list is NOT enforced", async () => {
    await acquire(proxy("observe"));
    const logged = warn.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(logged).toContain("is NOT enforced");
    expect(logged).toContain("api.anthropic.com");
    expect(logged).not.toMatch(/\bdenies\b/);
  });

  it("enforce provisions and injects the same proxy env", async () => {
    await acquire(proxy("enforce"));
    expect(h.claim).toHaveBeenCalledTimes(1);
    const env = sandboxEnv();
    expect(env.HTTPS_PROXY).toBe(PROXY_URL);
    expect(env.PAPERCLIP_NETWORK_EGRESS_PROXY_ENFORCEMENT).toBe("enforce");
    expect(warn).not.toHaveBeenCalled();
  });

  it("NO_PROXY keeps the runner, paperclip-server and cluster Services direct", async () => {
    await acquire(proxy("observe", { noProxy: ["registry.internal"] }));
    const env = sandboxEnv();
    const noProxy = env.NO_PROXY!.split(",");
    expect(env.no_proxy).toBe(env.NO_PROXY);
    expect(noProxy).toEqual(
      expect.arrayContaining(["localhost", "127.0.0.1", "::1", "paperclip-server", ".svc", ".cluster.local", "registry.internal"]),
    );
    // Public model API hosts must go through the proxy.
    expect(noProxy).not.toContain("api.anthropic.com");
  });

  it("the proxy address comes from config, not a hardcoded value", () => {
    const env = buildEgressProxyEnv(
      parseKubernetesProviderConfig({ inCluster: true, ...proxy("observe"), egressProxy: { url: "http://other-proxy:8080", enforcement: "observe" } }),
    );
    expect(env.HTTPS_PROXY).toBe("http://other-proxy:8080");
  });

  it("other modes inject no proxy env", () => {
    expect(buildEgressProxyEnv(parseKubernetesProviderConfig({ inCluster: true, egressMode: "cilium" }))).toEqual({});
  });
});

describe("config schema", () => {
  it("proxy mode requires egressProxy", () => {
    expect(() => parseKubernetesProviderConfig({ inCluster: true, egressMode: "proxy" })).toThrow(/egressProxy/);
  });

  it("enforcement is explicit: there is no default", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true, egressMode: "proxy", egressProxy: { url: PROXY_URL } }),
    ).toThrow();
  });

  it("rejects non-HTTP proxy URLs", () => {
    expect(() =>
      parseKubernetesProviderConfig({
        inCluster: true,
        egressMode: "proxy",
        egressProxy: { url: "socks5://proxy:1080", enforcement: "observe" },
      }),
    ).toThrow(/http/);
  });
});

describe("status output", () => {
  it("validateConfig accepts standard + hostnames but warns that new sandboxes are refused", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, egressMode: "standard" },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings?.join("\n")).toMatch(/Refusing to provision a new sandbox/);
  });

  it("validateConfig warns that proxy observe does NOT enforce hostnames", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, ...proxy("observe") },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings?.join("\n")).toContain("is NOT enforced");
  });

  it("validateConfig has no warning for proxy enforce", async () => {
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: { inCluster: true, ...proxy("enforce") },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeUndefined();
  });

  it("never claims enforcement in observe, and never leaks proxy credentials", () => {
    const posture = assessEgressPosture(
      parseKubernetesProviderConfig({
        inCluster: true,
        egressMode: "proxy",
        egressProxy: { url: "http://user:secret@proxy.paperclip.svc:3128", enforcement: "observe" },
      }),
      ["api.openai.com"],
    );
    expect(posture.hostnamesEnforced).toBe(false);
    expect(posture.summary).toContain("NOT enforced");
    expect(posture.summary).not.toContain("secret");
  });
});
