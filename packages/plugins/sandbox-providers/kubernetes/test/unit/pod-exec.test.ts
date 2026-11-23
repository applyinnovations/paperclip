import { describe, it, expect, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import type { PassThrough } from "node:stream";

// Mock the k8s client so `execInPod` runs against a scripted WebSocket exec: the
// fake `Exec.exec` streams stdout chunks into the provided PassThrough and, for
// the success path, reports an exit status. This exercises the host-side stdout
// accumulation cap without a real cluster.
type StatusCb = (status: {
  status: string;
  reason?: string;
  message?: string;
  code?: number;
  details?: { causes?: { reason?: string; message?: string }[] };
}) => void;

let scriptedExec: (
  stdout: PassThrough,
  stderr: PassThrough,
  statusCb: StatusCb,
  stdin: PassThrough | null,
) => void = () => undefined;

vi.mock("@kubernetes/client-node", () => {
  class Exec {
    constructor(_kc: unknown) {}
    async exec(
      _namespace: string,
      _podName: string,
      _containerName: string,
      _command: string[],
      stdout: PassThrough,
      stderr: PassThrough,
      stdin: PassThrough | null,
      _tty: boolean,
      statusCb: StatusCb,
    ) {
      // Defer so the caller has wired its stream listeners first.
      setImmediate(() => scriptedExec(stdout, stderr, statusCb, stdin));
      return { close() {} };
    }
  }
  return { Exec };
});

const { describeExecStatusFailure, execInPod, execInPodStreaming } = await import("../../src/pod-exec.js");

const KC = {} as never;

describe("execInPod stdout cap", () => {
  it("fails closed when pod stdout exceeds the cap", async () => {
    scriptedExec = (stdout) => {
      // Emit more than the cap in a single chunk; the host must reject.
      stdout.write(Buffer.alloc(64, 0x41));
    };
    await expect(
      execInPod(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], undefined, 5_000, 16),
    ).rejects.toThrow(/cap|exceeded/i);
  });

  it("accepts stdout within the cap and returns the accumulated output", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stdout.write(Buffer.from("hello", "utf-8"));
      stdout.end();
      stderr.end();
      statusCb({ status: "Success" });
    };
    const result = await execInPod(
      KC,
      "ns",
      "pod",
      "agent",
      ["/bin/sh", "-c", ":"],
      undefined,
      5_000,
      1024,
    );
    expect(result).toEqual({ exitCode: 0, stdout: "hello", stderr: "" });
  });

  it("leaves stdout unbounded when no cap is provided", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stdout.write(Buffer.alloc(4096, 0x42));
      stdout.end();
      stderr.end();
      statusCb({ status: "Success" });
    };
    const result = await execInPod(
      KC,
      "ns",
      "pod",
      "agent",
      ["/bin/sh", "-c", ":"],
      undefined,
      5_000,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(4096);
  });
});

describe("execInPod stderr cap", () => {
  it("fails closed when pod stderr exceeds the cap", async () => {
    // stderr is equally pod-controlled: a malicious pod that floods stderr must
    // not grow the host accumulator without bound. Same DoS class as stdout.
    scriptedExec = (_stdout, stderr) => {
      stderr.write(Buffer.alloc(64, 0x45));
    };
    await expect(
      // maxStdoutBytes generous, maxStderrBytes = 16 -> stderr must trip.
      execInPod(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], undefined, 5_000, 1024, 16),
    ).rejects.toThrow(/stderr.*cap|cap.*stderr|exceeded/i);
  });

  it("accepts stderr within the cap and returns the accumulated output", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stderr.write(Buffer.from("warn", "utf-8"));
      stdout.end();
      stderr.end();
      statusCb({ status: "Success" });
    };
    const result = await execInPod(
      KC,
      "ns",
      "pod",
      "agent",
      ["/bin/sh", "-c", ":"],
      undefined,
      5_000,
      1024,
      1024,
    );
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "warn" });
  });

  it("leaves stderr unbounded when no cap is provided", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stderr.write(Buffer.alloc(4096, 0x46));
      stdout.end();
      stderr.end();
      statusCb({ status: "Success" });
    };
    const result = await execInPod(
      KC,
      "ns",
      "pod",
      "agent",
      ["/bin/sh", "-c", ":"],
      undefined,
      5_000,
      1024,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toHaveLength(4096);
  });
});

