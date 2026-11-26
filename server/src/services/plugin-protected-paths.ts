import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveDefaultConfigPath,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultSecretsKeyFilePath,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceRoot,
} from "../home-paths.js";
import { resolveBundledCatalogRoot } from "./bundled-plugins.js";

/**
 * Host paths no plugin may ever reach, neither through its own filesystem
 * access (the worker sandbox) nor through host RPC that reads files for it
 * (local folders). See doc/plugins/PLUGIN_SPEC.md §12.6.
 */

/** Env vars naming operator secret files that no worker may ever be able to read. */
const PROTECTED_FILE_ENV_VARS = [
  "PAPERCLIP_GITHUB_APPS_FILE",
  "PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE",
] as const;
const GITHUB_APPS_FILE_ENV = "PAPERCLIP_GITHUB_APPS_FILE";

/**
 * System trees no local folder may touch. `/run` and `/var/run` hold mounted
 * secrets (Kubernetes service account tokens, Docker secrets, and in our image
 * the master key, OIDC and MCP client secrets); `/proc` exposes every process's
 * environment (`/proc/<pid>/environ` holds DATABASE_URL and the auth secrets);
 * `/etc`, `/sys` and `/dev` are host configuration and devices.
 */
const SYSTEM_DENIED_DIRS = ["/run", "/var/run", "/proc", "/sys", "/dev", "/etc"] as const;

/**
 * The server's install root: the nearest ancestor of this module holding
 * `pnpm-workspace.yaml` (`/app` in the image, the checkout in development).
 * Walking up rather than a fixed `../../..` keeps it right for the bundled
 * `server/dist-runtime/index.mjs`, where a fixed hop count would land on `/`.
 */
export function resolveServerInstallRoot(startDir = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const MAX_SYMLINK_HOPS = 40;

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Resolve `p` to its canonical path by walking up to the nearest existing
 * ancestor, calling `fs.realpathSync` on that ancestor, and re-appending the
 * remaining missing path segments. Dangling symlinks encountered while walking
 * up are also followed relative to their canonical parent directory.
 *
 * Throws on filesystem errors other than `ENOENT`/`ENOTDIR` (for example
 * `EACCES` or `ELOOP`) so security callers can fail closed.
 */
export function resolveCanonicalPath(p: string): string {
  let current = path.resolve(p);
  let hops = 0;

  for (;;) {
    const trailing: string[] = [];
    let probe = current;
    let followedSymlink = false;

    for (;;) {
      try {
        const realAncestor = fs.realpathSync(probe);
        return trailing.length > 0 ? path.join(realAncestor, ...trailing.reverse()) : realAncestor;
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }

      let isSymlink = false;
      try {
        isSymlink = fs.lstatSync(probe).isSymbolicLink();
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) throw lstatError;
      }

      if (isSymlink) {
        hops += 1;
        if (hops > MAX_SYMLINK_HOPS) {
          const loopError = new Error(`Too many levels of symbolic links while resolving ${p}`) as NodeJS.ErrnoException;
          loopError.code = "ELOOP";
          throw loopError;
        }
        const linkDir = fs.realpathSync(path.dirname(probe));
        const target = fs.readlinkSync(probe);
        const resolvedTarget = path.resolve(linkDir, target);
        current = trailing.length > 0 ? path.join(resolvedTarget, ...trailing.reverse()) : resolvedTarget;
        followedSymlink = true;
        break;
      }

      const parent = path.dirname(probe);
      if (parent === probe) {
        return trailing.length > 0 ? path.join(probe, ...trailing.reverse()) : probe;
      }
      trailing.push(path.basename(probe));
      probe = parent;
    }

    if (!followedSymlink) return current;
  }
}

export function realpathOrResolve(p: string): string {
  try {
    return resolveCanonicalPath(p);
  } catch {
    return path.resolve(p);
  }
}

