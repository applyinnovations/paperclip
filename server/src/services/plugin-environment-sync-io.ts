/**
 * Host-mediated sync I/O for environment-driver plugin workers.
 *
 * During an `environmentSyncIn` / `environmentSyncOut` call the host reads a
 * mapping's host source, or writes its host target, on the worker's behalf, so
 * a sandboxed worker never needs filesystem access to run workspaces. The
 * engine (streaming, member confinement, staged writes) is the SDK's
 * `@paperclipai/plugin-sdk/sync-host`; this module adds the server's policy:
 *
 * - one process-wide registry of per-call handles, bound to the plugin, the
 *   company and the call;
 * - a root policy: a declared host root may not be, contain, or sit inside a
 *   protected path (`collectProtectedSecretPaths()` and the rest of the local
 *   folder deny list), and may not be a shared parent of several workspaces or
 *   runs (the filesystem root, the home and tmp directories, the Paperclip home
 *   and instance roots, the instance `workspaces` and `projects` trees, or a
 *   company or project directory inside `projects`).
 *
 * @see doc/plugins/SANDBOX_FILE_SYNC_HOOKS.md — "Host-mediated sync I/O"
 */

import os from "node:os";
import path from "node:path";
import type { EnvironmentSyncIoMethodName, PluginSyncOperation, WorkerHostCallContext } from "@paperclipai/plugin-sdk";
import {
  createSyncHostIoRegistry,
  type SyncHostIoSession,
  type SyncHostRootRefusal,
} from "@paperclipai/plugin-sdk/sync-host";
import { resolvePaperclipHomeDir, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { findLocalFolderRootConflict, isWithin, realpathOrResolve } from "./plugin-protected-paths.js";

/** Depth below `<instance>/projects` of a per-project checkout: `<company>/<project>/<repo>`. */
const PROJECT_CHECKOUT_DEPTH = 3;

function sharedParentBases(): string[] {
  const instanceRoot = resolvePaperclipInstanceRoot();
  const bases = [
    path.parse(process.cwd()).root,
    os.homedir(),
    os.tmpdir(),
    resolvePaperclipHomeDir(),
    instanceRoot,
    path.join(instanceRoot, "workspaces"),
    path.join(instanceRoot, "projects"),
  ];
  return [...new Set(bases.flatMap((base) => [path.resolve(base), realpathOrResolve(base)]))];
}

/**
 * Refuse a sync host root that exposes a protected path or is a shared parent
 * of several workspaces. `realRoot` is canonical; `declaredRoot` is the path the
 * caller declared.
 */
export function findSyncHostRootRefusal(realRoot: string, declaredRoot = realRoot): SyncHostRootRefusal {
  for (const candidate of new Set([realRoot, path.resolve(declaredRoot)])) {
    const protectedPath = findLocalFolderRootConflict(candidate);
    if (protectedPath) {
      return { code: "protected_path", reason: "A sync host root is, contains, or sits inside a protected path." };
    }
    for (const base of sharedParentBases()) {
      if (isWithin(candidate, base)) {
        return { code: "confinement", reason: "A sync host root is a shared parent directory, not a per-run directory." };
      }
    }
    const projectsRoot = realpathOrResolve(path.join(resolvePaperclipInstanceRoot(), "projects"));
    if (isWithin(projectsRoot, candidate)) {
      const depth = path.relative(projectsRoot, candidate).split(path.sep).filter(Boolean).length;
      if (depth < PROJECT_CHECKOUT_DEPTH) {
        return { code: "confinement", reason: "A sync host root is a shared parent directory, not a per-run directory." };
      }
    }
  }
  return null;
}

const registry = createSyncHostIoRegistry({ checkRoot: findSyncHostRootRefusal });

/**
 * Mint the host I/O handle for one plugin sync call. Returns null when the
 * caller declared no host roots: the call then runs without host I/O, exactly
 * as before. Call `end()` once the call settles.
 */
export function beginEnvironmentSyncHostIo(input: {
  pluginId: string;
  companyId: string;
  direction: "in" | "out";
  operations: readonly PluginSyncOperation[];
  hostRoots: readonly string[] | undefined;
}): SyncHostIoSession | null {
  if (!input.hostRoots || input.hostRoots.length === 0) return null;
  return registry.begin(input);
}

/** The `environmentSync` host service for one plugin's worker. */
export function createEnvironmentSyncHostService(pluginId: string) {
  return {
    dispatch<M extends EnvironmentSyncIoMethodName>(method: M, params: unknown, context?: WorkerHostCallContext) {
      return registry.dispatch(method, params, {
        pluginId,
        companyId: context?.invocationScope?.companyId ?? null,
        invalidScope: context?.invalidInvocationScope === true,
      });
    },
  };
}

/** Live handle count, for leak checks in tests. */
export function activeEnvironmentSyncHostIoSessions(): number {
  return registry.activeSessionCount();
}
