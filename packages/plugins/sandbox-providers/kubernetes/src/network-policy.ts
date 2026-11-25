export interface BuildNetworkPolicyInput {
  namespace: string;
  paperclipServerNamespace: string;
  egressAllowCidrs: string[];
  name?: string;
  podSelector?: Record<string, string>;
  includeBaseRules?: boolean;
  ownerReferences?: Record<string, unknown>[];
}

// Hostnames (FQDNs) are deliberately absent: Kubernetes NetworkPolicy is
// CIDR-only and cannot enforce them. There is no "public IPv4" fallback for
// a hostname list any more; the plugin refuses to provision under
// egressMode=standard when one is configured (see egress-mode.ts).

// Design note: the deny-all baseline blocks all ingress to agent pods.
// Paperclip-server does NOT push to agent pods — the agent shim makes
// outbound calls to paperclip-server via the egress allow-list (port 3100).
// This pull/callback model means no ingress rule is needed. If a future
// feature requires server→agent push (e.g. forced shutdown, live exec),
// add a targeted ingress rule here scoped to the paperclip-server pod
// selector.
export function buildNetworkPolicyManifests(input: BuildNetworkPolicyInput): Record<string, unknown>[] {
  const denyAll = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: "paperclip-deny-all",
      namespace: input.namespace,
      labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin" },
    },
    spec: {
      podSelector: {},
      policyTypes: ["Ingress", "Egress"],
    },
  };

  const egressAllow: Record<string, unknown> = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      namespace: input.namespace,
      labels: { "paperclip.io/managed-by": "paperclip-k8s-plugin" },
    },
    spec: {
      podSelector: { matchLabels: input.podSelector ?? { "paperclip.io/role": "agent" } },
      policyTypes: ["Egress"],
      egress: [
        ...(input.includeBaseRules === false ? [] : [{
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        }]),
        ...(input.includeBaseRules === false ? [] : [{
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": input.paperclipServerNamespace } },
              podSelector: { matchLabels: { app: "paperclip-server" } },
            },
          ],
          ports: [{ protocol: "TCP", port: 3100 }],
        }]),
        // NOTE: operator-supplied CIDRs are intentionally NOT port-scoped —
        // operators may need them for non-HTTP services (e.g. private VCS
        // mirrors, S3 endpoints, internal artifact registries). Operators
        // should keep CIDRs as specific as possible.
        ...input.egressAllowCidrs.map((cidr) => ({
          to: [{ ipBlock: { cidr } }],
        })),
      ],
    },
  };

  (egressAllow.metadata as Record<string, unknown>).name = input.name ?? "paperclip-egress-allow";
  if (input.ownerReferences) {
    (egressAllow.metadata as Record<string, unknown>).ownerReferences = input.ownerReferences;
  }

  return [denyAll, egressAllow];
}
