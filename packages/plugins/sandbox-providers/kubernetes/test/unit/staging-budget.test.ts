import { describe, expect, it } from "vitest";
import {
  DEFAULT_SYNC_STAGING_BUDGET_BYTES,
  StagingBudget,
  StagingBudgetExceededError,
  parseByteQuantity,
  resolveSyncStagingBudgetBytes,
  SYNC_STAGING_BUDGET_ENV,
} from "../../src/staging-budget.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("StagingBudget", () => {
  it("grants immediately while bytes are free and queues the excess", async () => {
    const budget = new StagingBudget(100);
    const first = await budget.acquire(60);
    let secondGranted = false;
    const second = budget.acquire(60).then((reservation) => {
      secondGranted = true;
      return reservation;
    });
    await tick();
    expect(secondGranted).toBe(false);
    expect(budget.reservedBytes).toBe(60);
    expect(budget.waitingCount).toBe(1);

    first.release();
    const granted = await second;
    expect(secondGranted).toBe(true);
    expect(budget.reservedBytes).toBe(60);
    granted.release();
    expect(budget.reservedBytes).toBe(0);
  });

  it("rejects at once, without queueing, a reservation larger than the whole budget", async () => {
    const budget = new StagingBudget(100);
    const held = await budget.acquire(100);
    await expect(budget.acquire(101, { label: "Kubernetes syncOut directory transfer" })).rejects.toBeInstanceOf(
      StagingBudgetExceededError,
    );
    await expect(budget.acquire(101)).rejects.toThrow(/101 bytes .* 100-byte sync staging budget/);
    expect(budget.waitingCount).toBe(0);
    held.release();
  });

  it("serves waiters in FIFO order, so a large request is not starved by later small ones", async () => {
    const budget = new StagingBudget(100);
    const held = await budget.acquire(50);
    const order: string[] = [];
    const big = budget.acquire(100).then((r) => {
      order.push("big");
      return r;
    });
    const small = budget.acquire(10).then((r) => {
      order.push("small");
      return r;
    });
    await tick();
    // 10 bytes would fit now, but the 100-byte request is ahead of it.
    expect(order).toEqual([]);
    held.release();
    const bigReservation = await big;
    expect(order).toEqual(["big"]);
    bigReservation.release();
    (await small).release();
    expect(order).toEqual(["big", "small"]);
  });

  it("drops an aborted waiter from the queue without it ever holding bytes", async () => {
    const budget = new StagingBudget(100);
    const held = await budget.acquire(90);
    const controller = new AbortController();
    const blocked = budget.acquire(50, { signal: controller.signal });
    const behind = budget.acquire(10);
    await tick();
    controller.abort(new Error("exec timed out"));
    await expect(blocked).rejects.toThrow("exec timed out");
    // The aborted head no longer blocks the request behind it.
    (await behind).release();
    expect(budget.waitingCount).toBe(0);
    held.release();
    expect(budget.reservedBytes).toBe(0);
  });

  it("release is idempotent", async () => {
    const budget = new StagingBudget(10);
    const reservation = await budget.acquire(10);
    reservation.release();
    reservation.release();
    expect(budget.reservedBytes).toBe(0);
  });

  it("reports how long a reservation queued", async () => {
    const budget = new StagingBudget(10);
    const held = await budget.acquire(10);
    const waiting = budget.acquire(10);
    await new Promise((resolve) => setTimeout(resolve, 25));
    held.release();
    const reservation = await waiting;
    expect(reservation.waitMs).toBeGreaterThanOrEqual(20);
    reservation.release();
  });

  it("never holds more than its capacity across many concurrent random reservations", async () => {
    const capacity = 1000;
    const budget = new StagingBudget(capacity);
    let peak = 0;
    let live = 0;
    await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        const bytes = ((i * 37) % capacity) + 1;
        const reservation = await budget.acquire(bytes);
        live += bytes;
        peak = Math.max(peak, live);
        expect(budget.reservedBytes).toBeLessThanOrEqual(capacity);
        await new Promise((resolve) => setTimeout(resolve, i % 5));
        live -= bytes;
        reservation.release();
      }),
    );
    expect(peak).toBeLessThanOrEqual(capacity);
    expect(budget.reservedBytes).toBe(0);
  });
});

describe("sync staging budget configuration", () => {
  it("parses plain and suffixed byte quantities", () => {
    expect(parseByteQuantity("1048576")).toBe(1048576);
    expect(parseByteQuantity("512Mi")).toBe(512 * 1024 * 1024);
    expect(parseByteQuantity("2Gi")).toBe(2 * 1024 ** 3);
    expect(parseByteQuantity("1G")).toBe(1000 ** 3);
    expect(parseByteQuantity(" 64ki ")).toBe(64 * 1024);
    for (const bad of ["", "0", "-1", "1.5Gi", "1Ti", "lots"]) expect(parseByteQuantity(bad)).toBeNull();
  });

  it("defaults when unset and reports, then defaults, when invalid", () => {
    expect(resolveSyncStagingBudgetBytes({})).toBe(DEFAULT_SYNC_STAGING_BUDGET_BYTES);
    expect(resolveSyncStagingBudgetBytes({ [SYNC_STAGING_BUDGET_ENV]: "768Mi" })).toBe(768 * 1024 * 1024);
    const invalid: string[] = [];
    expect(resolveSyncStagingBudgetBytes({ [SYNC_STAGING_BUDGET_ENV]: "huge" }, (raw) => invalid.push(raw))).toBe(
      DEFAULT_SYNC_STAGING_BUDGET_BYTES,
    );
    expect(invalid).toEqual(["huge"]);
  });
});
