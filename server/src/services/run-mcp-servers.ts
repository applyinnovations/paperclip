import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import type { AdapterRuntimeMcpServer } from "../adapters/index.js";

/**
 * Operator-run MCP servers that agent runs reach through this server.
 *
 * PAPERCLIP_RUN_MCP_SERVERS_FILE names a JSON file:
 *   { "servers": [ { "name", "url", "companyIds", "agents", "tokenUrl",
 *                    "clientId", "clientSecretFile", "scope" } ] }
 *
 * A run of a listed company whose agent URL key is in `agents` gets an MCP
 * server `name` at /api/run-mcp/<name>, authenticated with the run's own agent
 * JWT. The server checks the run, company and agent on every request, then
 * forwards it to `url` with an OAuth access token it obtains with client
 * credentials and refreshes before expiry. Agents never hold the client
 * secret or the upstream access token, and access ends with the run.
 *
 * `agents` are URL keys (the agent name, lowercased, non-alphanumerics as
 * dashes: "Cycle Time Engineer" is "cycle-time-engineer"), so the list can be
 * written before the agents exist. Renaming an agent changes its key.
 * An invalid file refuses startup.
 */
export const RUN_MCP_SERVERS_FILE_ENV = "PAPERCLIP_RUN_MCP_SERVERS_FILE";
export const RUN_MCP_ROUTE_PREFIX = "/api/run-mcp/";

export type RunMcpServerConfig = {
  name: string;
  url: string;
  companyIds: ReadonlySet<string>;
  agentUrlKeys: ReadonlySet<string>;
  tokenUrl: string;
  clientId: string;
  clientSecretFile: string;
  scopes: readonly string[];
};

export type RunMcpServersConfigResult =
  | { status: "disabled" }
  | { status: "invalid"; error: string }
  | { status: "enabled"; servers: readonly RunMcpServerConfig[] };

const ENTRY_KEYS = new Set(["name", "url", "companyIds", "agents", "tokenUrl", "clientId", "clientSecretFile", "scope"]);
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const TOKEN_TIMEOUT_MS = 10_000;
/** Refresh this long before expiry, so a forwarded request never carries a token about to lapse. */
const REFRESH_MARGIN_SECONDS = 60;
/** Used when the token response omits expires_in. */
const DEFAULT_EXPIRES_IN_SECONDS = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plainUrl(value: unknown, protocols: readonly string[]): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash || url.search) return null;
  return url.toString();
}

/** Validate the parsed contents of PAPERCLIP_RUN_MCP_SERVERS_FILE. */
export function parseRunMcpServersFile(document: unknown): RunMcpServersConfigResult {
  const invalid = (error: string): RunMcpServersConfigResult => ({
    status: "invalid",
    error: `${RUN_MCP_SERVERS_FILE_ENV}: ${error}`,
  });
  if (!isRecord(document) || !Array.isArray(document.servers)) {
    return invalid('expected an object with a "servers" array');
  }
  const extraRootKeys = Object.keys(document).filter((key) => key !== "servers");
  if (extraRootKeys.length > 0) return invalid(`unknown key "${extraRootKeys[0]}"`);
  if (document.servers.length === 0) return invalid("list at least one server, or unset the variable");

  const servers: RunMcpServerConfig[] = [];
  const names = new Set<string>();
  for (const [index, entry] of document.servers.entries()) {
    const at = `servers[${index}]`;
    if (!isRecord(entry)) return invalid(`${at} must be an object`);
    const unknown = Object.keys(entry).find((key) => !ENTRY_KEYS.has(key));
    if (unknown) return invalid(`${at} has unknown key "${unknown}"`);
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!NAME.test(name)) return invalid(`${at}.name must be lowercase letters, digits and dashes`);
    if (names.has(name)) return invalid(`server name "${name}" is listed more than once`);
    names.add(name);
    const url = plainUrl(entry.url, ["http:", "https:"]);
    if (!url) return invalid(`${at}.url must be an http(s) URL without credentials, query or fragment`);
    const companyIds = Array.isArray(entry.companyIds)
      ? entry.companyIds.map((id) => (typeof id === "string" ? id.trim().toLowerCase() : ""))
      : [];
    if (companyIds.length === 0 || !companyIds.every((id) => UUID.test(id))) {
      return invalid(`${at}.companyIds must list company UUIDs`);
    }
    // Explicit allowlist: an empty or missing list is an error, not "everyone".
    const agents = Array.isArray(entry.agents) ? entry.agents : [];
    const agentUrlKeys = agents.map((key) => (typeof key === "string" ? normalizeAgentUrlKey(key) : null));
    if (agents.length === 0 || agentUrlKeys.some((key, i) => key === null || key !== agents[i])) {
      return invalid(`${at}.agents must list agent URL keys (lowercase, dashes), for example "cycle-time-engineer"`);
    }
    // The client secret travels to the token endpoint, so only over TLS.
    const tokenUrl = plainUrl(entry.tokenUrl, ["https:"]);
    if (!tokenUrl) return invalid(`${at}.tokenUrl must be an https URL without credentials, query or fragment`);
    const clientId = typeof entry.clientId === "string" ? entry.clientId.trim() : "";
    if (!clientId) return invalid(`${at}.clientId is required`);
    const clientSecretFile = typeof entry.clientSecretFile === "string" ? entry.clientSecretFile.trim() : "";
    if (!clientSecretFile || !path.isAbsolute(clientSecretFile)) {
      return invalid(`${at}.clientSecretFile must be an absolute file path`);
    }
    const scopes = typeof entry.scope === "string" ? entry.scope.trim().split(/\s+/).filter(Boolean) : [];
    if (scopes.length === 0 || !scopes.every((scope) => SCOPE_TOKEN.test(scope))) {
      return invalid(`${at}.scope must list one or more OAuth scopes`);
    }
    servers.push({
      name, url, companyIds: new Set(companyIds), agentUrlKeys: new Set(agentUrlKeys as string[]),
      tokenUrl, clientId, clientSecretFile, scopes,
    });
  }
  return { status: "enabled", servers };
}

