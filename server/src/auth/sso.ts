import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { APIError, addOAuthServerContext, createAuthMiddleware, getOAuthState, getSessionFromCtx } from "better-auth/api";
import { genericOAuth, keycloak, auth0, okta, microsoftEntraId } from "better-auth/plugins";
import type { GenericOAuthConfig } from "better-auth/plugins";
import { createRemoteJWKSet, decodeJwt } from "jose";
import type { SsoProviderConfig } from "@paperclipai/shared";
import type { Config } from "../config.js";

const CREDENTIAL_PATHS = new Set(["/get-access-token", "/refresh-token", "/account-info"]);
const SIGNING_ALGORITHMS = new Set(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"]);

export function ssoUrl(value: string, query = false, allowLoopback = true) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (!query && url.search) ||
      (url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("SSO URLs require HTTPS, except loopback development URLs.");
  }
  return url;
}

export function ssoProviderMetadata(provider: SsoProviderConfig) {
  const base = { clientId: provider.clientId, clientSecret: provider.clientSecret };
  let preset: GenericOAuthConfig;
  switch (provider.type) {
    case "keycloak": preset = keycloak({ ...base, issuer: provider.issuer! }); break;
    case "okta": preset = okta({ ...base, issuer: provider.issuer! }); break;
    case "auth0": preset = auth0({ ...base, domain: provider.domain ?? new URL(provider.issuer!).host }); break;
    case "microsoft_entra_id": preset = microsoftEntraId({ ...base, tenantId: provider.tenantId! }); break;
    case "oidc": preset = { ...base, providerId: provider.providerId, discoveryUrl: provider.discoveryUrl }; break;
  }
  const discovery = ssoUrl(preset.discoveryUrl!);
  // Standard OIDC discovery locations can establish the configured issuer.
  // Nonstandard discovery URLs must supply an explicit issuer.
  const suffix = "/.well-known/openid-configuration";
  const inferred = discovery.pathname.endsWith(suffix) ? discovery.href.slice(0, -suffix.length) : undefined;
  const issuer = typeof preset.accountIssuer === "string" ? preset.accountIssuer : provider.issuer ?? inferred;
  if (!issuer) throw new Error("A nonstandard SSO discovery URL requires an explicit issuer.");
  ssoUrl(issuer);
  return { discoveryUrl: discovery.href, issuer };
}

