/**
 * The host's deadline for one environmentAcquireLease call.
 *
 * The host stops waiting at `acquireDeadlineAt` and fails the run. A Sandbox
 * the plugin finishes creating after that is handed to nobody: no lease row
 * points at it, so no release ever comes, and its pod holds a quota slot until
 * someone deletes it by hand. The plugin therefore stops waiting before the
 * deadline and deletes what it created.
 */

/**
 * Time kept back from the host's deadline to delete the Sandbox and answer.
 * A Foreground delete returns once the API server accepts it (well under a
 * second); the rest covers the RPC reply and clock skew between the two
 * processes, which share a host.
 */
export const ACQUIRE_RELEASE_RESERVE_MS = 5_000;

/** Epoch ms of the host's deadline, or null when an older host sends none. */
export function parseAcquireDeadline(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export class SandboxAcquireDeadlineError extends Error {
  constructor(namespace: string, name: string, when: string, cause?: unknown) {
    super(
      `Sandbox ${namespace}/${name} hit the host's acquire deadline ${when}; ` +
        "it was deleted so it does not hold a quota slot after the run fails.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "SandboxAcquireDeadlineError";
  }
}
