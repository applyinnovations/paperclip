import { describe, expect, it } from "vitest";
import type { SsoProviderConfig } from "@paperclipai/shared";
import { ssoProviderMetadata, ssoUserInfo, ssoUrl } from "../auth/sso.js";
const provider: SsoProviderConfig = { providerId: "custom-keycloak", type: "keycloak", clientId: "client", clientSecret: "synthetic-secret",
  issuer: "https://idp.example.test/realms/main", requiredRoles: { claimPath: "resource_access.paperclip.roles", roles: ["human"] } };
const claims = { sub: "subject", email: "person@example.test", email_verified: true, name: "Person", iat: 100, exp: 500,
  resource_access: { paperclip: { roles: ["human"] } } };
// Pure claim-policy tests; signature proof belongs to the real callback integration suite.
const token = (value: Record<string, unknown>) => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`;
describe("verified SSO claim policy", () => {
  it("admits the configured role", () => expect(ssoUserInfo(provider, token(claims))).toMatchObject({ emailVerified: true, sub: "subject" }));
  it("rejects missing roles", () => expect(ssoUserInfo(provider, token({ ...claims, resource_access: {} }))).toBeNull());
  it.each([false, "false", "true", 1, null])("requires literal verified email: %s", email_verified => {
    expect(ssoUserInfo(provider, token({ ...claims, email_verified }))).toBeNull();
  });
  it("allows omission of role restrictions", () => expect(ssoUserInfo({ ...provider, requiredRoles: undefined }, token({ ...claims, resource_access: {} }))).not.toBeNull());
  it("rejects a conflicting authorized party", () => expect(ssoUserInfo(provider, token({ ...claims, azp: "other-client" }))).toBeNull());
});
describe("native SSO provider metadata", () => {
  it.each([
    [provider, "https://idp.example.test/realms/main"],
    [{ ...provider, issuer: "https://idp.example.test/realms/main/" }, "https://idp.example.test/realms/main"],
    [{ ...provider, type: "oidc", issuer: undefined, discoveryUrl: "https://idp.example.test/realms/main/.well-known/openid-configuration" }, "https://idp.example.test/realms/main"],
    [{ ...provider, type: "okta" }, "https://idp.example.test/realms/main"],
    [{ ...provider, type: "okta", issuer: "https://idp.example.test/realms/main/" }, "https://idp.example.test/realms/main"],
    [{ ...provider, type: "auth0", issuer: undefined, domain: "example.auth0.com" }, "https://example.auth0.com/"],
    [{ ...provider, type: "auth0", issuer: "https://example.auth0.com", domain: undefined }, "https://example.auth0.com/"],
    [{ ...provider, type: "microsoft_entra_id", issuer: undefined, tenantId: "12345678-1234-1234-1234-123456789abc" }, "https://login.microsoftonline.com/12345678-1234-1234-1234-123456789abc/v2.0"],
  ])("derives the configured issuer for %s", (value, issuer) => expect(ssoProviderMetadata(value as SsoProviderConfig).issuer).toBe(issuer));
  it("requires an issuer for nonstandard discovery", () => expect(() => ssoProviderMetadata({ ...provider, type: "oidc", issuer: undefined, discoveryUrl: "https://identity.example.test/discovery" })).toThrow("explicit issuer"));
  it.each(["http://private.example.test", "https://user:password@identity.example.test", "https://identity.example.test/#fragment"])("rejects unsafe URL %s", value => expect(() => ssoUrl(value)).toThrow());
});
