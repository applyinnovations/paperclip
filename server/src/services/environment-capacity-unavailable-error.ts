import { readEnvironmentAcquireErrorDiagnostic, type PluginEnvironmentCapacityReason } from "@paperclipai/plugin-sdk";

/**
 * Error code of a run that was cancelled because its environment had no room
 * for a new sandbox. It is not a failure: the run waits, as a scheduled retry,
 * for capacity to free, and never spends the bounded transient-retry budget.
 */
export const ENVIRONMENT_CAPACITY_WAIT_CODE = "environment_capacity_wait";

/**
 * Why a run is waiting for its environment: the provider refused the sandbox
 * because the tenant quota was full (`quota`) or no node had room
 * (`scheduling`), or older runs were already waiting for the same environment
 * and this run joined the back of that queue (`queued`).
 */
export type EnvironmentCapacityWaitReason = PluginEnvironmentCapacityReason | "queued";

const PROVIDER_REASONS = new Set<string>(["quota", "scheduling"]);

function own(value: unknown, key: string): unknown {
  try {
    return value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  } catch { return undefined; }
}

/**
 * The capacity reason a provider attached to a refused lease acquisition: the
 * validated plugin RPC envelope, or the `capacityUnavailable` field of an
 * in-process provider's error. Message text is never parsed.
 */
export function readEnvironmentCapacityReason(error: unknown): PluginEnvironmentCapacityReason | null {
  for (let cause = error, depth = 0; cause && depth < 5; cause = own(cause, "cause"), depth++) {
    const reason = readEnvironmentAcquireErrorDiagnostic(cause)?.capacityUnavailable ?? own(cause, "capacityUnavailable");
    if (typeof reason === "string" && PROVIDER_REASONS.has(reason)) return reason as PluginEnvironmentCapacityReason;
  }
  return null;
}

/** A lease acquisition that has to wait for room in its environment. */
export class EnvironmentCapacityUnavailableError extends Error {
  readonly code = ENVIRONMENT_CAPACITY_WAIT_CODE;
  readonly environmentId: string;
  readonly reason: EnvironmentCapacityWaitReason;

  constructor(input: { environmentId: string; environmentName: string; reason: EnvironmentCapacityWaitReason; cause?: unknown }) {
    super(input.reason === "queued"
      ? `Environment "${input.environmentName}" has older runs waiting for capacity; this run waits behind them.`
      : `Environment "${input.environmentName}" has no capacity for a new sandbox (${input.reason === "quota" ? "the tenant quota is full" : "no node has room"}).`,
    input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "EnvironmentCapacityUnavailableError";
    this.environmentId = input.environmentId;
    this.reason = input.reason;
  }
}

/** Find a capacity wait through the orchestrator's error wrappers. */
export function findEnvironmentCapacityUnavailableError(error: unknown): EnvironmentCapacityUnavailableError | null {
  for (let cause = error, depth = 0; cause && depth < 4; cause = own(cause, "cause"), depth++) {
    if (cause instanceof EnvironmentCapacityUnavailableError) return cause;
  }
  return null;
}
