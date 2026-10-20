import { afterEach, describe, expect, it, vi } from "vitest";
import { authApi } from "./auth";

describe("authApi.signOut", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the managed deployment redirect from the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, redirectTo: "/cloud/logout" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authApi.signOut()).resolves.toEqual({
      success: true,
      redirectTo: "/cloud/logout",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  });
});

describe("native SSO protocol requests", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uses the standard sign-in and password-confirmed linking endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ url: "https://idp.example.test/authorize" }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await authApi.signInSso("keycloak", "/invite/synthetic");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/sign-in/social");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ provider: "keycloak", callbackURL: "/invite/synthetic" });
    await authApi.linkSso("keycloak", "synthetic-password", "/company/settings/instance/profile");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/link-social");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ provider: "keycloak", callbackURL: "/company/settings/instance/profile", disableRedirect: true, additionalData: { password: "synthetic-password" } });
  });
});
