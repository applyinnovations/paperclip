import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { sanitizeRemoteExecutionEnv } from "@paperclipai/adapter-utils/remote-execution-env";
import { buildSandboxToolCacheEnv, isSandboxToolCachePath, prepareSandboxToolCaches } from "./sandbox-tool-caches.js";

const remoteCwd = "/workspace/paperclip-workspace";
const cacheRoot = `${remoteCwd}/.paperclip-runtime/cache`;
const expectedEnv = {
  npm_config_cache: `${cacheRoot}/npm`,
  npm_config_store_dir: `${cacheRoot}/pnpm-store`,
  XDG_CACHE_HOME: `${cacheRoot}/xdg`,
  GOMODCACHE: `${cacheRoot}/go-mod`,
  npm_config_package_import_method: "hardlink",
};

// A sandbox runner that runs commands on this host, rooted in a temp dir.
function localRunner(): CommandManagedRuntimeRunner & { execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async (input) => {
    const startedAt = new Date().toISOString();
    try {
      const result = await promisify(execFile)(input.command, input.args ?? [], { cwd: input.cwd, timeout: 15_000 });
      return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: failure.code ?? 1,
        signal: null, timedOut: false, pid: null, startedAt };
    }
  });
  return { execute } as never;
}

describe("buildSandboxToolCacheEnv", () => {
  it("puts the tool caches under .paperclip-runtime/cache in the remote workspace", () => {
    expect(buildSandboxToolCacheEnv(remoteCwd, {})).toEqual({
      env: expectedEnv,
      directories: [`${cacheRoot}/npm`, `${cacheRoot}/pnpm-store`, `${cacheRoot}/xdg`, `${cacheRoot}/go-mod`],
    });
  });

  it("keeps an explicit operator or agent value, in either case for npm keys", () => {
    const { env, directories } = buildSandboxToolCacheEnv(remoteCwd, {
      TMPDIR: "/scratch",
      NPM_CONFIG_CACHE: "/npm-cache",
      XDG_CACHE_HOME: "   ",
      GOMODCACHE: "/go-mod",
      HOME: "/tmp/managed-home",
    });
    expect(env).toEqual({
      npm_config_store_dir: `${cacheRoot}/pnpm-store`,
      XDG_CACHE_HOME: `${cacheRoot}/xdg`,
      npm_config_package_import_method: "hardlink",
    });
    expect(directories).toEqual([`${cacheRoot}/pnpm-store`, `${cacheRoot}/xdg`]);
  });

  it("leaves TMPDIR alone: a temp dir inside the workspace repo breaks Git run from it", () => {
    expect(buildSandboxToolCacheEnv(remoteCwd, {}).env).not.toHaveProperty("TMPDIR");
  });

  it("only forces hardlinks for the store it places itself", () => {
    expect(buildSandboxToolCacheEnv(remoteCwd, { npm_config_store_dir: "/other-volume/store" }).env)
      .not.toHaveProperty("npm_config_package_import_method");
    expect(buildSandboxToolCacheEnv(remoteCwd, { npm_config_package_import_method: "copy" }).env)
      .not.toHaveProperty("npm_config_package_import_method");
  });
});

