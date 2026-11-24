import { beforeEach, describe, expect, it, vi } from "vitest";

const updateGeneral = vi.fn();
const listCompanyIds = vi.fn();
const ensureKubernetesEnvironment = vi.fn();

vi.mock("./instance-settings.js", () => ({
  instanceSettingsService: () => ({
    updateGeneral,
    listCompanyIds,
  }),
}));

vi.mock("./environments.js", () => ({
  environmentService: () => ({
    ensureKubernetesEnvironment,
  }),
}));

const {
  parseExecutionPolicyBootstrapEnv,
  applyExecutionPolicyBootstrap,
} = await import("./execution-policy-bootstrap.js");
type ExecutionPolicyBootstrapEnv = import("./execution-policy-bootstrap.js").ExecutionPolicyBootstrapEnv;
type ExecutionPolicyBootstrap = import("./execution-policy-bootstrap.js").ExecutionPolicyBootstrap;

function env(overrides: Record<string, string | undefined>): ExecutionPolicyBootstrapEnv {
  return overrides;
}

const bootstrap: ExecutionPolicyBootstrap = {
  executionMode: "kubernetes",
  allowedSandboxProviders: ["mac-lanes"],
  kubernetesConfig: { inCluster: true, backend: "job" },
};

// `applyExecutionPolicyBootstrap` constructs its services internally from the
// Db, so we mock the service modules; the Db itself is never touched here.
const fakeDb = {} as never;

