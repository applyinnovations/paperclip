/**
 * Exec a command inside a running pod container using the Kubernetes exec API.
 *
 * Uses @kubernetes/client-node's Exec class, which opens a WebSocket to the
 * kube-apiserver and streams stdout/stderr. The statusCallback receives a V1Status
 * with status="Success" or status="Failure" + details.causes[{reason:"ExitCode"}].
 *
 * NOTE: tty=false so stdout and stderr arrive on separate channels. If tty=true
 * were used, they would be merged onto stdout and the exit code would not be
 * reliable from the status callback on older cluster versions.
 *
 * Stdin handling: @kubernetes/client-node v1.x attaches `stdin.on("end", ()
 * => ws.close())`, which closes the entire WebSocket as soon as our PassThrough
 * ends — BEFORE the pod's command has a chance to flush and BEFORE the
 * statusCallback fires. We work around this by removing that listener after
 * exec setup completes so EOF on stdin only signals the pod (via a stdin-
 * channel close frame implicit in our flow) without tearing down the
 * connection. We then close the WebSocket explicitly inside the statusCallback.
 */

import { Exec } from "@kubernetes/client-node";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";
import type { KubeConfig } from "@kubernetes/client-node";

/**
 * Turn whatever the Kubernetes client rejected with into a readable message.
 *
 * `Exec.exec` rejects with a non-`Error` when the WebSocket upgrade fails: a
 * `ws` `ErrorEvent` (`{ type, message, error, target }`) when the apiserver or
 * pod is unreachable, or a `V1Status`-shaped body when the apiserver refuses
 * the exec (for example a pod that is gone). `String(obj)` on either is
 * `"[object Object]"`, which is how a dead sandbox used to surface as
 * `stderr: [object Object]` (APP-762).
 */
export function describeExecError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  if (Buffer.isBuffer(err)) return err.toString("utf8");
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof record.type === "string" && record.type !== "error") parts.push(record.type);
    if (typeof record.status === "string") parts.push(record.status);
    if (typeof record.code === "number" || typeof record.code === "string") parts.push(`code ${String(record.code)}`);
    if (typeof record.reason === "string" && record.reason.length > 0) parts.push(record.reason);
    if (typeof record.message === "string" && record.message.length > 0) parts.push(record.message);
    if (record.error instanceof Error && record.error.message && record.error.message !== record.message) {
      parts.push(record.error.message);
    }
    if (parts.length > 0) return parts.join(": ");
    try {
      // Skip `target` (an ErrorEvent's WebSocket) so JSON never walks a socket.
      const json = JSON.stringify(err, (key, value) => (key === "target" ? undefined : value));
      if (json && json !== "{}") return json;
    } catch {
      // Circular or otherwise unserializable; fall through.
    }
    const ctor = (err as { constructor?: { name?: unknown } }).constructor?.name;
    return `non-Error exec failure (${typeof ctor === "string" ? ctor : "object"})`;
  }
  return String(err);
}

/** Normalize a client rejection into an `Error` with a readable message. */
export function toExecError(err: unknown): Error {
  return err instanceof Error ? err : new Error(describeExecError(err));
}

// Minimal WebSocket-like shape covering what we touch. The full type comes from
// @kubernetes/client-node's transitive ws/isomorphic-ws dep but importing it
// directly couples this file to that internal choice. `send`, `pause` and
// `resume` are the `ws` package's own API; the streaming exec uses them for
// flow control (see `execInPodStreaming`).
type WebSocketLike = {
  close(): void;
  send?(data: Buffer, cb?: (err?: Error) => void): void;
  pause?(): void;
  resume?(): void;
};

// The Kubernetes exec channel byte that prefixes every stdin frame.
const EXEC_STDIN_CHANNEL = 0;

// Most bytes of stdin a streaming exec hands the WebSocket before it waits for
// the socket to take them. Small enough that a transfer's memory does not grow
// with the payload; large enough to keep the connection busy.
const STREAM_STDIN_HIGH_WATER_BYTES = 1024 * 1024;

