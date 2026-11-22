import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import {
  checkGitHubAppsConfigAtStartup,
  parseGitHubAppsFile,
  readGitHubAppsConfig,
} from "../services/github-app-config.js";
import { createGitHubAppInstallationTokenSource } from "../services/github-app-installation-credentials.js";
import { createGitHubAppWebhookVerifier } from "../services/github-app-webhooks.js";
import { buildHostServices } from "../services/plugin-host-services.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const APPLY = "a9d886a3-e526-461c-95d6-d2d0d6b6c722";
const CALILE = "0b6f3c0e-1c1d-4c39-9d43-6a3f9d1c2e01";
const PLAYABLE = "7c2a5d4e-8f60-4b1a-a3c2-1d9e8f7a6b55";
const CONFIG_PATH = "/etc/paperclip/github-apps.json";

const APPS = {
  apps: [
    {
      companyId: APPLY,
      appId: "5462605",
      installationId: "175009740",
      privateKeyFile: "/var/run/github-apps/apply/private-key.pem",
      webhookSecretFile: "/var/run/github-apps/apply/webhook-secret",
      repositories: ["xlab-deployments"],
    },
    {
      companyId: CALILE,
      appId: 6000001,
      installationId: 200000001,
      privateKeyFile: "/var/run/github-apps/calile/private-key.pem",
    },
  ],
};

const fileEnv = { PAPERCLIP_GITHUB_APPS_FILE: CONFIG_PATH };
const SINGLE_ENV = {
  PAPERCLIP_GITHUB_APP_ID: "5462605",
  PAPERCLIP_GITHUB_APP_INSTALLATION_ID: "175009740",
  PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE: "/var/run/paperclip-github-app/private-key.pem",
  PAPERCLIP_GITHUB_APP_COMPANY_IDS: APPLY,
};