export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function addPath(paths: Set<string>, p: unknown) {
  if (typeof p !== "string" || !p.trim()) return;
  const resolved = path.resolve(p.trim());
  paths.add(resolved);
  paths.add(realpathOrResolve(resolved));
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
  for (const name of PROTECTED_FILE_ENV_VARS) addPath(paths, processEnv[name]);
  const appsFile = processEnv[GITHUB_APPS_FILE_ENV]?.trim();
  if (appsFile) {
    try {
      const doc = JSON.parse(fs.readFileSync(appsFile, "utf8")) as unknown;
      const baseDir = path.dirname(path.resolve(appsFile));
      const walk = (node: unknown) => {
        if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === "object") {
          for (const [key, value] of Object.entries(node)) {
            if (/File$/.test(key) && typeof value === "string") addPath(paths, path.resolve(baseDir, value));
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

export interface LocalFolderDeniedPaths {
  /** A local folder root may not be, or contain, any of these. */
  files: string[];
  /** A local folder root may not be, contain, or sit inside any of these. */
  dirs: string[];
}

/**
 * Directories holding code the host executes: the server install root (which
 * contains the repo plugin tree and node_modules), the bundled plugin catalog
 * (in the image, including the writable distribution emptyDir under it), the
 * local plugin install dir and the external adapter plugin dir. `/` is never
 * returned: it would deny every root.
 */
export function collectHostCodeDirs(processEnv: NodeJS.ProcessEnv = process.env): string[] {
  const paperclipHome = resolvePaperclipHomeDir();
  const candidates = [
    resolveServerInstallRoot(),
    resolveBundledCatalogRoot(processEnv),
    // DEFAULT_LOCAL_PLUGIN_DIR (plugin-loader.ts), plus its PAPERCLIP_HOME form.
    path.join(os.homedir(), ".paperclip", "plugins"),
    path.join(paperclipHome, "plugins"),
    // adapter-plugin-store.ts: external adapters are imported into the server process.
    path.join(paperclipHome, "adapter-plugins"),
  ];
  const dirs = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    const resolved = path.resolve(candidate);
    if (path.dirname(resolved) === resolved) continue;
    dirs.add(resolved);
  }
  return [...dirs];
}

/**
 * Paths a plugin local-folder root must stay clear of. The host reads and
 * writes local folders on the plugin's behalf, so a root over any of these
 * would hand the plugin the file through RPC even though its own sandbox
 * denies it.
 */
export function collectLocalFolderDeniedPaths(processEnv: NodeJS.ProcessEnv = process.env): LocalFolderDeniedPaths {
  const files = new Set<string>(collectProtectedSecretPaths(processEnv));
  const dirs = new Set<string>();

  const masterKeyFile = processEnv.PAPERCLIP_SECRETS_MASTER_KEY_FILE?.trim() || resolveDefaultSecretsKeyFilePath();
  addPath(files, masterKeyFile);
  addPath(dirs, path.dirname(path.resolve(masterKeyFile)));
  addPath(dirs, path.join(resolvePaperclipInstanceRoot(), "secrets"));
  addPath(dirs, resolveDefaultEmbeddedPostgresDir());

  const configFile = processEnv.PAPERCLIP_CONFIG?.trim() || resolveDefaultConfigPath();
  addPath(files, configFile);
  addPath(files, path.join(path.dirname(path.resolve(configFile)), ".env"));

  for (const dir of SYSTEM_DENIED_DIRS) addPath(dirs, dir);

  // Code the host runs or loads. Host writes through a readWrite folder over
  // any of these would let a plugin replace trusted plugin code (which runs
  // unsandboxed as a trusted exception), another plugin's worker, an adapter
  // the server imports in-process, or the server itself.
  for (const dir of collectHostCodeDirs(processEnv)) addPath(dirs, dir);
  return { files: [...files], dirs: [...dirs] };
}

/**
 * Returns the protected path a local folder root would expose, or null when the
 * root is clear. Checks both the configured path and its realpath.
 */
export function findLocalFolderRootConflict(
  root: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates = [...new Set([path.resolve(root), realpathOrResolve(root)])];
  const denied = collectLocalFolderDeniedPaths(processEnv);
  for (const candidate of candidates) {
    for (const file of denied.files) {
      if (isWithin(candidate, file)) return file;
    }
    for (const dir of denied.dirs) {
      if (isWithin(candidate, dir) || isWithin(dir, candidate)) return dir;
    }
  }
  return null;
}
