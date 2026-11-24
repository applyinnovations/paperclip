import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { Readable, Writable } from "node:stream";
import { KubeConfig } from "@kubernetes/client-node";
import { WebSocketServer, type WebSocket } from "ws";
import { execInPodStreaming } from "../../src/pod-exec.js";

// `execInPodStreaming` against the real Kubernetes client and a local WebSocket
// server that speaks the exec channel protocol. The server stalls one side of the
// transfer and the tests check that the host stops moving bytes instead of
// holding the whole transfer in memory.

const TOTAL_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
// Loopback socket buffers, the stdin window and stream buffers together stay
// far below this; holding the transfer in memory would pass it.
const BOUND_BYTES = 24 * 1024 * 1024;
const STALL_MS = 500;

const STDOUT_CHANNEL = 1;
const STATUS_CHANNEL = 3;

let server: WebSocketServer | null = null;

afterEach(async () => {
  const current = server;
  server = null;
  if (!current) return;
  for (const client of current.clients) client.terminate();
  await new Promise<void>((resolve) => current.close(() => resolve()));
});

async function startExecServer(onConnection: (ws: WebSocket) => void): Promise<KubeConfig> {
  const wss = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    handleProtocols: () => "v4.channel.k8s.io",
  });
  server = wss;
  wss.on("connection", onConnection);
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const { port } = wss.address() as AddressInfo;
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: "local", server: `http://127.0.0.1:${port}`, skipTLSVerify: true }],
    users: [{ name: "local" }],
    contexts: [{ name: "local", cluster: "local", user: "local" }],
    currentContext: "local",
  });
  return kc;
}

function frame(channel: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([channel]), payload]);
}

function sendSuccess(ws: WebSocket): void {
  ws.send(frame(STATUS_CHANNEL, Buffer.from(JSON.stringify({ status: "Success" }))));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("execInPodStreaming flow control", () => {
  it("stops reading stdin while the API server is not accepting it", async () => {
    let receivedBytes = 0;
    let serverSocket: WebSocket | null = null;
    const kc = await startExecServer((ws) => {
      serverSocket = ws;
      ws.pause();
      ws.on("message", (data: Buffer) => {
        if (data[0] !== 0) return;
        receivedBytes += data.length - 1;
        if (receivedBytes === TOTAL_BYTES) sendSuccess(ws);
      });
    });

    let readBytes = 0;
    const source = new Readable({
      read() {
        if (readBytes >= TOTAL_BYTES) {
          this.push(null);
          return;
        }
        readBytes += CHUNK_BYTES;
        this.push(Buffer.alloc(CHUNK_BYTES, 0x61));
      },
    });

    const result = execInPodStreaming(kc, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], {
      stdin: source,
      timeoutMs: 20_000,
    });
    await delay(STALL_MS);
    expect(serverSocket).not.toBeNull();
    expect(readBytes).toBeLessThan(BOUND_BYTES);

    serverSocket!.resume();
    await expect(result).resolves.toEqual({ exitCode: 0, stderr: "" });
    expect(receivedBytes).toBe(TOTAL_BYTES);
  }, 30_000);

  it("stops reading from the API server while the stdout sink is full", async () => {
    let serverSocket: WebSocket | null = null;
    const kc = await startExecServer((ws) => {
      serverSocket = ws;
      const chunk = frame(STDOUT_CHANNEL, Buffer.alloc(CHUNK_BYTES, 0x62));
      for (let sent = 0; sent < TOTAL_BYTES; sent += CHUNK_BYTES) ws.send(chunk);
      sendSuccess(ws);
    });

    let writtenBytes = 0;
    let release: (() => void) | null = null;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const sink = new Writable({
      write(chunk: Buffer, _encoding, cb) {
        writtenBytes += chunk.length;
        released.then(() => cb());
      },
    });

    const result = execInPodStreaming(kc, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], {
      stdout: sink,
      timeoutMs: 20_000,
    });
    await delay(STALL_MS);
    expect(serverSocket).not.toBeNull();
    // What the server could not hand over is still queued on its side, not in
    // this process.
    expect(serverSocket!.bufferedAmount).toBeGreaterThan(TOTAL_BYTES - BOUND_BYTES);

    release!();
    await expect(result).resolves.toEqual({ exitCode: 0, stderr: "" });
    expect(writtenBytes).toBe(TOTAL_BYTES);
  }, 30_000);
});
