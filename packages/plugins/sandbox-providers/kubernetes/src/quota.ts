/**
 * Tenant ResourceQuota check for the Sandbox readiness wait.
 *
 * A Sandbox whose pod the tenant quota refuses stays Pending: the controller
 * retries the pod create until something frees up. Without this check the
 * acquire waits out the host's deadline and fails as
 * SandboxAcquireDeadlineError, hiding the cause. While the Sandbox has no pod,
 * the wait reads the quota and fails at once, naming it, when this Sandbox's
 * pod cannot fit.
 *
 * The check can only shorten a wait. A quota that is missing, unreadable or
 * forbidden leaves the wait exactly as it was.
 */

import type { KubeClients } from "./kube-client.js";

/** Set by ensureTenant; the provisioner Role may `get` only this name. */
export const TENANT_RESOURCE_QUOTA_NAME = "paperclip-quota";

/**
 * Consecutive Pending polls that must see the shortfall before failing. One
 * read can race a pod that is just being deleted; two (a poll apart) cannot.
 */
export const QUOTA_SHORTFALL_POLLS = 2;

export class SandboxQuotaExceededError extends Error {
  readonly quotaName: string;
  readonly exhausted: string[];

  constructor(namespace: string, name: string, quotaName: string, exhausted: string[]) {
    super(
      `quota ${quotaName} exhausted: ${exhausted.join(", ")}. ` +
        `Sandbox ${namespace}/${name} could not start its pod and was deleted.`,
    );
    this.name = "SandboxQuotaExceededError";
    this.quotaName = quotaName;
    this.exhausted = exhausted;
  }
}

const BINARY_SUFFIXES: Record<string, number> = {
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
};
const DECIMAL_SUFFIXES: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3, "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
};

/** Parse a Kubernetes resource quantity ("2", "500m", "4Gi", "1e3"). NaN if unknown. */
export function parseQuantity(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]{0,2})$/.exec(value.trim());
  if (!match) return Number.NaN;
  const [, number, suffix] = match;
  const scale = BINARY_SUFFIXES[suffix] ?? DECIMAL_SUFFIXES[suffix];
  return scale === undefined ? Number.NaN : Number(number) * scale;
}

type ResourceList = Record<string, unknown> | undefined;
type Container = { resources?: { requests?: ResourceList; limits?: ResourceList } };

/**
 * What one pod of this Sandbox counts against the quota, keyed by quota
 * resource name: one pod plus the sum of its containers' requests and limits.
 * Resources the pod does not set are left out, so the check never guesses.
 */
export function sandboxQuotaDemand(manifest: Record<string, unknown>): Record<string, number> {
  const podSpec = ((manifest.spec as Record<string, unknown> | undefined)?.podTemplate as
    | { spec?: { containers?: Container[] } }
    | undefined)?.spec;
  const demand: Record<string, number> = { pods: 1 };
  const add = (key: string, value: unknown) => {
    const quantity = parseQuantity(value);
    if (Number.isFinite(quantity)) demand[key] = (demand[key] ?? 0) + quantity;
  };
  for (const container of podSpec?.containers ?? []) {
    for (const resource of ["cpu", "memory"]) {
      const request = container.resources?.requests?.[resource];
      if (request !== undefined) {
        add(`requests.${resource}`, request);
        // A bare "cpu"/"memory" quota entry means requests.
        add(resource, request);
      }
      const limit = container.resources?.limits?.[resource];
      if (limit !== undefined) add(`limits.${resource}`, limit);
    }
  }
  return demand;
}

/**
 * The quota resources this pod would push over their hard limit, as
 * "pods 16/16". Only resources in `demand` are compared.
 */
export function quotaShortfall(
  quota: { status?: { hard?: Record<string, unknown>; used?: Record<string, unknown> } },
  demand: Record<string, number>,
): string[] {
  const hard = quota.status?.hard ?? {};
  const used = quota.status?.used ?? {};
  const short: string[] = [];
  for (const [resource, need] of Object.entries(demand)) {
    if (!(resource in hard)) continue;
    const hardValue = parseQuantity(hard[resource]);
    const usedValue = parseQuantity(used[resource] ?? "0");
    if (!Number.isFinite(hardValue) || !Number.isFinite(usedValue)) continue;
    if (usedValue + need > hardValue) {
      short.push(`${resource} ${String(used[resource] ?? "0")}/${String(hard[resource])}`);
    }
  }
  return short;
}

export interface QuotaGateLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * A check to run on each Pending poll of the readiness wait. Throws
 * SandboxQuotaExceededError once the Sandbox has no pod and the quota has had
 * no room for it on QUOTA_SHORTFALL_POLLS consecutive polls. The first failed
 * quota read turns the check off for this acquire.
 */
export function createQuotaGate(input: {
  clients: KubeClients;
  namespace: string;
  sandboxName: string;
  demand: Record<string, number>;
  quotaName?: string;
  logger?: QuotaGateLogger;
}): () => Promise<void> {
  const quotaName = input.quotaName ?? TENANT_RESOURCE_QUOTA_NAME;
  let disabled = false;
  let streak = 0;

  return async () => {
    if (disabled) return;
    let quota: Parameters<typeof quotaShortfall>[0];
    try {
      quota = (await input.clients.core.readNamespacedResourceQuota({
        name: quotaName,
        namespace: input.namespace,
      })) as typeof quota;
    } catch (err) {
      disabled = true;
      input.logger?.warn("Tenant quota unreadable; waiting for the Sandbox without the quota check", {
        namespace: input.namespace,
        quota: quotaName,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const short = quotaShortfall(quota, input.demand);
    if (short.length === 0 || (await sandboxHasPod(input.clients, input.namespace, input.sandboxName))) {
      // Room, or the pod already exists: quota is not what this wait is on.
      streak = 0;
      return;
    }
    streak += 1;
    if (streak >= QUOTA_SHORTFALL_POLLS) {
      throw new SandboxQuotaExceededError(input.namespace, input.sandboxName, quotaName, short);
    }
  };
}

/**
 * Whether the Sandbox's pod exists. The agent-sandbox controller names the pod
 * after the Sandbox. Any read error other than 404 counts as "has a pod", so an
 * unreadable cluster never produces a quota error.
 */
async function sandboxHasPod(clients: KubeClients, namespace: string, name: string): Promise<boolean> {
  try {
    await clients.core.readNamespacedPod({ namespace, name });
    return true;
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { code?: number; statusCode?: number }).statusCode;
    return code !== 404;
  }
}
