export type OidcProvider = { providerId: string; displayName: string };

export const oidcApi = {
  getProvider: async (): Promise<OidcProvider | null> => {
    const response = await fetch("/api/auth/oidc/provider", { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error("Cannot check single sign-on.");
    const result = await response.json() as { provider: OidcProvider | null };
    return result.provider;
  },
  begin: async (providerId: string, callbackURL: string, password?: string) => {
    const target = new URL(callbackURL, window.location.origin);
    if (target.origin !== window.location.origin) throw new Error("Invalid sign-in return URL.");
    const response = await fetch(`/api/auth/${password === undefined ? "sign-in/social" : "link-social"}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: providerId,
        callbackURL: target.href,
        errorCallbackURL: new URL("/auth?error=oidc", window.location.origin).href,
        disableRedirect: true,
        ...(password === undefined ? {} : { additionalData: { password } }),
      }),
    });
    const result = await response.json() as { url?: string };
    if (!response.ok || !result.url) throw new Error(password === undefined
      ? "Single sign-on failed. Try again or use your Paperclip password."
      : "Cannot link this account. Check your Paperclip password and try again.");
    const redirect = new URL(result.url);
    if (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname))) {
      throw new Error("Invalid provider sign-in URL.");
    }
    window.location.assign(redirect.href);
  },
};
