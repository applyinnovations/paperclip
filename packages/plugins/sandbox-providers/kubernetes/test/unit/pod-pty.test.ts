import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PassThrough } from "node:stream";

// A scripted terminal exec: the fake `Exec.exec` records its arguments and hands
// the test the stdout stream, the stdin stream, the status callback and a fake
// socket, so each test drives the exec like the API server would.
type StatusCb = (status: {
  status: string;
  details?: { causes?: { reason?: string; message?: string }[] };
}) => void;

interface FakeSocket {
  closed: number;
  listeners: Array<() => void>;
  close(): void;
  addEventListener(type: "close", listener: () => void): void;
}

interface ExecCall {
  namespace: string;
  podName: string;
  container: string;
  command: string[];
  stdout: PassThrough & { columns?: number; rows?: number };
  stderr: unknown;
  stdin: PassThrough | null;
  tty: boolean;
  status: StatusCb;
  socket: FakeSocket;
}

const h = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock("@kubernetes/client-node", () => {
  class Exec {
    constructor(_kc: unknown) {}
    async exec(
      namespace: string,
      podName: string,
      container: string,
      command: string[],
      stdout: PassThrough,
      stderr: unknown,
      stdin: PassThrough | null,
      tty: boolean,
      status: StatusCb,
    ) {
      const socket: FakeSocket = {
        closed: 0,
        listeners: [],
        close() {
          this.closed += 1;
          for (const l of this.listeners) l();
        },
        addEventListener(_type, listener) {
          this.listeners.push(listener);
        },
      };
      h.calls.push({ namespace, podName, container, command, stdout, stderr, stdin, tty, status, socket });
      return socket;
    }
  }
  return { Exec };
});

const { openPodPty } = await import("../../src/pod-exec.js");
const KC = {} as never;
const lastCall = () => h.calls[h.calls.length - 1] as ExecCall;
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  h.calls.length = 0;
});

describe("openPodPty", () => {
  it("opens a terminal exec with stdin, no stderr channel, and a terminal size", async () => {
    await openPodPty(KC, "ns", "pod", "agent", ["/bin/sh", "-c", "exec true"]);
    const call = lastCall();
    expect(call).toMatchObject({
      namespace: "ns",
      podName: "pod",
      container: "agent",
      command: ["/bin/sh", "-c", "exec true"],
      tty: true,
      stderr: null,
    });
    expect(call.stdin).not.toBeNull();
    // `columns` and `rows` on stdout make the client send the size on the resize channel.
    expect(call.stdout.columns).toBe(120);
    expect(call.stdout.rows).toBe(30);
  });

  it("buffers output until a listener exists and keeps split multibyte characters whole", async () => {
    const pty = await openPodPty(KC, "ns", "pod", "agent", ["x"]);
    const call = lastCall();
    const euro = Buffer.from("€", "utf-8");
    call.stdout.write(Buffer.from("Paste code: ", "utf-8"));
    call.stdout.write(euro.subarray(0, 1));
    await tick();
    const chunks: string[] = [];
    pty.onData((c) => chunks.push(c));
    call.stdout.write(euro.subarray(1));
    await tick();
    expect(chunks.join("")).toBe("Paste code: €");
  });

  it("writes input to the exec stdin", async () => {
    const pty = await openPodPty(KC, "ns", "pod", "agent", ["x"]);
    const received: string[] = [];
    lastCall().stdin!.on("data", (d: Buffer) => received.push(d.toString()));
    pty.write("code-123\r");
    await tick();
    expect(received.join("")).toBe("code-123\r");
  });

  it("reports exit code 0 on Success", async () => {
    const pty = await openPodPty(KC, "ns", "pod", "agent", ["x"]);
    lastCall().status({ status: "Success" });
    await expect(pty.wait()).resolves.toEqual({ exitCode: 0 });
  });

  it("reports the ExitCode cause on Failure", async () => {
    const pty = await openPodPty(KC, "ns", "pod", "agent", ["x"]);
    lastCall().status({ status: "Failure", details: { causes: [{ reason: "ExitCode", message: "7" }] } });
    await expect(pty.wait()).resolves.toEqual({ exitCode: 7 });
  });

  it("reports null for a Failure without an exit code", async () => {
    const pty = await openPodPty(KC, "ns", "pod", "agent", ["x"]);
    lastCall().status({ status: "Failure", details: { causes: [{ reason: "Other", message: "boom" }] } });
    await expect(pty.wait()).resolves.toEqual({ exitCode: null });
  });

  it("resolves null when the socket closes without a status frame", async () => {
    const pty = await openPodPty(KC, "ns", "pod", "agent", ["x"]);
    lastCall().socket.close();
    await expect(pty.wait()).resolves.toEqual({ exitCode: null });
  });

  it("keeps the first exit result when the socket closes after the status", async () => {
    const pty = await openPodPty(KC, "ns", "pod", "agent", ["x"]);
    lastCall().status({ status: "Success" });
    lastCall().socket.close();
    await expect(pty.wait()).resolves.toEqual({ exitCode: 0 });
  });

  it("kill sends an interrupt and closes the socket once", async () => {
    const pty = await openPodPty(KC, "ns", "pod", "agent", ["x"]);
    const call = lastCall();
    const received: string[] = [];
    call.stdin!.on("data", (d: Buffer) => received.push(d.toString()));
    pty.kill();
    pty.kill();
    await pty.close();
    await tick();
    expect(received.join("")).toBe("\u0003");
    expect(call.socket.closed).toBe(1);
    await expect(pty.wait()).resolves.toEqual({ exitCode: null });
  });

  it("drops input after close", async () => {
    const pty = await openPodPty(KC, "ns", "pod", "agent", ["x"]);
    const received: string[] = [];
    lastCall().stdin!.on("data", (d: Buffer) => received.push(d.toString()));
    await pty.close();
    pty.write("late");
    await tick();
    expect(received).toEqual([]);
  });
});
