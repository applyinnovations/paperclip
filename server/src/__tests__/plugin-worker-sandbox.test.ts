import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
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

import { logger } from "../middleware/logger.js";
import { createPluginWorkerHandle, parseSandboxProbeMessage } from "../services/plugin-worker-manager.js";
import {
  collectProtectedSecretPaths,
  planPluginWorkerSandbox,
  PluginWorkerSandboxError,
  SANDBOX_PROBE_PATHS_ENV,
  SANDBOX_PROBE_URL,
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

function probeHandle(
  pluginId = "test.sandbox",
  hostHandlers: Record<string, unknown> = {},
  options: { env?: Record<string, string>; manifest?: PaperclipPluginManifestV1 } = {},
) {
  const { env, manifest = MANIFEST } = options;
  return createPluginWorkerHandle(pluginId, {
    ...(env ? { env } : {}),
    entrypointPath: PROBE_WORKER,
    manifest,
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

  it("refuses to start a worker whose allowlist would contain a configured key file", async () => {
    // Misconfigured mount: the approvals key sits inside the worker's own package tree.
    vi.stubEnv("PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE", path.join(FIXTURES_DIR, "mounted-approvals.pem"));
    const handle = probeHandle();
    await expect(handle.start()).rejects.toThrow(PluginWorkerSandboxError);
    expect(handle.status).toBe("stopped");
  });

  it("startup probe: the running sandboxed worker is denied the configured key and still serves RPCs", async () => {
    vi.stubEnv("PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE", keyFile);
    const handle = probeHandle();
    try {
      await handle.start();
      const report = handle.diagnostics().sandbox;
      expect(report?.mode).toBe("enforced");
      expect(report?.protectedPathProbe?.length).toBeGreaterThan(0);
      expect(report?.protectedPathProbe?.map((r) => r.path)).toContain(fs.realpathSync(keyFile));
      for (const result of report?.protectedPathProbe ?? []) expect(result.outcome).toBe("ERR_ACCESS_DENIED");
      await expect(handle.call("health", {} as never)).resolves.toMatchObject({ status: "ok" });
      // The path list does not stay in the plugin's environment.
      expect(await probe(handle, { op: "env", name: SANDBOX_PROBE_PATHS_ENV })).toBe("unset");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("startup probe: an unsandboxed worker reports the key as readable, and plugin code cannot overwrite that", async () => {
    vi.stubEnv("PAPERCLIP_PLUGIN_WORKER_SANDBOX", "off");
    vi.stubEnv("PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE", keyFile);
    const expected = collectProtectedSecretPaths(process.env);
    const handle = probeHandle("test.sandbox", {}, { env: { FORGE_SANDBOX_PROBE: JSON.stringify(expected) } });
    try {
      await handle.start();
      const report = handle.diagnostics().sandbox;
      expect(report).toMatchObject({ mode: "disabled", reason: "operator-opt-out" });
      expect(report?.protectedPathProbe).toContainEqual({ path: keyFile, outcome: "readable" });
      await expect(handle.call("health", {} as never)).resolves.toMatchObject({ status: "ok" });
    } finally {
      await handle.stop().catch(() => undefined);
    }
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

describe("manifest read grants (real worker process)", () => {
  let grantDir: string;
  beforeEach(() => {
    grantDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sandbox-grant-"));
    fs.writeFileSync(path.join(grantDir, "granted.txt"), "granted contents");
    fs.writeFileSync(path.join(grantDir, "sibling.txt"), "sibling contents");
  });
  afterEach(() => {
    fs.rmSync(grantDir, { recursive: true, force: true });
    vi.mocked(logger.warn).mockClear();
  });

  const grantManifest = (): PaperclipPluginManifestV1 => ({
    ...MANIFEST,
    sandbox: { fsRead: [path.join(grantDir, "granted.txt")] },
  });

  it("lets a trusted plugin read its granted file and nothing beside it", async () => {
    // The probe counts as trusted when it sits under the bundled catalog root.
    vi.stubEnv("PAPERCLIP_BUNDLED_PLUGIN_ROOT", FIXTURES_DIR);
    const handle = probeHandle("test.sandbox", {}, { manifest: grantManifest() });
    try {
      await handle.start();
      expect(await probe(handle, { op: "read", file: path.join(grantDir, "granted.txt") })).toBe("ok");
      expect(await probe(handle, { op: "read", file: path.join(grantDir, "sibling.txt") })).toBe("ERR_ACCESS_DENIED");
      expect(await probe(handle, { op: "read", file: keyFile })).toBe("ERR_ACCESS_DENIED");
      // Read only: the grant gives neither write nor child-process access.
      expect(await probe(handle, { op: "write", file: path.join(grantDir, "granted.txt") })).toBe("ERR_ACCESS_DENIED");
      expect(await probe(handle, { op: "spawn" })).toBe("ERR_ACCESS_DENIED");
      expect(fs.readFileSync(path.join(grantDir, "granted.txt"), "utf8")).toBe("granted contents");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("drops the grant of a third-party plugin, logs why, and still runs it sandboxed", async () => {
    const handle = probeHandle("acme.thirdparty", {}, { manifest: grantManifest() });
    try {
      await handle.start();
      expect(await probe(handle, { op: "read", file: path.join(grantDir, "granted.txt") })).toBe("ERR_ACCESS_DENIED");
      expect(await probe(handle, { op: "tmp" })).toBe("ok");
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "untrusted-plugin-root", ignoredReadGrants: [path.join(grantDir, "granted.txt")] }),
        expect.stringMatching(/ignoring sandbox\.fsRead grants declared by plugin "acme\.thirdparty".*not installed from a trusted plugin root/),
      );
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
    expect(trusted.execArgv).toEqual(["--disable-sigusr1", "--import", SANDBOX_PROBE_URL, "--import", "x"]);
    const optOut = planPluginWorkerSandbox({
      pluginId: "p", entrypointPath: PROBE_WORKER, manifest: MANIFEST,
      processEnv: { PAPERCLIP_PLUGIN_WORKER_SANDBOX: "off" }, tmpRoot: tmpRoot(),
    });
    expect(optOut.execArgv).toEqual(["--disable-sigusr1", "--import", SANDBOX_PROBE_URL]);
  });

  it("runs the startup probe first in every worker and hands it the protected paths", () => {
    const processEnv = { PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE: keyFile };
    const enforced = planPluginWorkerSandbox({
      pluginId: "p", entrypointPath: PROBE_WORKER, manifest: MANIFEST, processEnv, tmpRoot: tmpRoot(),
      execArgv: ["--import", "x"],
    });
    const probeAt = enforced.execArgv.indexOf(SANDBOX_PROBE_URL);
    expect(enforced.execArgv[probeAt - 1]).toBe("--import");
    expect(enforced.execArgv.indexOf("x")).toBeGreaterThan(probeAt);
    expect(enforced.probePaths).toEqual(collectProtectedSecretPaths(processEnv));
    expect(enforced.probePaths).toContain(keyFile);
    expect(JSON.parse(enforced.env[SANDBOX_PROBE_PATHS_ENV])).toEqual(enforced.probePaths);
  });

  it("accepts only a well-formed probe message for exactly the expected paths", () => {
    const expected = ["/a", "/b"];
    const ok = { type: "paperclip.sandboxProbe", results: [{ path: "/a", outcome: "ERR_ACCESS_DENIED" }, { path: "/b", outcome: "ENOENT" }] };
    expect(parseSandboxProbeMessage(ok, expected)).toEqual(ok.results);
    expect(parseSandboxProbeMessage({ ...ok, type: "other" }, expected)).toBeNull();
    expect(parseSandboxProbeMessage({ ...ok, results: ok.results.slice(0, 1) }, expected)).toBeNull();
    expect(parseSandboxProbeMessage({ ...ok, results: [ok.results[1], ok.results[0]] }, expected)).toBeNull();
    expect(parseSandboxProbeMessage({ ...ok, results: [{ path: "/a", outcome: "-----BEGIN" }, ok.results[1]] }, expected)).toBeNull();
    expect(parseSandboxProbeMessage(null, expected)).toBeNull();
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

  describe("read grants", () => {
    const withGrants = (fsRead: string[]) => ({ ...MANIFEST, sandbox: { fsRead } });
    const plan = (fsRead: string[], processEnv: NodeJS.ProcessEnv = {}, trustedPluginRoots = [FIXTURES_DIR]) =>
      planPluginWorkerSandbox({
        pluginId: "p", entrypointPath: PROBE_WORKER, manifest: withGrants(fsRead), processEnv,
        trustedPluginRoots, tmpRoot: tmpRoot(),
      });

    it("adds a trusted plugin's grant as a read-only path", () => {
      const granted = path.join(secretsDir, "readable.txt");
      const result = plan([granted]);
      expect(result.mode).toBe("enforced");
      if (result.mode !== "enforced") return;
      const real = path.join(fs.realpathSync(secretsDir), "readable.txt");
      expect(result.execArgv).toContain(`--allow-fs-read=${real}`);
      expect(result.grantedReadPaths).toContain(real);
      expect(result.writePaths).not.toContain(real);
      expect(result.execArgv.some((arg) => arg.startsWith("--allow-fs-write=") && arg.includes(real))).toBe(false);
      expect(result.execArgv.some((arg) => arg.startsWith("--allow-child-process") || arg.startsWith("--allow-worker"))).toBe(false);
    });

    it("ignores a third-party plugin's grant and reports why", () => {
      const granted = path.join(secretsDir, "readable.txt");
      const result = plan([granted], {}, [path.join(secretsDir, "not-the-plugin-root")]);
      expect(result.mode).toBe("enforced");
      if (result.mode !== "enforced") return;
      expect(result.ignoredReadGrants).toEqual({ paths: [granted], reason: "untrusted-plugin-root" });
      expect(result.grantedReadPaths).toEqual([]);
      expect(result.execArgv.some((arg) => arg.includes("readable.txt"))).toBe(false);
    });

    it("does not change the trusted exception: an exempt plugin stays unsandboxed", () => {
      const result = planPluginWorkerSandbox({
        pluginId: "p", entrypointPath: PROBE_WORKER,
        manifest: { capabilities: ["environment.drivers.register"], sandbox: { fsRead: ["/opt/data"] } } as PaperclipPluginManifestV1,
        processEnv: {}, trustedPluginRoots: [FIXTURES_DIR], tmpRoot: tmpRoot(),
      });
      expect(result).toMatchObject({ mode: "disabled", reason: "trusted-exception" });
    });

    describe("with an approvals key configured", () => {
      let appsEnv: NodeJS.ProcessEnv;
      let linkDir: string;
      let appsDir: string;
      afterEach(() => {
        fs.rmSync(appsDir, { recursive: true, force: true });
        fs.rmSync(linkDir, { recursive: true, force: true });
      });
      beforeEach(() => {
        appsDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sandbox-apps-"));
        const appsFile = path.join(appsDir, "apps.json");
        fs.writeFileSync(appsFile, JSON.stringify({ approvalsApp: { appId: 2, privateKeyFile: keyFile } }));
        appsEnv = { PAPERCLIP_GITHUB_APPS_FILE: appsFile };
        fs.writeFileSync(path.join(secretsDir, "sibling.txt"), "not a key");
        linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sandbox-link-"));
        fs.symlinkSync(secretsDir, path.join(linkDir, "to-secrets"));
        fs.symlinkSync(keyFile, path.join(linkDir, "to-key"));
      });

      const refused = () => [
        ["the key itself", () => keyFile],
        ["the key's parent directory", () => secretsDir],
        ["a sibling file in that directory", () => path.join(secretsDir, "sibling.txt")],
        ["a not-yet-existing path in that directory", () => path.join(secretsDir, "later", "file")],
        ["an ancestor (/)", () => "/"],
        ["an ancestor (the tmp dir above the key's directory)", () => path.dirname(secretsDir)],
        ["a symlink to the parent directory", () => path.join(linkDir, "to-secrets")],
        ["a symlink to the key", () => path.join(linkDir, "to-key")],
      ] as const;

      for (const [label, grant] of refused()) {
        it(`refuses to start when a trusted plugin grants ${label}`, () => {
          expect(() => plan([grant()], appsEnv)).toThrow(PluginWorkerSandboxError);
          expect(() => plan([grant()], appsEnv)).toThrow(/manifest read grant .* sits beside the operator secret file /);
        });
      }

      it("still allows a grant clear of the key", () => {
        const result = plan([linkDir], appsEnv);
        expect(result.mode).toBe("enforced");
      });

      it("ignores, rather than refuses, a forbidden grant from a third-party plugin", () => {
        const result = plan([secretsDir], appsEnv, [path.join(linkDir, "elsewhere")]);
        expect(result.mode).toBe("enforced");
        if (result.mode !== "enforced") return;
        expect(result.ignoredReadGrants?.paths).toEqual([secretsDir]);
        expect(result.readPaths.some((p) => isInside(p, keyFile))).toBe(false);
      });

      it("refuses a key mounted with PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE too", () => {
        expect(() => plan([secretsDir], { PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE: keyFile })).toThrow(PluginWorkerSandboxError);
      });
    });
  });
});

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
