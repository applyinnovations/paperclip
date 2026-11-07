import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { runMcpRoutes } from "../routes/run-mcp.js";
import {
  checkRunMcpServersConfigAtStartup,
  createRunMcpTokenCache,
  parseRunMcpServersFile,
  readRunMcpServersConfig,
  requestRunMcpToken,
  runMcpServersForRun,
  type RunMcpServerConfig,
} from "../services/run-mcp-servers.js";

const APPLY = "a9d886a3-e526-461c-95d6-d2d0d6b6c722";
const CALILE = "0b6f3c0e-1c1d-4c39-9d43-6a3f9d1c2e01";
const AGENT = "7c2a5d4e-8f60-4b1a-a3c2-1d9e8f7a6b55";
const RUN = "1d9e8f7a-6b55-4b1a-a3c2-7c2a5d4e8f60";
const SECRET_FILE = "/var/run/paperclip-run-mcp/grafana/client-secret";
const SECRET = "synthetic client secret/with+reserved:chars";
const CONFIG_PATH = "/etc/paperclip-run-mcp-servers/servers.json";
const UPSTREAM = "http://grafana-mcp-agents.grafana-mcp.svc.cluster.local:8080/mcp";

const GRAFANA = {
  name: "grafana",
  url: UPSTREAM,
  companyIds: [APPLY],
  agents: ["engineer", "cycle-time-engineer"],
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

const readSecretFile = async () => `${SECRET}\n`;

describe("run MCP server configuration", () => {
  it("is disabled unless the file variable is set", () => {
    expect(readRunMcpServersConfig({})).toEqual({ status: "disabled" });
  });

  it("parses agent URL keys", () => {
    const [server] = servers();
    expect([...server.agentUrlKeys]).toEqual(["engineer", "cycle-time-engineer"]);
    expect(server.companyIds.has(APPLY)).toBe(true);
  });

  it.each([
    ["unknown key", { ...GRAFANA, clientSecret: SECRET }, "unknown key"],
    ["agent IDs instead of keys", { ...GRAFANA, agentIds: [AGENT] }, "unknown key"],
    ["missing allowlist", { ...GRAFANA, agents: undefined }, "agents"],
    ["empty allowlist", { ...GRAFANA, agents: [] }, "agents"],
    ["agent name instead of key", { ...GRAFANA, agents: ["Cycle Time Engineer"] }, "agents"],
    ["plaintext token endpoint", { ...GRAFANA, tokenUrl: "http://id.xlab.now/token" }, "tokenUrl"],
    ["credentials in URL", { ...GRAFANA, url: "http://user:pass@grafana.invalid/mcp" }, "url"],
    ["relative secret file", { ...GRAFANA, clientSecretFile: "client-secret" }, "clientSecretFile"],
    ["no companies", { ...GRAFANA, companyIds: [] }, "companyIds"],
    ["empty scope", { ...GRAFANA, scope: " " }, "scope"],
    ["bad name", { ...GRAFANA, name: "Grafana MCP" }, "name"],
  ])("rejects %s", (_label, entry, field) => {
    const result = parseRunMcpServersFile({ servers: [entry] });
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.error).toContain(field);
  });

  it("fails startup on an invalid file or unreadable or empty secret, without printing the secret", async () => {
    const env = { PAPERCLIP_RUN_MCP_SERVERS_FILE: CONFIG_PATH };
    const readConfigFile = () => JSON.stringify({ servers: [GRAFANA] });
    await expect(checkRunMcpServersConfigAtStartup(env, { readConfigFile, readSecretFile }))
      .resolves.toEqual({ status: "enabled", servers: ["grafana"] });
    await expect(checkRunMcpServersConfigAtStartup(env, { readConfigFile: () => "{", readSecretFile })).rejects.toThrow("not valid JSON");
    await expect(checkRunMcpServersConfigAtStartup(env, { readConfigFile, readSecretFile: async () => "\n" })).rejects.toThrow("is empty");
    const failure = checkRunMcpServersConfigAtStartup(env, { readConfigFile, readSecretFile: async () => { throw new Error(SECRET); } });
    await expect(failure).rejects.toThrow(`cannot read ${SECRET_FILE}`);
    await expect(failure).rejects.not.toThrow(SECRET);
  });
});

