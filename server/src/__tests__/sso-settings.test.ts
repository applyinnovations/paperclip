import { describe, expect, it } from "vitest";
import { resolveSsoProviders } from "../auth/sso-settings.js";
import { patchInstanceSsoSettingsSchema, type InstanceSsoSettings } from "@paperclipai/shared";
const provider = { providerId: "operator", type: "oidc" as const, clientId: "synthetic-client", clientSecret: "synthetic-secret", discoveryUrl: "https://idp.example.test/.well-known/openid-configuration" };
const stored = { ...provider, providerId: "database" };
describe("SSO source and PATCH semantics", () => {
  it.each([
    [{ enabled: false, providers: [] }, "operator"],
    [{ enabled: true, providers: [] }, "operator"],
    [{ enabled: false, providers: [stored] }, "operator"],
    [{ enabled: true, providers: [stored] }, "database"],
    [{ source: "operator", enabled: true, providers: [stored] }, "operator"],
    [{ source: "database", enabled: true, providers: [stored] }, "database"],
    [{ source: "database", enabled: false, providers: [stored] }, undefined],
    [{ source: "database", enabled: true, providers: [] }, undefined],
  ])("keeps source across save/restart: %s", (settings, expected) => {
    const first = resolveSsoProviders(settings as InstanceSsoSettings, [provider]);
    expect(first.map(p => p.providerId)).toEqual(expected ? [expected] : []);
    expect(resolveSsoProviders(JSON.parse(JSON.stringify(settings)), [provider])).toEqual(first);
  });
  it("does not inject defaults into partial writes", () => {
    expect(patchInstanceSsoSettingsSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(patchInstanceSsoSettingsSchema.parse({ source: "database" })).toEqual({ source: "database" });
    expect(patchInstanceSsoSettingsSchema.parse({})).toEqual({});
  });
});
