import { describe, it, expect, vi } from "vitest";
import { Readable, Writable } from "node:stream";
import type { PassThrough } from "node:stream";

// Mock the k8s client so `execInPod` runs against a scripted WebSocket exec: the
// fake `Exec.exec` streams stdout chunks into the provided PassThrough and, for
// the success path, reports an exit status. This exercises the host-side stdout
// accumulation cap without a real cluster.
type StatusCb = (status: {
  status: string;
  message?: string;
  reason?: string;
  details?: { causes?: { reason?: string; message?: string }[] };
}) => void;

let scriptedExec: (
  stdout: PassThrough,
  stderr: PassThrough,
  statusCb: StatusCb,
  stdin: PassThrough | null,
) => void = () => undefined;

// Frames the streaming exec sends on the fake WebSocket (channel byte first).
let sentFrames: Buffer[] = [];

// When set, the fake `Exec.exec` rejects with this value instead of opening a
// socket, the way the real client rejects a failed WebSocket upgrade.
let execRejection: unknown = undefined;

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
      if (execRejection !== undefined) throw execRejection;
      // Defer so the caller has wired its stream listeners first.
      setImmediate(() => scriptedExec(stdout, stderr, statusCb, stdin));
      return {
        close() {},
        send(data: Buffer, cb?: (err?: Error) => void) {
          sentFrames.push(Buffer.from(data));
          setImmediate(() => cb?.());
        },
        pause() {},
        resume() {},
      };
    }
  }
  return { Exec };
});

const { describeExecError, execInPod, execInPodStreaming } = await import("../../src/pod-exec.js");

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

describe("execInPod exit status", () => {
  it("reports the command's own exit code without adding a diagnostic", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stderr.write(Buffer.from("fatal: bad object\n", "utf-8"));
      stdout.end();
      stderr.end();
      statusCb({ status: "Failure", details: { causes: [{ reason: "ExitCode", message: "128" }] } });
    };
    const result = await execInPod(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], undefined, 5_000);
    expect(result).toEqual({ exitCode: 128, stdout: "", stderr: "fatal: bad object\n" });
  });

  // APP-128: an evicted sandbox pod fails the exec with no ExitCode cause and no
  // output. The status message must reach stderr, or the run error is a bare
  // "failed with exit code 1" that hides the eviction.
  it("puts the status message in stderr when the exec fails without an exit code", async () => {
    scriptedExec = (stdout, stderr, statusCb) => {
      stdout.end();
      stderr.end();
      statusCb({ status: "Failure", reason: "InternalError", message: 'container "agent" not found' });
    };
    const result = await execInPod(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], undefined, 5_000);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('InternalError: container "agent" not found');
    expect(result.stderr).toMatch(/evicted/);
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

  it("sends the caller stdin Readable to the pod command on the stdin channel", async () => {
    sentFrames = [];
    let stdinRequested = false;
    scriptedExec = (stdout, stderr, statusCb, stdin) => {
      stdinRequested = stdin !== null;
      // Report the exit once the source has been sent.
      setTimeout(() => {
        stdout.end();
        stderr.end();
        statusCb({ status: "Success" });
      }, 20);
    };
    const source = Readable.from([Buffer.from("payload-"), Buffer.from("bytes")]);
    const result = await execInPodStreaming(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], {
      stdin: source,
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(0);
    expect(stdinRequested).toBe(true);
    expect(sentFrames.every((frame) => frame[0] === 0)).toBe(true);
    expect(Buffer.concat(sentFrames.map((frame) => frame.subarray(1))).toString("utf-8")).toBe("payload-bytes");
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

describe("execInPod non-Error rejections (APP-762)", () => {
  it("rejects with a readable Error when the client rejects with a ws ErrorEvent", async () => {
    execRejection = {
      type: "error",
      message: "Unexpected server response: 404",
      error: new Error("Unexpected server response: 404"),
      target: { readyState: 3 },
    };
    try {
      const failure = await execInPod(KC, "ns", "pod", "agent", ["/bin/sh", "-c", ":"], undefined, 5_000)
        .then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("Unexpected server response: 404");
      expect(String(failure)).not.toContain("[object Object]");
    } finally {
      execRejection = undefined;
    }
  });

  it("describes a V1Status-shaped rejection by status, code, reason and message", () => {
    expect(describeExecError({ status: "Failure", code: 404, reason: "NotFound", message: 'pods "p" not found' }))
      .toBe('Failure: code 404: NotFound: pods "p" not found');
  });

  it("never renders an object as [object Object]", () => {
    expect(describeExecError({ foo: 1 })).toBe('{"foo":1}');
    expect(describeExecError(Buffer.from("boom"))).toBe("boom");
    expect(describeExecError(new Error("bad"))).toBe("bad");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeExecError(circular)).not.toContain("[object Object]");
  });
});
