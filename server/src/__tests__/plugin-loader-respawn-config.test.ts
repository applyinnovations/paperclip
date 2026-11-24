/**
 * APP-329: a plugin worker that crashes is respawned by the worker manager,
 * not by the loader, so it comes back with an empty bootstrap config. The
 * loader listens for every worker `ready` and replays each configured
 * company's current stored config to the respawned process, so company setup
 * resumes with no manual step. A loader-driven start is not replayed twice:
 * its own step 5b delivery covers it.
 *
 * Same fixture-package + mocked-registry setup as
 * plugin-loader-before-worker-start.test.ts; one test runs a real worker
 * process through the real worker manager and SIGKILLs it.
 */
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  listConfigs: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import { pluginLoader, type PluginRuntimeServices } from "../services/plugin-loader.js";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const PLUGIN_ID = "plugin-1";

const manifest = {
  id: "example.respawn-config-plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Respawn Config Plugin",
  description: "Fixture",
  author: "Test",
  categories: ["automation"],
  capabilities: ["issues.read"],
  entrypoints: { worker: "dist/worker.cjs" },
};

type ConfigRow = { companyId: string; configJson: Record<string, unknown> };
type Delivery = { companyId: string; config: Record<string, unknown> };

/** Lets fire-and-forget replay work settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A worker manager double with the real manager's `ready` semantics: a start
 * emits `ready` before it resolves, and a crash respawn emits `ready` again on
 * the same handle without going through the loader.
 */
function fakeWorkerManager() {
  const readyListeners = new Set<(pluginId: string) => void>();
  const deliveries: Delivery[] = [];
  let handle: object | undefined;
  const emitReady = (pluginId: string) => {
    for (const listener of [...readyListeners]) listener(pluginId);
  };
  let deliver: (params: Delivery) => Promise<unknown> = async () => ({});
  const manager = {
    onWorkerReady: vi.fn((listener: (pluginId: string) => void) => {
      readyListeners.add(listener);
      return () => { readyListeners.delete(listener); };
    }),
    startWorker: vi.fn(async (pluginId: string) => {
      handle = {};
      emitReady(pluginId);
      return handle;
    }),
    stopWorker: vi.fn(async () => { handle = undefined; }),
    stopAll: vi.fn(async () => { handle = undefined; }),
    isRunning: vi.fn(() => handle !== undefined),
    getWorker: vi.fn(() => handle),
    proactiveScopeGeneration: vi.fn(() => 0),
    call: vi.fn(async (_pluginId: string, method: string, params: Delivery) => {
      if (method !== "configChanged") return {};
      deliveries.push(params);
      return deliver(params);
    }),
  };
  return {
    manager,
    deliveries,
    readyListeners,
    /** The process died and the manager restarted it on the same handle. */
    crashAndRespawn: (pluginId = PLUGIN_ID) => emitReady(pluginId),
    setDeliver: (fn: typeof deliver) => { deliver = fn; },
  };
}

function runtimeWith(workerManager: unknown): PluginRuntimeServices {
  return {
    lifecycleManager: { markError: vi.fn(async () => undefined) },
    workerManager,
    eventBus: { forPlugin: vi.fn(() => ({})), subscriptionCount: vi.fn(() => 0), clearPlugin: vi.fn() },
    jobScheduler: { registerPlugin: vi.fn(async () => undefined), unregisterPlugin: vi.fn(async () => undefined), stop: vi.fn() },
    jobStore: { syncJobDeclarations: vi.fn(async () => undefined) },
    toolDispatcher: { registerPluginTools: vi.fn(), unregisterPluginTools: vi.fn() },
    buildHostHandlers: vi.fn(() => ({})),
    instanceInfo: { instanceId: "test", hostVersion: "0.0.0-test" },
  } as unknown as PluginRuntimeServices;
}

