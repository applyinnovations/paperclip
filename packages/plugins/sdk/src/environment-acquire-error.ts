import { PluginEnvironmentCreationCleanupError, environmentCreationCleanupErrorData } from "./environment-creation-cleanup.js";
import {
  providerErrorDiagnostic,
  sanitizeProviderErrorDiagnostic,
  type PluginEnvironmentResumeErrorDiagnostic,
} from "./environment-resume-error.js";

/**
 * Why a provider had no room for a new sandbox: the tenant's quota was full
 * (`quota`) or no node could take the pod (`scheduling`). Both clear on their
 * own as other sandboxes finish.
 */
export type PluginEnvironmentCapacityReason = "quota" | "scheduling";

const CAPACITY_REASONS = new Set<PluginEnvironmentCapacityReason>(["quota", "scheduling"]);

/**
 * Diagnostic evidence for a refused `environmentAcquireLease`: the provider's
 * HTTP status or a closed errno code, and whether the refusal was a temporary
 * lack of capacity. It crosses the worker RPC boundary as structured error data
 * because a JSON-RPC error carries only a message and a numeric RPC code.
 * Provider text and identifiers never cross. The host uses it only to decide
 * whether a bounded retry, or waiting for capacity, is worthwhile; ownership of
 * any provisional allocation stays with the creation-cleanup envelope.
 */
export type PluginEnvironmentAcquireErrorDiagnostic = PluginEnvironmentResumeErrorDiagnostic & {
  capacityUnavailable?: PluginEnvironmentCapacityReason;
};

/**
 * Thrown by a provider whose sandbox could not start only because capacity is
 * short (a full quota, or no node with room). The provider has already released
 * anything it created for the attempt. Unlike other refusals it is expected to
 * clear without operator action, so the host may wait and try again.
 */
export class PluginEnvironmentCapacityUnavailableError extends Error {
  readonly capacityUnavailable: PluginEnvironmentCapacityReason;

  constructor(reason: PluginEnvironmentCapacityReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PluginEnvironmentCapacityUnavailableError";
    this.capacityUnavailable = reason;
  }
}

const SCHEMA = "paperclip/environment-acquire-error/v1";
const CLEANUP_SCHEMA = "paperclip/environment-creation-cleanup/v1";

function field(value: unknown, key: string): unknown {
  try { return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}

/**
 * Worker side: the RPC error data for a failed acquisition. A creation whose
 * cleanup could not be confirmed keeps its ownership envelope and adds the
 * status of the create call only, never of the compensating lookup or delete.
 */
export function environmentAcquireErrorData(error: unknown): unknown {
  const createError = error instanceof PluginEnvironmentCreationCleanupError ? error.errors[0] : error;
  const capacityUnavailable = capacityReason(createError);
  // A capacity refusal carries no transient status, so the host never mistakes
  // it for a provider outage and spends its bounded retries on it.
  const providerDiagnostic = capacityUnavailable ? null : providerErrorDiagnostic(createError);
  const extra = {
    ...(providerDiagnostic ? { providerDiagnostic } : {}),
    ...(capacityUnavailable ? { capacityUnavailable } : {}),
  };
  const cleanup = environmentCreationCleanupErrorData(error, true);
  if (cleanup && typeof cleanup === "object") return { ...cleanup, ...extra };
  return Object.keys(extra).length > 0 ? { schema: SCHEMA, ...extra } : undefined;
}

/** The capacity reason on a thrown error or its causes, if any. */
function capacityReason(error: unknown): PluginEnvironmentCapacityReason | undefined {
  for (let cause = error, depth = 0; cause && depth < 4; cause = field(cause, "cause"), depth++) {
    const reason = field(cause, "capacityUnavailable");
    if (typeof reason === "string" && CAPACITY_REASONS.has(reason as PluginEnvironmentCapacityReason)) {
      return reason as PluginEnvironmentCapacityReason;
    }
  }
  return undefined;
}

/** Host side: read and re-validate the provider diagnostic from an RPC error. */
export function readEnvironmentAcquireErrorDiagnostic(error: unknown): PluginEnvironmentAcquireErrorDiagnostic | null {
  const data = field(error, "data");
  const schema = field(data, "schema");
  if (schema !== SCHEMA && schema !== CLEANUP_SCHEMA) return null;
  const diagnostic = field(data, "providerDiagnostic");
  const provider = sanitizeProviderErrorDiagnostic({ httpStatus: field(diagnostic, "httpStatus"), errorCode: field(diagnostic, "errorCode") });
  const capacity = field(data, "capacityUnavailable");
  const capacityUnavailable = typeof capacity === "string" && CAPACITY_REASONS.has(capacity as PluginEnvironmentCapacityReason)
    ? capacity as PluginEnvironmentCapacityReason : undefined;
  if (!capacityUnavailable) return provider;
  return { ...provider, capacityUnavailable };
}