describe("execInPodStreaming", () => {
  it("streams the command's stdout into the caller sink and resolves with exit code + stderr", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stdout.write(Buffer.from("chunk-one;"));
      stdout.write(Buffer.from("chunk-two"));
      stdout.end();
      stderr.write(Buffer.from("warn"));
      stderr.end();
      statusCb({ status: "Success" });
    };
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    const result = await execInPodStreaming(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], {
      stdout: sink,
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ exitCode: 0, stderr: "warn" });
    expect(Buffer.concat(chunks).toString("utf-8")).toBe("chunk-one;chunk-two");
  });

  it("streams the caller stdin Readable into the pod command", async () => {
    let received = Buffer.alloc(0);
    scriptedExec = (stdout, stderr, statusCb, stdin) => {
      if (stdin) {
        stdin.on("data", (chunk: Buffer) => {
          received = Buffer.concat([received, chunk]);
        });
      }
      // Resolve once the source has been fully piped through.
      setImmediate(() => {
        stdout.end();
        stderr.end();
        statusCb({ status: "Success" });
      });
    };
    const source = Readable.from([Buffer.from("payload-bytes")]);
    const result = await execInPodStreaming(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], {
      stdin: source,
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(0);
    expect(received.toString("utf-8")).toBe("payload-bytes");
  });

  it("fails closed when the pod floods stderr past the cap", async () => {
    scriptedExec = (_stdout, stderr) => {
      stderr.write(Buffer.alloc(64, 0x45));
    };
    const sink = new Writable({ write(_c, _e, cb) { cb(); } });
    await expect(
      execInPodStreaming(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], {
        stdout: sink,
        timeoutMs: 5_000,
        maxStderrBytes: 16,
      }),
    ).rejects.toThrow(/stderr.*cap|exceeded/i);
  });

  it("fails closed when the caller sink errors (e.g. a streamed-bytes disk guard trips)", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stdout.write(Buffer.alloc(4096, 0x42));
      stdout.end();
      stderr.end();
      statusCb({ status: "Success" });
    };
    // A sink that rejects any write, standing in for the file-sync disk guard.
    const sink = new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error("streamed-output disk guard tripped"));
      },
    });
    await expect(
      execInPodStreaming(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], {
        stdout: sink,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/disk guard/i);
  });
});

// APP-17: an exec into a sandbox whose container is no longer running (the
// kubelet evicted it, or it is stopping) gets a Failure status with no ExitCode
// cause. That used to come back as a fabricated `exit 1` with empty stderr, so
// sync-out failed as a bare "transfer failed (exit 1)".
describe("execInPodStreaming exec failures without an exit code", () => {
  it("rejects with the apiserver reason and message instead of inventing exit 1", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stdout.end();
      stderr.end();
      statusCb({
        status: "Failure",
        reason: "InternalError",
        code: 500,
        message: "Internal error occurred: error executing command in container: container is not running",
      });
    };
    const sink = new Writable({ write(_c, _e, cb) { cb(); } });
    await expect(
      execInPodStreaming(KC, "ns", "pc-pod", "agent", ["/bin/sh", "-c", ":"], { stdout: sink, timeoutMs: 5_000 }),
    ).rejects.toThrow(
      "execInPodStreaming: the exec failed without a command exit code (pod=pc-pod, container=agent): InternalError, code 500: Internal error occurred: error executing command in container: container is not running",
    );
  });

  it("still resolves a real non-zero exit code from the ExitCode cause, with stderr", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stdout.end();
      stderr.write(Buffer.from("tar: ./a: file changed as we read it\n"));
      stderr.end();
      statusCb({
        status: "Failure",
        reason: "NonZeroExitCode",
        message: "command terminated with non-zero exit code: exit status 1",
        details: { causes: [{ reason: "ExitCode", message: "1" }] },
      });
    };
    const sink = new Writable({ write(_c, _e, cb) { cb(); } });
    const result = await execInPodStreaming(KC, "ns", "pc-pod", "agent", ["/bin/sh", "-c", ":"], {
      stdout: sink,
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ exitCode: 1, stderr: "tar: ./a: file changed as we read it\n" });
  });
});

describe("describeExecStatusFailure", () => {
  it("names the status when the apiserver gave no reason", () => {
    expect(describeExecStatusFailure({ status: "Failure" })).toBe("status Failure with no reason");
  });

  it("includes non-ExitCode causes and bounds the text", () => {
    expect(describeExecStatusFailure({
      status: "Failure",
      reason: "BadRequest",
      details: { causes: [{ reason: "ExitCode", message: "3" }, { reason: "FieldValueInvalid", message: "bad container" }] },
    })).toBe("BadRequest: FieldValueInvalid: bad container");
    expect(describeExecStatusFailure({ status: "Failure", message: "x".repeat(5000) }).length).toBe(1025);
  });
});