/**
 * The exec stdout channel. The Kubernetes client writes each stdout frame here
 * and ignores the return value of `write()`, so on its own a slow sink makes
 * every received byte pile up in memory. This PassThrough reports when its
 * buffer is full, and the streaming exec pauses the WebSocket until it drains.
 */
class ExecStdoutChannel extends PassThrough {
  onBackpressure: (() => void) | null = null;

  override write(chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
    const ok = super.write(chunk, encoding as BufferEncoding, cb as (error: Error | null | undefined) => void);
    if (!ok) this.onBackpressure?.();
    return ok;
  }
}

/**
 * Send `source` to the exec's stdin channel, waiting for the WebSocket to
 * flush once more than {@link STREAM_STDIN_HIGH_WATER_BYTES} are queued. The
 * Kubernetes client's own stdin handling sends every chunk the moment it is
 * read, so a file read from local disk faster than the API server accepts it
 * ends up queued, whole, in the WebSocket's send buffer.
 */
async function pumpExecStdin(
  ws: WebSocketLike,
  source: Readable,
  stopped: () => boolean,
): Promise<void> {
  const send = ws.send;
  if (typeof send !== "function") throw new Error("exec WebSocket cannot send stdin");
  let queuedBytes = 0;
  let sendError: Error | null = null;
  let wake: (() => void) | null = null;
  for await (const chunk of source) {
    if (stopped()) break;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    if (bytes.length === 0) continue;
    const frame = Buffer.allocUnsafe(bytes.length + 1);
    frame[0] = EXEC_STDIN_CHANNEL;
    bytes.copy(frame, 1);
    queuedBytes += frame.length;
    send.call(ws, frame, (err?: Error) => {
      queuedBytes -= frame.length;
      if (err && !sendError) sendError = err;
      const resume = wake;
      wake = null;
      resume?.();
    });
    while (queuedBytes > STREAM_STDIN_HIGH_WATER_BYTES && !sendError && !stopped()) {
      await new Promise<void>((resolve) => { wake = resolve; });
    }
    if (sendError) throw sendError;
  }
}

// Single-quote a string for safe interpolation into a sh -c script. Wraps in
// '...' and escapes any embedded single quotes via '\'' (close, escape, reopen).
export function shQuote(segment: string): string {
  return `'${segment.replace(/'/g, "'\\''")}'`;
}

// Reads one base64 line of `export K='v'` statements from stdin, applies it, and
// execs the real command (`"$@"`) on the rest of stdin. The script is fixed: it
// never contains an env value. Exit 125 means the env line could not be applied.
const ENV_FROM_STDIN_SCRIPT = [
  "IFS= read -r paperclip_env_b64 || exit 125",
  "paperclip_env_sh=$(printf '%s' \"$paperclip_env_b64\" | base64 -d) || exit 125",
  "eval \"$paperclip_env_sh\" || exit 125",
  "unset paperclip_env_b64 paperclip_env_sh",
  "exec \"$@\"",
].join("\n");

export interface CommandWithEnv {
  command: string[];
  stdin: string | undefined;
}

