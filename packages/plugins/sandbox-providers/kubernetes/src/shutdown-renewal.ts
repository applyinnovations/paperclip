/**
 * Keeps a held Sandbox lease's `spec.shutdownTime` ahead of its activity.
 *
 * A Sandbox is created with `shutdownPolicy: Delete` and a `shutdownTime` of
 * creation + `podActivityDeadlineSec`, so the controller reaps it if the server
 * never releases it. Left alone, that deadline also deletes the pod of a run
 * that lasts longer, mid-run. The renewer moves the deadline forward while the
 * lease is in use: on each touch (acquire, resume, sync) and, while a command
 * is running in the pod, on a timer. A lease with no activity is not renewed,
 * so an orphan is still reaped one deadline after its last use.
 *
 * While a command runs, the timer fires every `renewalStepMs` (a quarter of the
 * deadline, at most 5 min) and patches once the deadline has fallen a step
 * behind now + deadline. New shutdown times are rounded *up* to whole seconds
 * (the API server stores seconds), so a patch always leaves at least the full
 * deadline ahead. Together that keeps the deadline at least half of
 * `podActivityDeadlineSec` ahead of now during a command, for every accepted
 * value down to 1 s.
 *
 * Renewal is best effort: a failed patch is logged and retried on the next
 * touch or tick, and never fails the command that triggered it.
 */

export interface ShutdownRenewalLease {
  /** How far past the last activity the Sandbox may live, in ms. */
  ttlMs: number;
  /** The Sandbox's current shutdown time, if known (ms since epoch). */
  shutdownMs?: number;
  /** Writes `spec.shutdownTime` on the Sandbox. */
  patchShutdownTime(shutdownTime: string): Promise<void>;
}

export interface ShutdownRenewerOptions {
  now?: () => number;
  /** Upper bound on the renewal step and the in-flight timer (default 5 min). */
  maxStepMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  warn?: (message: string) => void;
}

interface Entry {
  ttlMs: number;
  shutdownMs: number;
  inFlight: number;
  patching: Promise<void> | null;
  patchShutdownTime(shutdownTime: string): Promise<void>;
}

export interface ShutdownRenewer {
  /** Start (or refresh) renewing a lease. Does not by itself extend it. */
  hold(leaseId: string, lease: ShutdownRenewalLease): void;
  isHeld(leaseId: string): boolean;
  /** Record activity now: extend the deadline if it is due. */
  touch(leaseId: string): Promise<void>;
  /** Keep the deadline ahead of `now` for as long as `work` runs. */
  track<T>(leaseId: string, work: () => Promise<T>): Promise<T>;
  forget(leaseId: string): void;
  /** One timer pass; exported for tests. */
  tick(): Promise<void>;
}

/**
 * The timer period and the minimum extension worth a patch: a quarter of the
 * deadline, capped at `maxStepMs`. Never more than a quarter, so even the
 * shortest deadline (1 s) is renewed well before it passes.
 */
export function renewalStepMs(ttlMs: number, maxStepMs: number): number {
  return Math.max(1, Math.min(maxStepMs, Math.floor(ttlMs / 4)));
}

export function createShutdownRenewer(options: ShutdownRenewerOptions = {}): ShutdownRenewer {
  const now = options.now ?? (() => Date.now());
  const maxStepMs = options.maxStepMs ?? 5 * 60_000;
  const setTimer = options.setInterval ?? ((fn, ms) => {
    const handle = setInterval(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  });
  const clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const warn = options.warn ?? ((message) => console.warn(message));
  const entries = new Map<string, Entry>();
  let timer: unknown = null;
  let timerMs = 0;

  function syncTimer(): void {
    let wanted = 0;
    for (const entry of entries.values()) {
      const step = renewalStepMs(entry.ttlMs, maxStepMs);
      if (wanted === 0 || step < wanted) wanted = step;
    }
    if (wanted === timerMs) return;
    if (timer !== null) clearTimer(timer);
    timer = wanted > 0 ? setTimer(() => void tick(), wanted) : null;
    timerMs = wanted;
  }

  function renewIfDue(leaseId: string, entry: Entry): Promise<void> {
    if (entry.patching) return entry.patching;
    // Round up: rounding down would leave less than a full deadline ahead.
    const target = Math.ceil((now() + entry.ttlMs) / 1000) * 1000;
    if (target - entry.shutdownMs < renewalStepMs(entry.ttlMs, maxStepMs)) return Promise.resolve();
    entry.patching = entry
      .patchShutdownTime(new Date(target).toISOString())
      .then(
        () => {
          entry.shutdownMs = Math.max(entry.shutdownMs, target);
        },
        (err: unknown) => {
          const code = (err as { code?: number; statusCode?: number }).code
            ?? (err as { code?: number; statusCode?: number }).statusCode;
          if (code === 404) {
            // The Sandbox is gone; nothing left to keep alive.
            if (entries.get(leaseId) === entry) {
              entries.delete(leaseId);
              syncTimer();
            }
            return;
          }
          warn(
            `[plugin-kubernetes] could not renew the shutdown time of Sandbox ${leaseId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        },
      )
      .finally(() => {
        entry.patching = null;
      });
    return entry.patching;
  }

  async function tick(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [leaseId, entry] of entries) {
      if (entry.inFlight > 0) {
        pending.push(renewIfDue(leaseId, entry));
      } else if (!entry.patching && entry.shutdownMs > 0 && now() > entry.shutdownMs) {
        // Idle past its deadline: the controller has reaped it.
        entries.delete(leaseId);
      }
    }
    syncTimer();
    await Promise.all(pending);
  }

  return {
    hold(leaseId, lease) {
      const existing = entries.get(leaseId);
      if (existing) {
        existing.ttlMs = lease.ttlMs;
        existing.patchShutdownTime = lease.patchShutdownTime;
        existing.shutdownMs = Math.max(existing.shutdownMs, lease.shutdownMs ?? 0);
      } else {
        entries.set(leaseId, {
          ttlMs: lease.ttlMs,
          shutdownMs: lease.shutdownMs ?? 0,
          inFlight: 0,
          patching: null,
          patchShutdownTime: lease.patchShutdownTime,
        });
      }
      syncTimer();
    },
    isHeld(leaseId) {
      return entries.has(leaseId);
    },
    touch(leaseId) {
      const entry = entries.get(leaseId);
      return entry ? renewIfDue(leaseId, entry) : Promise.resolve();
    },
    async track(leaseId, work) {
      const entry = entries.get(leaseId);
      if (!entry) return work();
      entry.inFlight += 1;
      void renewIfDue(leaseId, entry);
      try {
        return await work();
      } finally {
        entry.inFlight -= 1;
        void renewIfDue(leaseId, entry);
      }
    },
    forget(leaseId) {
      if (entries.delete(leaseId)) syncTimer();
    },
    tick,
  };
}
