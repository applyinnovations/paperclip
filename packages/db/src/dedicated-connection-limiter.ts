import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Bounds how many single-connection clients `withDedicatedDbConnection` holds
 * open at once for one `createDb` owner. Callers keep one private connection
 * per holder (they take session- and transaction-scoped advisory locks), but a
 * burst beyond the bound queues here instead of opening more backends.
 *
 * Holders nest: a lock holder can call another helper that takes its own
 * dedicated connection. A flat semaphore would deadlock once every permit
 * belongs to a holder waiting for a nested one. Admission is therefore graded
 * by nesting depth: a holder at depth `d` may only take a permit while fewer
 * than `admissionLimit(d)` are in use, and deeper levels have higher limits.
 * The permits between two levels' limits can only go to deeper holders, so a
 * nested request always has capacity that shallower holders cannot consume,
 * and nesting up to `DEDICATED_CONNECTION_LEVELS` deep cannot deadlock. Total
 * use never exceeds `maxConnections`.
 *
 * Waits can still form a cycle through another in-process queue (a holder
 * waiting on an I/O slot whose owner waits for a dedicated permit). The wait
 * timeout turns such a cycle into a `dedicated_connection_wait_timeout` error
 * instead of a hang.
 */
export const DEDICATED_CONNECTION_LEVELS = 4;
export const MIN_DEDICATED_CONNECTIONS = DEDICATED_CONNECTION_LEVELS;
export const DEFAULT_DEDICATED_MAX_CONNECTIONS = 16;
export const DEFAULT_DEDICATED_WAIT_TIMEOUT_SECONDS = 120;

export class DedicatedConnectionWaitTimeoutError extends Error {
  readonly code = "dedicated_connection_wait_timeout";
  constructor(readonly waitedMs: number, readonly maxConnections: number) {
    super("dedicated_connection_wait_timeout");
  }
}

/** Depth of dedicated connections the current async context already holds. */
const heldDepth = new AsyncLocalStorage<number>();

export function currentDedicatedConnectionDepth(): number {
  return heldDepth.getStore() ?? 0;
}

export function runAtDedicatedConnectionDepth<T>(depth: number, action: () => Promise<T>): Promise<T> {
  return heldDepth.run(depth, action);
}

/** In-use limit for a request at `depth` (1 = not inside another holder). */
export function dedicatedAdmissionLimit(maxConnections: number, depth: number): number {
  const level = Math.min(Math.max(depth, 1), DEDICATED_CONNECTION_LEVELS);
  const reserve = Math.max(1, Math.floor(maxConnections / 8));
  return maxConnections - reserve * (DEDICATED_CONNECTION_LEVELS - level);
}

type Waiter = { limit: number; grant: () => void };

export class DedicatedConnectionLimiter {
  #inUse = 0;
  #peak = 0;
  readonly #waiters: Waiter[] = [];

  constructor(readonly maxConnections: number, readonly waitTimeoutMs: number) {
    if (!Number.isInteger(maxConnections) || maxConnections < MIN_DEDICATED_CONNECTIONS) {
      throw new Error(`Dedicated connection limit must be an integer of at least ${MIN_DEDICATED_CONNECTIONS}, got: ${maxConnections}`);
    }
  }

  get inUse(): number { return this.#inUse; }
  get peak(): number { return this.#peak; }
  get waiting(): number { return this.#waiters.length; }

  /** Resolves with an idempotent release once a permit is held. */
  acquire(depth: number): Promise<() => void> {
    const limit = dedicatedAdmissionLimit(this.maxConnections, depth);
    // Every queued waiter is ineligible at the current count (`#drain` runs on
    // each release), and limits rise with depth, so admitting an eligible
    // newcomer never overtakes an eligible waiter.
    if (this.#inUse < limit) return Promise.resolve(this.#take());
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      const waiter: Waiter = {
        limit,
        grant: () => {
          if (timer) clearTimeout(timer);
          resolve(this.#take());
        },
      };
      if (this.waitTimeoutMs > 0) {
        timer = setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index < 0) return;
          this.#waiters.splice(index, 1);
          reject(new DedicatedConnectionWaitTimeoutError(Date.now() - started, this.maxConnections));
        }, this.waitTimeoutMs);
        timer.unref?.();
      }
      this.#waiters.push(waiter);
    });
  }

  #take(): () => void {
    this.#inUse += 1;
    if (this.#inUse > this.#peak) this.#peak = this.#inUse;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inUse -= 1;
      this.#drain();
    };
  }

  /** Grants waiters in arrival order among those the current count admits. */
  #drain(): void {
    for (let index = 0; index < this.#waiters.length && this.#inUse < this.maxConnections;) {
      const waiter = this.#waiters[index]!;
      if (this.#inUse < waiter.limit) {
        this.#waiters.splice(index, 1);
        waiter.grant();
      } else index += 1;
    }
  }
}
