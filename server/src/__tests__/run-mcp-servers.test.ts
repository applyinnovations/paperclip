import { describe, expect, it, vi } from "vitest";
import {
  checkRunMcpServersConfigAtStartup,
  mintRunMcpServers,
  parseRunMcpServersFile,
  readRunMcpServersConfig,
  type RunMcpServerConfig,
} from "../services/run-mcp-servers.js";

const APPLY = "a9d886a3-e526-461c-95d6-d2d0d6b6c722";
const CALILE = "0b6f3c0e-1c1d-4c39-9d43-6a3f9d1c2e01";
const AGENT = "7c2a5d4e-8f60-4b1a-a3c2-1d9e8f7a6b55";
const OTHER_AGENT = "1d9e8f7a-6b55-4b1a-a3c2-7c2a5d4e8f60";
const SECRET_FILE = "/var/run/paperclip-run-mcp/grafana/client-secret";
const SECRET = "synthetic client secret/with+reserved:chars";
const CONFIG_PATH = "/etc/paperclip-run-mcp-servers/servers.json";

const GRAFANA = {
  name: "grafana",
  url: "http://grafana-mcp-agents.grafana-mcp.svc.cluster.local:8080/mcp",
  companyIds: [APPLY],
  tokenUrl: "https://id.xlab.now/realms/xlab/protocol/openid-connect/token",
  clientId: "paperclip-agents",
  clientSecretFile: SECRET_FILE,
  scope: "read:agent-telemetry",
};

function servers(entry: Record<string, unknown> = GRAFANA): readonly RunMcpServerConfig[] {
  const result = parseRunMcpServersFile({ servers: [entry] });
  if (result.status !== "enabled") throw new Error(result.status === "invalid" ? result.error : "disabled");
  return result.servers;
}

function tokenResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("run MCP server configuration", () => {
  it("is disabled unless the file variable is set", () => {
    expect(readRunMcpServersConfig({})).toEqual({ status: "disabled" });
  });

  it("parses a valid file", () => {
    const [server] = servers({ ...GRAFANA, agentIds: [AGENT.toUpperCase()] });
    expect(server).toMatchObject({ name: "grafana", clientId: "paperclip-agents", scopes: ["read:agent-telemetry"] });
    expect(server.companyIds.has(APPLY)).toBe(true);
    expect(server.agentIds?.has(AGENT)).toBe(true);
  });

  it.each([
    ["unknown key", { ...GRAFANA, clientSecret: SECRET }, "unknown key"],
    ["plaintext token endpoint", { ...GRAFANA, tokenUrl: "http://id.xlab.now/token" }, "tokenUrl"],
    ["credentials in URL", { ...GRAFANA, url: "http://user:pass@grafana.invalid/mcp" }, "url"],
    ["query in URL", { ...GRAFANA, url: "http://grafana.invalid/mcp?token=x" }, "url"],
    ["relative secret file", { ...GRAFANA, clientSecretFile: "client-secret" }, "clientSecretFile"],
    ["no companies", { ...GRAFANA, companyIds: [] }, "companyIds"],
    ["malformed agent", { ...GRAFANA, agentIds: ["agent-1"] }, "agentIds"],
    ["empty scope", { ...GRAFANA, scope: " " }, "scope"],
    ["bad name", { ...GRAFANA, name: "Grafana MCP" }, "name"],
  ])("rejects %s", (_label, entry, field) => {
    const result = parseRunMcpServersFile({ servers: [entry] });
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.error).toContain(field);
  });

  it("rejects duplicate names and empty lists", () => {
    expect(parseRunMcpServersFile({ servers: [GRAFANA, GRAFANA] }).status).toBe("invalid");
    expect(parseRunMcpServersFile({ servers: [] }).status).toBe("invalid");
  });

  it("fails startup on an invalid file or unreadable or empty secret, without printing the secret", async () => {
    const env = { PAPERCLIP_RUN_MCP_SERVERS_FILE: CONFIG_PATH };
    const readConfigFile = () => JSON.stringify({ servers: [GRAFANA] });
    await expect(checkRunMcpServersConfigAtStartup(env, { readConfigFile, readSecretFile: async () => SECRET }))
      .resolves.toEqual({ status: "enabled", servers: ["grafana"] });
    await expect(checkRunMcpServersConfigAtStartup(env, { readConfigFile: () => "{", readSecretFile: async () => SECRET }))
      .rejects.toThrow("not valid JSON");
    await expect(checkRunMcpServersConfigAtStartup(env, { readConfigFile, readSecretFile: async () => "\n" }))
      .rejects.toThrow("is empty");
    const failure = checkRunMcpServersConfigAtStartup(env, {
      readConfigFile,
      readSecretFile: async () => { throw new Error(SECRET); },
    });
    await expect(failure).rejects.toThrow(`cannot read ${SECRET_FILE}`);
    await expect(failure).rejects.not.toThrow(SECRET);
  });
});

