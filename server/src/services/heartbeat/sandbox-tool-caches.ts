import path from "node:path";
import {
  runAdapterExecutionTargetShellCommand,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";

/**
 * Sandbox tool caches (APP-20).
 *
 * A sandbox pod mounts `/tmp` as an emptyDir, and a run's provider homes
 * (HOME, XDG_CONFIG_HOME, ...) live there too, so package stores and build
 * caches land on `/tmp` and the kubelet evicts the pod when they outgrow it.
 * Point the heavy, rebuildable caches at the workspace volume instead, under
 * `<remoteCwd>/.paperclip-runtime/cache/`:
 *
 * - `.paperclip-runtime` is git-ignored and excluded from sync-out and the
 *   workspace baseline, so cache contents never ship back as edits.
 * - The pnpm store shares a filesystem with `node_modules`, so pnpm hardlinks
 *   instead of copying.
 * - Go writes its module cache read-only. That is safe here: `.paperclip-runtime`
 *   is preserved by the workspace wipe, and the volume goes away with the pod.
 *
 * Provider homes stay where they are: they are small and hold credentials that
 * do not belong on the synced volume.
 *
 * TMPDIR stays on `/tmp` too. A temp dir under `.paperclip-runtime/` sits inside
 * the workspace repo's ignored tree, so Git run from it finds the workspace
 * repo, and `git ls-files --ignored --directory` fails with an internal error.
 * Paperclip's own Git runner drops `GIT_*` env, so `GIT_CEILING_DIRECTORIES`
 * cannot fence it off. Tests that expect a fresh temp dir outside any repo
 * broke. Temp files are short-lived; the persistent caches are what grow.
 */
export const SANDBOX_TOOL_CACHE_RELATIVE_ROOT = path.posix.join(".paperclip-runtime", "cache");

const SANDBOX_TOOL_CACHE_DIRECTORIES = {
  npm_config_cache: "npm",
  npm_config_store_dir: "pnpm-store",
  XDG_CACHE_HOME: "xdg",
  // Go's build cache (GOCACHE) already follows XDG_CACHE_HOME, but the module
  // cache defaults to $GOPATH/pkg/mod, i.e. $HOME/go on /tmp. Move only the
  // module cache: GOPATH also decides where `go install` puts binaries.
  GOMODCACHE: "go-mod",
} as const;

type SandboxToolCacheDirectoryKey = keyof typeof SANDBOX_TOOL_CACHE_DIRECTORIES;

/**
 * pnpm's default import method (`auto`) clones files on a reflink-capable
 * filesystem such as the sandbox's XFS volumes. A clone is a separate inode,
 * so `du` and the XFS project quota kubelet uses for emptyDir limits charge it
 * in full: a monorepo install measured 7.2 GB on `/workspace` with clones and
 * 3.7 GB with hardlinks. Ask for hardlinks only when the store is ours, so it
 * is known to share a filesystem with the workspace's `node_modules`.
 */
const PNPM_IMPORT_METHOD_KEY = "npm_config_package_import_method";

export type SandboxToolCacheKey = SandboxToolCacheDirectoryKey | typeof PNPM_IMPORT_METHOD_KEY;

export const SANDBOX_TOOL_CACHE_KEYS = [
  ...Object.keys(SANDBOX_TOOL_CACHE_DIRECTORIES) as SandboxToolCacheDirectoryKey[],
  PNPM_IMPORT_METHOD_KEY,
] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function hasExplicitValue(env: Record<string, unknown>, key: string): boolean {
  // npm reads its config keys case-insensitively (npm_config_cache and
  // NPM_CONFIG_CACHE are the same setting), so either spelling counts as an
  // explicit operator or agent choice.
  const upper = key.toUpperCase();
  return Object.entries(env).some(
    ([candidate, value]) => candidate.toUpperCase() === upper && typeof value === "string" && value.trim().length > 0,
  );
}

/**
 * The cache env for a run in `remoteCwd`. Keys the run env already sets are
 * left out, so an explicit operator or agent value wins.
 */
export function buildSandboxToolCacheEnv(
  remoteCwd: string,
  existingEnv: Record<string, unknown>,
): { env: Partial<Record<SandboxToolCacheKey, string>>; directories: string[] } {
  const root = path.posix.join(remoteCwd, SANDBOX_TOOL_CACHE_RELATIVE_ROOT);
  const env: Partial<Record<SandboxToolCacheKey, string>> = {};
  const directories: string[] = [];
  for (const key of Object.keys(SANDBOX_TOOL_CACHE_DIRECTORIES) as SandboxToolCacheDirectoryKey[]) {
    if (hasExplicitValue(existingEnv, key)) continue;
    const directory = path.posix.join(root, SANDBOX_TOOL_CACHE_DIRECTORIES[key]);
    env[key] = directory;
    directories.push(directory);
  }
  if (env.npm_config_store_dir && !hasExplicitValue(existingEnv, PNPM_IMPORT_METHOD_KEY)) {
    env[PNPM_IMPORT_METHOD_KEY] = "hardlink";
  }
  return { env, directories };
}

export type SandboxToolCachesResult =
  | { applied: true; env: Record<string, unknown>; appliedEnv: Partial<Record<SandboxToolCacheKey, string>> }
  | { applied: false; env: Record<string, unknown>; reason: "not_sandbox" | "provider_task" | "nothing_to_set" | "mkdir_failed"; detail?: string };

/**
 * Adds the sandbox tool cache env to a run env and creates the directories
 * (mode 0700) in the sandbox before the agent command runs.
 *
 * Only command-capable sandbox targets change. Local and SSH runs keep their
 * env, and provider-owned runner tasks decide their own runtime layout. If the
 * directories cannot be created, the env is returned unchanged: a TMPDIR that
 * does not exist breaks more tools than a full `/tmp`.
 */
export async function prepareSandboxToolCaches(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  env: Record<string, unknown>;
  runShellCommand?: typeof runAdapterExecutionTargetShellCommand;
}): Promise<SandboxToolCachesResult> {
  const target = input.target;
  if (!target || target.kind !== "remote" || target.transport !== "sandbox") {
    return { applied: false, env: input.env, reason: "not_sandbox" };
  }
  if (target.runnerTask) return { applied: false, env: input.env, reason: "provider_task" };
  const { env, directories } = buildSandboxToolCacheEnv(target.remoteCwd, input.env);
  if (directories.length === 0) return { applied: false, env: input.env, reason: "nothing_to_set" };
  const quoted = directories.map(shellQuote).join(" ");
  const runShellCommand = input.runShellCommand ?? runAdapterExecutionTargetShellCommand;
  try {
    const result = await runShellCommand(input.runId, target, `umask 077 && mkdir -p ${quoted} && chmod 700 ${quoted}`, {
      cwd: target.remoteCwd,
      env: {},
      timeoutSec: 30,
    });
    if (result.timedOut || result.exitCode !== 0) {
      return {
        applied: false, env: input.env, reason: "mkdir_failed",
        detail: `exit=${result.exitCode} timedOut=${result.timedOut} ${(result.stderr ?? "").trim().slice(-512)}`.trim(),
      };
    }
  } catch (error) {
    return { applied: false, env: input.env, reason: "mkdir_failed", detail: error instanceof Error ? error.message : String(error) };
  }
  return { applied: true, env: { ...input.env, ...env }, appliedEnv: env };
}
