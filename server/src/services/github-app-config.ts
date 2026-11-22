import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Operator-owned GitHub App configuration.
 *
 * Two mutually exclusive forms:
 *
 * 1. One App shared by an allowlist of companies (the original form):
 *      PAPERCLIP_GITHUB_APP_ID, PAPERCLIP_GITHUB_APP_INSTALLATION_ID,
 *      PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE, PAPERCLIP_GITHUB_APP_COMPANY_IDS,
 *      PAPERCLIP_GITHUB_APP_REPOSITORIES (optional)
 *
 * 2. One App per company, listed in a JSON file named by PAPERCLIP_GITHUB_APPS_FILE:
 *      { "apps": [ { "companyId", "appId", "installationId", "privateKeyFile",
 *                    "webhookSecretFile"?, "repositories"? } ] }
 *
 * The file holds only identifiers and paths; private keys and webhook secrets stay in their
 * own files (mounted secrets). Setting both forms, duplicate companies/Apps/installations,
 * unknown keys or malformed IDs are configuration errors: the server refuses to start.
 */

export const GITHUB_APP_ENV = {
  appId: "PAPERCLIP_GITHUB_APP_ID",
  installationId: "PAPERCLIP_GITHUB_APP_INSTALLATION_ID",
  privateKeyFile: "PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE",
  companyIds: "PAPERCLIP_GITHUB_APP_COMPANY_IDS",
  repositories: "PAPERCLIP_GITHUB_APP_REPOSITORIES",
} as const;

export const GITHUB_APPS_FILE_ENV = "PAPERCLIP_GITHUB_APPS_FILE";

export type GitHubAppInstallationConfig = {
  appId: string;
  installationId: string;
  privateKeyFile: string;
  /** Only the per-company file form can name a webhook secret. */
  webhookSecretFile: string | null;
  companyIds: ReadonlySet<string>;
  repositories: readonly string[];
};

export type GitHubAppConfigResult =
  | { status: "disabled" }
  | { status: "invalid"; error: string }
  | { status: "enabled"; config: GitHubAppInstallationConfig };

export type GitHubAppsConfig = {
  source: "env" | "file";
  apps: readonly GitHubAppInstallationConfig[];
};

export type GitHubAppsConfigResult =
  | { status: "disabled" }
  | { status: "invalid"; error: string }
  | { status: "enabled"; config: GitHubAppsConfig };

const NUMERIC_ID = /^[1-9][0-9]*$/;
const REPOSITORY_NAME = /^[A-Za-z0-9._-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const list = (value: string | undefined) =>
  (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

/** The original single-App form, read from the environment. Behaviour is unchanged. */
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
  if (!NUMERIC_ID.test(appId) || !NUMERIC_ID.test(installationId)) {
    return { status: "invalid", error: "GitHub App and installation IDs must be numeric" };
  }
  if (repositories.some((name) => !REPOSITORY_NAME.test(name))) {
    return { status: "invalid", error: `${GITHUB_APP_ENV.repositories} must list repository names without owners` };
  }
  return {
    status: "enabled",
    config: {
      appId,
      installationId,
      privateKeyFile,
      webhookSecretFile: null,
      companyIds: new Set(companyIds),
      repositories,
    },
  };
}

const ENTRY_KEYS = new Set([
  "companyId",
  "appId",
  "installationId",
  "privateKeyFile",
  "webhookSecretFile",
  "repositories",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && NUMERIC_ID.test(value.trim())) return value.trim();
  return null;
}

function absolutePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && path.isAbsolute(trimmed) ? trimmed : null;
}

/** Validate the parsed contents of PAPERCLIP_GITHUB_APPS_FILE. */
export function parseGitHubAppsFile(document: unknown): GitHubAppsConfigResult {
  const invalid = (error: string): GitHubAppsConfigResult => ({
    status: "invalid",
    error: `${GITHUB_APPS_FILE_ENV}: ${error}`,
  });
  if (!isRecord(document) || !Array.isArray(document.apps)) {
    return invalid('expected an object with an "apps" array');
  }
  const extraRootKeys = Object.keys(document).filter((key) => key !== "apps");
  if (extraRootKeys.length > 0) return invalid(`unknown key "${extraRootKeys[0]}"`);
  if (document.apps.length === 0) return invalid("list at least one App, or unset the variable");

  const apps: GitHubAppInstallationConfig[] = [];
  const seen = { companyId: new Set<string>(), appId: new Set<string>(), installationId: new Set<string>() };
  for (const [index, entry] of document.apps.entries()) {
    const at = `apps[${index}]`;
    if (!isRecord(entry)) return invalid(`${at} must be an object`);
    const unknown = Object.keys(entry).find((key) => !ENTRY_KEYS.has(key));
    if (unknown) return invalid(`${at} has unknown key "${unknown}"`);

    const companyId = typeof entry.companyId === "string" ? entry.companyId.trim().toLowerCase() : "";
    if (!UUID.test(companyId)) return invalid(`${at}.companyId must be a company UUID`);
    const appId = numericId(entry.appId);
    if (!appId) return invalid(`${at}.appId must be a positive integer`);
    const installationId = numericId(entry.installationId);
    if (!installationId) return invalid(`${at}.installationId must be a positive integer`);
    const privateKeyFile = absolutePath(entry.privateKeyFile);
    if (!privateKeyFile) return invalid(`${at}.privateKeyFile must be an absolute file path`);
    let webhookSecretFile: string | null = null;
    if (entry.webhookSecretFile !== undefined && entry.webhookSecretFile !== null) {
      webhookSecretFile = absolutePath(entry.webhookSecretFile);
      if (!webhookSecretFile) return invalid(`${at}.webhookSecretFile must be an absolute file path`);
    }
    let repositories: string[] = [];
    if (entry.repositories !== undefined && entry.repositories !== null) {
      if (
        !Array.isArray(entry.repositories) ||
        entry.repositories.some((name) => typeof name !== "string" || !REPOSITORY_NAME.test(name))
      ) {
        return invalid(`${at}.repositories must list repository names without owners`);
      }
      repositories = [...new Set(entry.repositories as string[])];
    }

    if (seen.companyId.has(companyId)) return invalid(`company ${companyId} is mapped to more than one App`);
    if (seen.appId.has(appId)) return invalid(`App ${appId} is mapped to more than one company`);
    if (seen.installationId.has(installationId)) {
      return invalid(`installation ${installationId} is mapped to more than one company`);
    }
    seen.companyId.add(companyId);
    seen.appId.add(appId);
    seen.installationId.add(installationId);
    apps.push({
      appId,
      installationId,
      privateKeyFile,
      webhookSecretFile,
      companyIds: new Set([companyId]),
      repositories,
    });
  }
  return { status: "enabled", config: { source: "file", apps } };
}