// Wrap a command so the given env vars are set before it runs. The Kubernetes
// exec API has no env field, so an exec'd process can only get extra env from a
// shell that sets it and then `exec`s the real command.
//
// Env values never go into the exec argv. The argv travels in the exec request
// URI, which the kube-apiserver audit log records, and is visible in the pod's
// process table. The values travel on the exec's stdin instead: one base64 line
// ahead of the caller's stdin, read and applied by a fixed script.
//
// PATH is never replaced. A PATH equal to the orchestrator's own (`hostPath`,
// default this process's PATH) is the orchestrator's, not the sandbox image's,
// and is skipped. Any other PATH was built for the sandbox (for example the
// GitHub operation launchers, which must come first) and is prepended to the
// image's PATH, so commands the caller didn't list still resolve. Only valid
// shell identifiers are applied. Returns the command and stdin unchanged when
// there is nothing to apply.
export function wrapCommandWithEnv(
  command: string[],
  env: Record<string, string> | undefined | null,
  stdin?: string,
  options: { hostPath?: string } = {},
): CommandWithEnv {
  const hostPath = "hostPath" in options ? options.hostPath : process.env.PATH;
  const entries = Object.entries(env && typeof env === "object" ? env : {}).filter(
    ([key, value]) =>
      typeof value === "string" &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
      (key !== "PATH" || (value !== "" && value !== hostPath)),
  );
  if (entries.length === 0) return { command, stdin };
  const exports = entries
    .map(([k, v]) => (k === "PATH" ? `export PATH=${shQuote(v)}"\${PATH:+:$PATH}"` : `export ${k}=${shQuote(v)}`))
    .join("\n");
  const envLine = `${Buffer.from(exports, "utf-8").toString("base64")}\n`;
  return {
    command: ["/bin/sh", "-c", ENV_FROM_STDIN_SCRIPT, "paperclip-env", ...command],
    stdin: envLine + (stdin ?? ""),
  };
}

type ExecStatus = {
  status?: string;
  message?: string;
  reason?: string;
  details?: { causes?: { reason?: string; message?: string }[] };
};

/**
 * Map an exec status frame to an exit code, plus a diagnostic line when the
 * failure did not come from the command. A `Failure` with no `ExitCode` cause
 * means the exec itself failed: the container is gone (the pod was evicted or
 * OOM-killed), or the runtime refused the exec. The command wrote nothing, so
 * without this line the caller sees a bare "exit code 1" with empty output.
 */
export function exitFromExecStatus(status: ExecStatus): { exitCode: number; diagnostic: string | null } {
  if (status.status === "Success") return { exitCode: 0, diagnostic: null };
  const exitCodeCause = (status.details?.causes ?? []).find((c) => c.reason === "ExitCode");
  const code = exitCodeCause?.message ? Number(exitCodeCause.message) : Number.NaN;
  if (Number.isInteger(code)) return { exitCode: code, diagnostic: null };
  const detail = [status.reason, status.message].filter((part) => typeof part === "string" && part.length > 0).join(": ");
  return {
    exitCode: 1,
    diagnostic: `Kubernetes exec failed without a command exit code (${detail || "no status message"}); the sandbox container may have been evicted or killed.\n`,
  };
}

