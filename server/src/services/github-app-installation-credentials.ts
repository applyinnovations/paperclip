import { readFile } from "node:fs/promises";
import { githubAppJwt, githubBotRequest } from "./chat-github-client.js";
import type { GitCredential } from "./git-credentials.js";

/**
 * Operator-owned GitHub App credentials for self-hosted instances.
 *
 * A self-hosted operator can run their own GitHub App instead of connecting a personal
 * account or Paperclip Cloud's shared App. The server holds the App private key (read from a
 * file, e.g. a mounted Kubernetes Secret) and mints a short-lived installation access token
 * when a git/gh operation needs one. Agents only ever receive the installation token through
 * the existing brokered launchers; the private key and the App JWT never leave this module.
 *
 * Configuration (all from the server environment):
 *   PAPERCLIP_GITHUB_APP_ID                 App ID
 *   PAPERCLIP_GITHUB_APP_INSTALLATION_ID    installation to mint tokens for
 *   PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE   path to the App private key (PEM)
 *   PAPERCLIP_GITHUB_APP_COMPANY_IDS        comma-separated company IDs allowed to use it
 *   PAPERCLIP_GITHUB_APP_REPOSITORIES       optional comma-separated repository names; when
 *                                           set, tokens are scoped to these repositories
 *
 * Unset means disabled. A partial configuration is a misconfiguration and fails closed.
 * Only allow-listed companies can use the App, so one installation is never shared across
 * tenants by accident.
 */

export const GITHUB_APP_ENV = {
  appId: "PAPERCLIP_GITHUB_APP_ID",
  installationId: "PAPERCLIP_GITHUB_APP_INSTALLATION_ID",
  privateKeyFile: "PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE",
  companyIds: "PAPERCLIP_GITHUB_APP_COMPANY_IDS",
  repositories: "PAPERCLIP_GITHUB_APP_REPOSITORIES",
} as const;

export type GitHubAppInstallationConfig = {
  appId: string;
  installationId: string;
  privateKeyFile: string;
  companyIds: ReadonlySet<string>;
  repositories: readonly string[];
};

export type GitHubAppConfigResult =
  | { status: "disabled" }
  | { status: "invalid"; error: string }
  | { status: "enabled"; config: GitHubAppInstallationConfig };

