import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createProcessMetricsRegistry,
  processMetricsConfigFromEnv,
  readProcRssBytes,
  startProcessMetricsServer,
} from "./process-metrics.js";

describe("process metrics", () => {
  it("is off unless PAPERCLIP_METRICS_PORT is set", () => {
    expect(processMetricsConfigFromEnv({})).toBeNull();
    expect(processMetricsConfigFromEnv({ PAPERCLIP_METRICS_PORT: "9464" })).toEqual({ port: 9464, host: "0.0.0.0" });
    expect(processMetricsConfigFromEnv({ PAPERCLIP_METRICS_PORT: "9464", PAPERCLIP_METRICS_HOST: "127.0.0.1" }))
      .toEqual({ port: 9464, host: "127.0.0.1" });
    expect(() => processMetricsConfigFromEnv({ PAPERCLIP_METRICS_PORT: "nope" })).toThrow(/PAPERCLIP_METRICS_PORT/);
    expect(() => processMetricsConfigFromEnv({ PAPERCLIP_METRICS_PORT: "70000" })).toThrow(/PAPERCLIP_METRICS_PORT/);
  });

  it("exports Node memory, plugin worker RSS and transfer limiter metrics", async () => {
    const registry = createProcessMetricsRegistry({
      pluginWorkers: () => [
        { pluginId: "kubernetes", pid: 101 },
        { pluginId: "stopped", pid: null },
        { pluginId: "exited", pid: 103 },
      ],
      readProcessRssBytes: async (pid) => (pid === 101 ? 256 * 1024 * 1024 : null),
      sandboxTransfers: () => ({ concurrency: 4, active: 3, queued: 9 }),
    });
    const text = await registry.metrics();

    for (const name of [
      "process_resident_memory_bytes",
      "nodejs_heap_size_used_bytes",
      "nodejs_heap_size_total_bytes",
      "nodejs_external_memory_bytes",
      "nodejs_eventloop_lag_seconds",
      "nodejs_array_buffers_bytes",
    ]) {
      expect(text).toMatch(new RegExp(`^${name} \\d`, "m"));
    }
    expect(text).toContain(`paperclip_plugin_worker_resident_memory_bytes{plugin_id="kubernetes"} ${256 * 1024 * 1024}`);
    expect(text).not.toContain('plugin_id="stopped"');
    expect(text).not.toContain('plugin_id="exited"');
    expect(text).toMatch(/^paperclip_sandbox_transfers_active 3$/m);
    expect(text).toMatch(/^paperclip_sandbox_transfers_queued 9$/m);
    expect(text).toMatch(/^paperclip_sandbox_transfers_limit 4$/m);
  });

  it.runIf(process.platform === "linux")("reads this process's RSS from /proc", async () => {
    const rss = await readProcRssBytes(process.pid);
    expect(rss).toBeGreaterThan(0);
    expect(await readProcRssBytes(2 ** 22 + 12_345)).toBeNull();
  });

  it("serves /metrics on its own listener and nothing else", async () => {
    const server = await startProcessMetricsServer({
      config: { port: 0, host: "127.0.0.1" },
      sources: { sandboxTransfers: () => ({ concurrency: 2, active: 1, queued: 0 }) },
    });
    try {
      const { port } = server.address() as AddressInfo;
      const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get("content-type")).toContain("text/plain");
      expect(await metrics.text()).toMatch(/^paperclip_sandbox_transfers_active 1$/m);

      expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: "POST" })).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