export async function execInPod(
  kc: KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
  stdin?: string | Buffer,
  timeoutMs?: number,
  // Optional host-side bound on accumulated stdout. The pod is an untrusted,
  // attacker-controlled endpoint: a malicious pod can emit unbounded stdout
  // during an exec (e.g. a native file-sync `syncOut` tarball), which would grow
  // the in-memory accumulator without limit — blowing up the worker's RSS and,
  // past V8's ~512 MB max string length, throwing a synchronous RangeError inside
  // the stream `data` listener that no caller can catch (an uncaught exception =
  // worker crash = cross-tenant DoS). When set, accumulation fails closed the
  // instant it would exceed the cap so the caller can fall back. In-pod size
  // checks are worthless here — only the host can be trusted to enforce this.
  maxStdoutBytes?: number,
  // Same bound for the stderr channel. stderr is equally pod-controlled: a
  // malicious pod can emit an unbounded stderr stream during the SAME exec (e.g.
  // crafted tar/realpath diagnostics on the `syncOut` path) and trigger the
  // identical uncaught-`RangeError` worker crash. When set, stderr accumulation
  // fails closed at the cap; regardless of the cap, the `+=` is guarded so a
  // max-string-length `RangeError` can never escape as an uncaught exception.
  maxStderrBytes?: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const exec = new Exec(kc);
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();

  const stdinPayload: Buffer | null =
    Buffer.isBuffer(stdin) ? stdin
    : typeof stdin === "string" && stdin.length > 0 ? Buffer.from(stdin, "utf-8")
    : null;
  const stdinStream: PassThrough | null = stdinPayload ? new PassThrough() : null;

  // When stdin is provided, wrap the command so its stdin is bounded by
  // `head -c <N>`. Any program reading stdin (`cat`, `claude --print -`,
  // `base64 -d`, etc.) waits for EOF to terminate the read. With the k8s
  // client v0.21.0 stdin-end -> ws.close() limitation (see comment above)
  // we can't reliably deliver EOF without tearing down the exec — so we
  // pipe `head -c <N>` (which exits after exactly N bytes) into the
  // original command. The pipe propagates the exit code of the RHS so the
  // statusCallback still reflects the real command's exit status.
  //
  // NOTE: `stdinPayload.length` is the Buffer's BYTE length (correct for
  // `head -c` which counts bytes). Do NOT substitute `string.length` here
  // if the input is ever non-ASCII — UTF-8 multi-byte sequences would
  // give a byte count that differs from JS character count.
  const effectiveCommand = stdinPayload
    ? ["/bin/sh", "-c", `head -c ${stdinPayload.length} | ${command.map(shQuote).join(" ")}`]
    : command;

  let stdoutData = "";
  let stderrData = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;

  return await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      let ws: WebSocketLike | null = null;
      let resolved = false;
      let pendingExitCode: number | null = null;
      let stdoutEnded = false;
      let stderrEnded = false;

      // The k8s client writes stdout/stderr to our PassThroughs synchronously
      // and calls statusCallback in the same WS message handler. But `data`
      // events on the PassThroughs fire on process.nextTick, so resolving
      // inside statusCallback captures stdoutData/stderrData BEFORE the final
      // bytes have been appended. Wait for both streams' `end` events (which
      // the k8s client triggers via `stream.end()` when it processes the
      // status frame) so all buffered data has been drained into our string
      // accumulators before resolving.
      //
      // Watchdog: if the WebSocket drops silently after setup (network blip,
      // pod OOM-killed mid-exec, apiserver restart) the statusCallback never
      // fires and the stream `end` events never arrive. Without a timer the
      // calling worker hangs forever. Reject with a clear error so the caller
      // can retry or surface the failure.
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      if (typeof timeoutMs === "number" && timeoutMs > 0) {
        watchdog = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          try { ws?.close(); } catch { /* ignore */ }
          reject(new Error(
            `execInPod timed out after ${timeoutMs}ms (pod=${podName}, container=${containerName}, cmd0=${effectiveCommand[0] ?? ""}). The WebSocket likely dropped before the command produced a status frame.`,
          ));
        }, timeoutMs);
      }

      const tryFinish = () => {
        if (resolved) return;
        if (pendingExitCode === null) return;
        if (!stdoutEnded || !stderrEnded) return;
        resolved = true;
        if (watchdog) clearTimeout(watchdog);
        try { ws?.close(); } catch { /* ignore */ }
        resolve({ exitCode: pendingExitCode, stdout: stdoutData, stderr: stderrData });
      };

      // Fail the whole exec closed, tearing down the WebSocket so the pod stops
      // streaming. Used by the stdout cap below; the `resolved` guard makes it a
      // no-op if the exec already finished.
      const failClosed = (err: Error) => {
        if (resolved) return;
        resolved = true;
        if (watchdog) clearTimeout(watchdog);
        try { ws?.close(); } catch { /* ignore */ }
        reject(err);
      };

      // Accumulate stdout inside the executor so the cap can reject before an
      // unbounded pod payload exhausts memory. Once resolved (finished, timed
      // out, or capped) further chunks are dropped rather than appended.
      stdoutStream.on("data", (chunk: Buffer) => {
        if (resolved) return;
        if (typeof maxStdoutBytes === "number" && maxStdoutBytes >= 0) {
          stdoutBytes += chunk.length;
          if (stdoutBytes > maxStdoutBytes) {
            failClosed(new Error(
              `execInPod stdout exceeded the ${maxStdoutBytes}-byte cap (pod=${podName}, container=${containerName}); the sandbox produced more output than the buffer allows.`,
            ));
            return;
          }
        }
        try {
          stdoutData += chunk.toString("utf-8");
        } catch (err) {
          // Belt-and-suspenders: even under an explicit cap (or with none set),
          // never let a `+=` RangeError at V8's max string length escape this
          // listener as an uncaught exception.
          failClosed(toExecError(err));
        }
      });

      // stderr is pod-controlled too — bound it with the same fail-closed policy
      // and, unconditionally, guard the `+=` so a max-string-length `RangeError`
      // can never escape this listener as an uncaught (worker-crashing) exception.
      stderrStream.on("data", (chunk: Buffer) => {
        if (resolved) return;
        if (typeof maxStderrBytes === "number" && maxStderrBytes >= 0) {
          stderrBytes += chunk.length;
          if (stderrBytes > maxStderrBytes) {
            failClosed(new Error(
              `execInPod stderr exceeded the ${maxStderrBytes}-byte cap (pod=${podName}, container=${containerName}); the sandbox produced more output than the buffer allows.`,
            ));
            return;
          }
        }
        try {
          stderrData += chunk.toString("utf-8");
        } catch (err) {
          failClosed(toExecError(err));
        }
      });

      stdoutStream.on("end", () => { stdoutEnded = true; tryFinish(); });
      stderrStream.on("end", () => { stderrEnded = true; tryFinish(); });

      const execPromise = exec.exec(
        namespace,
        podName,
        containerName,
        effectiveCommand,
        stdoutStream,
        stderrStream,
        stdinStream,
        false, // tty=false: keep stdout/stderr on separate channels
        (status) => {
          const exit = exitFromExecStatus(status);
          pendingExitCode = exit.exitCode;
          if (exit.diagnostic) stderrData += exit.diagnostic;
          tryFinish();
        },
      );

      execPromise
        .then((webSocket) => {
          ws = webSocket as unknown as WebSocketLike;
          if (stdinStream && stdinPayload) {
            // Remove the default `end -> ws.close()` listener that k8s client
            // attaches in handleStandardInput; it tears down the connection
            // before the pod's command can finish flushing. We manage ws
            // closure inside `tryFinish()` instead.
            stdinStream.removeAllListeners("end");
            stdinStream.end(stdinPayload);
          } else if (stdinStream) {
            stdinStream.removeAllListeners("end");
            stdinStream.end();
          }
        })
        .catch((err) => {
          if (resolved) return;
          resolved = true;
          if (watchdog) clearTimeout(watchdog);
          reject(toExecError(err));
        });
    },
  );
}