describe("parseExecutionPolicyBootstrapEnv", () => {
  it("returns null when no execution mode is set (default unrestricted)", () => {
    expect(parseExecutionPolicyBootstrapEnv(env({}))).toBeNull();
  });

  it("returns null when execution mode is explicitly any", () => {
    expect(
      parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "any" })),
    ).toBeNull();
  });

  it("parses the forced kubernetes policy with a job/gvisor/cilium config", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(
      env({
        PAPERCLIP_EXECUTION_MODE: "kubernetes",
        PAPERCLIP_K8S_BACKEND: "job",
        PAPERCLIP_K8S_IN_CLUSTER: "true",
        PAPERCLIP_K8S_RUNTIME_CLASS_NAME: "gvisor",
        PAPERCLIP_K8S_EGRESS_MODE: "cilium",
        PAPERCLIP_K8S_EGRESS_ALLOW_FQDNS: "api.anthropic.com, api.openai.com",
        PAPERCLIP_K8S_EGRESS_ALLOW_CIDRS: "10.0.0.0/8",
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.executionMode).toBe("kubernetes");
    expect(parsed?.kubernetesConfig).toMatchObject({
      backend: "job",
      inCluster: true,
      runtimeClassName: "gvisor",
      egressMode: "cilium",
      egressAllowFqdns: ["api.anthropic.com", "api.openai.com"],
      egressAllowCidrs: ["10.0.0.0/8"],
    });
  });

  it("defaults inCluster false and omits unset optional fields", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(
      env({ PAPERCLIP_EXECUTION_MODE: "kubernetes" }),
    );
    expect(parsed?.kubernetesConfig.inCluster).toBe(false);
    expect(parsed?.kubernetesConfig.runtimeClassName).toBeUndefined();
    expect(parsed?.kubernetesConfig.egressAllowFqdns).toBeUndefined();
  });

  it("throws on an unknown execution mode", () => {
    expect(() =>
      parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "vm" })),
    ).toThrow(/PAPERCLIP_EXECUTION_MODE/);
  });

  it("attaches the declared adapter registry to the kubernetes config", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(
      env({
        PAPERCLIP_EXECUTION_MODE: "kubernetes",
        PAPERCLIP_ADAPTERS: JSON.stringify([
          { adapterType: "opencode_local", runtimeImage: "img", envKeys: ["ANTHROPIC_API_KEY"], allowFqdns: [], probeCommand: ["opencode", "--version"], defaultEnv: { ANTHROPIC_BASE_URL: "http://bifrost:8080" } },
        ]),
      }),
    );
    expect(parsed?.kubernetesConfig.adapters).toHaveLength(1);
    expect(parsed?.kubernetesConfig.adapters?.[0].adapterType).toBe("opencode_local");
  });

  it("leaves adapters undefined when PAPERCLIP_ADAPTERS is absent", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "kubernetes" }));
    expect(parsed?.kubernetesConfig.adapters).toBeUndefined();
  });

  it("reads PAPERCLIP_K8S_RPC_TIMEOUT_MS into kubernetesConfig.timeoutMs", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(
      env({
        PAPERCLIP_EXECUTION_MODE: "kubernetes",
        PAPERCLIP_K8S_RPC_TIMEOUT_MS: "600000",
      }),
    );
    expect(parsed?.kubernetesConfig.timeoutMs).toBe(600000);
  });

  it("omits timeoutMs when PAPERCLIP_K8S_RPC_TIMEOUT_MS is absent", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "kubernetes" }));
    expect(parsed?.kubernetesConfig.timeoutMs).toBeUndefined();
  });

  it("reads PAPERCLIP_K8S_DEFAULT_RESOURCES into kubernetesConfig.defaultResources", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(
      env({
        PAPERCLIP_EXECUTION_MODE: "kubernetes",
        PAPERCLIP_K8S_DEFAULT_RESOURCES: '{"requests":{"cpu":"500m","memory":"1Gi"},"limits":{"cpu":"4","memory":"4Gi"}}',
      }),
    );
    expect(parsed?.kubernetesConfig.defaultResources).toEqual({
      requests: { cpu: "500m", memory: "1Gi" },
      limits: { cpu: "4", memory: "4Gi" },
    });
    expect(parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "kubernetes" }))?.kubernetesConfig.defaultResources)
      .toBeUndefined();
  });

  it.each([
    ["not JSON", "{requests"],
    ["an array", "[]"],
    ["an unknown section", '{"request":{"memory":"1Gi"}}'],
    ["an unknown resource", '{"requests":{"gpu":"1"}}'],
    ["a malformed quantity", '{"limits":{"memory":"4 GB"}}'],
    ["a number instead of a quantity string", '{"limits":{"memory":4}}'],
  ])("throws when PAPERCLIP_K8S_DEFAULT_RESOURCES is %s", (_why, value) => {
    expect(() =>
      parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "kubernetes", PAPERCLIP_K8S_DEFAULT_RESOURCES: value })),
    ).toThrow(/PAPERCLIP_K8S_DEFAULT_RESOURCES/);
  });

  it("reads PAPERCLIP_K8S_EXTRA_VOLUMES, _VOLUME_MOUNTS and _ENV into kubernetesConfig", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(
      env({
        PAPERCLIP_EXECUTION_MODE: "kubernetes",
        PAPERCLIP_K8S_EXTRA_VOLUMES: '[{"name":"git-mirror","persistentVolumeClaim":{"claimName":"git-mirror","readOnly":true}}]',
        PAPERCLIP_K8S_EXTRA_VOLUME_MOUNTS: '[{"name":"git-mirror","mountPath":"/mnt/git-mirror","readOnly":true}]',
        PAPERCLIP_K8S_EXTRA_ENV: '[{"name":"GIT_MIRROR","value":"/mnt/git-mirror"}]',
      }),
    );
    expect(parsed?.kubernetesConfig.extraVolumes).toEqual([
      { name: "git-mirror", persistentVolumeClaim: { claimName: "git-mirror", readOnly: true } },
    ]);
    expect(parsed?.kubernetesConfig.extraVolumeMounts).toEqual([
      { name: "git-mirror", mountPath: "/mnt/git-mirror", readOnly: true },
    ]);
    expect(parsed?.kubernetesConfig.extraEnv).toEqual([{ name: "GIT_MIRROR", value: "/mnt/git-mirror" }]);

    const plain = parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "kubernetes" }))?.kubernetesConfig;
    expect(plain).not.toHaveProperty("extraVolumes");
    expect(plain).not.toHaveProperty("extraVolumeMounts");
    expect(plain).not.toHaveProperty("extraEnv");
  });

  it.each([
    ["PAPERCLIP_K8S_EXTRA_VOLUMES", "not JSON", "[{"],
    ["PAPERCLIP_K8S_EXTRA_VOLUMES", "an object instead of an array", '{"name":"x","emptyDir":{}}'],
    ["PAPERCLIP_K8S_EXTRA_VOLUMES", "an entry without a name", '[{"emptyDir":{}}]'],
    ["PAPERCLIP_K8S_EXTRA_VOLUME_MOUNTS", "a mount without a mountPath", '[{"name":"x"}]'],
    ["PAPERCLIP_K8S_EXTRA_ENV", "an entry that is not an object", '["A=1"]'],
    ["PAPERCLIP_K8S_EXTRA_ENV", "a non-string value", '[{"name":"A","value":1}]'],
  ])("throws when %s is %s", (name, _why, value) => {
    expect(() => parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "kubernetes", [name]: value }))).toThrow(
      new RegExp(name),
    );
  });

  it("throws when PAPERCLIP_K8S_RPC_TIMEOUT_MS is not a positive integer", () => {
    expect(() =>
      parseExecutionPolicyBootstrapEnv(
        env({ PAPERCLIP_EXECUTION_MODE: "kubernetes", PAPERCLIP_K8S_RPC_TIMEOUT_MS: "0" }),
      ),
    ).toThrow(/PAPERCLIP_K8S_RPC_TIMEOUT_MS/);
    expect(() =>
      parseExecutionPolicyBootstrapEnv(
        env({ PAPERCLIP_EXECUTION_MODE: "kubernetes", PAPERCLIP_K8S_RPC_TIMEOUT_MS: "abc" }),
      ),
    ).toThrow(/PAPERCLIP_K8S_RPC_TIMEOUT_MS/);
  });

  it("allows no other sandbox provider unless one is listed", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "kubernetes" }));
    expect(parsed?.allowedSandboxProviders).toEqual([]);
  });

  it("parses PAPERCLIP_EXECUTION_ALLOWED_SANDBOX_PROVIDERS", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(
      env({
        PAPERCLIP_EXECUTION_MODE: "kubernetes",
        PAPERCLIP_EXECUTION_ALLOWED_SANDBOX_PROVIDERS: "mac-lanes, e2b,mac-lanes",
      }),
    );
    expect(parsed?.allowedSandboxProviders).toEqual(["mac-lanes", "e2b"]);
  });

  it("refuses kubernetes or a malformed key in the allowed providers", () => {
    for (const value of ["kubernetes", "Mac Lanes", "../x"]) {
      expect(() =>
        parseExecutionPolicyBootstrapEnv(
          env({ PAPERCLIP_EXECUTION_MODE: "kubernetes", PAPERCLIP_EXECUTION_ALLOWED_SANDBOX_PROVIDERS: value }),
        ),
      ).toThrow(/PAPERCLIP_EXECUTION_ALLOWED_SANDBOX_PROVIDERS/);
    }
  });

  it("refuses allowed providers without the kubernetes execution mode", () => {
    expect(() =>
      parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_ALLOWED_SANDBOX_PROVIDERS: "mac-lanes" })),
    ).toThrow(/PAPERCLIP_EXECUTION_ALLOWED_SANDBOX_PROVIDERS/);
  });
});

