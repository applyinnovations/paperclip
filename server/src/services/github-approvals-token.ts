import { readFile } from "node:fs/promises";
import { githubAppJwt, githubBotRequest } from "./chat-github-client.js";
import {
  approvalsRepositoryForCompany,
  GITHUB_APPS_FILE_ENV,
  readGitHubApprovalsAppConfig,
  type GitHubApprovalsAppConfig,
  type GitHubApprovalsAppConfigResult,
} from "./github-app-config.js";
import { GITHUB_APP_TOKEN_REFRESH_MARGIN_MS } from "./github-app-installation-credentials.js";

/**
 * Tokens of the shared approvals App (github-app-config.ts, `approvalsApp`).
 *
 * The host holds the approvals App key; a plugin with `github.approvals.token` asks for a
 * token for one repository and receives an installation token scoped to that repository and
 * to exactly the permissions a merge gate needs. The key and the App JWT never leave this
 * module. A company only gets tokens for repositories the operator allowlisted for it.
 */

/** The permissions every approvals token is minted with: post statuses, read the PR, keep labels. */
export const GITHUB_APPROVALS_TOKEN_PERMISSIONS = {
  statuses: "write",
  pull_requests: "read",
  contents: "read",
  metadata: "read",
  issues: "write",
} as const;

export type GitHubApprovalsTokenResult =
  | { status: "not_configured" }
  | { status: "denied"; error: string }
  | { status: "unavailable"; error: string }
  | {
      status: "available";
      token: string;
      expiresAt: string;
      appId: string;
      installationId: string;
      /** `owner/name`, with the allowlist's spelling. */
      repository: string;
    };

type InstallationToken = { token: string; expires_at: string };

export function createGitHubApprovalsTokenSource(deps: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readPrivateKey?: (path: string) => Promise<string>;
  readConfigFile?: (path: string) => string;
  now?: () => Date;
} = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const readPrivateKey = deps.readPrivateKey ?? ((path: string) => readFile(path, "utf8"));
  const now = deps.now ?? (() => new Date());
  type Cached = { token: string; expiresAtMs: number };
  // One cache entry per App installation and repository: a token never covers two repositories.
  const cache = new Map<string, Cached>();
  const inflight = new Map<string, Promise<Cached>>();

  let configMemo: { key: string | null; result: GitHubApprovalsAppConfigResult } | null = null;
  const currentConfig = (): GitHubApprovalsAppConfigResult => {
    const env = deps.env ?? process.env;
    const key = env[GITHUB_APPS_FILE_ENV] ?? null;
    if (configMemo?.key === key) return configMemo.result;
    const result = readGitHubApprovalsAppConfig(env, deps.readConfigFile);
    configMemo = result.status === "invalid" ? null : { key, result };
    return result;
  };

  const mint = async (config: GitHubApprovalsAppConfig, name: string): Promise<Cached> => {
    const privateKey = await readPrivateKey(config.privateKeyFile);
    const jwt = githubAppJwt(config.appId, privateKey, now());
    const minted = await githubBotRequest<InstallationToken>(
      fetchImpl,
      jwt,
      `/app/installations/${config.installationId}/access_tokens`,
      { method: "POST", body: { repositories: [name], permissions: GITHUB_APPROVALS_TOKEN_PERMISSIONS } },
    );
    const expiresAtMs = Date.parse(minted.expires_at);
    if (!minted.token || !Number.isFinite(expiresAtMs)) throw new Error("GitHub returned an invalid installation token");
    return { token: minted.token, expiresAtMs };
  };

  return {
    /** A token for one allowlisted repository of a company. */
    async resolve(companyId: string, repository: string): Promise<GitHubApprovalsTokenResult> {
      const configResult = currentConfig();
      if (configResult.status === "disabled") return { status: "not_configured" };
      if (configResult.status === "invalid") return { status: "unavailable", error: configResult.error };
      const { config } = configResult;
      const target = approvalsRepositoryForCompany(config, companyId, repository);
      if (target.status === "denied") return { status: "denied", error: `approvals token denied: ${target.reason}` };
      const key = `${config.appId}:${config.installationId}:${target.name.toLowerCase()}`;
      let current = cache.get(key);
      if (!current || current.expiresAtMs - GITHUB_APP_TOKEN_REFRESH_MARGIN_MS <= now().getTime()) {
        let pending = inflight.get(key);
        if (!pending) {
          pending = mint(config, target.name).finally(() => inflight.delete(key));
          inflight.set(key, pending);
        }
        try {
          current = await pending;
          cache.set(key, current);
        } catch {
          // Never surface provider bodies or key-parsing errors: they can echo credential material.
          cache.delete(key);
          return {
            status: "unavailable",
            error: "The approvals GitHub App could not issue a token; check its App ID, private key, installation and repository access",
          };
        }
      }
      return {
        status: "available",
        token: current.token,
        expiresAt: new Date(current.expiresAtMs).toISOString(),
        appId: config.appId,
        installationId: config.installationId,
        repository: `${target.owner}/${target.name}`,
      };
    },
    /** Drop cached tokens, e.g. after GitHub rejects one. */
    invalidate() {
      cache.clear();
    },
  };
}

let defaultSource: ReturnType<typeof createGitHubApprovalsTokenSource> | null = null;

/** Process-wide source so plugin calls share one cached token per repository. */
export function githubApprovalsTokenSource() {
  defaultSource ??= createGitHubApprovalsTokenSource();
  return defaultSource;
}
