/**
 * The loader's `beforeWorkerStart` hook (used by PAPERCLIP_PLUGIN_CONFIG_FILE)
 * runs on activation before the stored company configs are read and before
 * the worker starts, so the worker's startup config replay carries what the
 * hook wrote. A failing hook never blocks activation.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

const manifest = {
  id: "example.config-plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Config Plugin",
  description: "Fixture",
  author: "Test",
  categories: ["automation"],
  capabilities: ["issues.read"],
  entrypoints: { worker: "dist/worker.js" },
};

describe("pluginLoader beforeWorkerStart", () => {
  let root: string;
  let packageRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "loader-before-start-")));
    packageRoot = path.join(root, "example");
    mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "@example/config-plugin",
      version: "1.0.0",
      type: "module",
      paperclipPlugin: { manifest: "dist/manifest.js", worker: "dist/worker.js" },
    }));
    writeFileSync(path.join(packageRoot, "dist/manifest.js"), `export default ${JSON.stringify(manifest)};`);
    writeFileSync(path.join(packageRoot, "dist/worker.js"), "");
    mockRegistry.getById.mockResolvedValue({
      id: "plugin-1",
      pluginKey: manifest.id,
      packageName: "@example/config-plugin",
      packagePath: packageRoot,
      version: "1.0.0",
      apiVersion: 1,
      categories: manifest.categories,
      status: "ready",
      lastError: null,
      installOrder: 1,
      manifestJson: manifest,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function activate(beforeWorkerStart: (plugin: { id: string; pluginKey: string }) => Promise<void>) {
    const order: string[] = [];
    mockRegistry.listConfigs.mockImplementation(async () => {
      order.push("listConfigs");
      return [];
    });
    const startWorker = vi.fn(async () => {
      order.push("startWorker");
      // Stop activation here; only the order up to the worker start matters.
      throw new Error("stop after start");
    });
    const runtime = {
      lifecycleManager: { markError: vi.fn(async () => undefined) },
      workerManager: { startWorker, isRunning: vi.fn(() => false) },
      eventBus: {},
      jobScheduler: {},
      jobStore: {},
      toolDispatcher: {},
      buildHostHandlers: vi.fn(() => ({})),
      instanceInfo: { instanceId: "test", hostVersion: "0.0.0-test" },
    } as unknown as PluginRuntimeServices;
    const loader = pluginLoader({} as Db, {
      localPluginDir: root,
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
      beforeWorkerStart: async (plugin) => {
        order.push(`hook:${plugin.pluginKey}`);
        await beforeWorkerStart(plugin);
      },
    }, runtime);
    return { order, result: loader.loadSingle("plugin-1") };
  }

  it("runs before the stored configs are read and the worker starts", async () => {
    const { order, result } = activate(async () => undefined);
    await result;
    expect(order).toEqual([`hook:${manifest.id}`, "listConfigs", "startWorker"]);
  });

  it("still starts the worker when the hook fails", async () => {
    const { order, result } = activate(async () => {
      throw new Error("bad file");
    });
    await result;
    expect(order).toEqual([`hook:${manifest.id}`, "listConfigs", "startWorker"]);
  });
});