const list = (value: string | undefined) =>
  (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

export function readGitHubAppInstallationConfig(
  env: NodeJS.ProcessEnv = process.env,
): GitHubAppConfigResult {
  const appId = env[GITHUB_APP_ENV.appId]?.trim() ?? "";
  const installationId = env[GITHUB_APP_ENV.installationId]?.trim() ?? "";
  const privateKeyFile = env[GITHUB_APP_ENV.privateKeyFile]?.trim() ?? "";
  const companyIds = list(env[GITHUB_APP_ENV.companyIds]);
  const repositories = list(env[GITHUB_APP_ENV.repositories]);
  if (!appId && !installationId && !privateKeyFile && companyIds.length === 0) {
    return { status: "disabled" };
  }
  const missing = [
    !appId && GITHUB_APP_ENV.appId,
    !installationId && GITHUB_APP_ENV.installationId,
    !privateKeyFile && GITHUB_APP_ENV.privateKeyFile,
    companyIds.length === 0 && GITHUB_APP_ENV.companyIds,
  ].filter(Boolean);
  if (missing.length > 0) {
    return { status: "invalid", error: `GitHub App configuration is incomplete: set ${missing.join(", ")}` };
  }
  if (!/^[1-9][0-9]*$/.test(appId) || !/^[1-9][0-9]*$/.test(installationId)) {
    return { status: "invalid", error: "GitHub App and installation IDs must be numeric" };
  }
  if (repositories.some((name) => !/^[A-Za-z0-9._-]+$/.test(name))) {
    return { status: "invalid", error: `${GITHUB_APP_ENV.repositories} must list repository names without owners` };
  }
  return {
    status: "enabled",
    config: { appId, installationId, privateKeyFile, companyIds: new Set(companyIds), repositories },
  };
}

type InstallationToken = { token: string; expires_at: string };
type AppInfo = { slug: string };
type BotUser = { id: number; login: string };

export type GitHubAppTokenResult =
  | { status: "not_applicable" }
  | { status: "unavailable"; error: string }
  | { status: "available"; credential: GitCredential };

/** Refresh this long before GitHub's expiry so a token never dies mid-operation. */
export const GITHUB_APP_TOKEN_REFRESH_MARGIN_MS = 10 * 60_000;

export function createGitHubAppInstallationTokenSource(deps: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readPrivateKey?: (path: string) => Promise<string>;
  now?: () => Date;
} = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const readPrivateKey = deps.readPrivateKey ?? ((path: string) => readFile(path, "utf8"));
  const now = deps.now ?? (() => new Date());
  type CachedToken = { token: string; expiresAtMs: number; identity?: { userId: string; login: string } };
  let cached: CachedToken | null = null;
  let inflight: Promise<CachedToken> | null = null;

  const mint = async (config: GitHubAppInstallationConfig): Promise<CachedToken> => {
    const privateKey = await readPrivateKey(config.privateKeyFile);
    const jwt = githubAppJwt(config.appId, privateKey, now());
    const minted = await githubBotRequest<InstallationToken>(
      fetchImpl,
      jwt,
      `/app/installations/${config.installationId}/access_tokens`,
      {
        method: "POST",
        ...(config.repositories.length > 0 ? { body: { repositories: config.repositories } } : {}),
      },
    );
    const expiresAtMs = Date.parse(minted.expires_at);
    if (!minted.token || !Number.isFinite(expiresAtMs)) throw new Error("GitHub returned an invalid installation token");
    // Commit identity is best effort: a token without it still authenticates.
    let identity = cached?.identity;
    if (!identity) {
      try {
        const app = await githubBotRequest<AppInfo>(fetchImpl, jwt, "/app");
        const bot = await githubBotRequest<BotUser>(fetchImpl, null, `/users/${encodeURIComponent(`${app.slug}[bot]`)}`);
        identity = { userId: String(bot.id), login: bot.login };
      } catch {
        identity = undefined;
      }
    }
    return { token: minted.token, expiresAtMs, identity };
  };

  return {
    /** Resolve a credential for one company, minting or reusing a cached installation token. */
    async resolve(companyId: string): Promise<GitHubAppTokenResult> {
      const configResult = readGitHubAppInstallationConfig(deps.env ?? process.env);
      if (configResult.status === "disabled") return { status: "not_applicable" };
      if (configResult.status === "invalid") return { status: "unavailable", error: configResult.error };
      const { config } = configResult;
      if (!config.companyIds.has(companyId)) return { status: "not_applicable" };
      let current = cached;
      if (!current || current.expiresAtMs - GITHUB_APP_TOKEN_REFRESH_MARGIN_MS <= now().getTime()) {
        inflight ??= mint(config).finally(() => {
          inflight = null;
        });
        try {
          current = cached = await inflight;
        } catch {
          // Never surface provider bodies or key-parsing errors: they can echo credential material.
          cached = null;
          return {
            status: "unavailable",
            error: "The GitHub App could not issue an installation token; check the App ID, private key and installation",
          };
        }
      }
      return {
        status: "available",
        credential: {
          token: current.token,
          source: "github_app",
          secretName: null,
          ...(current.identity ? { githubIdentity: current.identity } : {}),
          identitySource: "app",
        },
      };
    },
    /** Drop the cached token, e.g. after GitHub rejects it. */
    invalidate() {
      cached = null;
    },
  };
}

let defaultSource: ReturnType<typeof createGitHubAppInstallationTokenSource> | null = null;

/** Process-wide source so every run shares one cached installation token. */
export function githubAppInstallationTokenSource() {
  defaultSource ??= createGitHubAppInstallationTokenSource();
  return defaultSource;
}