describe("run MCP servers for a run", () => {
  it("points allowed agents at the proxy with the run token, never an upstream token", () => {
    const result = runMcpServersForRun(servers(), { companyId: APPLY, agentUrlKey: "cycle-time-engineer", runToken: "run-jwt", apiBaseUrl: "http://paperclip:3100/" });
    expect(result).toEqual([{ name: "grafana", url: "http://paperclip:3100/api/run-mcp/grafana", token: "run-jwt", connectionId: "run-mcp:grafana" }]);
  });

  it.each([
    ["other company", { companyId: CALILE, agentUrlKey: "engineer" }],
    ["agent not allowlisted", { companyId: APPLY, agentUrlKey: "ceo" }],
  ])("adds nothing for %s", (_label, input) => {
    expect(runMcpServersForRun(servers(), { ...input, runToken: "run-jwt", apiBaseUrl: "http://paperclip:3100" })).toEqual([]);
  });

  it("adds nothing without a run token or API URL", () => {
    const input = { companyId: APPLY, agentUrlKey: "engineer" };
    expect(runMcpServersForRun(servers(), { ...input, runToken: null, apiBaseUrl: "http://paperclip:3100" })).toEqual([]);
    expect(runMcpServersForRun(servers(), { ...input, runToken: "run-jwt", apiBaseUrl: null })).toEqual([]);
  });
});

