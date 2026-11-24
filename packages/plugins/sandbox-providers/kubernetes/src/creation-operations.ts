/**
 * Creation-operation support (host protocol `creationOperationVersion: 1`).
 *
 * The host records a durable creation operation before every fresh acquire
 * and passes its ID as `creationOperationId`. If the caller gives up (RPC
 * timeout, server restart) while the provider goes on to create the
 * workload, the host later asks `environmentInspectLease` about that
 * operation and destroys whatever the provider reports. To make that
 * possible the workload created for an operation:
 *
 * - has a deterministic name, `pc-<creationOperationId>`, so the provider can
 *   name it even when it is already gone, and
 * - carries ownership labels (operation, company, environment, run), so the
 *   provider can confirm what it found is that operation's workload and
 *   refuses to report a foreign one.
 */

import { createHash } from "node:crypto";
import type { PluginEnvironmentCreationCleanup } from "@paperclipai/plugin-sdk";
import type { KubeClients } from "./kube-client.js";
import type { KubernetesProviderConfig } from "./types.js";
import { isKubeNotFoundError } from "./lease-lifecycle.js";

export const CREATION_OPERATION_LABEL = "paperclip.io/creation-operation-id";
export const ENVIRONMENT_ID_LABEL = "paperclip.io/environment-id";

const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function isCreationIdentity(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Workload (Sandbox CR or Job) name for a creation operation. DNS-1123 safe. */
export function creationWorkloadName(creationOperationId: string): string {
  if (!isCreationIdentity(creationOperationId)) throw new Error("Invalid creation operation identity");
  return `pc-${creationOperationId.toLowerCase()}`;
}

export interface CreationOwner {
  creationOperationId: string;
  companyId: string;
  environmentId: string;
  runId: string;
}

/** Kubernetes labels that tie a workload to its creation operation. */
export function creationOwnershipLabels(owner: CreationOwner): Record<string, string> {
  return {
    [CREATION_OPERATION_LABEL]: owner.creationOperationId.toLowerCase(),
    [ENVIRONMENT_ID_LABEL]: owner.environmentId,
    "paperclip.io/company-id": owner.companyId,
    "paperclip.io/run-id": owner.runId,
  };
}

/**
 * Identifies the cluster account and tenant namespace a workload lives in,
 * so a cleanup record is only honoured against the same cluster. The
 * kubeconfig is hashed, never stored.
 */
export function kubernetesAccountFingerprint(config: KubernetesProviderConfig, namespace: string): string {
  const account = config.inCluster
    ? "in-cluster"
    : `kubeconfig:${createHash("sha256").update(config.kubeconfig ?? "").digest("hex")}`;
  return createHash("sha256").update(`kubernetes\0${account}\0${namespace}`).digest("hex");
}

/** The ownership envelope the host persists and hands back to destroy. */
export function creationCleanup(
  owner: CreationOwner,
  accountFingerprint: string,
): PluginEnvironmentCreationCleanup {
  return {
    providerLeaseId: creationWorkloadName(owner.creationOperationId),
    companyId: owner.companyId,
    environmentId: owner.environmentId,
    runId: owner.runId,
    attemptId: owner.creationOperationId,
    accountFingerprint,
    // Cleanup label keys must match `paperclip-[a-z-]+` (SDK validator).
    labels: {
      "paperclip-provider": "kubernetes",
      "paperclip-create-attempt": owner.creationOperationId.toLowerCase(),
      "paperclip-company-id": owner.companyId,
      "paperclip-environment-id": owner.environmentId,
      "paperclip-run-id": owner.runId,
    },
  };
}

interface WorkloadMeta {
  name?: string;
  labels?: Record<string, string>;
}

/**
 * The workload created for this operation, read by its deterministic name
 * (a plain GET, so recovery needs no RBAC beyond what leases already use).
 * Returns null when it does not exist. Callers check its ownership labels.
 */
export async function getCreationWorkload(
  clients: KubeClients,
  namespace: string,
  backend: "sandbox-cr" | "job",
  creationOperationId: string,
): Promise<WorkloadMeta | null> {
  const name = creationWorkloadName(creationOperationId);
  try {
    const workload = backend === "sandbox-cr"
      ? await clients.custom.getNamespacedCustomObject({
          group: "agents.x-k8s.io",
          version: "v1beta1",
          namespace,
          plural: "sandboxes",
          name,
        }) as { metadata?: WorkloadMeta }
      : await clients.batch.readNamespacedJob({ namespace, name }) as { metadata?: WorkloadMeta };
    return workload?.metadata ?? {};
  } catch (err) {
    if (isKubeNotFoundError(err)) return null;
    throw err;
  }
}

/** True when the workload's name and labels match the creation operation exactly. */
export function workloadMatchesOwner(workload: WorkloadMeta, owner: CreationOwner): boolean {
  if (workload.name !== creationWorkloadName(owner.creationOperationId)) return false;
  return Object.entries(creationOwnershipLabels(owner)).every(([key, value]) => workload.labels?.[key] === value);
}
