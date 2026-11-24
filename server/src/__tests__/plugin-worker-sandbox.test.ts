import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

vi.mock("../middleware/logger.js", () => {
  const mockLogger: Record<string, unknown> = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(() => mockLogger),
  };
  return { logger: mockLogger, httpLogger: vi.fn() };
});

import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";
import {
  collectProtectedSecretPaths,
  planPluginWorkerSandbox,
  PluginWorkerSandboxError,
} from "../services/plugin-worker-sandbox.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const PROBE_WORKER = path.join(FIXTURES_DIR, "plugin-worker-sandbox-probe.cjs");

const MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.sandbox",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Sandbox probe",
  description: "Sandbox probe",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

let secretsDir: string;
let keyFile: string;

beforeEach(() => {
  // A directory outside every allowlisted path, standing in for a mounted Secret.
  secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sandbox-secrets-"));
  keyFile = path.join(secretsDir, "approvals-app.pem");
  fs.writeFileSync(keyFile, "-----BEGIN PRIVATE KEY-----\nfixture-not-a-key\n", { mode: 0o600 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(secretsDir, { recursive: true, force: true });
});

function probeHandle(pluginId = "test.sandbox", hostHandlers: Record<string, unknown> = {}) {
  return createPluginWorkerHandle(pluginId, {
    entrypointPath: PROBE_WORKER,
    manifest: MANIFEST,
    config: {},
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    apiVersion: 1,
    hostHandlers: hostHandlers as never,
    execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")],
  });
}

async function probe(handle: ReturnType<typeof probeHandle>, config: Record<string, unknown>) {
  const result = await handle.call("environmentProbe", {
    driverKey: "probe", companyId: "company-1", environmentId: "env-1", config,
  } as never);
  return (result as { summary: string }).summary;
}

describe("plugin worker filesystem sandbox (real worker process)", () => {
  it("denies reading a key file outside the allowlist and keeps serving RPCs", async () => {
    const handle = probeHandle();
    try {
      await handle.start();
      expect(await probe(handle, { op: "read", file: keyFile })).toBe("ERR_ACCESS_DENIED");
      expect(await probe(handle, { op: "write", file: path.join(secretsDir, "planted.txt") })).toBe("ERR_ACCESS_DENIED");
      expect(await probe(handle, { op: "spawn" })).toBe("ERR_ACCESS_DENIED");
      // The denials do not break the worker: its private tmp dir works and RPCs still answer.
      expect(await probe(handle, { op: "tmp" })).toBe("ok");
      await expect(handle.call("health", {} as never)).resolves.toMatchObject({ status: "ok" });
      expect(handle.status).toBe("running");
      expect(fs.existsSync(path.join(secretsDir, "planted.txt"))).toBe(false);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("still reaches its configured local folder through the host", async () => {
    // A board-configured folder outside the allowlist, read by the host on the
    // worker's behalf the way the local-folder service does.
    const folder = path.join(secretsDir, "notes");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "readme.md"), "hello from the folder");
    const handle = probeHandle("test.sandbox", {
      "localFolders.readText": async (params: { folderKey: string; relativePath: string }) => {
        expect(params.folderKey).toBe("notes");
        return fs.readFileSync(path.join(folder, params.relativePath), "utf8");
      },
    });
    try {
      await handle.start();
      expect(await probe(handle, { op: "localFolderRead", relativePath: "readme.md" })).toBe("ok:hello from the folder");
      expect(await probe(handle, { op: "read", file: path.join(folder, "readme.md") })).toBe("ERR_ACCESS_DENIED");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("refuses to start a worker whose allowlist would contain a configured key file", async () => {
    // Misconfigured mount: the approvals key sits inside the worker's own package tree.
    vi.stubEnv("PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE", path.join(FIXTURES_DIR, "mounted-approvals.pem"));
    const handle = probeHandle();
    await expect(handle.start()).rejects.toThrow(PluginWorkerSandboxError);
    expect(handle.status).toBe("stopped");
  });

  it("runs unsandboxed only when the operator opts out", async () => {
    vi.stubEnv("PAPERCLIP_PLUGIN_WORKER_SANDBOX", "off");
    const handle = probeHandle();
    try {
      await handle.start();
      expect(await probe(handle, { op: "read", file: keyFile })).toBe("ok");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});

describe("planPluginWorkerSandbox", () => {
  const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sandbox-plan-"));

  it("grants the module closure and a private tmp dir, and nothing that holds a secret", () => {
    const plan = planPluginWorkerSandbox({
      pluginId: "acme/plugin", entrypointPath: PROBE_WORKER, manifest: MANIFEST,
      processEnv: {}, tmpRoot: tmpRoot(),
    });
    expect(plan.mode).toBe("enforced");
    if (plan.mode !== "enforced") return;
    expect(plan.execArgv[0]).toBe("--permission");
    expect(plan.execArgv.some((arg) => arg.startsWith("--allow-child-process") || arg.startsWith("--allow-worker"))).toBe(false);
    expect(plan.writePaths).toHaveLength(1);
    expect(plan.writePaths[0]).toMatch(/paperclip-plugin-workers[\\/]acme_plugin$/);
    expect(plan.env.TMPDIR).toBe(plan.writePaths[0]);
    expect(plan.readPaths.some((p) => secretsDir.startsWith(p + path.sep) || p === secretsDir)).toBe(false);
  });

  it("protects every *File path in the apps file and the apps file itself", () => {
    const appsFile = path.join(secretsDir, "apps.json");
    fs.writeFileSync(appsFile, JSON.stringify({
      apps: [{ appId: 1, privateKeyFile: "app-1.pem", webhookSecretFile: "/etc/hooks/secret" }],
      approvalsApp: { appId: 2, privateKeyFile: "/mnt/approvals/key.pem" },
    }));
    const paths = collectProtectedSecretPaths({ PAPERCLIP_GITHUB_APPS_FILE: appsFile });
    expect(paths).toEqual(expect.arrayContaining([
      fs.realpathSync(appsFile),
      path.join(fs.realpathSync(secretsDir), "app-1.pem"),
      "/etc/hooks/secret",
      "/mnt/approvals/key.pem",
    ]));
  });

  it("refuses when a key file named by the apps file falls inside the allowlist", () => {
    const appsFile = path.join(secretsDir, "apps.json");
    fs.writeFileSync(appsFile, JSON.stringify({ approvalsApp: { privateKeyFile: path.join(FIXTURES_DIR, "key.pem") } }));
    expect(() => planPluginWorkerSandbox({
      pluginId: "p", entrypointPath: PROBE_WORKER, manifest: MANIFEST,
      processEnv: { PAPERCLIP_GITHUB_APPS_FILE: appsFile }, tmpRoot: tmpRoot(),
    })).toThrow(/operator secret file .*key\.pem/);
  });

  it("exempts a child-process capability only for plugins from the trusted plugin roots", () => {
    const manifest = { capabilities: ["environment.drivers.register"] } as PaperclipPluginManifestV1;
    const trusted = planPluginWorkerSandbox({
      pluginId: "p", entrypointPath: PROBE_WORKER, manifest, processEnv: {},
      trustedPluginRoots: [FIXTURES_DIR], tmpRoot: tmpRoot(),
    });
    expect(trusted).toEqual({ mode: "disabled", reason: "trusted-exception", capability: "environment.drivers.register" });
    const untrusted = planPluginWorkerSandbox({
      pluginId: "p", entrypointPath: PROBE_WORKER, manifest, processEnv: {},
      trustedPluginRoots: [secretsDir], tmpRoot: tmpRoot(),
    });
    expect(untrusted.mode).toBe("enforced");
  });
});
