import type { InstanceSsoSettings, SsoProviderConfig } from "@paperclipai/shared";

/** One source decision for startup, public discovery and live settings changes.
 * Legacy disabled/empty DB settings retain #3040's documented operator fallback.
 * New explicit database mode can disable all SSO without restart re-enabling it.
 */
export function resolveSsoProviders(settings: InstanceSsoSettings, operator: SsoProviderConfig[]) {
  const source = settings.source ?? (settings.enabled && settings.providers.length ? "database" : "operator");
  return source === "operator" ? operator : settings.enabled ? settings.providers : [];
}
