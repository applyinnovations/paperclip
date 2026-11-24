import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

vi.mock("../middleware/logger.js", () => {
  const mockLogger: Record<string, unknown> = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(() => mockLogger),
  };
  return { logger: mockLogger, httpLogger: vi.fn() };
});

import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";
import { planPluginWorkerSandbox } from "../services/plugin-worker-sandbox.js";

/**
 * Every bundled plugin either starts and answers RPCs under the filesystem
 * sandbox, or is one of the listed trusted exceptions (it declares a capability
 * whose implementation needs a child process). A new bundled plugin fails this
 * test until it works sandboxed or is added to the exception list on purpose.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PLUGINS_ROOT = path.join(REPO_ROOT, "packages/plugins");

const EXPECTED_TRUSTED_EXCEPTIONS = [
  "examples/plugin-file-browser-example",
  "examples/plugin-kitchen-sink-example",
  "paperclip-plugin-fake-sandbox",
  "plugin-workspace-diff",
  "sandbox-providers/boxd",
  "sandbox-providers/cloudflare",
  "sandbox-providers/createos",
  "sandbox-providers/daytona",
  "sandbox-providers/e2b",
  "sandbox-providers/exe-dev",
  "sandbox-providers/kubernetes",
  "sandbox-providers/modal",
  "sandbox-providers/novita",
];

function findBundledPlugins(): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (fs.existsSync(path.join(dir, "src/manifest.ts")) && fs.existsSync(path.join(dir, "src/worker.ts"))) {
      out.push(dir);
      return;
    }
    if (depth === 0) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        walk(path.join(dir, entry.name), depth - 1);
      }
    }
  };
  walk(PLUGINS_ROOT, 2);
  return out.sort();
}

const plugins = await Promise.all(findBundledPlugins().map(async (dir) => {
  const mod = await import(pathToFileURL(path.join(dir, "src/manifest.ts")).href);
  const manifest = (mod.default ?? mod.manifest) as PaperclipPluginManifestV1;
  const workerPath = path.join(dir, "src/worker.ts");
  const plan = planPluginWorkerSandbox({ pluginId: manifest.id, entrypointPath: workerPath, manifest });
  return { key: path.relative(PLUGINS_ROOT, dir).split(path.sep).join("/"), manifest, workerPath, plan };
}));

describe("bundled plugins under the worker filesystem sandbox", () => {
  it("runs every bundled plugin sandboxed except the listed trusted exceptions", () => {
    expect(plugins.length).toBeGreaterThan(EXPECTED_TRUSTED_EXCEPTIONS.length);
    const exceptions = plugins.filter((p) => p.plan.mode === "disabled").map((p) => p.key);
    expect(exceptions).toEqual(EXPECTED_TRUSTED_EXCEPTIONS);
  });

  const sandboxed = plugins.filter((p) => p.plan.mode === "enforced");
  it.each(sandboxed.map((p) => [p.key, p] as const))("%s starts sandboxed and answers health", async (_key, plugin) => {
    const handle = createPluginWorkerHandle(plugin.manifest.id, {
      entrypointPath: plugin.workerPath,
      manifest: plugin.manifest,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {},
      execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")],
    });
    try {
      await handle.start();
      expect(handle.diagnostics().pid).not.toBeNull();
      await expect(handle.call("health", {} as never)).resolves.toMatchObject({ status: expect.any(String) });
      expect(handle.status).toBe("running");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  }, 60_000);
});