export async function discoverSso(provider: SsoProviderConfig) {
  const configured = ssoProviderMetadata(provider);
  const response = await fetch(configured.discoveryUrl, { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error("SSO discovery is unavailable.");
  const metadata = await response.json() as Record<string, unknown>;
  if (metadata.issuer !== configured.issuer) throw new Error("SSO discovery issuer does not match configuration.");
  const endpoint = (name: string) => {
    if (typeof metadata[name] !== "string") throw new Error("SSO discovery is incomplete.");
    return ssoUrl(metadata[name], true, new URL(configured.issuer).protocol === "http:").href;
  };
  const algorithms = Array.isArray(metadata.id_token_signing_alg_values_supported)
    ? metadata.id_token_signing_alg_values_supported.filter((alg): alg is string => typeof alg === "string" && SIGNING_ALGORITHMS.has(alg)) : [];
  if (!algorithms.length) throw new Error("SSO discovery has no supported signing algorithm.");
  for (const [field, required] of [["response_types_supported", "code"], ["code_challenge_methods_supported", "S256"],
    ["token_endpoint_auth_methods_supported", provider.tokenEndpointAuth ?? "client_secret_post"]] as const) {
    if (Array.isArray(metadata[field]) && !metadata[field].includes(required)) throw new Error("SSO provider does not support the required code flow.");
  }
  return { issuer: configured.issuer, authorizationUrl: endpoint("authorization_endpoint"), tokenUrl: endpoint("token_endpoint"),
    jwksUrl: endpoint("jwks_uri"), algorithms };
}

export function ssoUserInfo(provider: SsoProviderConfig, token: string) {
  // Called by Better Auth only after its provider verifies the ID token,
  // including issuer, audience, signature and the nonce from persisted state.
  const claims = decodeJwt(token);
  if (typeof claims.sub !== "string" || !claims.sub || typeof claims.email !== "string" || !claims.email ||
      claims.email_verified !== true || typeof claims.exp !== "number" || typeof claims.iat !== "number" ||
      (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== provider.clientId) ||
      (claims.azp !== undefined && claims.azp !== provider.clientId)) return null;
  if (provider.requiredRoles) {
    let roles: unknown = claims;
    for (const key of provider.requiredRoles.claimPath.split(".")) {
      roles = roles && typeof roles === "object" && Object.hasOwn(roles, key) ? (roles as Record<string, unknown>)[key] : undefined;
    }
    if (!provider.requiredRoles.roles.some(role => Array.isArray(roles) ? roles.includes(role) : roles === role)) return null;
  }
  return { ...claims, sub: claims.sub, email: claims.email, emailVerified: true,
    name: typeof claims.name === "string" && claims.name ? claims.name : claims.email };
}

export function validateSsoConfiguration(config: Config, providers = config.ssoProviders ?? []) {
  const ids = new Set(providers.map(p => p.providerId));
  if (ids.size !== providers.length || providers.length > 8) throw new Error("SSO requires at most eight uniquely named providers.");
  if (!providers.length) return undefined;
  if (providers.length && (config.deploymentMode !== "authenticated" || config.authBaseUrlMode !== "explicit" ||
      !config.authPublicBaseUrl)) throw new Error("SSO requires authenticated mode and an explicit public origin.");
  const publicUrl = ssoUrl(config.authPublicBaseUrl!);
  if (publicUrl.pathname !== "/") throw new Error("SSO requires authenticated mode and an explicit public origin.");
  return publicUrl.origin;
}

export function ssoAuth(config: Config) {
  let providers = config.ssoProviders ?? [];
  let origin: string | undefined;
  let invalidConfiguration = false;
  try { origin = validateSsoConfiguration(config, providers); }
  catch {
    // Invalid stored/operator SSO configuration must never remove the local
    // password recovery path. Settings writes validate before persistence.
    providers = [];
    invalidConfiguration = true;
  }
  const ids = new Set(providers.map(p => p.providerId));
  let available: SsoProviderConfig[] = [];
  const plugin: BetterAuthPlugin = {
    id: "paperclip-sso",
    rateLimit: [{ pathMatcher: path => path === "/link-social", window: 10, max: 3 }],
    init: async ctx => {
      if (invalidConfiguration) ctx.logger.warn("SSO configuration is invalid; local authentication remains available.");
      const discoveries = await Promise.all(providers.map(async provider => {
        try { return { provider, metadata: await discoverSso(provider) }; }
        catch { ctx.logger.warn("SSO provider initialization failed; local authentication remains available."); return null; }
      }));
      const valid = discoveries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      if (!valid.length) return {};
      const oauth = genericOAuth({ config: valid.map(({ provider, metadata }) => ({
        providerId: provider.providerId, name: provider.displayName, clientId: provider.clientId, clientSecret: provider.clientSecret,
        authorizationUrl: metadata.authorizationUrl, tokenUrl: metadata.tokenUrl,
        accountIssuer: metadata.issuer, accountSubject: ({ profile }) => typeof profile.sub === "string" ? profile.sub : "",
        tokenEndpointAuth: { method: provider.tokenEndpointAuth ?? "client_secret_post" },
        redirectURI: `${origin}/api/auth/callback/${provider.providerId}`, scopes: [...new Set(["openid", ...(provider.scopes ?? ["profile", "email"])])],
        pkce: true, disableSignUp: config.authDisableSignUp, disableProviderLogout: true,
        getUserInfo: async tokens => tokens.idToken ? ssoUserInfo(provider, tokens.idToken) : null,
      })) });
      const result = await oauth.init(ctx);
      for (const { provider, metadata } of valid) {
        const registered = result.context.socialProviders.find(p => p.id === provider.providerId);
        if (!registered) continue;
        registered.issuer = metadata.issuer;
        registered.idToken = { issuer: metadata.issuer, audience: provider.clientId, algorithms: metadata.algorithms,
          jwks: createRemoteJWKSet(new URL(metadata.jwksUrl), { timeoutDuration: 5000 }) };
        registered.requiresIdTokenNonce = true;
        registered.options = { ...registered.options, disableIdTokenSignIn: false };
      }
      available = valid.map(entry => entry.provider);
      return result;
    },
    hooks: { before: [{
      matcher: ctx => Boolean(origin && ctx.path === "/sign-out"),
      handler: createAuthMiddleware(async ctx => {
        if (ctx.headers?.get("origin") !== origin) throw new APIError("FORBIDDEN", { message: "SSO logout requires the configured public origin." });
      }),
    }, {
      // Login providers never grant browser access to provider bearer credentials,
      // including old account rows after a provider has been disabled/removed.
      matcher: ctx => Boolean(ctx.path && CREDENTIAL_PATHS.has(ctx.path)),
      handler: createAuthMiddleware(async () => { throw new APIError("FORBIDDEN", { message: "Provider credentials are unavailable for SSO." }); }),
    }, {
      matcher: ctx => Boolean((ctx.path === "/sign-in/social" || ctx.path === "/link-social") && ids.has(ctx.body?.provider)),
      handler: createAuthMiddleware(async ctx => {
        if (ctx.headers?.get("origin") !== origin) throw new APIError("FORBIDDEN", { message: "SSO initiation requires the configured public origin." });
        if (ctx.body?.scopes !== undefined || ctx.body?.additionalParams !== undefined || ctx.body?.idToken) {
          throw new APIError("BAD_REQUEST", { message: "SSO uses server-owned authorization inputs and the authorization code flow." });
        }
        for (const field of ["callbackURL", "errorCallbackURL", "newUserCallbackURL"]) {
          const value: unknown = ctx.body?.[field];
          if (value !== undefined && (typeof value !== "string" || new URL(value, origin).origin !== origin)) {
            throw new APIError("BAD_REQUEST", { message: "SSO return URLs must use the public origin." });
          }
        }
        if (ctx.path !== "/link-social") return;
        const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
        if (!session) throw new APIError("UNAUTHORIZED", { message: "Sign in before linking." });
        const password: unknown = ctx.body?.additionalData?.password;
        const accounts = await ctx.context.internalAdapter.findAccounts(session.user.id);
        const credential = accounts.find(a => a.providerId === "credential" && a.password);
        if (typeof password !== "string" || !credential?.password || !await ctx.context.password.verify({ password, hash: credential.password })) {
          throw new APIError("UNAUTHORIZED", { message: "Confirm the current local password before linking." });
        }
        ctx.body.additionalData = {};
        await addOAuthServerContext({ paperclipSsoLink: { userId: session.user.id, sessionId: session.session.id, confirmedAt: Date.now() } });
      }),
    }] },
  };
  const options: Pick<BetterAuthOptions, "account" | "user"> = {
    account: { accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: false } },
    user: { validateUserInfo: async ({ user, source }, ctx) => {
      if (!ids.has(source.oauth?.providerId ?? "")) return;
      if (user.emailVerified !== true) return { error: "email_not_verified" };
      if (source.action !== "link-account") return;
      const state = await getOAuthState();
      const intent = state?.serverContext?.paperclipSsoLink as { userId?: string; sessionId?: string; confirmedAt?: number } | undefined;
      const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
      if (!intent || !session || intent.userId !== user.id || intent.userId !== session.user.id || intent.sessionId !== session.session.id ||
          typeof intent.confirmedAt !== "number" || Date.now() - intent.confirmedAt < 0 || Date.now() - intent.confirmedAt > 300_000) {
        return { error: "link_reauthentication_required" };
      }
    } },
  };
  return { plugin, options, getAvailable: () => available.map(p => ({ providerId: p.providerId, displayName: p.displayName || p.type.replace(/_/g, " "), type: p.type })) };
}