/**
 * Streaming variant of {@link execInPod} for bulk file transfer over the pod
 * exec data channel.
 *
 * Where `execInPod` buffers the command's whole stdout into an in-memory string
 * (fine for small command output, fatal for a multi-gigabyte tar), this variant
 * streams the exec's stdin from a caller `Readable` and its stdout into a caller
 * `Writable` — so a native file-sync `syncIn`/`syncOut` streams raw tar bytes
 * straight to/from a host file on disk and neither the host nor the pod ever
 * holds the whole payload in memory. Both are intentionally kept side by side:
 * `execInPod` still backs the `environmentExecute` path unchanged.
 *
 * stderr is still accumulated into a (bounded) string: it carries only the
 * script's fail-loud diagnostics, and the pod controls how many bytes it emits,
 * so `maxStderrBytes` fails the exec closed the instant the pod floods the
 * channel — the same DoS guard `execInPod` applies. stdout carries no such cap
 * here because it is streamed to disk, not a string; the caller bounds it with
 * its own streamed-bytes guard on the sink `Writable`.
 *
 * Stdin EOF: the same k8s-client `stdin.on("end", () => ws.close())` quirk noted
 * on `execInPod` applies, so we strip that listener and drive the pod command to
 * self-terminate on the byte count instead of relying on EOF (the caller's
 * `syncIn` script bounds its read with `head -c <N>`). We close the WebSocket
 * ourselves from the status callback.
 *
 * Flow control: the Kubernetes client sends each stdin chunk the moment it is
 * read and writes each stdout frame without checking `write()`, so by itself a
 * transfer queues as fast as the faster side allows: a whole tarball in the
 * WebSocket send buffer on the way in, or in the stdout stream when the sink is
 * slower than the network on the way out. Here stdin goes through
 * `pumpExecStdin`, which waits for the socket once about 1 MiB is queued, and a
 * full stdout sink pauses the WebSocket until it drains. A transfer's memory
 * therefore stays bounded whatever the archive size.
 *
 * Resolves once the command's exit status is known AND both the stdout sink has
 * finished draining and stderr has ended, so a caller that reads the sink file
 * back after `await` always sees the complete archive.
 */
