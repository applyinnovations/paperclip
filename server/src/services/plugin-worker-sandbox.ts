import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { resolveBundledCatalogRoot } from "./bundled-plugins.js";
import {
  collectProtectedSecretPaths,
  isWithin,
  realpathOrResolve,
  resolveCanonicalPath,
} from "./plugin-protected-paths.js";

export { collectProtectedSecretPaths };

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
 * A plugin from a trusted plugin root may declare extra read-only paths in
 * `manifest.sandbox.fsRead`. They are ignored (with a warning) for any other
 * plugin, and a grant at, above or beside a protected secret file refuses the
 * worker start.
 *
 * See doc/plugins/PLUGIN_SPEC.md §12.6.
 */

/** Operator-only escape hatch: `off` runs workers without the sandbox (local development). */
export const PLUGIN_WORKER_SANDBOX_ENV = "PAPERCLIP_PLUGIN_WORKER_SANDBOX";

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
  | {
      mode: "disabled";
      reason: "operator-opt-out" | "trusted-exception";
      capability?: string;
      /** The host's execArgv plus {@link WORKER_HARDENING_EXEC_ARGV} and the startup probe. */
      execArgv: string[];
      /** Env to merge into the worker env (the startup probe's path list). */
      env: Record<string, string>;
      /** Protected secret paths the startup probe tries to open. */
      probePaths: string[];
    }
  | {
      mode: "enforced";
      /** The worker's complete execArgv (sandbox flags plus the host's, minus any tsx loader). */
      execArgv: string[];
      /** Env to merge into the worker env (TMPDIR and friends). */
      env: Record<string, string>;
      readPaths: string[];
      writePaths: string[];
      /** Protected secret paths the startup probe tries to open. */
      probePaths: string[];
      /** Manifest `sandbox.fsRead` grants added to `readPaths` (as declared and their realpaths). */
      grantedReadPaths: string[];
      /** Set when the manifest declared read grants the host did not honour. */
      ignoredReadGrants?: { paths: string[]; reason: "untrusted-plugin-root" };
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
  manifest: Pick<PaperclipPluginManifestV1, "capabilities" | "sandbox">;
  execArgv?: readonly string[];
  /** Defaults to process.env. */
  processEnv?: NodeJS.ProcessEnv;
  /** Test seam; defaults to the repo plugin tree and the bundled catalog root. */
  trustedPluginRoots?: readonly string[];
  /** Test seam; parent of every per-worker tmp directory. Defaults to os.tmpdir(). */
  tmpRoot?: string;
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

/**
 * Flags for every plugin worker, sandboxed or not. The permission model does not
 * restrict `process.kill`, and Node opens its inspector on SIGUSR1, so without
 * this a worker could signal a sibling worker into opening an inspector it can
 * then drive. The server itself must run with the same flag (Dockerfile CMD);
 * otherwise a worker can signal its parent the same way.
 */
export const WORKER_HARDENING_EXEC_ARGV = ["--disable-sigusr1"] as const;

/** Env var carrying the startup probe's path list (JSON array) into the worker. */
export const SANDBOX_PROBE_PATHS_ENV = "PAPERCLIP_PLUGIN_SANDBOX_PROBE_PATHS";
/** IPC message type the startup probe sends to the host. */
export const SANDBOX_PROBE_MESSAGE_TYPE = "paperclip.sandboxProbe";

/**
 * Startup probe, the first module every worker runs (sandboxed or not), before
 * any plugin code. It tries to open each protected secret path the host names
 * and reports only the outcome: `readable` or the error code (ERR_ACCESS_DENIED
 * under the sandbox). It never reads: a file that opens is closed at once. The
 * result goes to the host over the IPC channel; plugin code runs later, so the
 * host takes the first probe message and ignores any after it. This lets
 * production verify isolation inside the real running worker from logs alone,
 * with no exec into the pod. See PLUGIN_SPEC.md §12.6.
 */
const SANDBOX_PROBE_SOURCE = `
import fs from "node:fs";
const raw = process.env.${SANDBOX_PROBE_PATHS_ENV};
delete process.env.${SANDBOX_PROBE_PATHS_ENV};
let paths = [];
try { const parsed = JSON.parse(raw ?? "[]"); if (Array.isArray(parsed)) paths = parsed.filter((p) => typeof p === "string"); } catch {}
const results = [];
for (const path of paths) {
  let fd;
  let outcome;
  try { fd = fs.openSync(path, "r"); outcome = "readable"; }
  catch (error) { outcome = (error && typeof error.code === "string") ? error.code : "error"; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
  results.push({ path, outcome });
}
if (typeof process.send === "function") process.send({ type: "${SANDBOX_PROBE_MESSAGE_TYPE}", results });
`;
export const SANDBOX_PROBE_URL = `data:text/javascript,${encodeURIComponent(SANDBOX_PROBE_SOURCE)}`;
/** Runs the startup probe first, ahead of any host `--import`. */
export const WORKER_PROBE_EXEC_ARGV = ["--import", SANDBOX_PROBE_URL] as const;

/**
 * Extra flags for sandboxed workers. `node:sqlite` opens database files without
 * consulting the permission model, so it would read and write outside the
 * allowlist.
 */
export const SANDBOX_HARDENING_EXEC_ARGV = ["--no-experimental-sqlite"] as const;

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

function resolveGrantCandidates(grant: string): string[] {
  const declared = path.resolve(grant);
  let canonical: string;
  try {
    canonical = resolveCanonicalPath(declared);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw new PluginWorkerSandboxError(
      `Refusing manifest read grant ${grant}: cannot resolve canonical path${code ? ` (${code})` : ""}.`,
    );
  }
  return [...new Set([declared, canonical])];
}

/**
 * Returns the protected secret file a read grant would reach, or null when the
 * grant is clear. A grant may not be, contain, or sit in the directory of an
 * operator secret file: that covers the file itself, every ancestor (`/`,
 * `/etc`, ...), its parent directory and any sibling in it. Both the declared
 * path and its canonical path (resolving the nearest existing ancestor and any
 * symlinks along the way when the target does not yet exist) are checked for
 * both grants and protected secret paths, so a symlink to a forbidden location
 * is refused even for nonexistent descendants. Fails closed with
 * {@link PluginWorkerSandboxError} if canonicalising the grant fails for any
 * reason other than missing path components (for example `EACCES` or `ELOOP`).
 */
export function findForbiddenReadGrant(grant: string, protectedSecretPaths: readonly string[]): string | null {
  const grantCandidates = resolveGrantCandidates(grant);
  for (const secret of protectedSecretPaths) {
    const secretCandidates = [...new Set([path.resolve(secret), realpathOrResolve(secret)])];
    for (const secretPath of secretCandidates) {
      const secretDir = path.dirname(secretPath);
      for (const candidate of grantCandidates) {
        if (isWithin(candidate, secretPath) || isWithin(secretDir, candidate)) return secret;
      }
    }
  }
  return null;
}

function isTrustedPluginEntry(input: PluginWorkerSandboxInput, processEnv: NodeJS.ProcessEnv): boolean {
  const trustedRoots = (input.trustedPluginRoots ?? DEFAULT_TRUSTED_PLUGIN_ROOTS(processEnv)).map(realpathOrResolve);
  const entry = realpathOrResolve(input.entrypointPath);
  return trustedRoots.some((root) => isWithin(root, entry));
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
  const probePaths = collectProtectedSecretPaths(processEnv);
  const probeEnv = { [SANDBOX_PROBE_PATHS_ENV]: JSON.stringify(probePaths) };
  if (processEnv[PLUGIN_WORKER_SANDBOX_ENV]?.trim().toLowerCase() === "off") {
    return {
      mode: "disabled",
      reason: "operator-opt-out",
      execArgv: [...WORKER_HARDENING_EXEC_ARGV, ...WORKER_PROBE_EXEC_ARGV, ...(input.execArgv ?? [])],
      env: probeEnv,
      probePaths,
    };
  }

  const capabilities = (input.manifest.capabilities ?? []) as readonly string[];
  const exceptionCapability = UNSANDBOXED_TRUSTED_CAPABILITIES.find((c) => capabilities.includes(c));
  if (exceptionCapability) {
    if (isTrustedPluginEntry(input, processEnv)) {
      return {
        mode: "disabled",
        reason: "trusted-exception",
        capability: exceptionCapability,
        execArgv: [...WORKER_HARDENING_EXEC_ARGV, ...WORKER_PROBE_EXEC_ARGV, ...(input.execArgv ?? [])],
        env: probeEnv,
        probePaths,
      };
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

  const declaredGrants = input.manifest.sandbox?.fsRead ?? [];
  const grantedReadPaths: string[] = [];
  let ignoredReadGrants: { paths: string[]; reason: "untrusted-plugin-root" } | undefined;
  if (declaredGrants.length > 0) {
    if (isTrustedPluginEntry(input, processEnv)) {
      for (const grant of declaredGrants) {
        const secret = findForbiddenReadGrant(grant, probePaths);
        if (secret) {
          throw new PluginWorkerSandboxError(
            `Refusing to start plugin worker "${input.pluginId}": its manifest read grant ${grant} ` +
              `is, contains or sits beside the operator secret file ${secret}. Read grants may not reach ` +
              `a protected secret file, its directory or any ancestor of it.`,
          );
        }
        // fs calls are checked against the path as given and module loads against
        // the realpath, so grant both; findForbiddenReadGrant checked both.
        for (const p of resolveGrantCandidates(grant)) {
          grantedReadPaths.push(p);
          read.add(p);
        }
      }
    } else {
      ignoredReadGrants = { paths: [...declaredGrants], reason: "untrusted-plugin-root" };
    }
  }

  const readPaths = [...read].sort();
  for (const secret of probePaths) {
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
      ...WORKER_HARDENING_EXEC_ARGV,
      ...WORKER_PROBE_EXEC_ARGV,
      ...SANDBOX_HARDENING_EXEC_ARGV,
      ...readPaths.map((p) => `--allow-fs-read=${p}`),
      ...write.map((p) => `--allow-fs-write=${p}`),
      ...SANDBOX_TYPESCRIPT_EXEC_ARGV,
      ...hostExecArgv,
    ],
    env: { TMPDIR: realTmpDir, TMP: realTmpDir, TEMP: realTmpDir, ...probeEnv },
    readPaths,
    writePaths: write,
    probePaths,
    grantedReadPaths,
    ...(ignoredReadGrants ? { ignoredReadGrants } : {}),
  };
}
