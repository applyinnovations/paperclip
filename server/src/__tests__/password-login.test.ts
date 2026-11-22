import { describe, expect, it } from "vitest";
import { assertPasswordLoginPolicy, isPasswordLoginPath } from "../auth/password-login.js";
import type { OidcConfig } from "../auth/oidc-config.js";
import { parseStrictBooleanEnv } from "../config.js";

const oidc = { providerId: "xlab" } as OidcConfig;

describe("OIDC-only sign-in policy", () => {
  it.each([
    "/sign-in/email", "/sign-in/email/", "/SIGN-IN/EMAIL", "/sign-in/username", "/sign-in/anonymous",
    "/sign-up/email", "/request-password-reset", "/forget-password", "/reset-password", "/reset-password/:token",
    "/change-password", "/set-password", "/verify-password", "/link-social", "/unlink-account",
  ])("refuses %s", (path) => expect(isPasswordLoginPath(path)).toBe(true));

  it.each([
    "/sign-in/social", "/callback/:id", "/get-session", "/sign-out", "/list-accounts", "/oidc/provider",
    "/update-user", "/list-sessions", "/revoke-session", "/sign-up-later-unrelated",
  ])("allows %s", (path) => expect(isPasswordLoginPath(path)).toBe(false));

  it("is a no-op when the flag is off", () => {
    expect(() => assertPasswordLoginPolicy({ authDisablePasswordLogin: false, deploymentMode: "local_trusted" }, null)).not.toThrow();
    expect(() => assertPasswordLoginPolicy({ authDisablePasswordLogin: false, deploymentMode: "authenticated" }, null)).not.toThrow();
  });

  it("fails closed when the flag is on without OIDC or outside authenticated mode", () => {
    expect(() => assertPasswordLoginPolicy({ authDisablePasswordLogin: true, deploymentMode: "authenticated" }, null))
      .toThrow("requires OIDC sign-in");
    expect(() => assertPasswordLoginPolicy({ authDisablePasswordLogin: true, deploymentMode: "local_trusted" }, oidc))
      .toThrow("requires authenticated deployment mode");
    expect(() => assertPasswordLoginPolicy({ authDisablePasswordLogin: true, deploymentMode: "authenticated" }, oidc)).not.toThrow();
  });

  it("parses the flag strictly so a typo cannot leave passwords enabled", () => {
    expect(parseStrictBooleanEnv("X", undefined)).toBe(false);
    expect(parseStrictBooleanEnv("X", "")).toBe(false);
    expect(parseStrictBooleanEnv("X", "false")).toBe(false);
    expect(parseStrictBooleanEnv("X", "true")).toBe(true);
    expect(parseStrictBooleanEnv("X", " TRUE ")).toBe(true);
    for (const value of ["1", "yes", "ture", "on"]) {
      expect(() => parseStrictBooleanEnv("X", value)).toThrow('X must be "true" or "false".');
    }
  });
});
