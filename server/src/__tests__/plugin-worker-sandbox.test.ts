import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { ENVIRONMENT_SYNC_IO_METHODS, type PluginSyncOperation, type WorkerHostCallContext } from "@paperclipai/plugin-sdk";

vi.mock("../middleware/logger.js", () => {
  const mockLogger: Record<string, unknown> = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(() => mockLogger),
  };
  return { logger: mockLogger, httpLogger: vi.fn() };
});

import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";
import { beginEnvironmentSyncHostIo, createEnvironmentSyncHostService } from "../services/plugin-environment-sync-io.js";
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

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

async function portOpensWithin(port: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await portIsOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** A long-lived node process whose SIGUSR1 inspector would listen on a known free port. */
async function inspectorTarget(flags: string[], env: NodeJS.ProcessEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [...flags, `--inspect-port=127.0.0.1:${port}`, "-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    env: { ...process.env, NODE_OPTIONS: "", ...env },
  });
  await new Promise((r) => setTimeout(r, 200));
  return {
    pid: child.pid as number,
    port,
    alive: () => child.exitCode === null && child.signalCode === null,
    kill: () => child.kill("SIGKILL"),
  };
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

  it("cannot open databases outside the allowlist through node:sqlite", async () => {
    const outside = path.join(secretsDir, "other.db");
    const handle = probeHandle();
    try {
      await handle.start();
      expect(await probe(handle, { op: "sqlite", file: outside })).toBe("ERR_UNKNOWN_BUILTIN_MODULE");
      expect(fs.existsSync(outside)).toBe(false);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("cannot open the server's inspector with SIGUSR1", async () => {
    // Stand-in for the server, started with the Dockerfile CMD flag. The permission
    // model does not restrict process.kill, so the worker *can* send the signal;
    // --disable-sigusr1 on the target is what keeps the inspector closed.
    const control = await inspectorTarget([]);
    const server = await inspectorTarget(["--disable-sigusr1"]);
    const handle = probeHandle();
    try {
      await handle.start();
      expect(await probe(handle, { op: "signal", pid: control.pid })).toBe("ok");
      // Control: without the flag the signal does open an inspector, so the probe can detect it.
      expect(await portOpensWithin(control.port, 3000)).toBe(true);
      expect(await probe(handle, { op: "signal", pid: server.pid })).toBe("ok");
      expect(await portOpensWithin(server.port, 1500)).toBe(false);
      expect(server.alive()).toBe(true);
    } finally {
      await handle.stop().catch(() => undefined);
      control.kill();
      server.kill();
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

  it("syncs a run workspace through host-mediated sync I/O while direct fs access to it is denied", async () => {
    // A per-run workspace outside the worker's allowlist, served only through the host.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sync-workspace-"));
    fs.mkdirSync(path.join(workspace, "src/nested"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src/README.md"), "hello from the workspace");
    fs.writeFileSync(path.join(workspace, "src/nested/main.ts"), "export const answer = 42;\n");
    fs.mkdirSync(path.join(workspace, "restore"));
    const service = createEnvironmentSyncHostService("test.sandbox");
    const hostHandlers = Object.fromEntries(ENVIRONMENT_SYNC_IO_METHODS.map((method) => [
      method,
      (params: unknown, context?: WorkerHostCallContext) => service.dispatch(method, params, context),
    ]));
    const handle = probeHandle("test.sandbox", hostHandlers);
    const syncParams = (operations: PluginSyncOperation[], hostIo: string, config: Record<string, unknown>) => ({
      driverKey: "probe", companyId: "company-1", environmentId: "env-1", config,
      lease: { providerLeaseId: "lease-1" }, operations, hostIo: { handle: hostIo },
    });
    try {
      await handle.start();
      const inbound: PluginSyncOperation[] = [{ operationId: "in", files: [
        { sourcePath: path.join(workspace, "src"), targetPath: "/sandbox/src", kind: "directory" },
      ] }];
      const inSession = beginEnvironmentSyncHostIo({ pluginId: "test.sandbox", companyId: "company-1", direction: "in",
        operations: inbound, hostRoots: [workspace] })!;
      try {
        await expect(handle.call("environmentSyncIn",
          syncParams(inbound, inSession.handle, { directRead: path.join(workspace, "src/README.md") }) as never))
          .resolves.toMatchObject({ operations: [{ operationId: "in", filesTransferred: 2 }] });
      } finally { await inSession.end(); }
      expect(JSON.parse(await probe(handle, { op: "lastSync" }))).toEqual({ files: 2, direct: "ERR_ACCESS_DENIED" });

      const outbound: PluginSyncOperation[] = [{ operationId: "out", files: [
        { sourcePath: "/sandbox/src", targetPath: path.join(workspace, "restore"), kind: "directory" },
      ] }];
      const outSession = beginEnvironmentSyncHostIo({ pluginId: "test.sandbox", companyId: "company-1", direction: "out",
        operations: outbound, hostRoots: [workspace] })!;
      try {
        await handle.call("environmentSyncOut",
          syncParams(outbound, outSession.handle, { directWrite: path.join(workspace, "restore/direct.txt") }) as never);
      } finally { await outSession.end(); }
      expect(JSON.parse(await probe(handle, { op: "lastSync" }))).toEqual({ files: 3, direct: "ERR_ACCESS_DENIED" });
      expect(fs.readFileSync(path.join(workspace, "restore/README.md"), "utf8")).toBe("hello from the workspace");
      expect(fs.readFileSync(path.join(workspace, "restore/nested/main.ts"), "utf8")).toBe("export const answer = 42;\n");
      expect(fs.readFileSync(path.join(workspace, "restore/from-sandbox.txt"), "utf8")).toBe("made in the sandbox");
      expect(fs.existsSync(path.join(workspace, "restore/direct.txt"))).toBe(false);
      expect(handle.status).toBe("running");
    } finally {
      await handle.stop().catch(() => undefined);
      fs.rmSync(workspace, { recursive: true, force: true });
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
    expect(plan.execArgv).toContain("--disable-sigusr1");
    expect(plan.execArgv).toContain("--no-experimental-sqlite");
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
    expect(trusted).toMatchObject({ mode: "disabled", reason: "trusted-exception", capability: "environment.drivers.register" });
    const untrusted = planPluginWorkerSandbox({
      pluginId: "p", entrypointPath: PROBE_WORKER, manifest, processEnv: {},
      trustedPluginRoots: [secretsDir], tmpRoot: tmpRoot(),
    });
    expect(untrusted.mode).toBe("enforced");
  });

  it("disables the SIGUSR1 inspector on unsandboxed workers too", () => {
    const manifest = { capabilities: ["environment.drivers.register"] } as PaperclipPluginManifestV1;
    const trusted = planPluginWorkerSandbox({
      pluginId: "p", entrypointPath: PROBE_WORKER, manifest, processEnv: {},
      trustedPluginRoots: [FIXTURES_DIR], tmpRoot: tmpRoot(), execArgv: ["--import", "x"],
    });
    expect(trusted.execArgv).toEqual(["--disable-sigusr1", "--import", "x"]);
    const optOut = planPluginWorkerSandbox({
      pluginId: "p", entrypointPath: PROBE_WORKER, manifest: MANIFEST,
      processEnv: { PAPERCLIP_PLUGIN_WORKER_SANDBOX: "off" }, tmpRoot: tmpRoot(),
    });
    expect(optOut.execArgv).toEqual(["--disable-sigusr1"]);
  });

  it("starts the production server with --disable-sigusr1", () => {
    const dockerfile = fs.readFileSync(path.join(FIXTURES_DIR, "../../../../Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^CMD \["node", "--disable-sigusr1", "server\/dist-runtime\/index\.mjs"\]$/m);
  });

  it("sets NODE_OPTIONS=--disable-sigusr1 for every other Node process in the production image", () => {
    const dockerfile = fs.readFileSync(path.join(FIXTURES_DIR, "../../../../Dockerfile"), "utf8");
    const production = dockerfile.slice(dockerfile.indexOf("AS production"), dockerfile.indexOf("\nFROM ", dockerfile.indexOf("AS production")));
    expect(production).toMatch(/^ENV NODE_OPTIONS=--disable-sigusr1$/m);
    // No later stage may replace it (the cloud image builds FROM production).
    const after = dockerfile.slice(dockerfile.indexOf("AS production"));
    const values = [...after.matchAll(/NODE_OPTIONS=([^\s\\]+)/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values)).toEqual(new Set(["--disable-sigusr1"]));
  });

  it("a node -e started with NODE_OPTIONS=--disable-sigusr1 (the image env) never opens an inspector on SIGUSR1", async () => {
    // Stands in for the Deployment's `node -e` probes, which take the flag only from NODE_OPTIONS.
    const control = await inspectorTarget([]);
    const probeProcess = await inspectorTarget([], { NODE_OPTIONS: "--disable-sigusr1" });
    try {
      process.kill(control.pid, "SIGUSR1");
      expect(await portOpensWithin(control.port, 3000)).toBe(true);
      process.kill(probeProcess.pid, "SIGUSR1");
      expect(await portOpensWithin(probeProcess.port, 1500)).toBe(false);
      expect(probeProcess.alive()).toBe(true);
    } finally {
      control.kill();
      probeProcess.kill();
    }
  });
});
