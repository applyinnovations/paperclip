import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { resolveBundledCatalogRoot } from "./bundled-plugins.js";

/**
 * Filesystem sandbox for plugin workers (Node permission model).
 *
 * Every plugin worker is forked with `--permission`. It may read only its own
 * package and that package's resolvable dependency closure, the `--import`
 * loader, NODE_PATH entries and a private per-worker tmp directory; it may write
 * only that tmp directory. Child processes, worker threads, native addons, WASI
 * and the inspector stay denied. Local folders, plugin state and secrets are
 * reached through host RPC, never the worker's own filesystem access.
 *
 * Operator secret files (GitHub App private keys, webhook secret files and the
 * apps file itself) must never fall inside an allowed path; the host refuses to
 * start a worker whose allowlist would cover one.
 *
 * See doc/plugins/PLUGIN_SPEC.md §12.6.
 */

/** Operator-only escape hatch: `off` runs workers without the sandbox (local development). */
export const PLUGIN_WORKER_SANDBOX_ENV = "PAPERCLIP_PLUGIN_WORKER_SANDBOX";

/** Env vars naming operator secret files that no worker may ever be able to read. */
const PROTECTED_FILE_ENV_VARS = [
  "PAPERCLIP_GITHUB_APPS_FILE",
  "PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE",
] as const;
const GITHUB_APPS_FILE_ENV = "PAPERCLIP_GITHUB_APPS_FILE";

/**
 * Capabilities whose bundled implementations need a child process (tar, ssh, git,
 * arbitrary commands). A child process is not covered by the permission model, so
 * an `--allow-child-process` grant would let it read any file the server can;
 * a partial sandbox would be theatre. Plugins installed from the image's trusted
 * plugin roots that declare one of these run unsandboxed; every other plugin
 * declaring them stays sandboxed (and cannot spawn).
 */
export const UNSANDBOXED_TRUSTED_CAPABILITIES = [
  "environment.drivers.register",
  "execution.workspaces.read",
  "project.workspaces.read",
] as const;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// server/src/services (or server/dist/services) -> repo root
const DEFAULT_TRUSTED_PLUGIN_ROOTS = (env: NodeJS.ProcessEnv) => [
  path.resolve(MODULE_DIR, "../../../packages/plugins"),
  resolveBundledCatalogRoot(env),
];

export type PluginWorkerSandboxPlan =
  | { mode: "disabled"; reason: "operator-opt-out" | "trusted-exception"; capability?: string }
  | {
      mode: "enforced";
      /** The worker's complete execArgv (sandbox flags plus the host's, minus any tsx loader). */
      execArgv: string[];
      /** Env to merge into the worker env (TMPDIR and friends). */
      env: Record<string, string>;
      readPaths: string[];
      writePaths: string[];
    };

export class PluginWorkerSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginWorkerSandboxError";
  }
}

export interface PluginWorkerSandboxInput {
  pluginId: string;
  entrypointPath: string;
  manifest: Pick<PaperclipPluginManifestV1, "capabilities">;
  execArgv?: readonly string[];
  /** Defaults to process.env. */
  processEnv?: NodeJS.ProcessEnv;
  /** Test seam; defaults to the repo plugin tree and the bundled catalog root. */
  trustedPluginRoots?: readonly string[];
  /** Test seam; parent of every per-worker tmp directory. Defaults to os.tmpdir(). */
  tmpRoot?: string;
}

function realpathOrResolve(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function nearestPackageRoot(file: string): string {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(file);
    dir = parent;
  }
}

