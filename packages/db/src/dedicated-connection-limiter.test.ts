import { describe, expect, it } from "vitest";
import {
  DedicatedConnectionLimiter,
  DedicatedConnectionWaitTimeoutError,
  currentDedicatedConnectionDepth,
  dedicatedAdmissionLimit,
  runAtDedicatedConnectionDepth,
} from "./dedicated-connection-limiter.js";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1));

/** Holds a permit the way `withDedicatedDbConnection` does, tracking concurrency. */
async function hold<T>(limiter: DedicatedConnectionLimiter, observed: { now: number; max: number }, action: () => Promise<T>) {
  const depth = currentDedicatedConnectionDepth() + 1;
  const release = await limiter.acquire(depth);
  observed.now += 1;
  observed.max = Math.max(observed.max, observed.now);
  try { return await runAtDedicatedConnectionDepth(depth, action); }
  finally { observed.now -= 1; release(); }
}

describe("dedicatedAdmissionLimit", () => {
  it("reserves capacity for each deeper nesting level and caps at the bound", () => {
    expect([1, 2, 3, 4, 9].map(depth => dedicatedAdmissionLimit(16, depth))).toEqual([10, 12, 14, 16, 16]);
    expect([1, 2, 3, 4].map(depth => dedicatedAdmissionLimit(4, depth))).toEqual([1, 2, 3, 4]);
  });

  it("rejects a bound too small to reserve a slot per nesting level", () => {
    expect(() => new DedicatedConnectionLimiter(3, 0)).toThrow("at least 4");
  });
});

describe("DedicatedConnectionLimiter", () => {
  it("never lets more than the top-level limit of concurrent holders in at once", async () => {
    const limiter = new DedicatedConnectionLimiter(8, 0);
    const observed = { now: 0, max: 0 };
    let finished = 0;
    await Promise.all(Array.from({ length: 50 }, async (_, index) => {
      await hold(limiter, observed, async () => { for (let i = 0; i < 1 + (index % 3); i++) await tick(); });
      finished += 1;
    }));
    expect(finished).toBe(50);
    expect(observed.max).toBe(dedicatedAdmissionLimit(8, 1));
    expect(limiter.peak).toBe(observed.max);
    expect(limiter.inUse).toBe(0);
    expect(limiter.waiting).toBe(0);
  });

  it("completes a burst of holders that each nest four deep without deadlock or exceeding the bound", async () => {
    const limiter = new DedicatedConnectionLimiter(8, 0);
    const observed = { now: 0, max: 0 };
    const nest = (remaining: number): Promise<number> => hold(limiter, observed, async () => {
      await tick();
      return remaining > 1 ? nest(remaining - 1) : currentDedicatedConnectionDepth();
    });
    const depths = await Promise.all(Array.from({ length: 40 }, () => nest(4)));
    expect(depths).toEqual(Array(40).fill(4));
    expect(observed.max).toBeLessThanOrEqual(8);
    expect(limiter.peak).toBeLessThanOrEqual(8);
    expect(limiter.inUse).toBe(0);
  });

  it("serves a nested request from reserved capacity while top-level callers queue", async () => {
    const limiter = new DedicatedConnectionLimiter(4, 0);
    const outer = await limiter.acquire(1);
    let topLevelAdmitted = false;
    const topLevel = limiter.acquire(1).then(release => { topLevelAdmitted = true; return release; });
    await tick();
    expect(topLevelAdmitted).toBe(false);
    const nested = await limiter.acquire(2);
    expect(limiter.inUse).toBe(2);
    nested();
    outer();
    (await topLevel)();
    expect(limiter.inUse).toBe(0);
  });

  it("admits queued callers in arrival order", async () => {
    const limiter = new DedicatedConnectionLimiter(4, 0);
    const first = await limiter.acquire(1);
    const order: number[] = [];
    const queued = [1, 2, 3].map(id => limiter.acquire(1).then(release => { order.push(id); release(); }));
    first();
    await Promise.all(queued);
    expect(order).toEqual([1, 2, 3]);
  });

  it("fails a caller that waits past the timeout and keeps the slot accounting intact", async () => {
    const limiter = new DedicatedConnectionLimiter(4, 20);
    const held = await limiter.acquire(1);
    await expect(limiter.acquire(1)).rejects.toBeInstanceOf(DedicatedConnectionWaitTimeoutError);
    expect(limiter.waiting).toBe(0);
    held();
    held();
    expect(limiter.inUse).toBe(0);
    (await limiter.acquire(1))();
  });
});