describe("pluginLoader stored config replay to respawned workers", () => {
  let root: string;
  let packageRoot: string;
  let storedRows: ConfigRow[];

  beforeEach(() => {
    vi.clearAllMocks();
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "loader-respawn-config-")));
    packageRoot = path.join(root, "example");
    mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "@example/respawn-config-plugin",
      version: "1.0.0",
      type: "module",
      paperclipPlugin: { manifest: "dist/manifest.js", worker: "dist/worker.cjs" },
    }));
    writeFileSync(path.join(packageRoot, "dist/manifest.js"), `export default ${JSON.stringify(manifest)};`);
    copyFileSync(path.join(FIXTURES_DIR, "plugin-worker-config-echo.cjs"), path.join(packageRoot, "dist/worker.cjs"));
    mockRegistry.getById.mockResolvedValue({
      id: PLUGIN_ID,
      pluginKey: manifest.id,
      packageName: "@example/respawn-config-plugin",
      packagePath: packageRoot,
      version: "1.0.0",
      apiVersion: 1,
      categories: manifest.categories,
      status: "ready",
      lastError: null,
      installOrder: 1,
      manifestJson: manifest,
    });
    storedRows = [
      { companyId: "company-a", configJson: { channel: "a-1" } },
      { companyId: "company-b", configJson: { channel: "b-1" } },
    ];
    mockRegistry.listConfigs.mockImplementation(async () => storedRows.map((row) => ({ ...row })));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeLoader(workerManager: unknown) {
    return pluginLoader({} as Db, {
      localPluginDir: root,
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    }, runtimeWith(workerManager));
  }

  it("resumes company setup on a real crash respawn with the config stored while the worker was down", async () => {
    const workerManager = createPluginWorkerManager();
    const loader = makeLoader(workerManager);
    const health = async () =>
      (await workerManager.call(PLUGIN_ID, "health", {} as never)) as unknown as {
        details: { pid: number; configs: Record<string, unknown> };
      };
    try {
      const result = await loader.loadSingle(PLUGIN_ID);
      expect(result.success).toBe(true);
      const first = await health();
      expect(first.details.configs).toEqual({
        "company-a": { channel: "a-1" },
        "company-b": { channel: "b-1" },
      });

      // Saved while the worker is down (the save's own delivery has nowhere to go).
      storedRows = [
        { companyId: "company-a", configJson: { channel: "a-2" } },
        { companyId: "company-b", configJson: { channel: "b-1" } },
      ];
      process.kill(first.details.pid, "SIGKILL");

      // The manager restarts it after its crash backoff (1s, with jitter).
      await vi.waitFor(async () => {
        expect(workerManager.isRunning(PLUGIN_ID)).toBe(true);
        const after = await health();
        expect(after.details.pid).not.toBe(first.details.pid);
        expect(after.details.configs).toEqual({
          "company-a": { channel: "a-2" },
          "company-b": { channel: "b-1" },
        });
      }, { timeout: 8_000, interval: 100 });
    } finally {
      await loader.shutdownAll();
    }
  }, 15_000);

  it("delivers exactly once on initial load and each company only its own config on every respawn", async () => {
    const fake = fakeWorkerManager();
    const loader = makeLoader(fake.manager);
    await loader.loadSingle(PLUGIN_ID);
    await flush();
    expect(fake.deliveries).toEqual([
      { companyId: "company-a", config: { channel: "a-1" } },
      { companyId: "company-b", config: { channel: "b-1" } },
    ]);

    fake.deliveries.length = 0;
    fake.crashAndRespawn();
    await flush();
    expect(fake.deliveries).toEqual([
      { companyId: "company-a", config: { channel: "a-1" } },
      { companyId: "company-b", config: { channel: "b-1" } },
    ]);

    fake.deliveries.length = 0;
    fake.crashAndRespawn();
    await flush();
    fake.crashAndRespawn();
    await flush();
    expect(fake.deliveries).toHaveLength(4);
    await loader.shutdownAll();
  });

  it("subscribes once for the loader's life, delivers once for a replacement handle, and stops at shutdown", async () => {
    const fake = fakeWorkerManager();
    const loader = makeLoader(fake.manager);
    await loader.loadSingle(PLUGIN_ID);
    await loader.unloadSingle(PLUGIN_ID, manifest.id);
    fake.deliveries.length = 0;

    // A reload starts a replacement handle; step 5b delivers, the listener does not.
    await loader.loadSingle(PLUGIN_ID);
    await flush();
    expect(fake.deliveries).toHaveLength(2);
    expect(fake.manager.onWorkerReady).toHaveBeenCalledTimes(1);
    expect(fake.readyListeners.size).toBe(1);

    await loader.shutdownAll();
    expect(fake.readyListeners.size).toBe(0);
  });

  it("keeps delivering to the other companies when one company's delivery fails", async () => {
    const fake = fakeWorkerManager();
    const loader = makeLoader(fake.manager);
    await loader.loadSingle(PLUGIN_ID);
    fake.deliveries.length = 0;
    fake.setDeliver(async (params) => {
      if (params.companyId === "company-a") throw Object.assign(new Error("rejected"), { code: -32000 });
      return {};
    });
    fake.crashAndRespawn();
    await flush();
    expect(fake.deliveries.map((d) => d.companyId)).toEqual(["company-a", "company-b"]);
    await loader.shutdownAll();
  });

  it("re-delivers a save that lands while the replay is in flight", async () => {
    const fake = fakeWorkerManager();
    const loader = makeLoader(fake.manager);
    await loader.loadSingle(PLUGIN_ID);
    fake.deliveries.length = 0;
    // The save writes the row (and delivers it itself) after the replay read
    // the old row but before the replay's own delivery lands.
    fake.setDeliver(async (params) => {
      if (params.companyId === "company-a" && params.config.channel === "a-1") {
        storedRows = [
          { companyId: "company-a", configJson: { channel: "a-2" } },
          { companyId: "company-b", configJson: { channel: "b-1" } },
        ];
      }
      return {};
    });
    fake.crashAndRespawn();
    await flush();
    const lastForA = fake.deliveries.filter((d) => d.companyId === "company-a").at(-1);
    expect(lastForA).toEqual({ companyId: "company-a", config: { channel: "a-2" } });
    expect(fake.deliveries.filter((d) => d.companyId === "company-b")).toHaveLength(1);
    await loader.shutdownAll();
  });

  it("stops a stale replay when a newer respawn starts", async () => {
    const fake = fakeWorkerManager();
    const loader = makeLoader(fake.manager);
    await loader.loadSingle(PLUGIN_ID);
    fake.deliveries.length = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holdNext = true;
    fake.setDeliver(async () => {
      if (holdNext) { holdNext = false; await held; }
      return {};
    });
    fake.crashAndRespawn(); // replay 1 blocks delivering company-a
    await flush();
    storedRows = [
      { companyId: "company-a", configJson: { channel: "a-3" } },
      { companyId: "company-b", configJson: { channel: "b-3" } },
    ];
    fake.crashAndRespawn(); // replay 2 delivers the newer rows
    await flush();
    release();
    await flush();
    // Replay 1 never continues to company-b with its old row.
    expect(fake.deliveries).toEqual([
      { companyId: "company-a", config: { channel: "a-1" } },
      { companyId: "company-a", config: { channel: "a-3" } },
      { companyId: "company-b", config: { channel: "b-3" } },
    ]);
    await loader.shutdownAll();
  });
});
