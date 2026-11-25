import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

// Tool output the agent itself printed. It carries the literal phrase the
// model-not-found detector scans for, but the provider never returned it.
const POISONED_TOOL_OUTPUT =
  'execute.ts:1199: : failed && isClaudeModelNotFoundError({ ... ? "model_not_found"';

function buildProcResult(resultEvent: Record<string, unknown>, extraStdout = "") {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      ...(extraStdout
        ? [
            JSON.stringify({
              type: "assistant",
              session_id: "claude-session-1",
              message: { content: [{ type: "text", text: extraStdout }] },
            }),
          ]
        : []),
      JSON.stringify({ type: "result", session_id: "claude-session-1", ...resultEvent }),
    ].join("\n"),
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  };
}

function mockExecutionResult(result: ReturnType<typeof buildProcResult>) {
  runAdapterExecutionTargetProcess.mockImplementation(async (_runId: string, _target: unknown, _command: string, args: string[]) =>
    args.includes("--version")
      ? { ...result, exitCode: 0, stdout: "2.1.284 (Claude Code)" }
      : result,
  );
}

function buildContext() {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { engine: "cli" },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local failure classification precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps max_turns_exhausted when stdout mentions model_not_found", async () => {
    mockExecutionResult(
      buildProcResult({ is_error: true, subtype: "error_max_turns" }, POISONED_TOOL_OUTPUT),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("max_turns_exhausted");
  });

  it("still reports model_not_found when the provider returns it", async () => {
    mockExecutionResult(
      buildProcResult({ is_error: true, subtype: "error", result: "API Error: 404 model not found" }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("model_not_found");
  });

  it("never classifies an OOM-killed run as claude_auth_required (APP-199)", async () => {
    const toolOutput = JSON.stringify({
      type: "user",
      session_id: "claude-session-1",
      message: { content: [{ type: "tool_result", content: "Error: not logged in to Claude. Please run /login" }] },
    });
    mockExecutionResult({
      exitCode: 137,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
        toolOutput,
      ].join("\n"),
      stderr: "",
      pid: 321,
      startedAt: new Date().toISOString(),
    });

    const result = await execute(buildContext() as never);

    expect(result.errorCode).not.toBe("claude_auth_required");
  });

  it("never classifies a signal-killed run as claude_auth_required, even with a login prompt on stderr", async () => {
    mockExecutionResult({
      exitCode: null,
      signal: "SIGKILL",
      timedOut: false,
      stdout: "",
      stderr: "Not logged in · Please run /login",
      pid: 321,
      startedAt: new Date().toISOString(),
    } as never);

    const result = await execute(buildContext() as never);

    expect(result.errorCode).not.toBe("claude_auth_required");
  });

  it("classifies a SIGKILLed run whose stdout ends mid-stream as process_killed, not claude_transient_upstream (APP-225)", async () => {
    // The OOM killer takes the whole pod cgroup: tsc first, then claude. The
    // last thing claude wrote is tool output that happens to match the
    // transient-upstream detector ("429", "try again later"), and the final
    // JSON line is cut off mid-object.
    const toolOutput = JSON.stringify({
      type: "user",
      session_id: "claude-session-1",
      message: { content: [{ type: "tool_result", content: "src/a.ts(429,7): error TS2322 ... try again later" }] },
    });
    mockExecutionResult({
      exitCode: 137,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
        toolOutput,
        '{"type":"assistant","session_id":"claude-session-1","message":{"content":[{"type":"text","text":"Service unavail',
      ].join("\n"),
      stderr: "",
      pid: 321,
      startedAt: new Date().toISOString(),
    });

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("process_killed");
    expect(result.errorFamily).toBeNull();
    expect(result.retryNotBefore).toBeNull();
    expect(result.errorMessage).toMatch(/killed by SIGKILL \(exit code 137\)/);
    expect(result.errorMessage).toMatch(/Do not rerun the last command unchanged/);
  });

  it("classifies a run killed with signal SIGKILL as process_killed even with an overload message on stderr", async () => {
    mockExecutionResult({
      exitCode: null,
      signal: "SIGKILL",
      timedOut: false,
      stdout: "",
      stderr: "API Error: 529 overloaded_error",
      pid: 321,
      startedAt: new Date().toISOString(),
    } as never);

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("process_killed");
    expect(result.errorFamily).toBeNull();
  });

  it("classifies a failed result event followed by SIGKILL as process_killed, not transient upstream", async () => {
    mockExecutionResult({
      ...buildProcResult({ is_error: true, subtype: "error", result: "API Error: 529 overloaded_error" }),
      exitCode: 137,
    });

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("process_killed");
    expect(result.errorFamily).toBeNull();
  });

  it("still reports claude_transient_upstream for an overload when the CLI exits on its own", async () => {
    mockExecutionResult(
      buildProcResult({ is_error: true, subtype: "error", result: "API Error: 529 overloaded_error" }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_transient_upstream");
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("still reports claude_auth_required for a real CLI login failure", async () => {
    mockExecutionResult(
      buildProcResult({ is_error: true, subtype: "success", result: "Not logged in · Please run /login" }),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorCode).toBe("claude_auth_required");
  });
});