export async function execInPodStreaming(
  kc: KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
  io: {
    stdin?: Readable;
    stdout?: Writable;
    timeoutMs?: number;
    maxStderrBytes?: number;
  },
): Promise<{ exitCode: number; stderr: string }> {
  const exec = new Exec(kc);
  const stdoutStream = new ExecStdoutChannel();
  const stderrStream = new PassThrough();
  // Handed to the Kubernetes client only so it asks the API server for a stdin
  // channel. Nothing is ever written to it: `pumpExecStdin` sends the caller's
  // bytes itself, with flow control.
  const stdinStream: PassThrough | null = io.stdin ? new PassThrough() : null;

  let stderrData = "";
  let stderrBytes = 0;

  return await new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
    let ws: WebSocketLike | null = null;
    let resolved = false;
    let pendingExitCode: number | null = null;
    let stdoutDone = false;
    let stderrEnded = false;

    let watchdog: ReturnType<typeof setTimeout> | null = null;
    if (typeof io.timeoutMs === "number" && io.timeoutMs > 0) {
      watchdog = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try { ws?.close(); } catch { /* ignore */ }
        reject(new Error(
          `execInPodStreaming timed out after ${io.timeoutMs}ms (pod=${podName}, container=${containerName}, cmd0=${command[0] ?? ""}). The WebSocket likely dropped before the command produced a status frame.`,
        ));
      }, io.timeoutMs);
    }

    const tryFinish = () => {
      if (resolved) return;
      if (pendingExitCode === null) return;
      if (!stdoutDone || !stderrEnded) return;
      resolved = true;
      if (watchdog) clearTimeout(watchdog);
      try { ws?.close(); } catch { /* ignore */ }
      resolve({ exitCode: pendingExitCode, stderr: stderrData });
    };

    // Fail the whole exec closed, tearing down the WebSocket so the pod stops
    // streaming. Fired by a sink error (e.g. the caller's disk guard tripping)
    // or a stream error; the `resolved` guard makes it a no-op once finished.
    const failClosed = (err: Error) => {
      if (resolved) return;
      resolved = true;
      if (watchdog) clearTimeout(watchdog);
      try { ws?.close(); } catch { /* ignore */ }
      try { stdinStream?.destroy(); } catch { /* ignore */ }
      try { io.stdin?.destroy(); } catch { /* ignore */ }
      reject(err);
    };

    // Stop reading from the API server while the stdout sink is full, and
    // carry on once it drains, so a sink slower than the network (a busy disk)
    // holds the bytes in the socket instead of in this process.
    let stdoutPaused = false;
    stdoutStream.onBackpressure = () => {
      if (stdoutPaused || !ws?.pause) return;
      stdoutPaused = true;
      ws.pause();
    };
    stdoutStream.on("drain", () => {
      if (!stdoutPaused) return;
      stdoutPaused = false;
      ws?.resume?.();
    });

    // Pipe stdout to the caller sink (streamed to disk), or drain it if the
    // caller wants none. Piping with the default `end: true` ends the sink when
    // the pod's stdout closes, so the sink's `finish` marks the archive fully
    // written. A sink error (the caller's streamed-bytes guard, a full disk)
    // fails the exec closed and stops the pod.
    if (io.stdout) {
      const sink = io.stdout;
      sink.on("error", failClosed);
      stdoutStream.on("error", failClosed);
      sink.on("finish", () => { stdoutDone = true; tryFinish(); });
      stdoutStream.pipe(sink);
    } else {
      stdoutStream.on("data", () => { /* drain */ });
      stdoutStream.on("end", () => { stdoutDone = true; tryFinish(); });
      stdoutStream.on("error", failClosed);
    }

    // stderr is pod-controlled — bound it with the same fail-closed policy as
    // execInPod and guard the `+=` so a max-string-length RangeError can never
    // escape as an uncaught (worker-crashing) exception.
    stderrStream.on("data", (chunk: Buffer) => {
      if (resolved) return;
      if (typeof io.maxStderrBytes === "number" && io.maxStderrBytes >= 0) {
        stderrBytes += chunk.length;
        if (stderrBytes > io.maxStderrBytes) {
          failClosed(new Error(
            `execInPodStreaming stderr exceeded the ${io.maxStderrBytes}-byte cap (pod=${podName}, container=${containerName}); the sandbox produced more diagnostics than the buffer allows.`,
          ));
          return;
        }
      }
      try {
        stderrData += chunk.toString("utf-8");
      } catch (err) {
        failClosed(toExecError(err));
      }
    });
    stderrStream.on("end", () => { stderrEnded = true; tryFinish(); });

    const execPromise = exec.exec(
      namespace,
      podName,
      containerName,
      command,
      stdoutStream,
      stderrStream,
      stdinStream,
      false, // tty=false: keep stdout/stderr on separate channels
      (status) => {
        const exit = exitFromExecStatus(status);
        pendingExitCode = exit.exitCode;
        if (exit.diagnostic) stderrData += exit.diagnostic;
        tryFinish();
      },
    );

    execPromise
      .then((webSocket) => {
        ws = webSocket as unknown as WebSocketLike;
        if (resolved) {
          try { ws.close(); } catch { /* ignore */ }
          return;
        }
        if (stdinStream && io.stdin) {
          // Strip the default `end -> ws.close()` listener (see execInPod); the
          // pod command ends on its byte count, not on stdin EOF. Then send the
          // caller's source with flow control. A source or send error fails
          // closed.
          stdinStream.removeAllListeners("end");
          pumpExecStdin(ws, io.stdin, () => resolved).catch((err: unknown) => {
            failClosed(toExecError(err));
          });
        } else if (stdinStream) {
          stdinStream.removeAllListeners("end");
          stdinStream.end();
        }
      })
      .catch((err) => {
        if (resolved) return;
        resolved = true;
        if (watchdog) clearTimeout(watchdog);
        reject(toExecError(err));
      });
  });
}

