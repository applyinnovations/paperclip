/**
 * Worker-wide budget for bytes a file sync stages on the host's disk.
 *
 * Outbound syncs (`syncOut`) must land the sandbox-authored archive on disk
 * before it can be member-confined and extracted. Without a bound, peak host
 * `/tmp` is the sum of every concurrent sync's archive, so it grows with agent
 * count and workspace size until the server is evicted. This budget is a FIFO
 * weighted semaphore over staged bytes: a sync reserves its exact size before
 * writing, excess syncs wait in arrival order, and a sync that alone exceeds
 * the budget fails at once with {@link StagingBudgetExceededError} instead of
 * filling the disk.
 *
 * Each reservation is taken whole, once, before any byte is written, so two
 * syncs can never each hold part of the budget while waiting for the rest
 * (no deadlock). The queue is strict FIFO, so a large request is not starved
 * by a stream of small ones.
 */

export class StagingBudgetExceededError extends Error {
  constructor(
    readonly requestedBytes: number,
    readonly capacityBytes: number,
    label: string,
  ) {
    super(
      `${label} needs ${requestedBytes} bytes of host staging, more than the whole ` +
        `${capacityBytes}-byte sync staging budget (${SYNC_STAGING_BUDGET_ENV}); ` +
        "raise the budget or sync less data in one operation.",
    );
    this.name = "StagingBudgetExceededError";
  }
}

export interface StagingReservation {
  /** Bytes held by this reservation. */
  readonly bytes: number;
  /** Time spent queued before the reservation was granted. */
  readonly waitMs: number;
  /** Return the bytes to the budget. Idempotent. */
  release(): void;
}

interface Waiter {
  bytes: number;
  enqueuedAt: number;
  grant: (reservation: StagingReservation) => void;
  reject: (error: unknown) => void;
}

export class StagingBudget {
  private inUse = 0;
  private readonly queue: Waiter[] = [];

  constructor(readonly capacityBytes: number) {
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes <= 0) {
      throw new Error(`staging budget must be a positive integer byte count, got ${capacityBytes}`);
    }
  }

  /** Bytes currently reserved. */
  get reservedBytes(): number {
    return this.inUse;
  }

  /** Reservations waiting for bytes. */
  get waitingCount(): number {
    return this.queue.length;
  }

  /**
   * Reserve `bytes`, waiting in FIFO order until they are free. Rejects at once
   * with {@link StagingBudgetExceededError} when `bytes` exceeds the whole
   * budget, and with the signal's reason if `signal` aborts while queued (the
   * request then leaves the queue without ever holding bytes).
   */
  acquire(bytes: number, options: { signal?: AbortSignal; label?: string } = {}): Promise<StagingReservation> {
    const label = options.label ?? "Kubernetes file sync";
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      return Promise.reject(new Error(`${label}: invalid staging reservation of ${bytes} bytes`));
    }
    if (bytes > this.capacityBytes) {
      return Promise.reject(new StagingBudgetExceededError(bytes, this.capacityBytes, label));
    }
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const enqueuedAt = Date.now();
    if (this.queue.length === 0 && this.inUse + bytes <= this.capacityBytes) {
      return Promise.resolve(this.grant(bytes, enqueuedAt));
    }
    return new Promise<StagingReservation>((resolve, reject) => {
      const waiter: Waiter = { bytes, enqueuedAt, grant: resolve, reject };
      this.queue.push(waiter);
      const signal = options.signal;
      if (!signal) return;
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index === -1) return;
        this.queue.splice(index, 1);
        reject(signal.reason);
        // The head may have been the only thing blocking smaller requests.
        this.drain();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      waiter.grant = (reservation) => {
        signal.removeEventListener("abort", onAbort);
        resolve(reservation);
      };
    });
  }

  private grant(bytes: number, enqueuedAt: number): StagingReservation {
    this.inUse += bytes;
    let released = false;
    return {
      bytes,
      waitMs: Date.now() - enqueuedAt,
      release: () => {
        if (released) return;
        released = true;
        this.inUse -= bytes;
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (this.inUse + head.bytes > this.capacityBytes) return;
      this.queue.shift();
      head.grant(this.grant(head.bytes, head.enqueuedAt));
    }
  }
}

/** Env var holding the worker-wide sync staging budget. */
export const SYNC_STAGING_BUDGET_ENV = "PAPERCLIP_K8S_SYNC_STAGING_BUDGET_BYTES";

/**
 * Default budget: 1 GiB. Sized to sit well under a few-GiB `/tmp` (the server
 * shares it with everything else that writes temp files) while still admitting
 * a large single workspace archive.
 */
export const DEFAULT_SYNC_STAGING_BUDGET_BYTES = 1024 * 1024 * 1024;

const UNIT_FACTORS: Record<string, number> = {
  "": 1,
  k: 1000,
  m: 1000 ** 2,
  g: 1000 ** 3,
  ki: 1024,
  mi: 1024 ** 2,
  gi: 1024 ** 3,
};

/**
 * Parse a byte count: a plain integer, or an integer with a Kubernetes-style
 * suffix (`K`/`M`/`G`, `Ki`/`Mi`/`Gi`). Returns null for anything else.
 */
export function parseByteQuantity(raw: string | undefined): number | null {
  const match = raw?.trim().match(/^(\d+)\s*([kKmMgG]i?)?$/);
  if (!match) return null;
  const factor = UNIT_FACTORS[(match[2] ?? "").toLowerCase()];
  const bytes = Number(match[1]) * factor;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

/**
 * Resolve the configured budget from the worker env. An unset value uses the
 * default; an invalid one also uses the default and is reported through
 * `onInvalid` so a typo is visible rather than silently ignored.
 */
export function resolveSyncStagingBudgetBytes(
  env: Record<string, string | undefined> = process.env,
  onInvalid?: (raw: string) => void,
): number {
  const raw = env[SYNC_STAGING_BUDGET_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_SYNC_STAGING_BUDGET_BYTES;
  const parsed = parseByteQuantity(raw);
  if (parsed === null) {
    onInvalid?.(raw);
    return DEFAULT_SYNC_STAGING_BUDGET_BYTES;
  }
  return parsed;
}

let workerBudget: StagingBudget | null = null;

/** The single budget shared by every sync in this worker process. */
export function getSyncStagingBudget(onInvalid?: (raw: string) => void): StagingBudget {
  workerBudget ??= new StagingBudget(resolveSyncStagingBudgetBytes(process.env, onInvalid));
  return workerBudget;
}