export function readRunMcpServersConfig(
  env: NodeJS.ProcessEnv = process.env,
  readConfigFile: (file: string) => string = (file) => readFileSync(file, "utf8"),
): RunMcpServersConfigResult {
  const file = env[RUN_MCP_SERVERS_FILE_ENV]?.trim() ?? "";
  if (!file) return { status: "disabled" };
  let text: string;
  try {
    text = readConfigFile(file);
  } catch {
    return { status: "invalid", error: `${RUN_MCP_SERVERS_FILE_ENV}: cannot read ${file}` };
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { status: "invalid", error: `${RUN_MCP_SERVERS_FILE_ENV}: ${file} is not valid JSON` };
  }
  return parseRunMcpServersFile(document);
}

/**
 * Fail closed before serving: an invalid file, or an unreadable or empty client
 * secret, throws. Messages name files, never their contents.
 */
export async function checkRunMcpServersConfigAtStartup(
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    readConfigFile?: (file: string) => string;
    readSecretFile?: (file: string) => Promise<string>;
  } = {},
): Promise<{ status: "disabled" } | { status: "enabled"; servers: string[] }> {
  const readSecretFile = deps.readSecretFile ?? ((file: string) => readFile(file, "utf8"));
  const result = readRunMcpServersConfig(env, deps.readConfigFile);
  if (result.status === "disabled") return result;
  if (result.status === "invalid") throw new Error(`Run MCP server configuration is invalid: ${result.error}`);
  for (const server of result.servers) {
    let secret: string;
    try {
      secret = await readSecretFile(server.clientSecretFile);
    } catch {
      throw new Error(`${RUN_MCP_SERVERS_FILE_ENV} server "${server.name}": cannot read ${server.clientSecretFile}`);
    }
    if (secret.trim() === "") {
      throw new Error(`${RUN_MCP_SERVERS_FILE_ENV} server "${server.name}": ${server.clientSecretFile} is empty`);
    }
  }
  return { status: "enabled", servers: result.servers.map((server) => server.name) };
}

export function runMcpServerApplies(
  server: RunMcpServerConfig,
  input: { companyId: string; agentUrlKey: string },
): boolean {
  return server.companyIds.has(input.companyId.trim().toLowerCase()) && server.agentUrlKeys.has(input.agentUrlKey);
}

/**
 * The run's MCP servers: this server's proxy route for each applicable entry,
 * with the run's own agent JWT as bearer. No upstream token is involved here.
 */
export function runMcpServersForRun(
  servers: readonly RunMcpServerConfig[],
  input: { companyId: string; agentUrlKey: string; runToken: string | null; apiBaseUrl: string | null },
): AdapterRuntimeMcpServer[] {
  if (!input.runToken || !input.apiBaseUrl) return [];
  const base = input.apiBaseUrl.replace(/\/+$/, "");
  return servers
    .filter((server) => runMcpServerApplies(server, input))
    .map((server) => ({
      name: server.name,
      url: `${base}${RUN_MCP_ROUTE_PREFIX}${server.name}`,
      token: input.runToken!,
      connectionId: `run-mcp:${server.name}`,
    }));
}