/**
 * One live pseudo-terminal (PTY) exec in a pod container. The shape matches the
 * `LoginPtySession` the plugin SDK login transport consumes.
 */
export interface PodPty {
  /** Registers the one output listener. Output that arrived earlier is delivered first. */
  onData(listener: (chunk: string) => void): void;
  /** Writes raw input bytes to the terminal. */
  write(data: string): void;
  /** Resolves with the command exit code, or null when the exec ended without one. */
  wait(): Promise<{ exitCode: number | null }>;
  /** Interrupts the command and closes the exec stream. Safe to call more than once. */
  kill(): void;
  /** Closes the exec stream. Safe to call more than once. */
  close(): Promise<void>;
}

export interface OpenPodPtyOptions {
  /** Terminal width in columns (default 120). */
  cols?: number;
  /** Terminal height in rows (default 30). */
  rows?: number;
}

// The end-of-text byte. On a terminal the line discipline turns it into SIGINT
// for the foreground process group, which is the only stop signal the exec API
// can deliver without a second exec.
const PTY_INTERRUPT = "\u0003";

type ClosableWebSocket = WebSocketLike & {
  addEventListener?(type: "close", listener: () => void): void;
  on?(event: "close", listener: () => void): void;
};

/**
 * Runs `command` in the container on a real terminal (`tty=true`) and returns it
 * as a {@link PodPty}.
 *
 * With a terminal the API server merges stderr into stdout, so the exec opens no
 * stderr channel. The stdout stream advertises `columns` and `rows`, which makes
 * the client send the terminal size on the resize channel before any output.
 * Stdin is a PassThrough the caller writes to; it is never ended, because the
 * client closes the whole socket when stdin ends.
 *
 * The exit code comes from the status channel. A socket that closes without a
 * status frame (a dropped connection, a deleted pod) resolves `wait()` with
 * `null`, so a caller never waits forever. `kill()` sends an interrupt and closes
 * the socket; closing a terminal exec hangs up the command's terminal.
 */
