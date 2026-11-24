import { describe, expect, it, vi } from "vitest";
import { createShutdownRenewer, renewalStepMs } from "../../src/shutdown-renewal.js";

const HOUR = 3_600_000;
const MIN = 60_000;

function setup(startMs = Date.UTC(2026, 10, 24, 3, 0, 0)) {
  let nowMs = startMs;
  const patches: string[] = [];
  const warnings: string[] = [];
  const patch = vi.fn(async (shutdownTime: string) => {
    patches.push(shutdownTime);
  });
  const renewer = createShutdownRenewer({
    now: () => nowMs,
    // The test drives tick() itself.
    setInterval: () => ({}),
    clearInterval: () => undefined,
    warn: (message) => warnings.push(message),
  });
  return {
    renewer,
    patch,
    patches,
    warnings,
    get now() {
      return nowMs;
    },
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe("renewalStepMs", () => {
  it("is a quarter of the deadline, capped at five minutes and at least a second", () => {
    expect(renewalStepMs(HOUR, 5 * MIN)).toBe(5 * MIN);
    expect(renewalStepMs(4 * MIN, 5 * MIN)).toBe(MIN);
    expect(renewalStepMs(100, 5 * MIN)).toBe(1000);
  });
});

describe("createShutdownRenewer", () => {
  it("keeps the Sandbox of a command that runs past the initial deadline", async () => {
    const t = setup();
    let shutdownMs = t.now + HOUR;
    t.renewer.hold("pc-a", {
      ttlMs: HOUR,
      shutdownMs,
      patchShutdownTime: async (iso) => {
        shutdownMs = Date.parse(iso);
        await t.patch(iso);
      },
    });

    let finish!: () => void;
    const command = t.renewer.track("pc-a", () => new Promise<void>((resolve) => (finish = resolve)));

    // 90 minutes of one command, with the timer firing every five minutes. The
    // controller deletes the Sandbox the moment now passes shutdownMs.
    for (let elapsed = 0; elapsed < 90 * MIN; elapsed += 5 * MIN) {
      t.advance(5 * MIN);
      await t.renewer.tick();
      expect(shutdownMs).toBeGreaterThan(t.now + 45 * MIN);
    }
    finish();
    await command;
    expect(t.patch.mock.calls.length).toBeGreaterThanOrEqual(17);
    expect(t.patch.mock.calls.length).toBeLessThanOrEqual(19);
  });

  it("does not renew an idle lease, so an orphan is still reaped", async () => {
    const t = setup();
    t.renewer.hold("pc-idle", { ttlMs: HOUR, shutdownMs: t.now + HOUR, patchShutdownTime: t.patch });
    for (let i = 0; i < 14; i += 1) {
      t.advance(5 * MIN);
      await t.renewer.tick();
    }
    expect(t.patch).not.toHaveBeenCalled();
    // Past its deadline the entry is dropped.
    expect(t.renewer.isHeld("pc-idle")).toBe(false);
  });

  it("extends from the last activity, not beyond it", async () => {
    const t = setup();
    t.renewer.hold("pc-b", { ttlMs: HOUR, shutdownMs: t.now + HOUR, patchShutdownTime: t.patch });
    t.advance(30 * MIN);
    await t.renewer.track("pc-b", async () => undefined);
    await Promise.resolve();
    expect(t.patches).toEqual([new Date(t.now + HOUR).toISOString()]);
  });

  it("does not patch a touch inside one renewal step", async () => {
    const t = setup();
    t.renewer.hold("pc-c", { ttlMs: HOUR, shutdownMs: t.now + HOUR, patchShutdownTime: t.patch });
    t.advance(4 * MIN);
    await t.renewer.touch("pc-c");
    expect(t.patch).not.toHaveBeenCalled();
    t.advance(MIN);
    await t.renewer.touch("pc-c");
    expect(t.patch).toHaveBeenCalledTimes(1);
  });

  it("renews a lease of unknown deadline (resumed) on its first touch", async () => {
    const t = setup();
    t.renewer.hold("pc-r", { ttlMs: HOUR, patchShutdownTime: t.patch });
    await t.renewer.touch("pc-r");
    expect(t.patches).toEqual([new Date(t.now + HOUR).toISOString()]);
  });

  it("rounds the shutdown time down to whole seconds", async () => {
    const t = setup(Date.UTC(2026, 10, 24, 3, 0, 0, 750));
    t.renewer.hold("pc-s", { ttlMs: HOUR, patchShutdownTime: t.patch });
    await t.renewer.touch("pc-s");
    expect(t.patches[0]).toBe("2026-11-24T04:00:00.000Z");
  });

  it("logs a failed patch, does not fail the command, and retries on the next tick", async () => {
    const t = setup();
    const patch = vi
      .fn<(iso: string) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error("forbidden"), { code: 403 }))
      .mockResolvedValue(undefined);
    t.renewer.hold("pc-f", { ttlMs: HOUR, shutdownMs: t.now + HOUR, patchShutdownTime: patch });
    t.advance(10 * MIN);
    let finish!: (v: string) => void;
    const command = t.renewer.track("pc-f", () => new Promise<string>((resolve) => (finish = resolve)));
    await Promise.resolve();
    await Promise.resolve();
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toContain("pc-f");
    await t.renewer.tick();
    expect(patch).toHaveBeenCalledTimes(2);
    finish("done");
    await expect(command).resolves.toBe("done");
  });

  it("forgets a Sandbox that is already gone (404)", async () => {
    const t = setup();
    t.renewer.hold("pc-g", {
      ttlMs: HOUR,
      patchShutdownTime: async () => {
        throw Object.assign(new Error("not found"), { code: 404 });
      },
    });
    await t.renewer.touch("pc-g");
    expect(t.renewer.isHeld("pc-g")).toBe(false);
    expect(t.warnings).toEqual([]);
  });

  it("stops renewing a released lease", async () => {
    const t = setup();
    t.renewer.hold("pc-x", { ttlMs: HOUR, shutdownMs: t.now + HOUR, patchShutdownTime: t.patch });
    t.renewer.forget("pc-x");
    t.advance(30 * MIN);
    await t.renewer.touch("pc-x");
    await t.renewer.track("pc-x", async () => undefined);
    expect(t.patch).not.toHaveBeenCalled();
  });
});