describe("upstream token", () => {
  it("uses client credentials with Basic auth", async () => {
    const fetch = vi.fn(async () => tokenResponse({ access_token: "up-token", token_type: "Bearer", scope: "read:agent-telemetry", expires_in: 900 }));
    expect(await requestRunMcpToken(servers()[0], { fetch, readSecretFile })).toEqual({ token: "up-token", expiresInSeconds: 900 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GRAFANA.tokenUrl);
    expect(init.redirect).toBe("error");
    expect(new URLSearchParams(String(init.body))).toEqual(new URLSearchParams({ grant_type: "client_credentials", scope: "read:agent-telemetry" }));
    const basic = Buffer.from(String((init.headers as Record<string, string>).Authorization).slice(6), "base64").toString();
    expect(basic.split(":").map((part) => decodeURIComponent(part.replace(/\+/g, " ")))).toEqual(["paperclip-agents", SECRET]);
  });

  it.each([
    ["unreachable endpoint", async () => { throw new TypeError("fetch failed"); }, "token_endpoint_unreachable"],
    ["rejected client", async () => tokenResponse({ error: "unauthorized_client", error_description: SECRET }, 401), "token_endpoint_status_401"],
    ["not JSON", async () => new Response("<html>", { status: 200 }), "token_response_invalid"],
    ["not a bearer token", async () => tokenResponse({ access_token: "x", token_type: "DPoP" }), "token_response_invalid"],
    ["scope not granted", async () => tokenResponse({ access_token: "x", token_type: "Bearer", scope: "profile" }), "scope_not_granted"],
  ])("reports a reason code when %s", async (_label, fetch, reason) => {
    const result = await requestRunMcpToken(servers()[0], { fetch: fetch as typeof globalThis.fetch, readSecretFile });
    expect(result).toEqual({ reason });
  });

  it("is cached, refreshed before expiry, requested once at a time, and dropped when rejected", async () => {
    let now = 0;
    let n = 0;
    const fetch = vi.fn(async () => tokenResponse({ access_token: `up-${++n}`, token_type: "Bearer", expires_in: 900 }));
    const cache = createRunMcpTokenCache({ fetch, readSecretFile, now: () => now });
    const [server] = servers();
    const both = await Promise.all([cache.get(server), cache.get(server)]);
    expect(both.map((r) => "token" in r && r.token)).toEqual(["up-1", "up-1"]);
    now = 839_000; // 900 s lifetime, refreshed 60 s early
    expect(await cache.get(server)).toMatchObject({ token: "up-1" });
    now = 841_000;
    expect(await cache.get(server)).toMatchObject({ token: "up-2" });
    cache.invalidate(server, "up-2");
    expect(await cache.get(server)).toMatchObject({ token: "up-3" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("run MCP proxy route", () => {
  function app(options: {
    actor?: Record<string, unknown>;
    run?: { status: string; agentName: string } | null;
    upstream?: (url: string, init: RequestInit) => Promise<Response>;
    token?: { token: string; expiresInSeconds: number } | { reason: string };
  } = {}) {
    const upstream = vi.fn(options.upstream ?? (async () => new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "s1" } })));
    const invalidate = vi.fn();
    const tokens = { get: vi.fn(async () => options.token ?? { token: "up-token", expiresInSeconds: 600 }), invalidate };
    const lookupRun = vi.fn(async () => (options.run === undefined ? { status: "running", agentName: "Cycle Time Engineer" } : options.run));
    const server = express();
    server.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
    server.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = options.actor ?? { type: "agent", source: "agent_jwt", agentId: AGENT, companyId: APPLY, runId: RUN };
      next();
    });
    server.use("/api", runMcpRoutes({} as never, { servers: () => servers(), tokens, lookupRun, fetch: upstream as unknown as typeof fetch }));
    return { server, upstream, tokens, lookupRun };
  }
  const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };

  it("forwards an allowed run's request with the server's token and only MCP headers", async () => {
    const { server, upstream } = app();
    const res = await request(server).post("/api/run-mcp/grafana")
      .set("Authorization", "Bearer run-jwt").set("Origin", "https://evil.invalid").set("Cookie", "session=x")
      .set("mcp-session-id", "s1").set("x-grafana-url", "http://attacker.invalid").set("Accept", "application/json, text/event-stream")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.headers["mcp-session-id"]).toBe("s1");
    expect(res.body).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(UPSTREAM);
    expect(init.headers).toEqual({ Authorization: "Bearer up-token", accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-session-id": "s1" });
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it("streams event-stream responses", async () => {
    const { server } = app({
      upstream: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: message\ndata: {\"id\":1}\n\n"));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const res = await request(server).get("/api/run-mcp/grafana").set("Accept", "text/event-stream").buffer(true).parse((r, done) => {
      let text = ""; r.on("data", (c: Buffer) => { text += c; }); r.on("end", () => done(null, text));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toBe("event: message\ndata: {\"id\":1}\n\n");
  });

  it.each([
    ["a board user", { actor: { type: "board", userId: "u" } }, 401],
    ["an agent API key", { actor: { type: "agent", source: "agent_key", agentId: AGENT, companyId: APPLY } }, 401],
    ["a finished run", { run: { status: "succeeded", agentName: "Cycle Time Engineer" } }, 403],
    ["another company's run", { run: null }, 403],
    ["an agent not on the allowlist", { run: { status: "running", agentName: "CEO" } }, 403],
  ])("refuses %s without contacting upstream", async (_label, options, status) => {
    const { server, upstream, tokens } = app(options as never);
    expect((await request(server).post("/api/run-mcp/grafana").send(body)).status).toBe(status);
    expect(upstream).not.toHaveBeenCalled();
    expect(tokens.get).not.toHaveBeenCalled();
  });

  it("returns 404 for an unconfigured server and 503 when the upstream credential is unavailable", async () => {
    expect((await request(app().server).post("/api/run-mcp/other").send(body)).status).toBe(404);
    const { server, upstream } = app({ token: { reason: "token_endpoint_unreachable" } });
    const res = await request(server).post("/api/run-mcp/grafana").send(body);
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("token_endpoint_unreachable");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("drops a token the upstream rejects", async () => {
    const { server, tokens } = app({ upstream: async () => new Response("", { status: 401 }) });
    expect((await request(server).post("/api/run-mcp/grafana").send(body)).status).toBe(401);
    expect(tokens.invalidate).toHaveBeenCalledWith(expect.objectContaining({ name: "grafana" }), "up-token");
  });
});
