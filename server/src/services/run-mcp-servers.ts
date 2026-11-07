import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterRuntimeMcpServer } from "../adapters/index.js";

/**
 * Operator-configured MCP servers that agent runs reach directly, each with a
 * bearer token the server obtains for that run (OAuth 2.0 client credentials).
 *
 * PAPERCLIP_RUN_MCP_SERVERS_FILE names a JSON file:
 *   { "servers": [ { "name", "url", "companyIds", "agentIds"?, "tokenUrl",
 *                    "clientId", "clientSecretFile", "scope" } ] }
 *
 * Only the server reads the client secret (its own file, normally a mounted
 * Secret). Each run of a listed company (and agent, when `agentIds` is set)
 * gets a fresh access token in its MCP config, so the agent holds only that
 * token, for that token's lifetime. When a token cannot be obtained the run
 * starts without that server; the reason is logged, never a token or response.
 * An invalid file refuses startup.
 */
export const RUN_MCP_SERVERS_FILE_ENV = "PAPERCLIP_RUN_MCP_SERVERS_FILE";

export type RunMcpServerConfig = {
  name: string;
  url: string;
  companyIds: ReadonlySet<string>;
  /** null: every agent of the listed companies. */
  agentIds: ReadonlySet<string> | null;
  tokenUrl: string;
  clientId: string;
  clientSecretFile: string;
  scopes: readonly string[];
};

export type RunMcpServersConfigResult =
  | { status: "disabled" }
  | { status: "invalid"; error: string }
  | { status: "enabled"; servers: readonly RunMcpServerConfig[] };

const ENTRY_KEYS = new Set([
  "name",
  "url",
  "companyIds",
  "agentIds",
  "tokenUrl",
  "clientId",
  "clientSecretFile",
  "scope",
]);
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const TOKEN_TIMEOUT_MS = 10_000;

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

function uuidSet(value: unknown): Set<string> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = value.map((id) => (typeof id === "string" ? id.trim().toLowerCase() : ""));
  return ids.every((id) => UUID.test(id)) ? new Set(ids) : null;
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
    const companyIds = uuidSet(entry.companyIds);
    if (!companyIds) return invalid(`${at}.companyIds must list company UUIDs`);
    let agentIds: Set<string> | null = null;
    if (entry.agentIds !== undefined && entry.agentIds !== null) {
      agentIds = uuidSet(entry.agentIds);
      if (!agentIds) return invalid(`${at}.agentIds must list agent UUIDs, or be omitted for every agent`);
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
    servers.push({ name, url, companyIds, agentIds, tokenUrl, clientId, clientSecretFile, scopes });
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
  input: { companyId: string; agentId: string },
): boolean {
  return (
    server.companyIds.has(input.companyId.trim().toLowerCase()) &&
    (server.agentIds === null || server.agentIds.has(input.agentId.trim().toLowerCase()))
  );
}

export type RunMcpServerUnavailable = { name: string; reason: string };

export type RunMcpTokenDeps = {
  fetch?: typeof fetch;
  readSecretFile?: (file: string) => Promise<string>;
  timeoutMs?: number;
};

/** RFC 6749 §2.3.1: form-encode both parts before Basic encoding. */
function basicCredentials(clientId: string, secret: string): string {
  const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
  return Buffer.from(`${encode(clientId)}:${encode(secret)}`).toString("base64");
}

async function requestToken(
  server: RunMcpServerConfig,
  deps: RunMcpTokenDeps,
): Promise<{ token: string } | { reason: string }> {
  const readSecretFile = deps.readSecretFile ?? ((file: string) => readFile(file, "utf8"));
  let secret: string;
  try {
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
  // A token without the requested scope (for example, the operator revoked the
  // grant) would only produce 403s; leave the server out instead.
  if (typeof body.scope === "string") {
    const granted = new Set(body.scope.split(/\s+/));
    if (!server.scopes.every((scope) => granted.has(scope))) return { reason: "scope_not_granted" };
  }
  return { token: body.access_token };
}

/** Obtain one run-scoped token per applicable server. Never throws for a single server. */
export async function mintRunMcpServers(
  servers: readonly RunMcpServerConfig[],
  input: { companyId: string; agentId: string },
  deps: RunMcpTokenDeps = {},
): Promise<{ servers: AdapterRuntimeMcpServer[]; unavailable: RunMcpServerUnavailable[] }> {
  const minted: AdapterRuntimeMcpServer[] = [];
  const unavailable: RunMcpServerUnavailable[] = [];
  for (const server of servers) {
    if (!runMcpServerApplies(server, input)) continue;
    const result = await requestToken(server, deps);
    if ("token" in result) {
      minted.push({ name: server.name, url: server.url, token: result.token, connectionId: `run-mcp:${server.name}` });
    } else {
      unavailable.push({ name: server.name, reason: result.reason });
    }
  }
  return { servers: minted, unavailable };
}

let cachedServers: readonly RunMcpServerConfig[] | null = null;

/**
 * Servers configured for this process. The startup check has already validated
 * the file; an invalid file read later (it cannot change without a restart in
 * a ConfigMap deployment) yields no servers rather than failing runs.
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
