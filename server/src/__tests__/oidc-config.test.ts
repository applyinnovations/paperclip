import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { oidcUrl, readOidcConfig } from "../auth/oidc-config.js";
import type { Config } from "../config.js";

const config = { deploymentMode: "authenticated", authBaseUrlMode: "explicit",
  authPublicBaseUrl: "https://paperclip.example.test", authDisableSignUp: true } as Config;
const env = { PAPERCLIP_AUTH_OIDC_ISSUER: "https://identity.example.test/realms/team",
  PAPERCLIP_AUTH_OIDC_CLIENT_ID: "paperclip", PAPERCLIP_AUTH_OIDC_CLIENT_SECRET: "test-only-secret" };

describe("static OIDC configuration", () => {
  it("is opt-in and keeps signup policy", () => {
    expect(readOidcConfig(config, {})).toBeNull();
    expect(readOidcConfig(config, env)).toMatchObject({ issuer: env.PAPERCLIP_AUTH_OIDC_ISSUER, providerId: "oidc", disableSignUp: true });
  });
  it("reads a mounted secret without including its contents in errors", () => {
    const directory = mkdtempSync(join(tmpdir(), "paperclip-oidc-config-"));
    const file = join(directory, "secret");
    try {
      writeFileSync(file, "mounted-test-secret\n", { mode: 0o600 });
      expect(readOidcConfig(config, { ...env, PAPERCLIP_AUTH_OIDC_CLIENT_SECRET: undefined,
        PAPERCLIP_AUTH_OIDC_CLIENT_SECRET_FILE: file })?.clientSecret).toBe("mounted-test-secret");
      expect(() => readOidcConfig(config, { ...env, PAPERCLIP_AUTH_OIDC_CLIENT_SECRET_FILE: file })).toThrow("exactly one");
      expect(() => readOidcConfig(config, { ...env, PAPERCLIP_AUTH_OIDC_ISSUER: "https://user:do-not-print@example.test" }))
        .toThrow("OIDC URLs must use HTTPS");
    } finally { rmSync(directory, { recursive: true }); }
  });
  it.each(["http://identity.example.test", "https://user:password@identity.example.test", "https://identity.example.test#fragment", "javascript:alert(1)"])
    ("rejects unsafe endpoint %s", (url) => expect(() => oidcUrl(url, false)).toThrow());
  it("allows loopback development only when requested", () => {
    expect(oidcUrl("http://127.0.0.1:3100", true).origin).toBe("http://127.0.0.1:3100");
    expect(() => oidcUrl("http://127.0.0.1:3100", false)).toThrow();
  });
  it("allows discovered endpoint query parameters while forbidding issuer queries", () => {
    expect(oidcUrl("https://identity.example.test/token?tenant=example", false, true).search).toBe("?tenant=example");
    expect(() => oidcUrl("https://identity.example.test?tenant=example", false)).toThrow();
  });
  it("fails closed on partial configuration and unsafe modes", () => {
    expect(() => readOidcConfig(config, { PAPERCLIP_AUTH_OIDC_CLIENT_ID: "paperclip" })).toThrow("OIDC requires");
    expect(() => readOidcConfig({ ...config, authBaseUrlMode: "auto" }, env)).toThrow("explicit");
    expect(() => readOidcConfig({ ...config, deploymentMode: "local_trusted" }, env)).toThrow("authenticated");
    expect(() => readOidcConfig(config, { ...env, PAPERCLIP_AUTH_OIDC_PROVIDER_ID: "credential" })).toThrow("PROVIDER_ID");
  });
});
