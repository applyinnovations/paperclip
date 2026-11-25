/**
 * The quota check through the real @kubernetes/client-node request pipeline,
 * against a local HTTP API server. Stubbed clients skip the client's
 * middleware handling, which is where a wrongly shaped per-call middleware
 * fails, so these tests send real requests.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KubeConfig } from "@kubernetes/client-node";
import { makeKubeClients, type KubeClients } from "../../src/kube-client.js";
import { createQuotaGate, SandboxQuotaExceededError } from "../../src/quota.js";
import { SandboxCrTimeoutError, waitForSandboxReady } from "../../src/sandbox-cr-orchestrator.js";

const NS = "paperclip-acme";
const NAME = "pc-1";
const TOKEN = "test-token";
const QUOTA_PATH = `/api/v1/namespaces/${NS}/resourcequotas/paperclip-quota`;
const POD_PATH = `/api/v1/namespaces/${NS}/pods/${NAME}`;
const SANDBOX_PATH = `/apis/agents.x-k8s.io/v1beta1/namespaces/${NS}/sandboxes/${NAME}`;

const fullQuota = {
  apiVersion: "v1",
  kind: "ResourceQuota",
  metadata: { name: "paperclip-quota", namespace: NS },
  status: { hard: { pods: "16" }, used: { pods: "16" } },
};

type Route = "ok" | "missing" | "stall";

interface Fixture {
  clients: KubeClients;
  requests: Array<{ path: string; auth: string | undefined }>;
  /** Paths whose stalled request the client closed. */
  cancelled: string[];
  routes: { quota: Route; pod: Route };
}

let server: Server;
let fixture: Fixture;

beforeEach(async () => {
  const requests: Fixture["requests"] = [];
  const cancelled: string[] = [];
  const routes: Fixture["routes"] = { quota: "ok", pod: "missing" };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const answer = (req: IncomingMessage, res: ServerResponse, route: Route, body: unknown) => {
    if (route === "stall") {
      res.on("close", () => cancelled.push(req.url ?? ""));
      return;
    }
    if (route === "missing") json(res, 404, { kind: "Status", code: 404, reason: "NotFound" });
    else json(res, 200, body);
  };
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    requests.push({ path, auth: req.headers.authorization });
    if (path === SANDBOX_PATH) json(res, 200, { metadata: { name: NAME }, status: { phase: "Pending" } });
    else if (path === QUOTA_PATH) answer(req, res, routes.quota, fullQuota);
    else if (path === POD_PATH) answer(req, res, routes.pod, { kind: "Pod", metadata: { name: NAME } });
    else json(res, 404, { kind: "Status", code: 404 });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: "local", server: `http://127.0.0.1:${port}`, skipTLSVerify: true }],
    users: [{ name: "agent", token: TOKEN }],
    contexts: [{ name: "local", cluster: "local", user: "agent", namespace: NS }],
    currentContext: "local",
  });
  fixture = { clients: makeKubeClients(kc), requests, cancelled, routes };
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function gate(logger = { warn: vi.fn() }) {
  return createQuotaGate({ clients: fixture.clients, namespace: NS, sandboxName: NAME, demand: { pods: 1 }, logger });
}

describe("quota check with the real client", () => {
  it("reads the quota with the client's credentials and fails on the second poll when there is no pod", async () => {
    const logger = { warn: vi.fn() };
    const check = gate(logger);
    await expect(check()).resolves.toBeUndefined();
    await expect(check()).rejects.toBeInstanceOf(SandboxQuotaExceededError);
    expect(logger.warn).not.toHaveBeenCalled();
    const quotaReads = fixture.requests.filter((r) => r.path === QUOTA_PATH);
    expect(quotaReads).toHaveLength(2);
    expect(fixture.requests.filter((r) => r.path === POD_PATH)).toHaveLength(2);
    // Appending the signal middleware keeps the client's own authentication.
    for (const r of fixture.requests) expect(r.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("fails the readiness wait with the named quota error well before its deadline", async () => {
    const started = Date.now();
    const wait = waitForSandboxReady(fixture.clients, NS, NAME, { timeoutMs: 10_000, pollMs: 10, onPending: gate() });
    await expect(wait).rejects.toThrow(/quota paperclip-quota exhausted: pods 16\/16/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it.each(["quota", "pod"] as const)(
    "cancels a stalled %s request at the readiness deadline and times out on schedule",
    async (which) => {
      fixture.routes[which] = "stall";
      const logger = { warn: vi.fn() };
      const started = Date.now();
      const wait = waitForSandboxReady(fixture.clients, NS, NAME, { timeoutMs: 200, pollMs: 10, onPending: gate(logger) });
      await expect(wait).rejects.toBeInstanceOf(SandboxCrTimeoutError);
      expect(Date.now() - started).toBeLessThan(1_500);
      const stalledPath = which === "quota" ? QUOTA_PATH : POD_PATH;
      // The request was sent, then cancelled by the client, not left open.
      await vi.waitFor(() => expect(fixture.cancelled.some((p) => p.startsWith(stalledPath))).toBe(true), {
        timeout: 1_000,
      });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(fixture.requests.filter((r) => r.path === stalledPath)).toHaveLength(1);
    },
  );
});
