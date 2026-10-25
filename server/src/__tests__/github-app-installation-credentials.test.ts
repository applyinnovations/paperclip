import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createGitHubAppInstallationTokenSource,
  GITHUB_APP_TOKEN_REFRESH_MARGIN_MS,
  readGitHubAppInstallationConfig,
} from "../services/github-app-installation-credentials.js";
import { buildGitAuthInvocation, createGitRemoteAuthProvider } from "../services/git-credentials.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const COMPANY = "company-1";
const ENV = {
  PAPERCLIP_GITHUB_APP_ID: "5462605",
  PAPERCLIP_GITHUB_APP_INSTALLATION_ID: "777",
  PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE: "/run/secrets/github-app/private-key.pem",
  PAPERCLIP_GITHUB_APP_COMPANY_IDS: `${COMPANY}, company-2`,
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function githubStub(options: { tokenStatus?: number; expiresInMs?: number; now?: () => Date } = {}) {
  const calls: { url: string; method: string; authorization?: string; body?: unknown }[] = [];
  let minted = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization") ?? undefined,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url.endsWith("/app/installations/777/access_tokens")) {
      if (options.tokenStatus && options.tokenStatus !== 201) return json(options.tokenStatus, { message: "Not Found" });
      minted += 1;
      const now = options.now?.() ?? new Date();
      return json(201, {
        token: `ghs_installation_${minted}`,
        expires_at: new Date(now.getTime() + (options.expiresInMs ?? 60 * 60_000)).toISOString(),
      });
    }
    if (url.endsWith("/app")) return json(200, { slug: "paperclip-xlab-now" });
    if (url.includes("/users/paperclip-xlab-now%5Bbot%5D")) return json(200, { id: 4242, login: "paperclip-xlab-now[bot]" });
    return json(404, { message: "Not Found" });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("GitHub App installation configuration", () => {
  it("is disabled when unset and fails closed when partially configured", () => {
    expect(readGitHubAppInstallationConfig({})).toEqual({ status: "disabled" });
    const partial = readGitHubAppInstallationConfig({ PAPERCLIP_GITHUB_APP_ID: "1" });
    expect(partial.status).toBe("invalid");
    expect(partial.status === "invalid" && partial.error).toContain("PAPERCLIP_GITHUB_APP_COMPANY_IDS");
    expect(readGitHubAppInstallationConfig({ ...ENV, PAPERCLIP_GITHUB_APP_ID: "abc" }).status).toBe("invalid");
    expect(readGitHubAppInstallationConfig({ ...ENV, PAPERCLIP_GITHUB_APP_REPOSITORIES: "org/repo" }).status).toBe("invalid");
  });
});

describe("GitHub App installation tokens", () => {
  it("mints a token with an RS256 App JWT, scopes it, and caches it until shortly before expiry", async () => {
    let clock = new Date("2026-10-25T00:00:00Z");
    const github = githubStub({ now: () => clock });
    const source = createGitHubAppInstallationTokenSource({
      env: { ...ENV, PAPERCLIP_GITHUB_APP_REPOSITORIES: "xlab-deployments,xlab-containers" },
      fetchImpl: github.fetchImpl,
      readPrivateKey: async () => PEM,
      now: () => clock,
    });

    const first = await source.resolve(COMPANY);
    expect(first.status).toBe("available");
    if (first.status !== "available") return;
    expect(first.credential).toMatchObject({
      token: "ghs_installation_1",
      source: "github_app",
      identitySource: "app",
      githubIdentity: { userId: "4242", login: "paperclip-xlab-now[bot]" },
    });

    const exchange = github.calls.find((call) => call.url.endsWith("/access_tokens"))!;
    expect(exchange.method).toBe("POST");
    expect(exchange.body).toEqual({ repositories: ["xlab-deployments", "xlab-containers"] });
    const jwt = exchange.authorization!.replace(/^Bearer /, "");
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString()).iss).toBe("5462605");
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), createPublicKey(privateKey), Buffer.from(signature!, "base64url"))).toBe(true);

    // Reused while fresh, refreshed inside the margin before expiry.
    clock = new Date(clock.getTime() + 30 * 60_000);
    expect(await source.resolve(COMPANY)).toMatchObject({ credential: { token: "ghs_installation_1" } });
    clock = new Date(clock.getTime() + 30 * 60_000 - GITHUB_APP_TOKEN_REFRESH_MARGIN_MS + 1);
    expect(await source.resolve(COMPANY)).toMatchObject({ credential: { token: "ghs_installation_2" } });
    expect(github.calls.filter((call) => call.url.endsWith("/access_tokens"))).toHaveLength(2);
  });

  it("is not offered to companies outside the allow-list", async () => {
    const github = githubStub();
    const source = createGitHubAppInstallationTokenSource({ env: ENV, fetchImpl: github.fetchImpl, readPrivateKey: async () => PEM });
    expect(await source.resolve("other-company")).toEqual({ status: "not_applicable" });
    expect(github.calls).toHaveLength(0);
  });

  it.each([
    ["an unreadable private key", { readPrivateKey: async () => "not a pem" }],
    ["an uninstalled or revoked App", { tokenStatus: 404 }],
    ["a rejected App JWT", { tokenStatus: 401 }],
  ])("fails closed without leaking credential material for %s", async (_name, options) => {
    const github = githubStub({ tokenStatus: "tokenStatus" in options ? options.tokenStatus : undefined });
    const source = createGitHubAppInstallationTokenSource({
      env: ENV,
      fetchImpl: github.fetchImpl,
      readPrivateKey: "readPrivateKey" in options ? options.readPrivateKey : async () => PEM,
    });
    const result = await source.resolve(COMPANY);
    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE KEY|not a pem|Bearer|eyJ/);
  });

  it("hands agents only the installation token, never the App key or JWT", async () => {
    const github = githubStub();
    const source = createGitHubAppInstallationTokenSource({ env: ENV, fetchImpl: github.fetchImpl, readPrivateKey: async () => PEM });
    const result = await source.resolve(COMPANY);
    if (result.status !== "available") throw new Error("expected a credential");
    const env = JSON.stringify(buildGitAuthInvocation(result.credential).env);
    expect(env).toContain("ghs_installation_1");
    expect(env).not.toMatch(/PRIVATE KEY|eyJ/);
    expect(env).toContain("4242+paperclip-xlab-now[bot]@users.noreply.github.com");
  });
});

