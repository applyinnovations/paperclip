import { readFile } from "node:fs/promises";
import { githubAppJwt, githubBotRequest } from "./chat-github-client.js";
import type { GitCredential } from "./git-credentials.js";
import {
  githubAppForCompany,
  GITHUB_APP_ENV,
  GITHUB_APPS_FILE_ENV,
  readGitHubAppsConfig,
  type GitHubAppInstallationConfig,
  type GitHubAppsConfigResult,
} from "./github-app-config.js";

/**
 * Operator-owned GitHub App credentials for self-hosted instances.
 *
 * A self-hosted operator can run their own GitHub App instead of connecting a personal
 * account or Paperclip Cloud's shared App. The server holds the App private key (read from a
 * file, e.g. a mounted Kubernetes Secret) and mints a short-lived installation access token
 * when a git/gh operation needs one. Agents only ever receive the installation token through
 * the existing brokered launchers; the private key and the App JWT never leave this module.
 *
 * Configuration is either one App for an allowlist of companies (PAPERCLIP_GITHUB_APP_*) or
 * one App per company (PAPERCLIP_GITHUB_APPS_FILE); see github-app-config.ts. Each App keeps
 * its own token cache, so one company's token is never handed to another company.
 */

export {
  GITHUB_APP_ENV,
  GITHUB_APPS_FILE_ENV,
  readGitHubAppInstallationConfig,
  readGitHubAppsConfig,
  type GitHubAppConfigResult,
  type GitHubAppInstallationConfig,
  type GitHubAppsConfigResult,
} from "./github-app-config.js";

type InstallationToken = { token: string; expires_at: string };
type AppInfo = { slug: string };
type BotUser = { id: number; login: string };

export type GitHubAppTokenResult =
  | { status: "not_applicable" }
  | { status: "unavailable"; error: string }
  | {
      status: "available";
      credential: GitCredential;
      /** ISO time GitHub expires the token at. */
      expiresAt: string;
      appId: string;
      installationId: string;
    };

/** Refresh this long before GitHub's expiry so a token never dies mid-operation. */
export const GITHUB_APP_TOKEN_REFRESH_MARGIN_MS = 10 * 60_000;

const CONFIG_ENV_NAMES = [GITHUB_APPS_FILE_ENV, ...Object.values(GITHUB_APP_ENV)];

export function createGitHubAppInstallationTokenSource(deps: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readPrivateKey?: (path: string) => Promise<string>;
  readConfigFile?: (path: string) => string;
  now?: () => Date;
} = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const readPrivateKey = deps.readPrivateKey ?? ((path: string) => readFile(path, "utf8"));
  const now = deps.now ?? (() => new Date());
  type Identity = { userId: string; login: string };
  type CachedToken = { token: string; expiresAtMs: number; identity?: Identity };
  type AppTokenState = { cached: CachedToken | null; inflight: Promise<CachedToken> | null };
  // One cache per App installation: a company only ever reads its own App's entry.
  const states = new Map<string, AppTokenState>();
  const stateKey = (app: GitHubAppInstallationConfig) => `${app.appId}:${app.installationId}`;
  const stateFor = (app: GitHubAppInstallationConfig) => {
    const key = stateKey(app);
    let state = states.get(key);
    if (!state) {
      state = { cached: null, inflight: null };
      states.set(key, state);
    }
    return state;
  };

  // The file form is read once per distinct environment and reused; a broken read is retried.
  let configMemo: { key: string; result: GitHubAppsConfigResult } | null = null;
  const currentConfig = (): GitHubAppsConfigResult => {
    const env = deps.env ?? process.env;
    const key = JSON.stringify(CONFIG_ENV_NAMES.map((name) => env[name] ?? null));
    if (configMemo?.key === key) return configMemo.result;
    const result = readGitHubAppsConfig(env, deps.readConfigFile);
    configMemo = result.status === "invalid" ? null : { key, result };
    return result;
  };

  const mint = async (config: GitHubAppInstallationConfig, previous: Identity | undefined): Promise<CachedToken> => {
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
    let identity = previous;
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

  const appFor = (companyId: string):
    | { status: "not_applicable" }
    | { status: "unavailable"; error: string }
    | { status: "found"; app: GitHubAppInstallationConfig } => {
    const configResult = currentConfig();
    if (configResult.status === "disabled") return { status: "not_applicable" };
    if (configResult.status === "invalid") return { status: "unavailable", error: configResult.error };
    const app = githubAppForCompany(configResult.config, companyId);
    return app ? { status: "found", app } : { status: "not_applicable" };
  };

  return {
    /** Resolve a credential for one company, minting or reusing its App's cached installation token. */
    async resolve(companyId: string): Promise<GitHubAppTokenResult> {
      const found = appFor(companyId);
      if (found.status !== "found") return found;
      const { app } = found;
      const state = stateFor(app);
      let current = state.cached;
      if (!current || current.expiresAtMs - GITHUB_APP_TOKEN_REFRESH_MARGIN_MS <= now().getTime()) {
        state.inflight ??= mint(app, state.cached?.identity).finally(() => {
          state.inflight = null;
        });
        try {
          current = state.cached = await state.inflight;
        } catch {
          // Never surface provider bodies or key-parsing errors: they can echo credential material.
          state.cached = null;
          return {
            status: "unavailable",
            error: "The GitHub App could not issue an installation token; check the App ID, private key and installation",
          };
        }
      }
      return {
        status: "available",
        expiresAt: new Date(current.expiresAtMs).toISOString(),
        appId: app.appId,
        installationId: app.installationId,
        credential: {
          token: current.token,
          source: "github_app",
          secretName: null,
          ...(current.identity ? { githubIdentity: current.identity } : {}),
          identitySource: "app",
        },
      };
    },
    /** Drop cached tokens, e.g. after GitHub rejects one: for one company's App, or for all Apps. */
    invalidate(companyId?: string) {
      if (companyId === undefined) {
        for (const state of states.values()) state.cached = null;
        return;
      }
      const found = appFor(companyId);
      if (found.status === "found") stateFor(found.app).cached = null;
    },
  };
}

let defaultSource: ReturnType<typeof createGitHubAppInstallationTokenSource> | null = null;

/** Process-wide source so every run shares one cached token per App installation. */
export function githubAppInstallationTokenSource() {
  defaultSource ??= createGitHubAppInstallationTokenSource();
  return defaultSource;
}
