import { readFileSync } from "node:fs";
import type { Config } from "../config.js";

export type OidcConfig = {
  issuer: string;
  providerId: string;
  displayName: string;
  clientId: string;
  clientSecret: string;
  tokenEndpointAuth: "client_secret_basic" | "client_secret_post";
  baseUrl: string;
  disableSignUp: boolean;
};

export function oidcUrl(value: string, allowLoopback: boolean, allowQuery = false): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid OIDC URL."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username || url.password || url.hash || (!allowQuery && url.search) ||
    (url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:"))
  ) throw new Error("OIDC URLs must use HTTPS (HTTP is allowed only for loopback development).");
  return url;
}

export function readOidcConfig(config: Config, env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const prefix = "PAPERCLIP_AUTH_OIDC_";
  if (!Object.entries(env).some(([key, value]) => key.startsWith(prefix) && value?.trim())) return null;
  if (config.deploymentMode !== "authenticated" || config.authBaseUrlMode !== "explicit" || !config.authPublicBaseUrl) {
    throw new Error("OIDC requires authenticated mode and an explicit auth public base URL.");
  }
  const issuer = env.PAPERCLIP_AUTH_OIDC_ISSUER?.trim();
  const clientId = env.PAPERCLIP_AUTH_OIDC_CLIENT_ID?.trim();
  const secretValue = env.PAPERCLIP_AUTH_OIDC_CLIENT_SECRET;
  const secretFile = env.PAPERCLIP_AUTH_OIDC_CLIENT_SECRET_FILE?.trim();
  if (!issuer || !clientId || (!secretValue && !secretFile) || (secretValue && secretFile)) {
    throw new Error("OIDC requires ISSUER, CLIENT_ID and exactly one CLIENT_SECRET or CLIENT_SECRET_FILE.");
  }
  let clientSecret: string;
  try {
    clientSecret = secretFile ? readFileSync(secretFile, "utf8").replace(/\r?\n$/, "") : secretValue!;
  } catch {
    throw new Error("Cannot read the OIDC client secret file.");
  }
  if (!clientSecret.trim()) throw new Error("The OIDC client secret must not be empty.");
  const providerId = env.PAPERCLIP_AUTH_OIDC_PROVIDER_ID?.trim() || "oidc";
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(providerId) || providerId === "credential") {
    throw new Error("OIDC PROVIDER_ID must be a lowercase identifier other than credential.");
  }
  const method = env.PAPERCLIP_AUTH_OIDC_TOKEN_ENDPOINT_AUTH_METHOD?.trim() || "client_secret_basic";
  if (method !== "client_secret_basic" && method !== "client_secret_post") {
    throw new Error("OIDC TOKEN_ENDPOINT_AUTH_METHOD must be client_secret_basic or client_secret_post.");
  }
  oidcUrl(issuer, true);
  const baseUrl = oidcUrl(config.authPublicBaseUrl, true);
  if (baseUrl.pathname !== "/") throw new Error("OIDC auth public base URL must be an origin without a path.");
  return {
    issuer,
    providerId,
    displayName: env.PAPERCLIP_AUTH_OIDC_DISPLAY_NAME?.trim().slice(0, 80) || "OpenID Connect",
    clientId,
    clientSecret,
    tokenEndpointAuth: method,
    baseUrl: baseUrl.origin,
    disableSignUp: config.authDisableSignUp,
  };
}