describe("run-scoped MCP server tokens", () => {
  const readSecretFile = async () => `${SECRET}\n`;

  it("requests a client-credentials token with Basic auth and returns a run MCP server", async () => {
    const fetch = vi.fn(async () => tokenResponse({ access_token: "run-token", token_type: "Bearer", scope: "read:agent-telemetry", expires_in: 3600 }));
    const result = await mintRunMcpServers(servers(), { companyId: APPLY, agentId: AGENT }, { fetch, readSecretFile });
    expect(result).toEqual({
      servers: [{ name: "grafana", url: GRAFANA.url, token: "run-token", connectionId: "run-mcp:grafana" }],
      unavailable: [],
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GRAFANA.tokenUrl);
    expect(init.redirect).toBe("error");
    expect(new URLSearchParams(String(init.body))).toEqual(new URLSearchParams({ grant_type: "client_credentials", scope: "read:agent-telemetry" }));
    const basic = Buffer.from(String((init.headers as Record<string, string>).Authorization).slice(6), "base64").toString();
    const [id, secret] = basic.split(":").map((part) => decodeURIComponent(part.replace(/\+/g, " ")));
    expect([id, secret]).toEqual(["paperclip-agents", SECRET]);
    expect(String(init.body)).not.toContain("secret");
  });

  it("gives a new token to each run", async () => {
    let n = 0;
    const fetch = vi.fn(async () => tokenResponse({ access_token: `run-token-${++n}`, token_type: "bearer" }));
    const first = await mintRunMcpServers(servers(), { companyId: APPLY, agentId: AGENT }, { fetch, readSecretFile });
    const second = await mintRunMcpServers(servers(), { companyId: APPLY, agentId: AGENT }, { fetch, readSecretFile });
    expect([first.servers[0].token, second.servers[0].token]).toEqual(["run-token-1", "run-token-2"]);
  });

  it("skips other companies and unlisted agents without contacting the token endpoint", async () => {
    const fetch = vi.fn();
    const restricted = servers({ ...GRAFANA, agentIds: [AGENT] });
    for (const input of [{ companyId: CALILE, agentId: AGENT }, { companyId: APPLY, agentId: OTHER_AGENT }]) {
      expect(await mintRunMcpServers(restricted, input, { fetch, readSecretFile })).toEqual({ servers: [], unavailable: [] });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["unreachable endpoint", async () => { throw new TypeError("fetch failed"); }, "token_endpoint_unreachable"],
    ["rejected client", async () => tokenResponse({ error: "unauthorized_client", error_description: SECRET }, 401), "token_endpoint_status_401"],
    ["not JSON", async () => new Response("<html>", { status: 200 }), "token_response_invalid"],
    ["no token", async () => tokenResponse({ token_type: "Bearer" }), "token_response_invalid"],
    ["not a bearer token", async () => tokenResponse({ access_token: "x", token_type: "DPoP" }), "token_response_invalid"],
    ["scope not granted", async () => tokenResponse({ access_token: "x", token_type: "Bearer", scope: "profile" }), "scope_not_granted"],
  ])("leaves the server out when the token request fails: %s", async (_label, fetch, reason) => {
    const result = await mintRunMcpServers(servers(), { companyId: APPLY, agentId: AGENT }, { fetch: fetch as typeof globalThis.fetch, readSecretFile });
    expect(result).toEqual({ servers: [], unavailable: [{ name: "grafana", reason }] });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("leaves the server out when the client secret is unreadable or empty", async () => {
    const fetch = vi.fn();
    for (const read of [async () => { throw new Error("ENOENT"); }, async () => " \n"]) {
      const result = await mintRunMcpServers(servers(), { companyId: APPLY, agentId: AGENT }, { fetch, readSecretFile: read });
      expect(result.unavailable).toEqual([{ name: "grafana", reason: "client_secret_unavailable" }]);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