function singleAppEnvIsSet(env: NodeJS.ProcessEnv): boolean {
  return Object.values(GITHUB_APP_ENV).some((name) => (env[name]?.trim() ?? "") !== "");
}

/**
 * Read whichever GitHub App form is configured. The file is read synchronously: the result
 * is cached by the token source, and the startup check reads it once before serving.
 */
export function readGitHubAppsConfig(
  env: NodeJS.ProcessEnv = process.env,
  readConfigFile: (file: string) => string = (file) => readFileSync(file, "utf8"),
): GitHubAppsConfigResult {
  const file = env[GITHUB_APPS_FILE_ENV]?.trim() ?? "";
  if (!file) {
    const single = readGitHubAppInstallationConfig(env);
    if (single.status !== "enabled") return single;
    return { status: "enabled", config: { source: "env", apps: [single.config] } };
  }
  if (singleAppEnvIsSet(env)) {
    return {
      status: "invalid",
      error: `Set either ${GITHUB_APPS_FILE_ENV} or the PAPERCLIP_GITHUB_APP_* variables, not both`,
    };
  }
  let text: string;
  try {
    text = readConfigFile(file);
  } catch {
    return { status: "invalid", error: `${GITHUB_APPS_FILE_ENV}: cannot read ${file}` };
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { status: "invalid", error: `${GITHUB_APPS_FILE_ENV}: ${file} is not valid JSON` };
  }
  return parseGitHubAppsFile(document);
}

/** The App configured for a company, if any. Each company maps to at most one App. */
export function githubAppForCompany(
  config: GitHubAppsConfig,
  companyId: string,
): GitHubAppInstallationConfig | null {
  const key = config.source === "file" ? companyId.trim().toLowerCase() : companyId;
  return config.apps.find((app) => app.companyIds.has(key)) ?? null;
}

export type GitHubAppsStartupCheck =
  | { status: "disabled" }
  | { status: "enabled"; source: "env" | "file"; apps: number }
  /** The single-App env form is invalid; kept non-fatal so its behaviour stays unchanged. */
  | { status: "warning"; error: string };

/**
 * Validate the GitHub App configuration before the server starts serving.
 *
 * The per-company file form fails closed: any error, including an unreadable or unparseable
 * private key or an empty webhook secret, throws. The original env form keeps its original
 * behaviour (a broken configuration fails at token time), so it is reported as a warning.
 * Error messages name files and IDs, never their contents.
 */
export async function checkGitHubAppsConfigAtStartup(
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    readConfigFile?: (file: string) => string;
    readSecretFile?: (file: string) => Promise<string>;
  } = {},
): Promise<GitHubAppsStartupCheck> {
  const readSecretFile = deps.readSecretFile ?? ((file: string) => readFile(file, "utf8"));
  const fileConfigured = (env[GITHUB_APPS_FILE_ENV]?.trim() ?? "") !== "";
  const result = readGitHubAppsConfig(env, deps.readConfigFile);
  if (result.status === "disabled") return { status: "disabled" };
  if (result.status === "invalid") {
    if (!fileConfigured) return { status: "warning", error: result.error };
    throw new Error(`GitHub App configuration is invalid: ${result.error}`);
  }
  if (result.config.source === "file") {
    for (const [index, app] of result.config.apps.entries()) {
      const label = `${GITHUB_APPS_FILE_ENV} apps[${index}] (App ${app.appId})`;
      let pem: string;
      try {
        pem = await readSecretFile(app.privateKeyFile);
      } catch {
        throw new Error(`${label}: cannot read private key file ${app.privateKeyFile}`);
      }
      try {
        createPrivateKey(pem);
      } catch {
        throw new Error(`${label}: ${app.privateKeyFile} is not a PEM private key`);
      }
      if (app.webhookSecretFile) {
        let secret: string;
        try {
          secret = await readSecretFile(app.webhookSecretFile);
        } catch {
          throw new Error(`${label}: cannot read webhook secret file ${app.webhookSecretFile}`);
        }
        if (secret.trim() === "") throw new Error(`${label}: webhook secret file ${app.webhookSecretFile} is empty`);
      }
    }
  }
  return { status: "enabled", source: result.config.source, apps: result.config.apps.length };
}
