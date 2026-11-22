import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adapterExecutionTargetCommandEnv,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  type AdapterSandboxExecutionTarget,
} from "./execution-target.js";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { sanitizeRemoteExecutionEnv, serverProcessEnvKeysIn } from "./remote-execution-env.js";

// A value only the server process holds. No remote target may ever see it.
const SENTINEL_KEY = "PAPERCLIP_TEST_SERVER_ONLY_SECRET";
const SENTINEL = "server-only-sentinel-7f3a9c";

type ExecuteInput = Parameters<CommandManagedRuntimeRunner["execute"]>[0];

function recordingSandboxTarget(calls: ExecuteInput[]): AdapterSandboxExecutionTarget {
  return {
    kind: "remote",
    transport: "sandbox",
    providerKey: "test",
    remoteCwd: "/workspace",
    timeoutMs: 5_000,
    runner: {
      execute: async (input) => {
        calls.push(input);
        return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: new Date().toISOString() };
      },
    },
  };
}

function expectNoSentinel(calls: ExecuteInput[]) {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(JSON.stringify(call.env ?? {})).not.toContain(SENTINEL);
    expect(JSON.stringify([call.command, call.args ?? []])).not.toContain(SENTINEL);
    expect(call.stdin ?? "").not.toContain(SENTINEL);
  }
}

describe("sanitizeRemoteExecutionEnv", () => {
  it("drops every entry that carries the server's own value", () => {
    const serverEnv = { DATABASE_URL: "postgres://server", BETTER_AUTH_SECRET: "s", NODE_OPTIONS: "--x" };
    expect(
      sanitizeRemoteExecutionEnv(
        { ...serverEnv, PAPERCLIP_RUN_ID: "run-1", ANTHROPIC_MODEL: "x" },
        {},
        { serverEnv },
      ),
    ).toEqual({ PAPERCLIP_RUN_ID: "run-1", ANTHROPIC_MODEL: "x" });
  });

  it("keeps an adapter value that differs from the server's", () => {
    expect(
      sanitizeRemoteExecutionEnv({ ANTHROPIC_API_KEY: "agent-key" }, {}, { serverEnv: { ANTHROPIC_API_KEY: "server-key" } }),
    ).toEqual({ ANTHROPIC_API_KEY: "agent-key" });
  });

  it("keeps terminal and locale settings that equal the server's", () => {
    const serverEnv = { TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "C.UTF-8", LC_ALL: "C", CI: "1" };
    expect(sanitizeRemoteExecutionEnv({ ...serverEnv }, {}, { serverEnv })).toEqual(serverEnv);
  });

  it("keeps the API URL the runtime publishes to agents from the server env", () => {
    const serverEnv = { PAPERCLIP_API_URL: "http://paperclip:3100" };
    expect(sanitizeRemoteExecutionEnv({ ...serverEnv }, {}, { serverEnv })).toEqual(serverEnv);
  });

  it("still keeps explicit identity keys when the identity baseline is empty", () => {
    const serverEnv = { PATH: "/server/bin", SECRET: "s" };
    expect(sanitizeRemoteExecutionEnv({ ...serverEnv }, {}, { serverEnv })).toEqual({ PATH: "/server/bin" });
  });

  it("reports the dropped key names without values", () => {
    expect(serverProcessEnvKeysIn({ A: "1", B: "2", PATH: "/bin" }, { A: "1", B: "other", PATH: "/bin" })).toEqual(["A"]);
  });
});

describe("remote execution targets never receive the server env", () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env[SENTINEL_KEY];
    process.env[SENTINEL_KEY] = SENTINEL;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env[SENTINEL_KEY];
    else process.env[SENTINEL_KEY] = previous;
  });

  // The shape every adapter used to build for its command checks.
  const mergedEnv = () => ({ ...process.env, ADAPTER_SETTING: "kept" }) as Record<string, string>;

  it("adapterExecutionTargetCommandEnv keeps the server env for local targets only", () => {
    const calls: ExecuteInput[] = [];
    expect(adapterExecutionTargetCommandEnv(null, { ADAPTER_SETTING: "kept" })[SENTINEL_KEY]).toBe(SENTINEL);
    const remote = adapterExecutionTargetCommandEnv(recordingSandboxTarget(calls), { ADAPTER_SETTING: "kept" });
    expect(remote).toEqual({ ADAPTER_SETTING: "kept" });
  });

  it("ensureAdapterExecutionTargetCommandResolvable strips a merged server env", async () => {
    const calls: ExecuteInput[] = [];
    await ensureAdapterExecutionTargetCommandResolvable("claude", recordingSandboxTarget(calls), "/workspace", mergedEnv(), {
      installCommand: "true",
    });
    expectNoSentinel(calls);
    expect(calls[0]!.env?.ADAPTER_SETTING).toBe("kept");
  });

  it("runAdapterExecutionTargetProcess strips a merged server env", async () => {
    const calls: ExecuteInput[] = [];
    await runAdapterExecutionTargetProcess("run-1", recordingSandboxTarget(calls), "claude", ["--print", "-"], {
      cwd: "/workspace",
      env: mergedEnv(),
      stdin: "prompt",
      timeoutSec: 5,
      graceSec: 1,
      onLog: async () => {},
    });
    expectNoSentinel(calls);
    expect(calls[0]!.env?.ADAPTER_SETTING).toBe("kept");
  });

  it("runAdapterExecutionTargetShellCommand strips a merged server env", async () => {
    const calls: ExecuteInput[] = [];
    await runAdapterExecutionTargetShellCommand("run-1", recordingSandboxTarget(calls), "echo hi", {
      cwd: "/workspace",
      env: mergedEnv(),
    });
    expectNoSentinel(calls);
  });

  it("install and detect paths strip a merged server env", async () => {
    const calls: ExecuteInput[] = [];
    const target = recordingSandboxTarget(calls);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId: "run-1",
      target,
      installCommand: "npm i -g x",
      detectCommand: "x",
      cwd: "/workspace",
      env: mergedEnv(),
    });
    await maybeRunSandboxInstallCommand({ runId: "run-1", target, adapterKey: "x", installCommand: "npm i -g x", env: mergedEnv() });
    expectNoSentinel(calls);
  });

  it("an SSH target's command env is stripped the same way", () => {
    expect(sanitizeRemoteExecutionEnv(mergedEnv())[SENTINEL_KEY]).toBeUndefined();
  });
});