const readConfigFile = (document: unknown) => (file: string) => {
  if (file !== CONFIG_PATH) throw new Error("ENOENT");
  return JSON.stringify(document);
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A GitHub stub that mints installation-specific tokens. */
function githubStub() {
  const minted: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const match = url.match(/\/app\/installations\/(\d+)\/access_tokens$/);
    if (match) {
      minted.push(match[1]!);
      return json(201, {
        token: `ghs_${match[1]}_${minted.filter((id) => id === match[1]).length}`,
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
    }
    return json(404, { message: "Not Found" });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, minted };
}

describe("per-company GitHub App configuration", () => {
  it("parses one App per company and normalizes numeric IDs", () => {
    const result = readGitHubAppsConfig(fileEnv, readConfigFile(APPS));
    expect(result.status).toBe("enabled");
    if (result.status !== "enabled") return;
    expect(result.config.source).toBe("file");
    expect(result.config.apps).toHaveLength(2);
    expect(result.config.apps[1]).toMatchObject({
      appId: "6000001",
      installationId: "200000001",
      webhookSecretFile: null,
      repositories: [],
    });
    expect([...result.config.apps[0]!.companyIds]).toEqual([APPLY]);
  });

  it.each([
    ["a company mapped twice", { apps: [APPS.apps[0], { ...APPS.apps[1], companyId: APPLY }] }, "mapped to more than one App"],
    ["an App mapped twice", { apps: [APPS.apps[0], { ...APPS.apps[1], appId: "5462605" }] }, "App 5462605 is mapped to more than one company"],
    ["an installation mapped twice", { apps: [APPS.apps[0], { ...APPS.apps[1], installationId: 175009740 }] }, "installation 175009740"],
    ["a malformed company ID", { apps: [{ ...APPS.apps[0], companyId: "apply" }] }, "companyId must be a company UUID"],
    ["a malformed App ID", { apps: [{ ...APPS.apps[0], appId: "54x" }] }, "appId must be a positive integer"],
    ["a zero installation ID", { apps: [{ ...APPS.apps[0], installationId: 0 }] }, "installationId must be a positive integer"],
    ["a relative key path", { apps: [{ ...APPS.apps[0], privateKeyFile: "key.pem" }] }, "privateKeyFile must be an absolute"],
    ["an owner-qualified repository", { apps: [{ ...APPS.apps[0], repositories: ["org/repo"] }] }, "repositories must list"],
    ["an unknown key", { apps: [{ ...APPS.apps[0], privateKey: "inline" }] }, 'unknown key "privateKey"'],
    ["an empty list", { apps: [] }, "at least one App"],
    ["a bare list", [APPS.apps[0]], '"apps" array'],
  ])("rejects %s", (_name, document, message) => {
    const result = parseGitHubAppsFile(document);
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.error).toContain(message);
  });

  it("rejects a missing or unparseable file without echoing its contents", () => {
    const missing = readGitHubAppsConfig({ PAPERCLIP_GITHUB_APPS_FILE: "/nope.json" }, readConfigFile(APPS));
    expect(missing).toEqual({ status: "invalid", error: "PAPERCLIP_GITHUB_APPS_FILE: cannot read /nope.json" });
    const garbage = readGitHubAppsConfig(fileEnv, () => "{ secret-ish garbage");
    expect(garbage.status === "invalid" && garbage.error).toBe(`PAPERCLIP_GITHUB_APPS_FILE: ${CONFIG_PATH} is not valid JSON`);
  });

  it("refuses both configuration forms at once", () => {
    for (const extra of [SINGLE_ENV, { PAPERCLIP_GITHUB_APP_REPOSITORIES: "xlab-deployments" }]) {
      const result = readGitHubAppsConfig({ ...fileEnv, ...extra }, readConfigFile(APPS));
      expect(result.status === "invalid" && result.error).toContain("not both");
    }
  });

  it("keeps the single-App variables as the one-App env form", () => {
    const result = readGitHubAppsConfig(SINGLE_ENV);
    expect(result.status === "enabled" && result.config.source).toBe("env");
    expect(readGitHubAppsConfig({})).toEqual({ status: "disabled" });
  });
});

describe("GitHub App startup check", () => {
  const secrets: Record<string, string> = {
    "/var/run/github-apps/apply/private-key.pem": PEM,
    "/var/run/github-apps/apply/webhook-secret": "s3cret\n",
    "/var/run/github-apps/calile/private-key.pem": PEM,
  };
  const readSecretFile = async (file: string) => {
    const value = secrets[file];
    if (value === undefined) throw new Error("ENOENT");
    return value;
  };

  it("accepts a readable configuration", async () => {
    await expect(
      checkGitHubAppsConfigAtStartup(fileEnv, { readConfigFile: readConfigFile(APPS), readSecretFile }),
    ).resolves.toEqual({ status: "enabled", source: "file", apps: 2 });
  });

  it.each([
    ["an invalid file", { readConfigFile: readConfigFile({ apps: [] }), readSecretFile }, "at least one App"],
    ["both forms", { readConfigFile: readConfigFile(APPS), readSecretFile, env: SINGLE_ENV }, "not both"],
    ["an unreadable key", { readConfigFile: readConfigFile(APPS), readSecretFile: async (file: string) => file.includes("calile") ? Promise.reject(new Error("EACCES")) : readSecretFile(file) }, "cannot read private key file /var/run/github-apps/calile/private-key.pem"],
    ["a non-PEM key", { readConfigFile: readConfigFile(APPS), readSecretFile: async (file: string) => file.endsWith(".pem") ? "-----BEGIN NOT A KEY-----" : readSecretFile(file) }, "is not a PEM private key"],
    ["an empty webhook secret", { readConfigFile: readConfigFile(APPS), readSecretFile: async (file: string) => file.endsWith("webhook-secret") ? "  \n" : readSecretFile(file) }, "is empty"],
  ])("refuses to start with %s", async (_name, deps, message) => {
    const { env, ...rest } = deps as typeof deps & { env?: NodeJS.ProcessEnv };
    const run = checkGitHubAppsConfigAtStartup({ ...fileEnv, ...env }, rest);
    await expect(run).rejects.toThrow(message);
    await run.catch((error: Error) => expect(error.message).not.toMatch(/PRIVATE KEY|s3cret/));
  });

  it("leaves a broken single-App env configuration non-fatal, as before", async () => {
    await expect(checkGitHubAppsConfigAtStartup({ PAPERCLIP_GITHUB_APP_ID: "1" })).resolves.toMatchObject({ status: "warning" });
    await expect(checkGitHubAppsConfigAtStartup(SINGLE_ENV)).resolves.toEqual({ status: "enabled", source: "env", apps: 1 });
    await expect(checkGitHubAppsConfigAtStartup({})).resolves.toEqual({ status: "disabled" });
  });
});

describe("per-company GitHub App tokens", () => {
  function source(github = githubStub()) {
    return {
      github,
      tokens: createGitHubAppInstallationTokenSource({
        env: fileEnv,
        readConfigFile: readConfigFile(APPS),
        fetchImpl: github.fetchImpl,
        readPrivateKey: async () => PEM,
      }),
    };
  }

  it("mints each company's token from its own App installation and never shares a cache", async () => {
    const { github, tokens } = source();
    const apply = await tokens.resolve(APPLY);
    const calile = await tokens.resolve(CALILE);
    expect(apply).toMatchObject({ status: "available", appId: "5462605", installationId: "175009740", credential: { token: "ghs_175009740_1" } });
    expect(calile).toMatchObject({ status: "available", appId: "6000001", installationId: "200000001", credential: { token: "ghs_200000001_1" } });
    // Cached per App: a second resolve for each company reuses its own token.
    expect(await tokens.resolve(APPLY)).toMatchObject({ credential: { token: "ghs_175009740_1" } });
    expect(await tokens.resolve(CALILE)).toMatchObject({ credential: { token: "ghs_200000001_1" } });
    expect(github.minted).toEqual(["175009740", "200000001"]);

    // Invalidating one company's App leaves the other cache in place.
    tokens.invalidate(CALILE);
    expect(await tokens.resolve(APPLY)).toMatchObject({ credential: { token: "ghs_175009740_1" } });
    expect(await tokens.resolve(CALILE)).toMatchObject({ credential: { token: "ghs_200000001_2" } });
  });

  it("falls through for a company without an App", async () => {
    const { github, tokens } = source();
    expect(await tokens.resolve(PLAYABLE)).toEqual({ status: "not_applicable" });
    expect(github.minted).toHaveLength(0);
  });

  it("fails closed for every company when the configuration is broken", async () => {
    const tokens = createGitHubAppInstallationTokenSource({
      env: { ...fileEnv, ...SINGLE_ENV },
      readConfigFile: readConfigFile(APPS),
      fetchImpl: githubStub().fetchImpl,
      readPrivateKey: async () => PEM,
    });
    expect(await tokens.resolve(APPLY)).toMatchObject({ status: "unavailable" });
    expect(await tokens.resolve(PLAYABLE)).toMatchObject({ status: "unavailable" });
  });
});

describe("GitHub App webhook verification", () => {
  const SECRET = "s3cret";
  const verifier = createGitHubAppWebhookVerifier({
    env: fileEnv,
    readConfigFile: readConfigFile(APPS),
    readSecret: async (file) => {
      if (file === "/var/run/github-apps/apply/webhook-secret") return `${SECRET}\n`;
      throw new Error("ENOENT");
    },
  });
  const body = JSON.stringify({ action: "opened", installation: { id: 175009740 } });
  const sign = (raw: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  const headers = (overrides: Record<string, string> = {}) => ({
    "x-github-hook-installation-target-type": "integration",
    "x-github-hook-installation-target-id": "5462605",
    "x-github-event": "pull_request",
    "x-github-delivery": "delivery-1",
    "x-hub-signature-256": sign(body),
    ...overrides,
  });

  it("verifies a signed delivery and reports the App's company", async () => {
    await expect(verifier.verify({ headers: headers(), rawBody: body })).resolves.toEqual({
      verified: true,
      companyId: APPLY,
      appId: "5462605",
      installationId: "175009740",
      event: "pull_request",
      deliveryId: "delivery-1",
    });
  });

  it.each([
    ["a tampered body", { rawBody: body.replace("opened", "closed") }, "bad_signature"],
    ["a wrong secret", { headers: headers({ "x-hub-signature-256": sign(body, "guess") }) }, "bad_signature"],
    ["a missing signature", { headers: headers({ "x-hub-signature-256": "" }) }, "missing_signature"],
    ["an unknown App", { headers: headers({ "x-github-hook-installation-target-id": "999" }) }, "unknown_app"],
    ["a repository webhook", { headers: headers({ "x-github-hook-installation-target-type": "repository" }) }, "not_github_app_delivery"],
    ["an App without a webhook secret", { headers: headers({ "x-github-hook-installation-target-id": "6000001" }) }, "no_webhook_secret"],
    [
      "another installation of the App",
      (() => {
        const raw = JSON.stringify({ installation: { id: 1 } });
        return { rawBody: raw, headers: headers({ "x-hub-signature-256": sign(raw) }) };
      })(),
      "installation_mismatch",
    ],
  ])("rejects %s", async (_name, overrides, reason) => {
    const input = { headers: headers(), rawBody: body, ...overrides };
    await expect(verifier.verify(input)).resolves.toEqual({ verified: false, reason });
  });
});

describe("plugin GitHub App host services", () => {
  const eventBus = { forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn() }) } as never;
  const tokens = createGitHubAppInstallationTokenSource({
    env: fileEnv,
    readConfigFile: readConfigFile(APPS),
    fetchImpl: githubStub().fetchImpl,
    readPrivateKey: async () => PEM,
  });
  const services = buildHostServices({} as never, "plugin-record-id", "paperclip.github", eventBus, undefined, {
    githubAppTokens: tokens,
    githubAppWebhooks: createGitHubAppWebhookVerifier({ readConfig: () => ({ status: "disabled" }) }),
  });
  const handlers = (capabilities: string[]) =>
    createHostClientHandlers({ pluginId: "paperclip.github", capabilities: capabilities as never, services });

  it("returns the invocation company's token and never the private key", async () => {
    const result = await handlers(["github.app.token"])["githubApp.getInstallationToken"](
      {},
      { invocationScope: { companyId: CALILE } },
    );
    expect(result).toMatchObject({ token: "ghs_200000001_1", appId: "6000001", installationId: "200000001", companyId: CALILE });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE KEY|eyJ/);
  });

  it("denies another company's token and calls without the capability", async () => {
    await expect(
      handlers(["github.app.token"])["githubApp.getInstallationToken"](
        { companyId: APPLY },
        { invocationScope: { companyId: CALILE } },
      ),
    ).rejects.toThrow(/scoped to company/);
    await expect(
      handlers(["github.app.token"])["githubApp.getInstallationToken"]({ companyId: APPLY }),
    ).rejects.toThrow(/company context is required/);
    await expect(
      handlers([])["githubApp.getInstallationToken"]({}, { invocationScope: { companyId: CALILE } }),
    ).rejects.toThrow(/github\.app\.token/);
    await expect(
      handlers(["github.app.token"])["githubApp.verifyWebhook"]({ headers: {}, rawBody: "" }),
    ).rejects.toThrow(/github\.app\.webhooks\.verify/);
  });

  it("resolves null for a company without an App", async () => {
    await expect(
      handlers(["github.app.token"])["githubApp.getInstallationToken"]({}, { invocationScope: { companyId: PLAYABLE } }),
    ).resolves.toBeNull();
  });

  it("verifies webhooks on the host", async () => {
    await expect(
      handlers(["github.app.webhooks.verify"])["githubApp.verifyWebhook"]({ headers: {}, rawBody: "{}" }),
    ).resolves.toEqual({ verified: false, reason: "not_configured" });
  });
});
