import { describe, it, expect } from "vitest";
import { buildNetworkPolicyManifests as buildRawNetworkPolicyManifests, type BuildNetworkPolicyInput } from "../../src/network-policy.js";
import type { DenyAllPolicyView, EgressAllowPolicyView } from "./manifest-views.js";

const buildNetworkPolicyManifests = (input: BuildNetworkPolicyInput) =>
  buildRawNetworkPolicyManifests(input) as unknown as [DenyAllPolicyView, EgressAllowPolicyView];

describe("buildNetworkPolicyManifests", () => {
  const baseInput = {
    namespace: "paperclip-acme",
    paperclipServerNamespace: "paperclip",
    egressAllowCidrs: [] as string[],
  };

  it("produces a deny-all + egress allow pair", () => {
    const manifests = buildNetworkPolicyManifests(baseInput);
    expect(manifests).toHaveLength(2);
    expect(manifests[0].metadata.name).toBe("paperclip-deny-all");
    expect(manifests[1].metadata.name).toBe("paperclip-egress-allow");
  });

  it("deny-all has no ingress/egress rules and applies to all pods", () => {
    const [denyAll] = buildNetworkPolicyManifests(baseInput);
    expect(denyAll.spec.podSelector).toEqual({});
    expect(denyAll.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(denyAll.spec.ingress).toBeUndefined();
    expect(denyAll.spec.egress).toBeUndefined();
  });

  it("egress allow includes kube-dns and paperclip-server callback", () => {
    const [, egress] = buildNetworkPolicyManifests(baseInput);
    const rules = egress.spec.egress;
    const dnsRule = rules.find((r: { ports?: { protocol: string; port: number }[] }) =>
      r.ports?.some((p) => p.port === 53),
    );
    expect(dnsRule).toBeDefined();
    const paperclipRule = rules.find((r: { to: { namespaceSelector?: { matchLabels?: Record<string, string> } }[] }) =>
      r.to.some((t) => t.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "paperclip"),
    );
    expect(paperclipRule).toBeDefined();
  });

  it("includes user-supplied CIDRs in egress allow", () => {
    const [, egress] = buildNetworkPolicyManifests({ ...baseInput, egressAllowCidrs: ["10.0.0.0/8"] });
    const cidrRule = egress.spec.egress.find((r: { to: { ipBlock?: { cidr: string } }[] }) =>
      r.to.some((t) => t.ipBlock?.cidr === "10.0.0.0/8"),
    );
    expect(cidrRule).toBeDefined();
  });

  it("uses paperclip-server pod label selector for callback ingress to paperclip ns", () => {
    const [, egress] = buildNetworkPolicyManifests(baseInput);
    const callbackRule = egress.spec.egress.find((r: { to: { podSelector?: { matchLabels?: Record<string, string> } }[] }) =>
      r.to.some((t) => t.podSelector?.matchLabels?.app === "paperclip-server"),
    );
    expect(callbackRule).toBeDefined();
    expect(callbackRule!.ports![0].port).toBe(3100);
  });

  // APP-464 AC4: NetworkPolicy is CIDR-only. A hostname list must never be
  // turned into "any public IPv4 on 80/443"; the plugin refuses to provision
  // instead (see egress-mode.test.ts).
  it("never adds a public-IPv4 rule, even when callers still pass hostnames", () => {
    for (const egressAllowCidrs of [[], ["203.0.113.0/24"]]) {
      const [, egress] = buildNetworkPolicyManifests({
        ...baseInput,
        egressAllowCidrs,
        egressAllowFqdns: ["api.anthropic.com"],
      } as BuildNetworkPolicyInput);
      const broad = egress.spec.egress.find((r: { to: { ipBlock?: { cidr: string } }[] }) =>
        r.to.some((t) => t.ipBlock?.cidr === "0.0.0.0/0"),
      );
      expect(broad).toBeUndefined();
      expect(egress.spec.egress.filter((r) => r.ports?.some((p) => p.port === 443 || p.port === 80))).toEqual([]);
    }
  });

  it("allows only DNS, paperclip-server and operator CIDRs", () => {
    const [, egress] = buildNetworkPolicyManifests({ ...baseInput, egressAllowCidrs: ["203.0.113.0/24"] });
    expect(egress.spec.egress).toHaveLength(3);
    expect(egress.spec.egress[2].to).toEqual([{ ipBlock: { cidr: "203.0.113.0/24" } }]);
  });

  it("builds a task-scoped allow policy without namespace-wide base rules", () => {
    const [, egress] = buildNetworkPolicyManifests({
      ...baseInput,
      name: "pc-run-egress",
      podSelector: { "paperclip.io/run-id": "run-123" },
      includeBaseRules: false,
      egressAllowCidrs: ["203.0.113.0/24"],
      ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: "pc-run", uid: "uid-1" }],
    });

    expect(egress.metadata.name).toBe("pc-run-egress");
    expect(egress.metadata.ownerReferences).toHaveLength(1);
    expect(egress.spec.podSelector.matchLabels).toEqual({ "paperclip.io/run-id": "run-123" });
    expect(egress.spec.egress).toHaveLength(1);
    expect(egress.spec.egress[0].to[0].ipBlock?.cidr).toBe("203.0.113.0/24");
  });
});
