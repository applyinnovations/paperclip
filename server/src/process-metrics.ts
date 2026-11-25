/**
 * Opt-in Prometheus endpoint for the server's own process metrics.
 *
 * Set `PAPERCLIP_METRICS_PORT` to serve `GET /metrics` on a separate listener
 * (host `PAPERCLIP_METRICS_HOST`, default `0.0.0.0`). It is a separate port so
 * the scrape target never goes through the app's ingress, auth, or request
 * logging. With the port unset nothing listens and nothing is collected.
 *
 * What it exports, and why:
 * - Node default metrics (heap used/total, external, RSS, event-loop lag, GC,
 *   handles), so a memory step can be told apart as heap or off-heap.
 * - `nodejs_array_buffers_bytes`, the share of external memory held by
 *   `ArrayBuffer`s and `Buffer`s, where streamed transfer data shows up.
 * - `paperclip_plugin_worker_resident_memory_bytes`, the RSS of each plugin
 *   worker child process. Sandbox providers run transfers in those workers, so
 *   their memory counts against the container but not this process's RSS.
 * - `paperclip_sandbox_transfers_*`, the transfer limiter's active and queued
 *   counts and its cap.
 * - `paperclip_board_items_resolved_stale{company,company_id}`, open
 *   user-assigned issues idle for more than N days whose links (PRs, blockers)
 *   have all resolved: board items that should have closed or gone back to an
 *   agent (APP-527). See `services/board-item-metrics.ts`. Only exported when
 *   the server passes a source for it, and cached between scrapes.
 *
 * No label carries user or issue data. Plugin workers are labelled by their
 * plugin id; the board item gauge by company issue prefix and id.
 */
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { Gauge, Registry, collectDefaultMetrics } from "@prometheus-io/client";
import { getSandboxTransferLimiter, type SandboxTransferLimiterSnapshot } from "./services/sandbox-transfer-limiter.js";
import type { ResolvedStaleBoardItemCount } from "./services/board-item-metrics.js";

export interface PluginWorkerProcessInfo {
  pluginId: string;
  pid: number | null;
}

export interface ProcessMetricsSources {
  pluginWorkers?: () => readonly PluginWorkerProcessInfo[];
  sandboxTransfers?: () => SandboxTransferLimiterSnapshot;
  /** Reads a process's resident set size in bytes, or null when it is gone. */
  readProcessRssBytes?: (pid: number) => Promise<number | null>;
  /** Per-company counts of resolved stale board items; expected to be cached by the caller. */
  resolvedStaleBoardItems?: () => Promise<readonly ResolvedStaleBoardItemCount[]>;
  /** Called when a database-backed source fails; the scrape still succeeds without that metric. */
  onSourceError?: (metric: string, error: unknown) => void;
}

export interface ProcessMetricsServerConfig {
  port: number;
  host: string;
}

export function processMetricsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ProcessMetricsServerConfig | null {
  const raw = env.PAPERCLIP_METRICS_PORT?.trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PAPERCLIP_METRICS_PORT must be a TCP port number, got "${raw}"`);
  }
  return { port, host: env.PAPERCLIP_METRICS_HOST?.trim() || "0.0.0.0" };
}

/** Linux only: `VmRSS` from `/proc/<pid>/status`. */
export async function readProcRssBytes(pid: number): Promise<number | null> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

export function createProcessMetricsRegistry(sources: ProcessMetricsSources = {}): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  new Gauge({
    name: "nodejs_array_buffers_bytes",
    help: "Memory allocated for ArrayBuffers and SharedArrayBuffers, including Node.js Buffers, in bytes.",
    registers: [registry],
    collect() {
      this.set(process.memoryUsage().arrayBuffers);
    },
  });

  const readRss = sources.readProcessRssBytes ?? readProcRssBytes;
  const pluginWorkers = sources.pluginWorkers;
  if (pluginWorkers) {
    new Gauge({
      name: "paperclip_plugin_worker_resident_memory_bytes",
      help: "Resident set size of each running plugin worker child process, in bytes.",
      labelNames: ["plugin_id"],
      registers: [registry],
      async collect() {
        this.reset();
        await Promise.all(pluginWorkers().map(async (worker) => {
          if (worker.pid === null) return;
          const rss = await readRss(worker.pid);
          if (rss !== null) this.set({ plugin_id: worker.pluginId }, rss);
        }));
      },
    });
  }

  const transfers = sources.sandboxTransfers;
  if (transfers) {
    const gauge = (name: string, help: string, pick: (snapshot: SandboxTransferLimiterSnapshot) => number) =>
      new Gauge({
        name,
        help,
        registers: [registry],
        collect() {
          this.set(pick(transfers()));
        },
      });
    gauge("paperclip_sandbox_transfers_active", "Native sandbox file transfers running now.", (s) => s.active);
    gauge("paperclip_sandbox_transfers_queued", "Native sandbox file transfers waiting for a slot.", (s) => s.queued);
    gauge("paperclip_sandbox_transfers_limit", "Maximum native sandbox file transfers that run at once.", (s) => s.concurrency);
  }

  const resolvedStaleBoardItems = sources.resolvedStaleBoardItems;
  if (resolvedStaleBoardItems) {
    const name = "paperclip_board_items_resolved_stale";
    new Gauge({
      name,
      help: "Open user-assigned issues not updated for more than the stale threshold whose linked PRs and blockers have all resolved.",
      labelNames: ["company", "company_id"],
      registers: [registry],
      async collect() {
        this.reset();
        try {
          for (const row of await resolvedStaleBoardItems()) {
            this.set({ company: row.issuePrefix, company_id: row.companyId }, row.count);
          }
        } catch (error) {
          // A database hiccup drops this series for one scrape; it must not
          // fail the whole endpoint and hide the process metrics with it.
          sources.onSourceError?.(name, error);
        }
      },
    });
  }

  return registry;
}

export async function startProcessMetricsServer(input: {
  config: ProcessMetricsServerConfig;
  sources?: ProcessMetricsSources;
}): Promise<Server> {
  const registry = createProcessMetricsRegistry({
    sandboxTransfers: () => getSandboxTransferLimiter().snapshot(),
    ...input.sources,
  });
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "GET" || path !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    registry.metrics().then(
      (body) => {
        res.writeHead(200, { "Content-Type": registry.contentType }).end(body);
      },
      (error: unknown) => {
        res.writeHead(500, { "Content-Type": "text/plain" }).end(
          error instanceof Error ? error.message : "metrics collection failed",
        );
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.config.port, input.config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // The metrics listener never holds the process open during shutdown.
  server.unref();
  return server;
}