function ancestorNodeModules(dir: string): string[] {
  const out: string[] = [];
  let current = dir;
  for (;;) {
    const candidate = path.join(current, "node_modules");
    if (fs.existsSync(candidate)) out.push(realpathOrResolve(candidate));
    const parent = path.dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

function listPackageEntries(nodeModulesDir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith("@")) {
      try {
        for (const scoped of fs.readdirSync(full)) out.push(path.join(full, scoped));
      } catch {
        // unreadable scope directory: nothing to resolve from it
      }
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * Directories a worker must read to load `entryFile`: its package root, every
 * ancestor `node_modules`, and — transitively — the real directories of linked
 * packages (pnpm workspace links resolve outside `node_modules`, and Node checks
 * the realpath of every module it loads).
 */
function moduleClosure(entryFile: string): string[] {
  const roots = new Set<string>();
  const covered = (p: string) => [...roots].some((root) => isWithin(root, p));
  const queue = [realpathOrResolve(nearestPackageRoot(realpathOrResolve(entryFile)))];
  const MAX_PACKAGES = 2000;
  let scanned = 0;
  while (queue.length && scanned < MAX_PACKAGES) {
    const pkgRoot = queue.shift() as string;
    if (covered(pkgRoot)) continue;
    roots.add(pkgRoot);
    scanned += 1;
    const moduleDirs = [path.join(pkgRoot, "node_modules"), ...ancestorNodeModules(path.dirname(pkgRoot))];
    for (const dir of moduleDirs) {
      if (!fs.existsSync(dir)) continue;
      const real = realpathOrResolve(dir);
      if (!covered(real)) roots.add(real);
    }
    for (const entry of listPackageEntries(path.join(pkgRoot, "node_modules"))) {
      const real = realpathOrResolve(entry);
      if (!covered(real)) queue.push(real);
    }
  }
  return [...roots];
}

/**
 * tsx cannot run under the permission model: esbuild's synchronous transform
 * starts a worker thread, and `--allow-worker` would let a plugin start a thread
 * with `--no-permission` and escape the sandbox. Sandboxed workers therefore load
 * TypeScript (the workspace packages such as `@paperclipai/shared` export source)
 * with Node's built-in, in-thread transform plus this resolve hook, which maps a
 * missing `./x.js` specifier to its `./x.ts` sibling the way tsx does. It is
 * passed as a data: URL so no extra file has to ship with the server bundle.
 */
const TS_RESOLVE_HOOK_SOURCE = `
import { registerHooks } from "node:module";
const TS_EXT = { ".js": ".ts", ".mjs": ".mts", ".cjs": ".cts" };
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const match = /\\.(m|c)?js$/.exec(specifier);
      if (!error || error.code !== "ERR_MODULE_NOT_FOUND" || !match) throw error;
      return nextResolve(specifier.slice(0, -match[0].length) + TS_EXT[match[0]], context);
    }
  },
});
`;
export const SANDBOX_TS_RESOLVE_HOOK_URL = `data:text/javascript,${encodeURIComponent(TS_RESOLVE_HOOK_SOURCE)}`;

const SANDBOX_TYPESCRIPT_EXEC_ARGV = [
  "--experimental-transform-types",
  "--disable-warning=ExperimentalWarning",
  "--import",
  SANDBOX_TS_RESOLVE_HOOK_URL,
];

function isTsxLoader(value: string): boolean {
  const file = value.startsWith("file:") ? fileURLToPath(value) : value;
  return /(^|[\\/])tsx([\\/]|$)/.test(file);
}

/** Drop `--import`/`--loader` entries that point at tsx; keep everything else. */
function withoutTsxLoader(execArgv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i];
    if ((arg === "--import" || arg === "--loader") && execArgv[i + 1] !== undefined && isTsxLoader(execArgv[i + 1])) {
      i += 1;
      continue;
    }
    const inline = /^--(import|loader)=(.*)$/.exec(arg);
    if (inline && isTsxLoader(inline[2])) continue;
    out.push(arg);
  }
  return out;
}

function importTargets(execArgv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i];
    let value: string | undefined;
    if (arg === "--import" || arg === "--require" || arg === "-r" || arg === "--loader") value = execArgv[i + 1];
    else if (/^--(import|require|loader)=/.test(arg)) value = arg.slice(arg.indexOf("=") + 1);
    if (!value) continue;
    const file = value.startsWith("file:") ? fileURLToPath(value) : value;
    if (path.isAbsolute(file)) out.push(file);
  }
  return out;
}

/**
 * Operator secret files a worker must never be able to read: the files named by
 * the GitHub App env vars and the apps file, plus every `*File` path inside the
 * apps file (apps[].privateKeyFile, apps[].webhookSecretFile,
 * approvalsApp.privateKeyFile, ...). The apps file is scanned raw so a
 * malformed one is still protected.
 */
