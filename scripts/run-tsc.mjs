#!/usr/bin/env node
// Runs the calling package's tsc, honoring the repository's low-memory mode.
//
// TypeScript 7 is a native binary, so Node heap flags do not limit it. Each
// checker keeps its own copy of the types, which makes the checker count the
// most useful control a package has over its peak memory.
// scripts/typecheck-low-memory.mjs sets PAPERCLIP_TYPECHECK_LOW_MEMORY=1 so the
// largest programs check on a single thread. A process whose cgroup memory
// limit is below LOW_MEMORY_LIMIT_BYTES (an agent sandbox) uses that mode too
// unless the variable is 0: with the default checkers the server's first layer
// passed 3.4 GiB in a 4 GiB sandbox, and the kernel killed the agent with it.
//
// A build that only needs JavaScript sets PAPERCLIP_TSC_EMIT_ONLY=1. That build
// skips type checks and declarations, which use most of the memory of an emit.
// The Docker image uses this mode.
//
// Usage: node ../scripts/run-tsc.mjs [tsc arguments]

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOW_MEMORY_VARIABLE = "PAPERCLIP_TYPECHECK_LOW_MEMORY";
export const EMIT_ONLY_VARIABLE = "PAPERCLIP_TSC_EMIT_ONLY";
export const LOW_MEMORY_LIMIT_BYTES = 8 * 1024 ** 3;

/** The memory limit of this process's cgroup in bytes, or Infinity when there is none. */
export function cgroupMemoryLimit(read = (file) => readFileSync(file, "utf8")) {
  // cgroup v2, then v1. v1 reports no limit as a number near 2^63.
  for (const file of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    let text;
    try {
      text = read(file).trim();
    } catch {
      continue;
    }
    const bytes = Number(text);
    return Number.isSafeInteger(bytes) ? bytes : Infinity;
  }
  return Infinity;
}

export function lowMemoryTscArgs(env = process.env, memoryLimit = cgroupMemoryLimit()) {
  const setting = env[LOW_MEMORY_VARIABLE];
  const lowMemory = setting === undefined || setting === ""
    ? memoryLimit < LOW_MEMORY_LIMIT_BYTES
    : setting === "1";
  return lowMemory ? ["--singleThreaded"] : [];
}

export function emitOnlyTscArgs(env = process.env) {
  return env[EMIT_ONLY_VARIABLE] === "1"
    ? ["--noCheck", "--declaration", "false", "--declarationMap", "false"]
    : [];
}

export function runTsc(args, { cwd = process.cwd(), env = process.env } = {}) {
  const tsc = path.join(cwd, "node_modules", "typescript", "bin", "tsc");
  // tsc only accepts -b as its first argument, so the caller's arguments go first.
  const result = spawnSync(process.execPath, [tsc, ...args, ...lowMemoryTscArgs(env), ...emitOnlyTscArgs(env)], {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, signal: result.signal };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runTsc(process.argv.slice(2)).status;
}
