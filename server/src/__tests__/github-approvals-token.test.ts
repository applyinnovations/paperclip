import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import {
  checkGitHubApprovalsAppAtStartup,
  parseGitHubApprovalsApp,
  parseGitHubAppsFile,
  readGitHubApprovalsAppConfig,
} from "../services/github-app-config.js";
import {
  createGitHubApprovalsTokenSource,
  GITHUB_APPROVALS_TOKEN_PERMISSIONS,
} from "../services/github-approvals-token.js";
import { buildHostServices } from "../services/plugin-host-services.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const COMPANY_A = "a9d886a3-e526-461c-95d6-d2d0d6b6c722";
const COMPANY_B = "0b6f3c0e-1c1d-4c39-9d43-6a3f9d1c2e01";
const COMPANY_C = "7c2a5d4e-8f60-4b1a-a3c2-1d9e8f7a6b55";
const CONFIG_PATH = "/etc/paperclip/github-apps.json";
const KEY_PATH = "/etc/paperclip/github-approvals/private-key.pem";

const APPROVALS = {
  appId: "123456",
  installationId: "7890123",
  owner: "acme",
  privateKeyFile: KEY_PATH,
  companies: { [COMPANY_A]: ["deployments", "Infrastructure"], [COMPANY_B]: ["web-app"] },
};
const FILE = {
  apps: [
    { companyId: COMPANY_A, appId: "5462605", installationId: "175009740", privateKeyFile: "/var/run/apply.pem" },
  ],
  approvalsApp: APPROVALS,
};
const env = { PAPERCLIP_GITHUB_APPS_FILE: CONFIG_PATH };
const readConfigFile = (document: unknown) => (file: string) => {
  if (file !== CONFIG_PATH) throw new Error("unexpected file");
  return JSON.stringify(document);
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function githubStub(options: { tokenStatus?: number } = {}) {
  const calls: { url: string; method: string; body?: any }[] = [];
  let minted = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url.endsWith("/app/installations/7890123/access_tokens")) {
      if (options.tokenStatus) return json(options.tokenStatus, { message: "-----BEGIN RSA PRIVATE KEY----- echo" });
      minted += 1;
      return json(201, { token: `ghs_approvals_${minted}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    return json(404, { message: "Not Found" });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("approvals App configuration", () => {
  it("is optional and leaves the company Apps unchanged", () => {
    expect(parseGitHubApprovalsApp({ apps: [] })).toEqual({ status: "disabled" });
    expect(parseGitHubAppsFile(FILE).status).toBe("enabled");
    expect(parseGitHubAppsFile({ approvalsApp: APPROVALS })).toEqual({ status: "disabled" });
    expect(parseGitHubAppsFile({ apps: FILE.apps, other: 1 }).status).toBe("invalid");
  });

  it("parses the allowlist per company", () => {
    const result = parseGitHubApprovalsApp(FILE);
    expect(result.status).toBe("enabled");
    if (result.status !== "enabled") return;
    expect(result.config).toMatchObject({ appId: "123456", installationId: "7890123", owner: "acme" });
    expect([...result.config.companies.get(COMPANY_A)!]).toEqual(["deployments", "Infrastructure"]);
  });

  it.each([
    ["an unknown key", { ...APPROVALS, extra: true }, /unknown key "extra"/],
    ["a non-numeric App ID", { ...APPROVALS, appId: "x" }, /appId/],
    ["a relative key path", { ...APPROVALS, privateKeyFile: "key.pem" }, /privateKeyFile/],
    ["a bad owner", { ...APPROVALS, owner: "a/b" }, /owner/],
    ["a non-UUID company", { ...APPROVALS, companies: { nope: ["x"] } }, /company UUID/],
    ["owner-qualified repositories", { ...APPROVALS, companies: { [COMPANY_A]: ["acme/x"] } }, /without owners/],
  ])("rejects %s", (_name, approvalsApp, error) => {
    const result = parseGitHubApprovalsApp({ approvalsApp });
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.error).toMatch(error);
  });

  it("must be separate from every company App", () => {
    const result = parseGitHubApprovalsApp({ ...FILE, approvalsApp: { ...APPROVALS, appId: "5462605" } });
    expect(result.status === "invalid" && result.error).toMatch(/must be separate/);
  });

  it("never throws at startup, and reports a broken key without its contents", async () => {
    expect(readGitHubApprovalsAppConfig({})).toEqual({ status: "disabled" });
    await expect(
      checkGitHubApprovalsAppAtStartup(env, { readConfigFile: readConfigFile(FILE), readSecretFile: async () => PEM }),
    ).resolves.toEqual({ status: "enabled", appId: "123456", companies: 2 });
    const unreadable = await checkGitHubApprovalsAppAtStartup(env, {
      readConfigFile: readConfigFile(FILE),
      readSecretFile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(unreadable).toEqual({ status: "warning", error: expect.stringContaining(KEY_PATH) });
    const garbage = await checkGitHubApprovalsAppAtStartup(env, {
      readConfigFile: readConfigFile(FILE),
      readSecretFile: async () => "not a key",
    });
    expect(garbage.status === "warning" && garbage.error).not.toContain("not a key");
    await expect(
      checkGitHubApprovalsAppAtStartup(env, { readConfigFile: () => "{" }),
    ).resolves.toMatchObject({ status: "warning" });
  });
});

describe("approvals token source", () => {
  const source = (stub = githubStub(), document: unknown = FILE) => ({
    stub,
    tokens: createGitHubApprovalsTokenSource({
      env,
      readConfigFile: readConfigFile(document),
      fetchImpl: stub.fetchImpl,
      readPrivateKey: async () => PEM,
    }),
  });

  it("mints a token scoped to one repository with exactly the gate permissions", async () => {
    const { stub, tokens } = source();
    const result = await tokens.resolve(COMPANY_A, "Acme/infrastructure");
    expect(result).toMatchObject({ status: "available", token: "ghs_approvals_1", repository: "acme/Infrastructure" });
    expect(stub.calls[0]).toMatchObject({
      method: "POST",
      body: { repositories: ["Infrastructure"], permissions: GITHUB_APPROVALS_TOKEN_PERMISSIONS },
    });
    expect(GITHUB_APPROVALS_TOKEN_PERMISSIONS).not.toHaveProperty("contents", "write");
  });

  it("caches per repository and never shares a token across repositories", async () => {
    const { stub, tokens } = source();
    const a = await tokens.resolve(COMPANY_A, "acme/deployments");
    const b = await tokens.resolve(COMPANY_A, "acme/deployments");
    const c = await tokens.resolve(COMPANY_A, "acme/infrastructure");
    expect(a.status === "available" && b.status === "available" && a.token === b.token).toBe(true);
    expect(c.status === "available" && a.status === "available" && c.token !== a.token).toBe(true);
    expect(stub.calls).toHaveLength(2);
  });

  it.each([
    ["another company's repository", COMPANY_B, "acme/deployments"],
    ["a company without an allowlist", COMPANY_C, "acme/deployments"],
    ["another owner", COMPANY_A, "evil/deployments"],
    ["a malformed name", COMPANY_A, "deployments"],
  ])("denies %s without calling GitHub", async (_name, companyId, repository) => {
    const { stub, tokens } = source();
    await expect(tokens.resolve(companyId, repository)).resolves.toMatchObject({ status: "denied" });
    expect(stub.calls).toHaveLength(0);
  });

  it("is not configured without an approvals App, and fails closed on a broken one", async () => {
    await expect(source(githubStub(), { apps: FILE.apps }).tokens.resolve(COMPANY_A, "acme/deployments")).resolves.toEqual({
      status: "not_configured",
    });
    const broken = source(githubStub(), { ...FILE, approvalsApp: { ...APPROVALS, appId: "x" } });
    await expect(broken.tokens.resolve(COMPANY_A, "acme/deployments")).resolves.toMatchObject({ status: "unavailable" });
  });

  it("never echoes GitHub's error body", async () => {
    const { tokens } = source(githubStub({ tokenStatus: 403 }));
    const result = await tokens.resolve(COMPANY_A, "acme/deployments");
    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE KEY/);
  });
});

describe("plugin approvals token host service", () => {
  const eventBus = { forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn() }) } as never;
  const { fetchImpl } = githubStub();
  const services = buildHostServices({} as never, "plugin-record-id", "paperclip.github", eventBus, undefined, {
    githubApprovalsTokens: createGitHubApprovalsTokenSource({
      env,
      readConfigFile: readConfigFile(FILE),
      fetchImpl,
      readPrivateKey: async () => PEM,
    }),
  });
  const handlers = (capabilities: string[]) =>
    createHostClientHandlers({ pluginId: "paperclip.github", capabilities: capabilities as never, services });
  const scope = (companyId: string) => ({ invocationScope: { companyId } });

  it("returns only a token for the invocation company's allowlisted repository", async () => {
    const result = await handlers(["github.approvals.token"])["githubApp.getApprovalsToken"](
      { repository: "acme/web-app" },
      scope(COMPANY_B),
    );
    expect(result).toMatchObject({ appId: "123456", repository: "acme/web-app", companyId: COMPANY_B });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE KEY|eyJ/);
  });

  it("refuses another company, a repository not allowlisted, and calls without the capability", async () => {
    const call = handlers(["github.approvals.token"])["githubApp.getApprovalsToken"];
    await expect(call({ repository: "acme/web-app", companyId: COMPANY_B }, scope(COMPANY_A))).rejects.toThrow(/scoped to company/);
    await expect(call({ repository: "acme/web-app" }, scope(COMPANY_A))).rejects.toThrow(/not allowlisted/);
    await expect(call({ repository: "" }, scope(COMPANY_A))).rejects.toThrow(/requires a repository/);
    await expect(
      handlers(["github.app.token"])["githubApp.getApprovalsToken"]({ repository: "acme/web-app" }, scope(COMPANY_B)),
    ).rejects.toThrow(/github\.approvals\.token/);
  });
});