export function collectProtectedSecretPaths(processEnv: NodeJS.ProcessEnv = process.env): string[] {
  const paths = new Set<string>();
  const add = (p: unknown) => {
    if (typeof p !== "string" || !p.trim()) return;
    const resolved = path.resolve(p.trim());
    paths.add(resolved);
    paths.add(realpathOrResolve(resolved));
  };
  for (const name of PROTECTED_FILE_ENV_VARS) add(processEnv[name]);
  const appsFile = processEnv[GITHUB_APPS_FILE_ENV]?.trim();
  if (appsFile) {
    try {
      const doc = JSON.parse(fs.readFileSync(appsFile, "utf8")) as unknown;
      const baseDir = path.dirname(path.resolve(appsFile));
      const walk = (node: unknown) => {
        if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === "object") {
          for (const [key, value] of Object.entries(node)) {
            if (/File$/.test(key) && typeof value === "string") add(path.resolve(baseDir, value));
            else walk(value);
          }
        }
      };
      walk(doc);
    } catch {
      // Unreadable or malformed: the server's own config check reports it. The
      // apps file path itself is still protected above.
    }
  }
  return [...paths];
}

function sanitizeForPath(pluginId: string): string {
  return pluginId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "plugin";
}

/**
 * Decide how to sandbox one worker. Throws {@link PluginWorkerSandboxError} when
 * the allowlist would cover an operator secret file; the worker must not start.
 */
export function planPluginWorkerSandbox(input: PluginWorkerSandboxInput): PluginWorkerSandboxPlan {
  const processEnv = input.processEnv ?? process.env;
  if (processEnv[PLUGIN_WORKER_SANDBOX_ENV]?.trim().toLowerCase() === "off") {
    return { mode: "disabled", reason: "operator-opt-out" };
  }

  const capabilities = (input.manifest.capabilities ?? []) as readonly string[];
  const exceptionCapability = UNSANDBOXED_TRUSTED_CAPABILITIES.find((c) => capabilities.includes(c));
  if (exceptionCapability) {
    const trustedRoots = (input.trustedPluginRoots ?? DEFAULT_TRUSTED_PLUGIN_ROOTS(processEnv)).map(realpathOrResolve);
    const entry = realpathOrResolve(input.entrypointPath);
    if (trustedRoots.some((root) => isWithin(root, entry))) {
      return { mode: "disabled", reason: "trusted-exception", capability: exceptionCapability };
    }
  }

  const tmpRoot = path.join(input.tmpRoot ?? os.tmpdir(), "paperclip-plugin-workers");
  const tmpDir = path.join(tmpRoot, sanitizeForPath(input.pluginId));
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const realTmpDir = realpathOrResolve(tmpDir);

  const read = new Set<string>();
  for (const p of moduleClosure(input.entrypointPath)) read.add(p);
  const hostExecArgv = withoutTsxLoader(input.execArgv ?? []);
  for (const target of importTargets(hostExecArgv)) {
    for (const p of moduleClosure(target)) read.add(p);
  }
  for (const entry of (processEnv.NODE_PATH ?? "").split(path.delimiter)) {
    if (entry.trim() && path.isAbsolute(entry) && fs.existsSync(entry)) read.add(realpathOrResolve(entry));
  }
  read.add(realTmpDir);
  const write = [realTmpDir];

  const readPaths = [...read].sort();
  for (const secret of collectProtectedSecretPaths(processEnv)) {
    const covering = [...readPaths, ...write].find((allowed) => isWithin(allowed, secret));
    if (covering) {
      throw new PluginWorkerSandboxError(
        `Refusing to start plugin worker "${input.pluginId}": its sandbox allowlist path ${covering} ` +
          `contains the operator secret file ${secret}. Move the secret outside the plugin and node_modules trees.`,
      );
    }
  }

  return {
    mode: "enforced",
    execArgv: [
      "--permission",
      ...readPaths.map((p) => `--allow-fs-read=${p}`),
      ...write.map((p) => `--allow-fs-write=${p}`),
      ...SANDBOX_TYPESCRIPT_EXEC_ARGV,
      ...hostExecArgv,
    ],
    env: { TMPDIR: realTmpDir, TMP: realTmpDir, TEMP: realTmpDir },
    readPaths,
    writePaths: write,
  };
}