describe("applyExecutionPolicyBootstrap", () => {
  beforeEach(() => {
    updateGeneral.mockReset().mockResolvedValue(undefined);
    listCompanyIds.mockReset();
    ensureKubernetesEnvironment.mockReset();
  });

  it("does not throw when every company gets a managed environment", async () => {
    listCompanyIds.mockResolvedValue(["c1", "c2", "c3"]);
    ensureKubernetesEnvironment.mockResolvedValue({ id: "env" });

    const result = await applyExecutionPolicyBootstrap(fakeDb, bootstrap);

    expect(result).toEqual({ executionMode: "kubernetes", companiesConfigured: 3 });
    expect(ensureKubernetesEnvironment).toHaveBeenCalledTimes(3);
    expect(updateGeneral).toHaveBeenCalledWith({
      executionMode: "kubernetes",
      allowedSandboxProviders: ["mac-lanes"],
    });
  });

  it("throws when at least one company fails, after attempting every company", async () => {
    listCompanyIds.mockResolvedValue(["c1", "c2", "c3"]);
    ensureKubernetesEnvironment.mockImplementation(async (companyId: string) => {
      if (companyId === "c2") throw new Error("operator config missing");
      return { id: `env-${companyId}` };
    });

    await expect(applyExecutionPolicyBootstrap(fakeDb, bootstrap)).rejects.toThrow(
      /execution-policy bootstrap: 1 of 3 companies failed.*c2/,
    );

    // It keeps going past the failure (attempts all three companies).
    expect(ensureKubernetesEnvironment).toHaveBeenCalledTimes(3);
  });
});