export type RunMcpTokenDeps = {
  fetch?: typeof fetch;
  readSecretFile?: (file: string) => Promise<string>;
  timeoutMs?: number;
  now?: () => number;
};

/** RFC 6749 §2.3.1: form-encode both parts before Basic encoding. */
function basicCredentials(clientId: string, secret: string): string {
  const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
  return Buffer.from(`${encode(clientId)}:${encode(secret)}`).toString("base64");
}

export type RunMcpTokenResult = { token: string; expiresInSeconds: number } | { reason: string };

export async function requestRunMcpToken(server: RunMcpServerConfig, deps: RunMcpTokenDeps = {}): Promise<RunMcpTokenResult> {
  const readSecretFile = deps.readSecretFile ?? ((file: string) => readFile(file, "utf8"));
  let secret: string;
  try {
    // Read per request so a rotated Secret is picked up without a restart.
    secret = (await readSecretFile(server.clientSecretFile)).trim();
  } catch {
    return { reason: "client_secret_unavailable" };
  }
  if (!secret) return { reason: "client_secret_unavailable" };
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(server.tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicCredentials(server.clientId, secret)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: server.scopes.join(" ") }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs ?? TOKEN_TIMEOUT_MS),
    });
  } catch {
    return { reason: "token_endpoint_unreachable" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { reason: `token_endpoint_status_${response.status}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { reason: "token_response_invalid" };
  }
  if (
    !isRecord(body) ||
    typeof body.access_token !== "string" ||
    !body.access_token ||
    typeof body.token_type !== "string" ||
    body.token_type.toLowerCase() !== "bearer"
  ) {
    return { reason: "token_response_invalid" };
  }
  // Without the requested scope (for example, the grant was revoked) the
  // upstream would only answer 403.
  if (typeof body.scope === "string") {
    const granted = new Set(body.scope.split(/\s+/));
    if (!server.scopes.every((scope) => granted.has(scope))) return { reason: "scope_not_granted" };
  }
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : DEFAULT_EXPIRES_IN_SECONDS;
  return { token: body.access_token, expiresInSeconds: expiresIn };
}

/**
 * The server's upstream access token per configured server: obtained on first
 * use, refreshed before expiry, one request in flight at a time. It is the
 * server's credential and never leaves this process.
 */
export function createRunMcpTokenCache(deps: RunMcpTokenDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const cached = new Map<string, { token: string; refreshAt: number }>();
  const pending = new Map<string, Promise<RunMcpTokenResult>>();
  return {
    async get(server: RunMcpServerConfig): Promise<RunMcpTokenResult> {
      const hit = cached.get(server.name);
      if (hit && now() < hit.refreshAt) return { token: hit.token, expiresInSeconds: (hit.refreshAt - now()) / 1000 };
      let flight = pending.get(server.name);
      if (!flight) {
        flight = requestRunMcpToken(server, deps).then((result) => {
          if ("token" in result) {
            const margin = Math.min(REFRESH_MARGIN_SECONDS, result.expiresInSeconds / 2);
            cached.set(server.name, { token: result.token, refreshAt: now() + (result.expiresInSeconds - margin) * 1000 });
          } else {
            cached.delete(server.name);
          }
          return result;
        }).finally(() => pending.delete(server.name));
        pending.set(server.name, flight);
      }
      return flight;
    },
    /** Drop a token the upstream rejected; the next request obtains a new one. */
    invalidate(server: RunMcpServerConfig, token: string) {
      if (cached.get(server.name)?.token === token) cached.delete(server.name);
    },
  };
}

let cachedServers: readonly RunMcpServerConfig[] | null = null;

/**
 * Servers configured for this process. The startup check has already validated
 * the file (a ConfigMap change restarts the pod); an invalid file read later
 * yields no servers rather than failing runs.
 */
export function configuredRunMcpServers(env: NodeJS.ProcessEnv = process.env): readonly RunMcpServerConfig[] {
  if (cachedServers === null) {
    const result = readRunMcpServersConfig(env);
    cachedServers = result.status === "enabled" ? result.servers : [];
  }
  return cachedServers;
}

export function resetRunMcpServersCacheForTests(): void {
  cachedServers = null;
}
