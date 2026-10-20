import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";

const provider = { providerId: "file", type: "keycloak", clientId: "client", clientSecret: "synthetic-secret",
  issuer: "https://identity.example.test/realms/main" };
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sso-config-"));
  const file = path.join(root, "config.json");
  fs.writeFileSync(file, JSON.stringify({ $meta: { version: 1, updatedAt: "2026-10-20T00:00:00Z", source: "configure" },
    database: { mode: "embedded-postgres" }, logging: { mode: "file" }, server: {}, auth: { ssoProviders: [provider] } }));
  vi.stubEnv("PAPERCLIP_CONFIG", file);
  vi.stubEnv("PAPERCLIP_SSO_PROVIDERS", undefined);
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe("operator SSO configuration", () => {
  it("uses file providers when the environment variable is absent", () => {
    expect(loadConfig().ssoProviders).toEqual([provider]);
  });
  it("treats an explicit empty environment array as authoritative", () => {
    vi.stubEnv("PAPERCLIP_SSO_PROVIDERS", "[]");
    expect(loadConfig().ssoProviders).toEqual([]);
  });
  it("uses environment providers ahead of the file", () => {
    const environment = { ...provider, providerId: "environment" };
    vi.stubEnv("PAPERCLIP_SSO_PROVIDERS", JSON.stringify([environment]));
    expect(loadConfig().ssoProviders).toEqual([environment]);
  });
  it.each(["{", "{}", "null", JSON.stringify([{ ...provider, providerId: "credential" }]),
    JSON.stringify([provider, provider]), JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ ...provider, providerId: `provider-${i}` })))])(
    "rejects invalid environment policy without falling back: %s", value => {
      vi.stubEnv("PAPERCLIP_SSO_PROVIDERS", value);
      expect(() => loadConfig()).toThrow(/SSO configuration|SSO provider/);
      try { loadConfig(); } catch (error) { expect(String(error)).not.toContain(provider.clientSecret); }
    });
});
