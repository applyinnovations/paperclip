// The login pseudo-terminal (PTY) session for the shared provider login flow
// (`claude setup-token`, `codex login --device-auth`). The login commands need a
// real terminal: on pipe stdio they print no prompt. This module runs the fixed
// command on a terminal exec in the lease's Sandbox pod and returns it as the
// session shape the plugin SDK login transport consumes.
//
// Command contract (same as the Daytona provider): the host resolves a closed
// command key and a server-controlled session home and sends both. The open
// request carries no command string. This module maps the key to a compile-time
// command, so a caller cannot select or override it, and it encodes the dynamic
// home as one POSIX shell argument, so the home cannot add a token or a command.
// The launch argv is fixed: `["/bin/sh", "-c", <line>]`, where the line `exec`s
// the command so its exit code is the exec's exit code.
//
// Session home: the module revalidates the descriptor shape, then creates the
// home with `mkdir -m 700 -p` as a plain argv exec (no shell). The directory lives
// in the sandbox, so the check is not a security boundary for the host; it keeps
// the credential the command writes private to the sandbox user.
//
// Dependency boundary: sandbox-provider plugins ship standalone (the workspace
// excludes `packages/plugins/sandbox-providers/**`) and import no workspace
// package at runtime, so this module keeps its own copy of the command table,
// as the Daytona provider does. A change to a login command lands in both.
//
// Secret handling: the browser code and the Enter byte travel over the exec
// stdin channel, never a command line. Output is forwarded raw; the host's login
// parser owns ANSI and OSC 8 handling and never logs the bytes.

import { shQuote } from "./pod-exec.js";

/** The closed set of login command identities. Matches the SDK `PluginLoginCommandKey`. */
export type LoginCommandKey = "claude" | "codex" | "grok";

/** The host-resolved launch descriptor. It carries no command string. */
export interface LoginPtyLaunchDescriptor {
  loginCommandKey: LoginCommandKey;
  /** Exact shape: `/tmp/paperclip-adapter-login/<uuid>`. */
  sessionHome: string;
}

/** The session shape the SDK login transport consumes (`PluginLoginPtyWorkerSession`). */
export interface LoginPtySession {
  onData(listener: (chunk: string) => void): void;
  write(data: string): void;
  wait(): Promise<{ exitCode: number | null }>;
  kill(): void;
  close(): Promise<void>;
}

const LOGIN_COMMAND_BY_KEY: Readonly<Record<LoginCommandKey, string>> = {
  claude: "claude setup-token",
  codex: "codex login --device-auth",
  grok: "grok login --device-auth",
};

/** The fixed root, one slash, one lowercase UUID. Rejects traversal, whitespace and metacharacters. */
const SESSION_HOME_PATTERN =
  /^\/tmp\/paperclip-adapter-login\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The fixed non-secret error for a rejected command key or session home. */
export const LOGIN_PTY_DESCRIPTOR_REJECTED = "LOGIN_PTY_DESCRIPTOR_REJECTED";
/** The fixed non-secret error when the session home cannot be created. */
export const LOGIN_PTY_HOME_REJECTED = "LOGIN_PTY_HOME_REJECTED";

export function isLoginCommandKey(value: unknown): value is LoginCommandKey {
  return value === "claude" || value === "codex" || value === "grok";
}

/**
 * Composes the shell line for the descriptor. It reads only the closed key and
 * the encoded home, so a command string smuggled onto the descriptor object
 * confers nothing. Codex and Grok get their home variable through `env`; Claude
 * prints its token and needs none.
 */
export function composeLaunchLine(descriptor: LoginPtyLaunchDescriptor): string {
  const command = LOGIN_COMMAND_BY_KEY[descriptor.loginCommandKey];
  const home = shQuote(descriptor.sessionHome);
  if (descriptor.loginCommandKey === "codex") return `exec env CODEX_HOME=${home} ${command}`;
  if (descriptor.loginCommandKey === "grok") return `exec env GROK_HOME=${home} ${command}`;
  return `exec ${command}`;
}

/** The fixed launch argv for the descriptor. */
export function composeLaunchArgv(descriptor: LoginPtyLaunchDescriptor): string[] {
  return ["/bin/sh", "-c", composeLaunchLine(descriptor)];
}

/** Fails closed on a key outside the closed set or a home of the wrong shape. */
export function assertLoginPtyDescriptor(descriptor: LoginPtyLaunchDescriptor): void {
  if (!isLoginCommandKey(descriptor.loginCommandKey)) throw new Error(LOGIN_PTY_DESCRIPTOR_REJECTED);
  if (typeof descriptor.sessionHome !== "string" || !SESSION_HOME_PATTERN.test(descriptor.sessionHome)) {
    throw new Error(LOGIN_PTY_DESCRIPTOR_REJECTED);
  }
}

/** The two pod operations a login session needs. Production binds them to one pod; tests fake them. */
export interface LoginPodExec {
  /** Runs `argv` (no shell) to completion and returns its exit code. */
  run(argv: string[]): Promise<{ exitCode: number }>;
  /** Opens `argv` on a terminal exec. */
  openPty(argv: string[]): Promise<LoginPtySession>;
}

/**
 * Opens a login session for `descriptor` in the pod `exec` is bound to:
 * revalidates the descriptor, creates the session home, then starts the fixed
 * command on a terminal.
 */
export async function openKubernetesLoginPtySession(
  exec: LoginPodExec,
  descriptor: LoginPtyLaunchDescriptor,
): Promise<LoginPtySession> {
  assertLoginPtyDescriptor(descriptor);
  let created: { exitCode: number };
  try {
    created = await exec.run(["mkdir", "-m", "700", "-p", descriptor.sessionHome]);
  } catch {
    throw new Error(LOGIN_PTY_HOME_REJECTED);
  }
  if (created.exitCode !== 0) throw new Error(LOGIN_PTY_HOME_REJECTED);
  return await exec.openPty(composeLaunchArgv(descriptor));
}
