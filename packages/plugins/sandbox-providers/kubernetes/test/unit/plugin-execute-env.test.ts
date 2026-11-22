import { describe, expect, it, vi } from "vitest";

// The exec request URI carries the argv, and the kube-apiserver audit log
// records it. These tests run environmentExecute against a recorded execInPod
// and assert that run env values never reach the argv.
const h = vi.hoisted(() => ({
  calls: [] as Array<{ command: string[]; stdin: string | Buffer | undefined }>,
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => ({})),
}));

vi.mock("../../src/sandbox-cr-orchestrator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/sandbox-cr-orchestrator.js")>();
  return {
    ...actual,
    sandboxCrOrchestrator: {
      ...actual.sandboxCrOrchestrator,
      waitForCompletion: vi.fn(async () => undefined),
      findPod: vi.fn(async () => "pc-env-pod"),
    },
  };
});

vi.mock("../../src/pod-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pod-exec.js")>();
  return {
    ...actual,
    execInPod: vi.fn(async (
      _kc: unknown, _ns: string, _pod: string, _container: string,
      command: string[], stdin?: string | Buffer,
    ) => {
      h.calls.push({ command, stdin });
      return { exitCode: 0, stdout: "", stderr: "" };
    }),
  };
});

import plugin from "../../src/plugin.js";

const SENTINEL = "server-secret-sentinel-0123456789";

function execute(leaseId: string, input: { command: string; args?: string[]; stdin?: string }) {
  return plugin.definition.onEnvironmentExecute!({
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    config: { inCluster: true, backend: "sandbox-cr" },
    lease: {
      providerLeaseId: leaseId,
      metadata: { namespace: "paperclip-acme", podName: "pc-env-pod", backend: "sandbox-cr" },
    },
    command: input.command,
    args: input.args,
    cwd: "/workspace",
    env: { DATABASE_URL: `postgres://u:${SENTINEL}@db/x`, CLAUDE_CODE_OAUTH_TOKEN: SENTINEL, MULTI: `a\n${SENTINEL}'b` },
    stdin: input.stdin,
    timeoutMs: 10_000,
  });
}

describe("onEnvironmentExecute env transport", () => {
  it("keeps env values out of the exec argv for a command with args", async () => {
    h.calls.length = 0;
    const result = await execute("pc-env-a", { command: "claude", args: ["--print", "-"], stdin: "prompt" });
    expect(result.exitCode).toBe(0);
    expect(h.calls).toHaveLength(1);
    const [{ command, stdin }] = h.calls;
    expect(command.join("\u0000")).not.toContain(SENTINEL);
    expect(command.join("\u0000")).not.toContain("DATABASE_URL");
    expect(command.slice(-3)).toEqual(["claude", "--print", "-"]);
    // The values ride on stdin, base64-encoded ahead of the caller's stdin.
    expect(String(stdin)).not.toContain(SENTINEL);
    const [envLine, ...rest] = String(stdin).split("\n");
    expect(rest.join("\n")).toBe("prompt");
    expect(Buffer.from(envLine!, "base64").toString("utf-8")).toContain(SENTINEL);
  });

  it("keeps env values out of the exec argv for a shell command string", async () => {
    h.calls.length = 0;
    await execute("pc-env-b", { command: "echo hello" });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.command.join("\u0000")).not.toContain(SENTINEL);
    expect(h.calls[0]!.command.slice(-3)).toEqual(["/bin/sh", "-lc", "echo hello"]);
  });
});
