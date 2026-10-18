import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { APIError, addOAuthServerContext, createAuthEndpoint, createAuthMiddleware, getOAuthState, getSessionFromCtx } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins";
import { createRemoteJWKSet, decodeJwt } from "jose";
import { oidcUrl, type OidcConfig } from "./oidc-config.js";
import { logger } from "../middleware/logger.js";

const SIGNING_ALGORITHMS = new Set(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"]);

export async function discoverOidc(config: OidcConfig) {
  const response = await fetch(`${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("OIDC discovery is unavailable.");
  const metadata = await response.json() as Record<string, unknown>;
  if (metadata.issuer !== config.issuer) throw new Error("OIDC discovery issuer does not match configuration.");
  const allowLoopback = new URL(config.issuer).protocol === "http:";
  const endpoint = (name: string) => {
    if (typeof metadata[name] !== "string") throw new Error("OIDC discovery is incomplete.");
    return oidcUrl(metadata[name], allowLoopback, true).href;
  };
  const algorithms = Array.isArray(metadata.id_token_signing_alg_values_supported)
    ? metadata.id_token_signing_alg_values_supported.filter((alg): alg is string => typeof alg === "string" && SIGNING_ALGORITHMS.has(alg))
    : [];
  if (!algorithms.length) throw new Error("OIDC discovery has no supported signing algorithm.");
  for (const [field, required] of [
    ["response_types_supported", "code"],
    ["code_challenge_methods_supported", "S256"],
    ["token_endpoint_auth_methods_supported", config.tokenEndpointAuth],
  ] as const) {
    if (Array.isArray(metadata[field]) && !metadata[field].includes(required)) {
      throw new Error("OIDC discovery does not support the required authorization code flow.");
    }
  }
  return {
    authorizationUrl: endpoint("authorization_endpoint"),
    tokenUrl: endpoint("token_endpoint"),
    jwksUrl: endpoint("jwks_uri"),
    algorithms,
  };
}

export function oidcPlugin(config: OidcConfig | null): BetterAuthPlugin {
  let available = false;
  return {
    id: "paperclip-oidc",
    endpoints: {
      oidcProvider: createAuthEndpoint("/oidc/provider", { method: "GET" }, async (ctx) => {
        ctx.setHeader("Cache-Control", "no-store");
        return ctx.json({ provider: config && available ? { providerId: config.providerId, displayName: config.displayName } : null });
      }),
    },
    init: async (ctx) => {
      if (!config) return {};
      try {
        const discovery = await discoverOidc(config);
        const plugin = genericOAuth({ config: [{
          providerId: config.providerId,
          name: config.displayName,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          tokenEndpointAuth: { method: config.tokenEndpointAuth },
          authorizationUrl: discovery.authorizationUrl,
          tokenUrl: discovery.tokenUrl,
          accountIssuer: config.issuer,
          accountSubject: ({ profile }) => typeof profile.sub === "string" ? profile.sub : "",
          redirectURI: `${config.baseUrl}/api/auth/callback/${config.providerId}`,
          scopes: ["openid", "profile", "email"],
          pkce: true,
          disableSignUp: config.disableSignUp,
          disableProviderLogout: true,
          getUserInfo: async (tokens) => {
            if (!tokens.idToken) return null;
            const claims = decodeJwt(tokens.idToken);
            if (
              typeof claims.sub !== "string" || !claims.sub ||
              typeof claims.email !== "string" || !claims.email || claims.email_verified !== true ||
              typeof claims.exp !== "number" || typeof claims.iat !== "number" ||
              (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== config.clientId) ||
              (claims.azp !== undefined && claims.azp !== config.clientId)
            ) return null;
            return { ...claims, sub: claims.sub, email: claims.email, emailVerified: true,
              name: typeof claims.name === "string" && claims.name ? claims.name : claims.email };
          },
        }] });
        const result = await plugin.init(ctx);
        const provider = result.context.socialProviders.find((entry) => entry.id === config.providerId);
        if (!provider) return {};
        provider.issuer = config.issuer;
        provider.idToken = {
          issuer: config.issuer,
          audience: config.clientId,
          algorithms: discovery.algorithms,
          jwks: createRemoteJWKSet(new URL(discovery.jwksUrl), { timeoutDuration: 5000 }),
        };
        provider.requiresIdTokenNonce = true;
        provider.options = { ...provider.options, disableIdTokenSignIn: false };
        available = true;
        return result;
      } catch {
        ctx.logger.warn("OIDC provider initialization failed; local authentication remains available. Check provider configuration and restart.");
        return {};
      }
    },
    hooks: {
      before: [{
        matcher: (ctx) => Boolean(config && (ctx.path === "/sign-in/social" || ctx.path === "/link-social") && ctx.body?.provider === config.providerId),
        handler: createAuthMiddleware(async (ctx) => {
          if (ctx.headers?.get("origin") !== config!.baseUrl) {
            throw new APIError("FORBIDDEN", { message: "OIDC requests require this instance's public origin." });
          }
          if (ctx.body?.idToken) throw new APIError("BAD_REQUEST", { message: "Use the OIDC authorization code flow." });
          for (const field of ["callbackURL", "errorCallbackURL", "newUserCallbackURL"]) {
            const value: unknown = ctx.body?.[field];
            if (value !== undefined && (typeof value !== "string" || new URL(value, config!.baseUrl).origin !== config!.baseUrl)) {
              throw new APIError("BAD_REQUEST", { message: "OIDC return URLs must use this instance's public origin." });
            }
          }
          if (ctx.path !== "/link-social") return;
          const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
          if (!session) throw new APIError("UNAUTHORIZED", { message: "Sign in before linking an account." });
          const password: unknown = ctx.body?.additionalData?.password;
          const accounts = await ctx.context.internalAdapter.findAccounts(session.user.id);
          const credential = accounts.find((account) => account.providerId === "credential" && account.password);
          if (typeof password !== "string" || !credential?.password || !await ctx.context.password.verify({ password, hash: credential.password })) {
            throw new APIError("UNAUTHORIZED", { message: "Confirm your current Paperclip password to link an account." });
          }
          ctx.body.additionalData = {};
          await addOAuthServerContext({ paperclipOidcLink: { sessionId: session.session.id, userId: session.user.id, confirmedAt: Date.now() } });
        }),
      }],
    },
  };
}

export function oidcAccountOptions(config: OidcConfig | null): Pick<BetterAuthOptions, "account" | "user" | "logger"> {
  if (!config) return {};
  return {
    logger: { level: "warn", log: (level) => {
      logger[level]({ component: "better-auth" }, "Authentication event. Check provider availability and configuration; request details omitted.");
    } },
    account: { accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: false } },
    user: {
      validateUserInfo: async ({ user, source }, ctx) => {
        if (source.oauth?.providerId !== config.providerId) return;
        if (user.emailVerified !== true) return { error: "email_not_verified" };
        if (source.action !== "link-account") return;
        const state = await getOAuthState();
        const intent = state?.serverContext?.paperclipOidcLink as { sessionId?: string; userId?: string; confirmedAt?: number } | undefined;
        const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
        if (!intent || !session || intent.userId !== session.user.id || intent.sessionId !== session.session.id ||
          intent.userId !== user.id || typeof intent.confirmedAt !== "number" || Date.now() - intent.confirmedAt > 5 * 60_000) {
          return { error: "link_reauthentication_required" };
        }
      },
    },
  };
}