export async function openPodPty(
  kc: KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
  options: OpenPodPtyOptions = {},
): Promise<PodPty> {
  const exec = new Exec(kc);
  const stdout = Object.assign(new PassThrough(), {
    columns: options.cols ?? 120,
    rows: options.rows ?? 30,
  });
  const stdin = new PassThrough();

  // Decode as a stream so a multibyte character split across two frames stays
  // whole, and buffer until the caller registers its listener so no early
  // output (the login prompt) is lost.
  const decoder = new TextDecoder("utf-8");
  let listener: ((chunk: string) => void) | null = null;
  let buffered = "";
  const emit = (text: string) => {
    if (text.length === 0) return;
    if (listener) listener(text);
    else buffered += text;
  };
  stdout.on("data", (chunk: Buffer) => emit(decoder.decode(chunk, { stream: true })));

  let settle!: (result: { exitCode: number | null }) => void;
  const exited = new Promise<{ exitCode: number | null }>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const finish = (exitCode: number | null) => {
    if (settled) return;
    settled = true;
    emit(decoder.decode());
    settle({ exitCode });
  };

  const ws = (await exec.exec(
    namespace,
    podName,
    containerName,
    command,
    stdout,
    null,
    stdin,
    true,
    (status) => {
      if (status.status === "Success") {
        finish(0);
        return;
      }
      const causes = status.details?.causes ?? [];
      const exitCodeCause = causes.find(
        (c: { reason?: string; message?: string }) => c.reason === "ExitCode",
      );
      const code = exitCodeCause?.message ? Number(exitCodeCause.message) : Number.NaN;
      finish(Number.isInteger(code) ? code : null);
    },
  )) as unknown as ClosableWebSocket;

  const onSocketClose = () => finish(null);
  if (typeof ws.addEventListener === "function") ws.addEventListener("close", onSocketClose);
  else if (typeof ws.on === "function") ws.on("close", onSocketClose);

  let closed = false;
  const closeSocket = () => {
    if (closed) return;
    closed = true;
    try { ws.close(); } catch { /* already closed */ }
  };

  return {
    onData(next) {
      listener = next;
      if (buffered.length > 0) {
        const pending = buffered;
        buffered = "";
        next(pending);
      }
    },
    write(data) {
      if (closed || settled) return;
      stdin.write(data);
    },
    wait() {
      return exited;
    },
    kill() {
      if (!closed && !settled) stdin.write(PTY_INTERRUPT);
      closeSocket();
    },
    async close() {
      closeSocket();
    },
  };
}
