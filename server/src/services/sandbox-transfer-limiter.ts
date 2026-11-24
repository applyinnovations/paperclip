/**
 * Process-wide cap on concurrent native sandbox file transfers
 * (`syncIn`/`syncOut`) that pass through this server.
 *
 * Each transfer stages a tarball or bundle on host disk and streams it to or
 * from the sandbox through the provider's plugin worker. A single transfer is
 * bounded, but sixteen runs starting together means sixteen transfers at once,
 * and their buffers, temp files and page cache all land in this container.
 * Callers past the cap wait in FIFO order instead of failing: a queued
 * transfer is slower, not lost.
 *
 * `PAPERCLIP_SANDBOX_TRANSFER_CONCURRENCY` sets the cap (default 4, 1–64).
 */

export const DEFAULT_SANDBOX_TRANSFER_CONCURRENCY = 4;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 64;

export interface SandboxTransferLimiterSnapshot {
  concurrency: number;
  active: number;
  queued: number;
}

export interface SandboxTransferLimiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
  snapshot(): SandboxTransferLimiterSnapshot;
}

export function sandboxTransferConcurrencyFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCLIP_SANDBOX_TRANSFER_CONCURRENCY?.trim();
  if (!raw) return DEFAULT_SANDBOX_TRANSFER_CONCURRENCY;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_SANDBOX_TRANSFER_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.floor(parsed)));
}

export function createSandboxTransferLimiter(concurrency: number): SandboxTransferLimiter {
  const limit = Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.floor(concurrency)));
  let active = 0;
  const waiters: Array<() => void> = [];

  const release = () => {
    const next = waiters.shift();
    // Hand the slot straight to the next waiter so `active` never dips below
    // the cap while work is queued.
    if (next) next();
    else active -= 1;
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active < limit) active += 1;
      else await new Promise<void>((resolve) => waiters.push(resolve));
      try {
        return await fn();
      } finally {
        release();
      }
    },
    snapshot() {
      return { concurrency: limit, active, queued: waiters.length };
    },
  };
}

let sharedLimiter: SandboxTransferLimiter | null = null;

export function getSandboxTransferLimiter(): SandboxTransferLimiter {
  sharedLimiter ??= createSandboxTransferLimiter(sandboxTransferConcurrencyFromEnv());
  return sharedLimiter;
}
