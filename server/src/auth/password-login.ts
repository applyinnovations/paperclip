import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Config } from "../config.js";
import type { OidcConfig } from "./oidc-config.js";

export const DISABLE_PASSWORD_LOGIN_ENV = "PAPERCLIP_AUTH_DISABLE_PASSWORD_LOGIN";

/**
 * Better Auth endpoints that create, verify, change or reset a local password,
 * plus the account-management endpoints that only make sense alongside one.
 * Better Auth 1.7 gates only `/sign-in/email` and `/sign-up/email` on
 * `emailAndPassword.enabled`; `/change-password`, `/verify-password` and the
 * reset endpoints still run, so each is refused here explicitly.
 *
 * - `/link-social` confirms the current password before linking OIDC.
 * - `/unlink-account` could remove the OIDC identity and leave only an inert
 *   password, locking the user out.
 */
const PASSWORD_PATH_PREFIXES = [
  "/sign-up",
  "/forget-password",
  "/request-password-reset",
  "/reset-password",
  "/change-password",
  "/set-password",
  "/verify-password",
  "/link-social",
  "/unlink-account",
];

/** Under OIDC-only sign-in, `/sign-in/social` for the configured provider is the only sign-in path. */
export function isPasswordLoginPath(path: string): boolean {
  const normalized = path.toLowerCase().replace(/\/+$/, "");
  if (normalized.startsWith("/sign-in")) return normalized !== "/sign-in/social";
  return PASSWORD_PATH_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

/**
 * Fail closed: OIDC-only sign-in with no usable OIDC provider would leave the
 * instance with no way to sign in, and must never fall back to passwords.
 */
export function assertPasswordLoginPolicy(config: Pick<Config, "authDisablePasswordLogin" | "deploymentMode">, oidc: OidcConfig | null) {
  if (!config.authDisablePasswordLogin) return;
  if (config.deploymentMode !== "authenticated") {
    throw new Error(`${DISABLE_PASSWORD_LOGIN_ENV}=true requires authenticated deployment mode.`);
  }
  if (!oidc) {
    throw new Error(
      `${DISABLE_PASSWORD_LOGIN_ENV}=true requires OIDC sign-in. Set PAPERCLIP_AUTH_OIDC_ISSUER, ` +
      "PAPERCLIP_AUTH_OIDC_CLIENT_ID and one of PAPERCLIP_AUTH_OIDC_CLIENT_SECRET or PAPERCLIP_AUTH_OIDC_CLIENT_SECRET_FILE. " +
      "Refusing to start without a sign-in method.",
    );
  }
}

export function passwordLoginGuardPlugin(oidc: OidcConfig): BetterAuthPlugin {
  return {
    id: "paperclip-password-login-guard",
    hooks: {
      before: [{
        matcher: (ctx) => Boolean(ctx.path && isPasswordLoginPath(ctx.path)),
        handler: createAuthMiddleware(async () => {
          throw new APIError("FORBIDDEN", { message: "Password sign-in is disabled on this instance. Use single sign-on." });
        }),
      }, {
        matcher: (ctx) => ctx.path === "/sign-in/social",
        handler: createAuthMiddleware(async (ctx) => {
          if (ctx.body?.provider !== oidc.providerId) {
            throw new APIError("FORBIDDEN", { message: "Only the configured single sign-on provider is available." });
          }
        }),
      }],
    },
  };
}