describe("prepareSandboxToolCaches", () => {
  it("creates the cache directories with mode 0700 and adds the env for a sandbox target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sandbox-tool-caches-"));
    try {
      const runner = localRunner();
      const result = await prepareSandboxToolCaches({
        runId: "run-1",
        target: { kind: "remote", transport: "sandbox", remoteCwd: root, runner },
        env: { HOME: "/tmp/managed-home", XDG_CONFIG_HOME: "/tmp/managed-home/config", CODEX_HOME: "/tmp/managed-home/provider" },
      });
      expect(result.applied).toBe(true);
      // Provider homes stay where the managed AI runtime put them.
      expect(result.env).toMatchObject({
        HOME: "/tmp/managed-home", XDG_CONFIG_HOME: "/tmp/managed-home/config", CODEX_HOME: "/tmp/managed-home/provider",
        npm_config_cache: path.posix.join(root, ".paperclip-runtime/cache/npm"),
        npm_config_store_dir: path.posix.join(root, ".paperclip-runtime/cache/pnpm-store"),
        XDG_CACHE_HOME: path.posix.join(root, ".paperclip-runtime/cache/xdg"),
        GOMODCACHE: path.posix.join(root, ".paperclip-runtime/cache/go-mod"),
      });
      for (const name of ["npm", "pnpm-store", "xdg", "go-mod"]) {
        const info = await stat(path.join(root, ".paperclip-runtime", "cache", name));
        expect(info.isDirectory()).toBe(true);
        expect(info.mode & 0o777).toBe(0o700);
      }
      // Idempotent: a warm sandbox's next run finds the directories in place.
      expect((await prepareSandboxToolCaches({
        runId: "run-2", target: { kind: "remote", transport: "sandbox", remoteCwd: root, runner }, env: {},
      })).applied).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not change local, SSH, or provider-task runs", async () => {
    const runShellCommand = vi.fn();
    const env = { PATH: "/bin" };
    for (const target of [
      null,
      { kind: "local" as const },
      { kind: "remote" as const, transport: "ssh" as const, remoteCwd, spec: {} as never },
      { kind: "remote" as const, transport: "sandbox" as const, remoteCwd, runnerTask: async () => undefined },
    ]) {
      const result = await prepareSandboxToolCaches({ runId: "run", target, env, runShellCommand });
      expect(result.applied).toBe(false);
      expect(result.env).toBe(env);
    }
    expect(runShellCommand).not.toHaveBeenCalled();
  });

  it("leaves the env unchanged when the directories cannot be created", async () => {
    const env = { PATH: "/bin" };
    const target = { kind: "remote" as const, transport: "sandbox" as const, remoteCwd, runner: localRunner() };
    const failed = await prepareSandboxToolCaches({
      runId: "run", target, env,
      runShellCommand: async () => ({ exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "mkdir: Permission denied", pid: null, startedAt: "" }),
    });
    expect(failed).toMatchObject({ applied: false, reason: "mkdir_failed", env });
    expect(failed.applied === false && failed.detail).toContain("Permission denied");
    const thrown = await prepareSandboxToolCaches({
      runId: "run", target, env, runShellCommand: async () => { throw new Error("sandbox gone"); },
    });
    expect(thrown).toMatchObject({ applied: false, reason: "mkdir_failed", detail: "sandbox gone", env });
  });

  it("survives remote env sanitizing when the server has its own XDG_CACHE_HOME", async () => {
    const runner = localRunner();
    const root = await mkdtemp(path.join(os.tmpdir(), "sandbox-tool-caches-"));
    try {
      const serverEnv = { TMPDIR: "/tmp", XDG_CACHE_HOME: "/home/paperclip/.cache", PATH: "/usr/bin" };
      const result = await prepareSandboxToolCaches({
        runId: "run", target: { kind: "remote", transport: "sandbox", remoteCwd: root, runner }, env: {},
      });
      // Adapters merge the server's env under the run env before dispatch.
      const merged = { ...serverEnv, ...result.env } as Record<string, string>;
      const sanitized = sanitizeRemoteExecutionEnv(merged, serverEnv, { serverEnv });
      expect(sanitized).toMatchObject({
        XDG_CACHE_HOME: path.posix.join(root, ".paperclip-runtime/cache/xdg"),
        npm_config_cache: path.posix.join(root, ".paperclip-runtime/cache/npm"),
        npm_config_store_dir: path.posix.join(root, ".paperclip-runtime/cache/pnpm-store"),
        GOMODCACHE: path.posix.join(root, ".paperclip-runtime/cache/go-mod"),
        npm_config_package_import_method: "hardlink",
      });
      // The process-session launch path sanitizes against an empty baseline.
      expect(sanitizeRemoteExecutionEnv(result.env as Record<string, string>, {}, { serverEnv }).XDG_CACHE_HOME)
        .toBe(path.posix.join(root, ".paperclip-runtime/cache/xdg"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recognizes only paths inside the workspace cache root as target-owned", () => {
    expect(isSandboxToolCachePath(remoteCwd, expectedEnv.XDG_CACHE_HOME)).toBe(true);
    expect(isSandboxToolCachePath(remoteCwd, cacheRoot)).toBe(true);
    expect(isSandboxToolCachePath(remoteCwd, "/home/paperclip/.cache")).toBe(false);
    expect(isSandboxToolCachePath(remoteCwd, `${cacheRoot}-other/xdg`)).toBe(false);
    expect(isSandboxToolCachePath(remoteCwd, `${cacheRoot}/../../../etc`)).toBe(false);
    expect(isSandboxToolCachePath(remoteCwd, ".paperclip-runtime/cache/xdg")).toBe(false);
    expect(isSandboxToolCachePath(remoteCwd, undefined)).toBe(false);
  });
});