describe("git remote credential resolution order", () => {
  const remote = "https://github.com/applyinnovations/xlab-deployments.git";
  const noSecrets = { getByName: async () => null, resolveSecretValue: async () => "" };
  const available = { resolve: async () => ({ status: "available" as const, credential: { token: "ghs_app", source: "github_app" as const, secretName: null } }) };

  it("prefers a company secret, then the GitHub App, before the server environment token", async () => {
    const withSecret = createGitRemoteAuthProvider(null as never, COMPANY, undefined, {
      secrets: { getByName: async () => ({ id: "secret-1" }), resolveSecretValue: async () => "company-token" },
      env: { GITHUB_TOKEN: "env-token" },
      githubApp: available,
    });
    expect((await withSecret(remote))?.source).toBe("company_secret");

    const withApp = createGitRemoteAuthProvider(null as never, COMPANY, undefined, {
      secrets: noSecrets, env: { GITHUB_TOKEN: "env-token" }, githubApp: available,
    });
    expect(await withApp(remote)).toMatchObject({ source: "github_app", env: { PAPERCLIP_GIT_TOKEN: "ghs_app" } });
  });

  it("fails closed instead of falling back to the environment when the App is broken", async () => {
    const provider = createGitRemoteAuthProvider(null as never, COMPANY, undefined, {
      secrets: noSecrets,
      env: { GITHUB_TOKEN: "env-token" },
      githubApp: { resolve: async () => ({ status: "unavailable" as const, error: "The GitHub App could not issue an installation token" }) },
    });
    await expect(provider(remote)).rejects.toThrow("could not issue an installation token");
  });
});
