import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_TRANSFER_CONCURRENCY,
  createSandboxTransferLimiter,
  sandboxTransferConcurrencyFromEnv,
} from "./sandbox-transfer-limiter.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("sandbox transfer limiter", () => {
  it("runs at most `concurrency` transfers at once and starts waiters in FIFO order", async () => {
    const limiter = createSandboxTransferLimiter(2);
    const gates = Array.from({ length: 5 }, deferred);
    const started: number[] = [];
    let running = 0;
    let peak = 0;

    const runs = gates.map((gate, index) =>
      limiter.run(async () => {
        started.push(index);
        running += 1;
        peak = Math.max(peak, running);
        try {
          await gate.promise;
          return index;
        } finally {
          running -= 1;
        }
      }),
    );
    const settledRuns = Promise.allSettled(runs);

    await tick();
    expect(started).toEqual([0, 1]);
    expect(limiter.snapshot()).toEqual({ concurrency: 2, active: 2, queued: 3 });

    gates[1].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);

    gates[0].reject(new Error("transfer failed"));
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);

    gates[2].resolve();
    gates[3].resolve();
    gates[4].resolve();

    const settled = await settledRuns;
    expect(settled.map((result) => result.status)).toEqual([
      "rejected",
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    expect(peak).toBe(2);
    expect(limiter.snapshot()).toEqual({ concurrency: 2, active: 0, queued: 0 });
  });

  it("releases the slot when the transfer throws synchronously", async () => {
    const limiter = createSandboxTransferLimiter(1);
    await expect(limiter.run(() => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(limiter.run(async () => "next")).resolves.toBe("next");
    expect(limiter.snapshot()).toEqual({ concurrency: 1, active: 0, queued: 0 });
  });

  it("reads and clamps PAPERCLIP_SANDBOX_TRANSFER_CONCURRENCY", () => {
    expect(sandboxTransferConcurrencyFromEnv({})).toBe(DEFAULT_SANDBOX_TRANSFER_CONCURRENCY);
    expect(sandboxTransferConcurrencyFromEnv({ PAPERCLIP_SANDBOX_TRANSFER_CONCURRENCY: "8" })).toBe(8);
    expect(sandboxTransferConcurrencyFromEnv({ PAPERCLIP_SANDBOX_TRANSFER_CONCURRENCY: "0" })).toBe(1);
    expect(sandboxTransferConcurrencyFromEnv({ PAPERCLIP_SANDBOX_TRANSFER_CONCURRENCY: "1000" })).toBe(64);
    expect(sandboxTransferConcurrencyFromEnv({ PAPERCLIP_SANDBOX_TRANSFER_CONCURRENCY: "lots" })).toBe(
      DEFAULT_SANDBOX_TRANSFER_CONCURRENCY,
    );
  });
});
