import { Readable } from "node:stream";
import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { deriveAgentUrlKey } from "@paperclipai/shared";
import { isHeartbeatRunTerminalStatus } from "../services/heartbeat/run-lifecycle.js";
import { logger } from "../middleware/logger.js";
import {
  configuredRunMcpServers,
  createRunMcpTokenCache,
  runMcpServerApplies,
  type RunMcpServerConfig,
} from "../services/run-mcp-servers.js";

/** MCP streamable-HTTP request headers forwarded upstream; nothing else (no Authorization, Origin or cookies). */
const REQUEST_HEADERS = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version"];

type RunLookup = (input: { runId: string; agentId: string; companyId: string }) =>
  Promise<{ status: string; agentName: string } | null>;

export type RunMcpRouteDeps = {
  servers?: () => readonly RunMcpServerConfig[];
  lookupRun?: RunLookup;
  tokens?: ReturnType<typeof createRunMcpTokenCache>;
  fetch?: typeof fetch;
};

function deny(res: Response, status: number, error: string) {
  res.status(status).json({ error });
}

/**
 * Proxy for PAPERCLIP_RUN_MCP_SERVERS_FILE servers. Mounted after actor
 * middleware. Only an agent run's own JWT authenticates; each request
 * rechecks that the run is still active and that its company and agent are
 * allowed, so access ends with the run and an allowlist change applies at once.
 */
export function runMcpRoutes(db: Db, deps: RunMcpRouteDeps = {}) {
  const router = Router();
  const servers = deps.servers ?? (() => configuredRunMcpServers());
  const tokens = deps.tokens ?? createRunMcpTokenCache({ fetch: deps.fetch });
  const upstreamFetch = deps.fetch ?? fetch;
  const lookupRun: RunLookup = deps.lookupRun ?? (async ({ runId, agentId, companyId }) => {
    const [row] = await db
      .select({ status: heartbeatRuns.status, agentName: agents.name })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.agentId, agentId),
        eq(heartbeatRuns.companyId, companyId),
        eq(agents.companyId, companyId),
      ))
      .limit(1);
    return row ?? null;
  });

  const handle = async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "agent" || actor.source !== "agent_jwt" || !actor.runId || !actor.agentId || !actor.companyId) {
      return deny(res, 401, "Run MCP servers require an agent run token");
    }
    const server = servers().find((candidate) => candidate.name === req.params.name);
    if (!server) return deny(res, 404, "Unknown MCP server");
    const row = await lookupRun({ runId: actor.runId, agentId: actor.agentId, companyId: actor.companyId });
    if (!row || isHeartbeatRunTerminalStatus(row.status)) return deny(res, 403, "The run is not active");
    const agentUrlKey = deriveAgentUrlKey(row.agentName, actor.agentId);
    if (!runMcpServerApplies(server, { companyId: actor.companyId, agentUrlKey })) {
      return deny(res, 403, "This agent may not use this MCP server");
    }
    const token = await tokens.get(server);
    if (!("token" in token)) {
      logger.warn({ companyId: actor.companyId, agentId: actor.agentId, runId: actor.runId, server: server.name, reason: token.reason }, "run MCP upstream token unavailable");
      return deny(res, 503, `Upstream credential unavailable (${token.reason})`);
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${token.token}` };
    for (const name of REQUEST_HEADERS) {
      const value = req.header(name);
      if (value) headers[name] = value;
    }
    let body: string | undefined;
    if (req.method === "POST") {
      const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
      body = raw ? raw.toString("utf8") : JSON.stringify(req.body ?? {});
      headers["content-type"] ??= "application/json";
    }
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    let upstream: globalThis.Response;
    try {
      upstream = await upstreamFetch(server.url, { method: req.method, headers, body, redirect: "error", signal: abort.signal });
    } catch {
      if (!res.headersSent) deny(res, 502, "Upstream MCP server unreachable");
      return;
    }
    if (upstream.status === 401) tokens.invalidate(server, token.token);
    logger.info({ companyId: actor.companyId, agentId: actor.agentId, runId: actor.runId, server: server.name, method: req.method, status: upstream.status }, "run MCP request");
    res.status(upstream.status);
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader("Cache-Control", "no-store");
    // Commit the head now: event streams must not be buffered for compression.
    res.flushHeaders();
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).on("error", () => res.destroy()).pipe(res);
  };
  // MCP streamable HTTP: POST messages, GET event stream, DELETE session.
  const guarded = (req: Request, res: Response) => handle(req, res).catch((error: unknown) => {
    logger.warn({ server: req.params.name, error: error instanceof Error ? error.name : "unknown" }, "run MCP proxy failed");
    if (!res.headersSent) deny(res, 500, "Run MCP proxy failed");
    else res.destroy();
  });
  router.post("/run-mcp/:name", guarded);
  router.get("/run-mcp/:name", guarded);
  router.delete("/run-mcp/:name", guarded);
  return router;
}
