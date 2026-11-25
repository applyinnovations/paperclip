import type { KubernetesProviderConfig } from "./types.js";

/**
 * Egress modes and what each one can honestly claim about a hostname
 * (FQDN) allow-list:
 *
 * - `standard`: Kubernetes NetworkPolicy only. CIDR-only, so it cannot
 *   enforce hostnames at all. A configured hostname list is refused rather
 *   than silently widened to "any public IP" (APP-464 AC4).
 * - `cilium`: CiliumNetworkPolicy `toFQDNs`. Claims hostname enforcement.
 * - `proxy`: sandboxes send HTTP(S) through an in-cluster egress proxy via
 *   `HTTPS_PROXY`/`HTTP_PROXY`. The plugin never enforces anything here; the
 *   proxy and the cluster's NetworkPolicies do. `enforcement` records which
 *   phase the proxy is in:
 *     - `observe`: the proxy logs hostnames only. The hostname list is NOT
 *       enforced, and the plugin says so.
 *     - `enforce`: the proxy denies hosts outside its allowlist.
 */
export type EgressMode = KubernetesProviderConfig["egressMode"];

/**
 * Destinations that must never go through the proxy: the in-pod runner
 * (loopback), paperclip-server's callback, and any other cluster Service.
 */
export const DEFAULT_NO_PROXY = [
  "localhost",
  "127.0.0.1",
  "::1",
  "paperclip-server",
  ".svc",
  ".cluster.local",
] as const;

export interface EgressPosture {
  /** True when the active mode actually enforces the hostname list. */
  hostnamesEnforced: boolean;
  /** One plain sentence for logs, probe output and validation warnings. */
  summary: string;
}

/**
 * Thrown when a new sandbox would be provisioned under a mode that cannot
 * enforce the configured hostname contract.
 */
export class EgressModeCannotEnforceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressModeCannotEnforceError";
  }
}

/**
 * Describe what the active egress mode does with `fqdns`. Throws
 * {@link EgressModeCannotEnforceError} when the mode can't enforce a
 * non-empty hostname list and doesn't say so (only `standard` today).
 */
export function assessEgressPosture(config: KubernetesProviderConfig, fqdns: readonly string[]): EgressPosture {
  const hosts = [...new Set(fqdns)];
  const list = hosts.join(", ");
  switch (config.egressMode) {
    case "standard": {
      if (hosts.length === 0) {
        return { hostnamesEnforced: false, summary: "egressMode=standard: no hostname list is configured." };
      }
      throw new EgressModeCannotEnforceError(
        `egressMode=standard cannot enforce the configured hostname list (${list}): Kubernetes NetworkPolicy is CIDR-only. ` +
          `Refusing to provision a new sandbox. Fix: set egressMode to "proxy" with egressProxy.url and egressProxy.enforcement ` +
          `("observe" logs hostnames without enforcing them; "enforce" denies hosts outside the proxy's allowlist), ` +
          `or to "cilium" on a cluster with the Cilium L7 proxy enabled. Running sandboxes are not affected.`,
      );
    }
    case "cilium":
      return {
        hostnamesEnforced: hosts.length > 0,
        summary: hosts.length > 0
          ? `egressMode=cilium: hostname list (${list}) is enforced by CiliumNetworkPolicy toFQDNs, which requires the Cilium L7 (DNS) proxy to be enabled.`
          : "egressMode=cilium: no hostname list is configured.",
      };
    case "proxy": {
      const proxy = requireEgressProxy(config);
      if (proxy.enforcement === "observe") {
        return {
          hostnamesEnforced: false,
          summary:
            `egressMode=proxy, enforcement=observe: the hostname list${hosts.length > 0 ? ` (${list})` : ""} is NOT enforced. ` +
            `Sandbox HTTP(S) traffic goes through ${redactProxyUrl(proxy.url)}, which only logs destination hostnames.`,
        };
      }
      return {
        hostnamesEnforced: true,
        summary:
          `egressMode=proxy, enforcement=enforce: sandbox HTTP(S) traffic goes through ${redactProxyUrl(proxy.url)}, ` +
          `which denies hostnames outside its allowlist.`,
      };
    }
  }
}

/**
 * Environment variables that route a sandbox's HTTP(S) clients through the
 * egress proxy. Returns `{}` for modes other than `proxy`. Both upper- and
 * lower-case forms are set because tools disagree on which they read.
 */
export function buildEgressProxyEnv(config: KubernetesProviderConfig): Record<string, string> {
  if (config.egressMode !== "proxy") return {};
  const proxy = requireEgressProxy(config);
  const noProxy = [...new Set([...DEFAULT_NO_PROXY, ...proxy.noProxy])].join(",");
  return {
    HTTPS_PROXY: proxy.url,
    https_proxy: proxy.url,
    HTTP_PROXY: proxy.url,
    http_proxy: proxy.url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

function requireEgressProxy(config: KubernetesProviderConfig): NonNullable<KubernetesProviderConfig["egressProxy"]> {
  // The config schema already rejects proxy mode without egressProxy; this
  // keeps the type narrow and fails loudly if that invariant ever breaks.
  if (!config.egressProxy) {
    throw new Error('egressMode=proxy requires egressProxy.url and egressProxy.enforcement ("observe" or "enforce").');
  }
  return config.egressProxy;
}

/** Strip any userinfo from the proxy URL before it reaches logs or status. */
function redactProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "the configured egress proxy";
  }
}
