/**
 * Creation recovery: find and delete a workload whose acquire failed.
 *
 * The host writes a creation intent before every environmentAcquireLease and
 * passes its id as `creationOperationId`. Each workload carries that id in the
 * `paperclip.io/create-attempt` label. When an acquire fails (the host's RPC
 * timed out, the server restarted mid-call) no lease row points at the
 * workload, so no release ever comes for it. The host's creation recovery then
 * asks this plugin, by attempt id, whether something was created. A match
 * returns a cleanup envelope; the host turns it into a pending-cleanup lease
 * and destroys it through onEnvironmentDestroyLease.
 */

import { createHash } from "node:crypto";
import type { KubeConfig } from "@kubernetes/client-node";
import type { PluginEnvironmentCreationCleanup } from "@paperclipai/plugin-sdk";
import type { KubeClients } from "./kube-client.js";
import { isKubeNotFoundError } from "./lease-lifecycle.js";
import { SANDBOX_GROUP, SANDBOX_PLURAL, SANDBOX_VERSION } from "./sandbox-cr-orchestrator.js";

export const CREATE_ATTEMPT_LABEL = "paperclip.io/create-attempt";
const RUN_ID_LABEL = "paperclip.io/run-id";
const COMPANY_ID_LABEL = "paperclip.io/company-id";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** The create-attempt label for an acquire, or none when the host sent no usable id. */
export function createAttemptLabels(creationOperationId: unknown): Record<string, string> {
  return typeof creationOperationId === "string" && UUID.test(creationOperationId)
    ? { [CREATE_ATTEMPT_LABEL]: creationOperationId }
    : {};
}

export interface CreationWorkload {
  name: string;
  labels: Record<string, string>;
}

function workloadsFrom(list: unknown): CreationWorkload[] {
  const items = (list as { items?: unknown[] } | undefined)?.items ?? [];
  return items.flatMap(item => {
    const metadata = (item as { metadata?: { name?: unknown; labels?: unknown } }).metadata;
    if (typeof metadata?.name !== "string") return [];
    const labels = metadata.labels && typeof metadata.labels === "object" ? metadata.labels as Record<string, string> : {};
    return [{ name: metadata.name, labels }];
  });
}

/** Workloads in the namespace labelled with this create attempt. */
export async function findCreationWorkloads(
  clients: KubeClients,
  namespace: string,
  backend: "sandbox-cr" | "job",
  attemptId: string,
): Promise<CreationWorkload[]> {
  const labelSelector = `${CREATE_ATTEMPT_LABEL}=${attemptId}`;
  try {
    const list = backend === "sandbox-cr"
      ? await clients.custom.listNamespacedCustomObject({
          group: SANDBOX_GROUP, version: SANDBOX_VERSION, plural: SANDBOX_PLURAL, namespace, labelSelector,
        })
      : await clients.batch.listNamespacedJob({ namespace, labelSelector });
    return workloadsFrom(list);
  } catch (err) {
    // A namespace that was never created holds nothing.
    if (isKubeNotFoundError(err)) return [];
    throw err;
  }
}

/** Identifies the cluster and namespace, never a credential. */
export function clusterFingerprint(kc: KubeConfig, namespace: string): string {
  const server = typeof kc.getCurrentCluster === "function" ? kc.getCurrentCluster()?.server ?? "" : "";
  return createHash("sha256").update(`kubernetes\n${server}\n${namespace}`).digest("hex");
}

export function creationCleanupFor(input: {
  workload: CreationWorkload;
  companyId: string;
  environmentId: string;
  runId: string;
  attemptId: string;
  accountFingerprint: string;
}): PluginEnvironmentCreationCleanup {
  return {
    providerLeaseId: input.workload.name,
    companyId: input.companyId,
    environmentId: input.environmentId,
    runId: input.runId,
    attemptId: input.attemptId,
    accountFingerprint: input.accountFingerprint,
    labels: {
      "paperclip-create-attempt": input.attemptId,
      "paperclip-run-id": input.runId,
      "paperclip-company-id": input.companyId,
    },
  };
}

/**
 * Look up the workload an acquire created, by its attempt id. Returns null when
 * there is none. Throws when one carries the attempt id but belongs to another
 * run or company, or when the attempt matches more than one workload: neither
 * may be handed to the host for deletion.
 */
export async function inspectCreation(input: {
  clients: KubeClients;
  kc: KubeConfig;
  namespace: string;
  backend: "sandbox-cr" | "job";
  companyId: string;
  environmentId: string;
  creationOperation: { id: string; runId: string };
}): Promise<PluginEnvironmentCreationCleanup | null> {
  const { id: attemptId, runId } = input.creationOperation;
  if (![attemptId, runId].every(value => typeof value === "string" && UUID.test(value))) {
    throw new Error("Invalid creation operation identity");
  }
  const workloads = await findCreationWorkloads(input.clients, input.namespace, input.backend, attemptId);
  if (workloads.length === 0) return null;
  if (workloads.length > 1) throw new Error("Creation attempt matches more than one workload");
  const [workload] = workloads;
  if (workload.labels[RUN_ID_LABEL] !== runId || workload.labels[COMPANY_ID_LABEL] !== input.companyId) {
    throw new Error("Creation operation ownership does not match");
  }
  return creationCleanupFor({
    workload, companyId: input.companyId, environmentId: input.environmentId, runId, attemptId,
    accountFingerprint: clusterFingerprint(input.kc, input.namespace),
  });
}

/**
 * Before destroying from a cleanup envelope, confirm the named workload is
 * still the one that attempt created. A missing workload is fine (destroy is
 * idempotent); a workload with other labels is never deleted.
 */
export async function assertCreationCleanupOwnership(
  clients: KubeClients,
  namespace: string,
  backend: "sandbox-cr" | "job",
  cleanup: PluginEnvironmentCreationCleanup,
): Promise<void> {
  let labels: Record<string, string>;
  try {
    const workload = backend === "sandbox-cr"
      ? await clients.custom.getNamespacedCustomObject({
          group: SANDBOX_GROUP, version: SANDBOX_VERSION, plural: SANDBOX_PLURAL, namespace, name: cleanup.providerLeaseId,
        })
      : await clients.batch.readNamespacedJob({ namespace, name: cleanup.providerLeaseId });
    labels = ((workload as { metadata?: { labels?: Record<string, string> } }).metadata?.labels) ?? {};
  } catch (err) {
    if (isKubeNotFoundError(err)) return;
    throw err;
  }
  if (labels[CREATE_ATTEMPT_LABEL] !== cleanup.attemptId || labels[COMPANY_ID_LABEL] !== cleanup.companyId ||
      (cleanup.runId !== undefined && labels[RUN_ID_LABEL] !== cleanup.runId)) {
    throw new Error("Creation cleanup ownership does not match the workload");
  }
}
