import express from "express";
import type { Auth } from "better-auth";
import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authAccounts, authSessions, authUsers, authVerifications, companies, companyMemberships, createDb, instanceUserRoles, invites } from "@paperclipai/db";
import { createBetterAuthHandler, createBetterAuthInstance, createBetterAuthManager, resolveBetterAuthSession } from "../auth/better-auth.js";
import { actorMiddleware } from "../middleware/auth.js";
import { assertCompanyAccess } from "../routes/authz.js";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/error-handler.js";
import type { Config } from "../config.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { startOidcProvider } from "./helpers/sso-provider.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { resolveSsoProviders } from "../auth/sso-settings.js";

const ORIGIN = "http://127.0.0.1:41999";
const PASSWORD = "correct-horse-battery-staple";
const support = await getEmbeddedPostgresTestSupport();
const run = support.supported ? describe : describe.skip;

function cookies(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map((value) => value.split(";", 1)[0]).join("; ");
}

run("OIDC through Better Auth and migrated PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let provider: Awaited<ReturnType<typeof startOidcProvider>>;
  let db: ReturnType<typeof createDb>;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-oidc-");
    db = createDb(database.connectionString);
    provider = await startOidcProvider();
  }, 90_000);
  afterAll(async () => {
    await provider?.close();
    await database?.cleanup();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });
  beforeEach(async () => {
    await db.execute(sql`set client_min_messages to warning`);
    await db.execute(sql`truncate "session", "account", "verification", "user", "instance_user_roles", "company_memberships", "companies", "invites" cascade`);
    process.env.BETTER_AUTH_SECRET = "paperclip-oidc-test-session-secret-only";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";
    provider.state.email = "person@example.test";
    provider.state.sub = "person-subject";
    provider.state.emailVerified = true;
    provider.state.claims = {};
    provider.state.wrongSignature = false;
    provider.state.missingToken = false;
    provider.state.discoveryIssuer = undefined;
    provider.state.outage = false;
    provider.state.tokenRequests = 0;
    provider.state.stallDiscovery = false;
    provider.state.endpointQuery = false;
    provider.state.authMethod = "client_secret_basic";
    provider.state.accessToken = "test-access-token";
    provider.state.algorithm = "RS256";
    provider.state.kid = "test-signing-key";
  });

  function providerSettings(extra: Record<string, unknown> = {}) {
    return { providerId: "oidc", type: "oidc" as const, displayName: "OpenID Connect", clientId: "test-client", clientSecret: "test-client-secret",
      issuer: provider.issuer, discoveryUrl: `${provider.issuer}/.well-known/openid-configuration`,
      tokenEndpointAuth: provider.state.authMethod as "client_secret_basic" | "client_secret_post", ...extra };
  }
  function app(disableSignUp = false, overrides: Partial<Config> = {}) {
    const config = { deploymentMode: "authenticated", deploymentExposure: "private", authBaseUrlMode: "explicit",
      authPublicBaseUrl: ORIGIN, authDisableSignUp: disableSignUp, allowedHostnames: ["127.0.0.1"], port: 41999, ssoProviders: [providerSettings()], ...overrides } as Config;
    const auth = createBetterAuthInstance(db, config, [ORIGIN]);
    const api = express();
    api.locals.auth = auth;
    api.locals.config = config;
    api.get("/api/auth/sso-providers", async (_req, res) => res.json({ providers: await auth.getSsoProviders() }));
    api.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
    api.use(express.json());
    api.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: (req) => resolveBetterAuthSession(auth, req) }));
    api.get("/actor", (req, res) => res.json(req.actor));
    api.get("/company", (req, res) => { assertCompanyAccess(req, "22222222-2222-4222-8222-222222222222"); res.json({ ok: true }); });
    api.use("/api", accessRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: ["127.0.0.1"] }));
    api.use((error: Error, _req: express.Request, _res: express.Response, next: express.NextFunction) => { api.locals.lastError = error; next(error); });
    api.use(errorHandler);
    return api;
  }
  async function start(api: express.Express, session = "", linkPassword?: string, providerId = "oidc") {
    const response = await request(api).post(`/api/auth/${linkPassword === undefined ? "sign-in/social" : "link-social"}`)
      .set("origin", ORIGIN).set("cookie", session).send({ provider: providerId, callbackURL: "/invite/test-invite",
        errorCallbackURL: "/auth?error=oidc", disableRedirect: true,
        ...(linkPassword === undefined ? {} : { additionalData: { password: linkPassword, serverContext: { forged: true } } }) });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const authorization = await fetch(response.body.url, { redirect: "manual" });
    expect(authorization.status).toBe(302);
    const target = new URL(authorization.headers.get("location")!);
    return { target, cookie: [session, cookies(response)].filter(Boolean).join("; ") };
  }
  const complete = (api: express.Express, flow: Awaited<ReturnType<typeof start>>, cookie = flow.cookie) =>
    request(api).get(`${flow.target.pathname}${flow.target.search}`).set("cookie", cookie);
  const passwordSignup = (api: express.Express) => request(api).post("/api/auth/sign-up/email").set("origin", ORIGIN)
    .send({ name: "Local Person", email: "person@example.test", password: PASSWORD });

  it("keeps local password recovery available when stored SSO lacks an explicit origin", async () => {
    const api = app(false, { authBaseUrlMode: "auto", authPublicBaseUrl: undefined });
    expect((await request(api).get("/api/auth/sso-providers")).body).toEqual({ providers: [] });
    const local = await passwordSignup(api);
    expect(local.status, JSON.stringify(local.body)).toBe(200);
    const signedIn = await request(api).post("/api/auth/sign-in/email").set("origin", ORIGIN)
      .send({ email: "person@example.test", password: PASSWORD });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    expect((await request(api).get("/actor").set("cookie", cookies(signedIn))).body.userId).toBe(local.body.user.id);
  });

  it("persists source transitions and reloads the same effective providers after restart", async () => {
    const settings = instanceSettingsService(db);
    const stored = providerSettings({ providerId: "stored" });
    const operator = providerSettings({ providerId: "operator" });
    await settings.updateSso({ source: "database", enabled: true, providers: [stored] });
    const reload = () => instanceSettingsService(db).getSso();
    expect(resolveSsoProviders(await reload(), [operator]).map(p => p.providerId)).toEqual(["stored"]);
    await settings.updateSso({ enabled: false });
    expect(resolveSsoProviders(await reload(), [operator])).toEqual([]);
    expect((await reload()).providers[0].clientSecret).toBe(stored.clientSecret);
    await settings.updateSso({ source: "operator" });
    expect(resolveSsoProviders(await reload(), [operator]).map(p => p.providerId)).toEqual(["operator"]);
    expect((await reload()).providers[0].providerId).toBe("stored");
    await settings.updateSso({ source: "database", enabled: true });
    expect(resolveSsoProviders(await reload(), [operator]).map(p => p.providerId)).toEqual(["stored"]);
  });

  it("does not activate operator fallback for invalid persisted SSO policy", async () => {
    const settings = instanceSettingsService(db);
    await settings.getSso();
    await db.execute(sql`update instance_settings set sso = '{"enabled":true,"providers":"invalid"}'::jsonb`);
    expect(resolveSsoProviders(await instanceSettingsService(db).getSso(), [providerSettings()])).toEqual([]);
    await settings.updateSso({ source: "database", enabled: false, providers: [] });
  });


  it.each(["sign-in/social", "link-social"])("rejects caller-owned authorization inputs on %s", async (endpoint) => {
    const api = app();
    const local = await passwordSignup(api);
    const context = await (api.locals.auth as Auth).$context;
    const verify = vi.spyOn(context.password, "verify");
    try {
      for (const authorization of [
        { scopes: ["offline_access", "privileged.read"] }, { scopes: ["openid offline_access"] },
        { scopes: "offline_access" }, { scopes: [] }, { scopes: null },
        { additionalParams: { resource: "https://resource.example.test" } },
        { additionalParams: { audience: "privileged-api" } },
        { additionalParams: { prompt: "consent" } },
        { additionalParams: { access_type: "offline" } },
        { additionalParams: { scope: "openid privileged.read" } },
        { additionalParams: {} }, { additionalParams: null },
      ]) {
        const response = await request(api).post(`/api/auth/${endpoint}`).set("origin", ORIGIN).set("cookie", cookies(local))
          .send({ provider: "oidc", callbackURL: "/", additionalData: { password: PASSWORD }, ...authorization });
        expect(response.status, JSON.stringify(authorization)).toBe(400);
        expect(response.body.url).toBeUndefined();
      }
      expect(verify).not.toHaveBeenCalled();
      expect(await db.select().from(authVerifications)).toHaveLength(0);
    } finally { verify.mockRestore(); }
  });

  it.each(["get-access-token", "refresh-token", "account-info"])("denies %s for stored provider credentials", async (endpoint) => {
    const api = app();
    const login = await complete(api, await start(api));
    const session = cookies(login);
    const account = (await db.select().from(authAccounts))[0];
    await db.update(authAccounts).set({
      accessToken: "legacy-access-sentinel", refreshToken: "legacy-refresh-sentinel", idToken: "legacy-id-sentinel",
      accessTokenExpiresAt: new Date(Date.now() + 60_000), refreshTokenExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(authAccounts.id, account.id));
    const tokenRequests = provider.state.tokenRequests;
    for (const selector of [
      { accountId: account.id }, { useAccountCookie: true }, { accountId: randomUUID() },
      { accountId: account.id, providerId: "different-provider" }, { accountId: account.id, userId: randomUUID() },
    ]) {
      const response = endpoint === "account-info"
        ? await request(api).get(`/api/auth/${endpoint}`).set("cookie", session).query(selector)
        : await request(api).post(`/api/auth/${endpoint}`).set("origin", ORIGIN).set("cookie", session).send(selector);
      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).not.toContain("legacy-");
    }
    if (endpoint === "account-info") {
      expect((await request(api).get(`/api/auth/account-info?accountId=${account.id}&accountId=${account.id}`)
        .set("cookie", session)).status).toBe(403);
    }
    expect(provider.state.tokenRequests).toBe(tokenRequests);
    const accounts = await request(api).get("/api/auth/list-accounts").set("cookie", session);
    expect(accounts.status).toBe(200);
    expect(JSON.stringify(accounts.body)).not.toContain("legacy-");
    expect((await request(api).get("/actor").set("cookie", session)).body.source).toBe("session");
  });

  it("rate limits linking password verification before a fourth credential attempt", async () => {
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "true";
    const api = app();
    const local = await passwordSignup(api);
    expect(local.status).toBe(200);
    const context = await (api.locals.auth as Auth).$context;
    const verify = vi.spyOn(context.password, "verify");
    const clock = vi.spyOn(Date, "now");
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await request(api).post("/api/auth/link-social").set("origin", ORIGIN).set("cookie", cookies(local))
          .send({ provider: "oidc", callbackURL: "/", additionalData: { password: "wrong-password" } });
        expect(response.status).toBe(attempt < 3 ? 401 : 429);
      }
      expect(verify).toHaveBeenCalledTimes(3);
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await request(api).post("/api/auth/sign-in/email").set("origin", ORIGIN)
          .send({ email: "person@example.test", password: "wrong-password" });
        expect(response.status).toBe(attempt < 3 ? 401 : 429);
      }
      expect(verify).toHaveBeenCalledTimes(6);
      clock.mockReturnValue(Date.now() + 11_000);
      await start(api, cookies(local), PASSWORD);
      expect(verify).toHaveBeenCalledTimes(7);
    } finally { clock.mockRestore(); verify.mockRestore(); }
  });


  it("honors an explicit rate-limit disable override for linking", async () => {
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";
    const api = app();
    const local = await passwordSignup(api);
    const context = await (api.locals.auth as Auth).$context;
    const verify = vi.spyOn(context.password, "verify");
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await request(api).post("/api/auth/link-social").set("origin", ORIGIN).set("cookie", cookies(local))
          .send({ provider: "oidc", callbackURL: "/", additionalData: { password: "wrong-password" } });
        expect(response.status).toBe(401);
      }
      expect(verify).toHaveBeenCalledTimes(4);
    } finally { verify.mockRestore(); }
  });

  it.each([
    { label: "omitted", scopes: undefined, expected: ["openid", "profile", "email"] },
    { label: "empty", scopes: [], expected: ["openid", "profile", "email"] },
    { label: "explicit", scopes: ["openid", "email", "groups"], expected: ["openid", "email", "groups"] },
  ])("normalizes operator scopes: $label", async ({ scopes, expected }) => {
    const api = app(false, { ssoProviders: [providerSettings({ scopes })] });
    await start(api);
    expect(provider.state.lastAuthorization?.get("scope")?.split(" ")).toEqual(expected);
  });

  it("creates an issuer/subject account and session without company or admin grants", async () => {
    const api = app();
    const metadata = await request(api).get("/api/auth/sso-providers");
    expect(metadata.body).toEqual({ providers: [{ providerId: "oidc", displayName: "OpenID Connect", type: "oidc" }] });
    const flow = await start(api);
    expect(provider.state.lastAuthorization?.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback/oidc`);
    expect(provider.state.lastAuthorization?.get("scope")?.split(" ")).toEqual(expect.arrayContaining(["openid", "profile", "email"]));
    const response = await complete(api, flow);
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("/invite/test-invite");
    const accounts = await db.select().from(authAccounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ providerId: "oidc", issuer: provider.issuer, accountId: "person-subject" });
    expect(await db.select().from(companyMemberships)).toHaveLength(0);
    expect(await db.select().from(instanceUserRoles)).toHaveLength(0);
    const session = cookies(response);
    expect(session).toContain("session_token");
    expect(response.headers["set-cookie"].join(";")).toContain("HttpOnly");
    expect(response.headers["set-cookie"].join(";")).toContain("SameSite=Lax");
    const actor = await request(api).get("/actor").set("cookie", session);
    expect(actor.body).toMatchObject({ type: "board", source: "session", isInstanceAdmin: false, companyIds: [] });
    expect((await request(api).get("/company").set("cookie", session)).status).toBe(403);
  });

  it("preserves query parameters on discovered OIDC endpoints", async () => {
    provider.state.endpointQuery = true;
    const api = app();
    const flow = await start(api);
    expect(provider.state.lastAuthorization?.get("tenant")).toBe("example");
    expect((await complete(api, flow)).headers.location).toContain("/invite/test-invite");
    expect(await db.select().from(authSessions)).toHaveLength(1);
  });

  it("supports providers that require client_secret_post", async () => {
    provider.state.authMethod = "client_secret_post";
    const api = app();
    expect((await complete(api, await start(api))).headers.location).toContain("/invite/test-invite");
    expect(await db.select().from(authSessions)).toHaveLength(1);
  });

  it.each([
    ["issuer", { iss: "https://other.example.test" }], ["audience", { aud: "other-client" }],
    ["expiry", { exp: 1 }], ["nonce", { nonce: "wrong-nonce" }],
    ["authorized party", { aud: ["test-client", "other-client"], azp: "other-client" }],
  ])("rejects an ID token with the wrong %s", async (_name, claims) => {
    provider.state.claims = claims;
    const api = app();
    const response = await complete(api, await start(api));
    expect(response.headers.location).toContain("error=");
    expect(await db.select().from(authUsers)).toHaveLength(0);
    expect(await db.select().from(authSessions)).toHaveLength(0);
  });

  it.each(["signature", "missing id token", "unverified email"])("rejects %s", async (failure) => {
    provider.state.wrongSignature = failure === "signature";
    provider.state.missingToken = failure === "missing id token";
    provider.state.emailVerified = failure !== "unverified email";
    const api = app();
    const response = await complete(api, await start(api));
    expect(response.headers.location).toContain("error=");
    expect(await db.select().from(authSessions)).toHaveLength(0);
  });

  it("requires browser-bound state and refuses callback replay", async () => {
    const api = app();
    const missingCookie = await start(api);
    const rejected = await complete(api, missingCookie, "");
    expect(rejected.headers.location).toContain("error=");
    expect(provider.state.tokenRequests).toBe(0);
    const flow = await start(api);
    const response = await complete(api, flow);
    expect(response.headers.location).toContain("/invite/test-invite");
    const replay = await complete(api, flow);
    expect(replay.headers.location).toContain("error=");
    expect(await db.select().from(authSessions)).toHaveLength(1);
  });

  it("rejects login CSRF, foreign return URLs and client-supplied ID tokens", async () => {
    const api = app();
    for (const [body, status] of [[{ callbackURL: "https://evil.example/" }, 400], [{ errorCallbackURL: "https://evil.example/" }, 400],
      [{ idToken: { token: "forged" } }, 400]] as const) {
      const response = await request(api).post("/api/auth/sign-in/social").set("origin", ORIGIN)
        .send({ provider: "oidc", callbackURL: "/", ...body });
      expect(response.status).toBe(status);
    }
    const csrf = await request(api).post("/api/auth/sign-in/social").set("origin", "https://evil.example")
      .send({ provider: "oidc", callbackURL: "/" });
    expect(csrf.status).toBe(403);
  });

  it("does not link by email; requires password-confirmed session-bound linking", async () => {
    const api = app();
    const local = await passwordSignup(api);
    expect(local.status).toBe(200);
    expect((await db.select().from(authUsers))[0].emailVerified).toBe(false);
    const collision = await complete(api, await start(api));
    expect(collision.headers.location).toContain("account_not_linked");
    expect(await db.select().from(authAccounts)).toHaveLength(1);
    const failed = await request(api).post("/api/auth/link-social").set("origin", ORIGIN).set("cookie", cookies(local))
      .send({ provider: "oidc", callbackURL: "/", additionalData: { password: "wrong" } });
    expect(failed.status).toBe(401);
    const flow = await start(api, cookies(local), PASSWORD);
    const storedState = JSON.stringify(await db.select().from(authVerifications));
    expect(storedState).not.toContain(PASSWORD);
    expect(storedState).not.toContain("forged");
    const linked = await complete(api, flow);
    expect(linked.headers.location).toContain("/invite/test-invite");
    expect(await db.select().from(authUsers)).toHaveLength(1);
    expect(await db.select().from(authAccounts)).toHaveLength(2);
    const again = await complete(api, await start(api));
    expect(again.headers.location).toContain("/invite/test-invite");
    const passwordSignIn = await request(api).post("/api/auth/sign-in/email").set("origin", ORIGIN)
      .send({ email: "person@example.test", password: PASSWORD });
    expect(passwordSignIn.status).toBe(200);
  });

  it("refuses a linking callback after the initiating session is revoked", async () => {
    const api = app();
    const local = await passwordSignup(api);
    const flow = await start(api, cookies(local), PASSWORD);
    await db.delete(authSessions);
    const response = await complete(api, flow);
    expect(response.headers.location).toContain("link_reauthentication_required");
    expect(await db.select().from(authAccounts)).toHaveLength(1);
  });

  it("refuses linking from another session of the same user", async () => {
    const api = app();
    const local = await passwordSignup(api);
    const flow = await start(api, cookies(local), PASSWORD);
    const otherSession = await request(api).post("/api/auth/sign-in/email").set("origin", ORIGIN)
      .send({ email: "person@example.test", password: PASSWORD });
    expect(otherSession.status).toBe(200);
    const stateCookies = flow.cookie.split("; ").filter((cookie) => !cookie.includes("session_token="));
    const response = await complete(api, flow, [...stateCookies, cookies(otherSession)].join("; "));
    expect(response.headers.location).toContain("link_reauthentication_required");
    expect(await db.select().from(authAccounts)).toHaveLength(1);
  });

  it("expires password confirmation after five minutes", async () => {
    const api = app();
    const local = await passwordSignup(api);
    const flow = await start(api, cookies(local), PASSWORD);
    const states = await db.select().from(authVerifications);
    expect(states).toHaveLength(1);
    const state = JSON.parse(states[0].value);
    state.serverContext.paperclipSsoLink.confirmedAt = Date.now() - 5 * 60_000 - 1;
    await db.update(authVerifications).set({ value: JSON.stringify(state) }).where(eq(authVerifications.id, states[0].id));
    const response = await complete(api, flow);
    expect(response.headers.location).toContain("link_reauthentication_required");
    expect(await db.select().from(authAccounts)).toHaveLength(1);
  });

  it("keeps disabled signup closed even when a callback returns to an invitation", async () => {
    const api = app(true);
    const response = await complete(api, await start(api));
    expect(response.headers.location).toContain("signup_disabled");
    expect(await db.select().from(authUsers)).toHaveLength(0);
  });

  it("accepts a company invite only through the existing invite route", async () => {
    const api = app();
    const company = (await db.insert(companies).values({ name: "Inviting company", issuePrefix: "OIDC" }).returning())[0];
    const token = randomUUID();
    await db.insert(invites).values({ companyId: company.id, inviteType: "company_join", allowedJoinTypes: "human",
      tokenHash: createHash("sha256").update(token).digest("hex"), defaultsPayload: { human: { role: "viewer" } }, expiresAt: new Date(Date.now() + 60_000) });
    const login = await complete(api, await start(api));
    expect(await db.select().from(companyMemberships)).toHaveLength(0);
    const accepted = await request(api).post(`/api/invites/${token}/accept`).set("cookie", cookies(login)).send({ requestType: "human" });
    expect(accepted.status, String(api.locals.lastError?.message ?? JSON.stringify(accepted.body))).toBe(202);
    expect(await db.select().from(companyMemberships)).toMatchObject([{ companyId: company.id, membershipRole: "viewer", status: "active" }]);
    expect(await db.select().from(instanceUserRoles)).toHaveLength(0);
  });

  it("bootstraps a local admin, closes signup, and explicitly links OIDC without losing password recovery", async () => {
    const local = await passwordSignup(app());
    expect(local.status).toBe(200);
    const api = app(true);
    const token = randomUUID();
    await db.insert(invites).values({ inviteType: "bootstrap_ceo", allowedJoinTypes: "human",
      tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000) });
    const accepted = await request(api).post(`/api/invites/${token}/accept`).set("cookie", cookies(local)).send({ requestType: "human" });
    expect(accepted.status, String(api.locals.lastError?.message ?? JSON.stringify(accepted.body))).toBe(202);
    expect(accepted.body.bootstrapAccepted).toBe(true);
    expect(await db.select().from(instanceUserRoles)).toHaveLength(1);
    expect((await complete(api, await start(api, cookies(local), PASSWORD))).headers.location).toContain("/invite/test-invite");
    const login = await complete(api, await start(api));
    const actor = await request(api).get("/actor").set("cookie", cookies(login));
    expect(actor.body.isInstanceAdmin).toBe(true);
    expect(await db.select().from(authUsers)).toHaveLength(1);
    expect((await request(api).post("/api/auth/sign-in/email").set("origin", ORIGIN)
      .send({ email: "person@example.test", password: PASSWORD })).status).toBe(200);
  });

  it("invalidates the local session on logout and rejects logout CSRF", async () => {
    const api = app();
    const response = await complete(api, await start(api));
    const session = cookies(response);
    expect((await request(api).get("/actor").set("cookie", session)).body.source).toBe("session");
    const csrf = await request(api).post("/api/auth/sign-out").set("origin", "https://evil.example").set("cookie", session).send({});
    expect(await db.select().from(authSessions)).toHaveLength(1);
    expect(csrf.status).toBe(403);
    const logout = await request(api).post("/api/auth/sign-out").set("origin", ORIGIN).set("cookie", session).send({});
    expect(logout.status).toBe(200);
    expect(await db.select().from(authSessions)).toHaveLength(0);
    expect((await request(api).get("/actor").set("cookie", session)).body.type).toBe("none");
  });

  it.each(["outage", "issuer mismatch"])("keeps password recovery available during discovery %s", async (failure) => {
    provider.state.outage = failure === "outage";
    provider.state.discoveryIssuer = failure === "issuer mismatch" ? "https://wrong.example.test" : undefined;
    const api = app();
    expect((await request(api).get("/api/auth/sso-providers")).body).toEqual({ providers: [] });
    expect((await passwordSignup(api)).status).toBe(200);
    expect((await request(api).post("/api/auth/sign-in/email").set("origin", ORIGIN)
      .send({ email: "person@example.test", password: PASSWORD })).status).toBe(200);
  });

  it("bounds a stalled discovery request and keeps password recovery usable", async () => {
    provider.state.stallDiscovery = true;
    const api = app();
    const startTime = Date.now();
    expect((await request(api).get("/api/auth/sso-providers")).body).toEqual({ providers: [] });
    expect(Date.now() - startTime).toBeLessThan(8000);
    expect((await passwordSignup(api)).status).toBe(200);
  }, 10_000);

  it("leaves password authentication unchanged when OIDC is not configured", async () => {
    const api = app(false, { ssoProviders: [] });
    expect((await request(api).get("/api/auth/sso-providers")).body).toEqual({ providers: [] });
    expect((await passwordSignup(api)).status).toBe(200);
  });
  it.each(["missing role", "access-token role", "string email verification"])("rejects %s using verified ID-token claims", async failure => {
    if (failure === "access-token role") provider.state.accessToken = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({realm_access:{roles:["member"]}})).toString("base64url")}.signature`;
    provider.state.claims = failure === "string email verification" ? { realm_access: { roles: ["member"] }, email_verified: "false" } : {};
    const api = app(false, { ssoProviders: [providerSettings({ requiredRoles: { claimPath: "realm_access.roles", roles: ["member"] } })] });
    const response = await complete(api, await start(api));
    expect(response.headers.location).toContain("error=");
    expect(await db.select().from(authSessions)).toHaveLength(0);
  });

  it("admits a role from the verified ID token", async () => {
    provider.state.claims = { realm_access: { roles: ["member"] } };
    const api = app(false, { ssoProviders: [providerSettings({ requiredRoles: { claimPath: "realm_access.roles", roles: ["member"] } })] });
    expect((await complete(api, await start(api))).headers.location).toContain("/invite/test-invite");
    expect(await db.select().from(authSessions)).toHaveLength(1);
  });

  it.each(["algorithm", "unknown JWKS key"])("rejects an invalid %s", async failure => {
    if (failure === "algorithm") provider.state.algorithm = "HS256";
    else provider.state.kid = "not-in-discovered-jwks";
    const api = app();
    expect((await complete(api, await start(api))).headers.location).toContain("error=");
    expect(await db.select().from(authSessions)).toHaveLength(0);
  });

  it("registers multiple preset providers with their configured identifiers", async () => {
    const api = app(false, { ssoProviders: [providerSettings(), providerSettings({ providerId: "keycloak-alt", type: "keycloak" })] });
    expect((await request(api).get("/api/auth/sso-providers")).body.providers.map((p: {providerId: string}) => p.providerId)).toEqual(["oidc", "keycloak-alt"]);
    const flow = await start(api, "", undefined, "keycloak-alt");
    expect(flow.target.pathname).toBe("/api/auth/callback/keycloak-alt");
    expect((await complete(api, flow)).headers.location).toContain("/invite/test-invite");
    expect((await db.select().from(authAccounts))[0]).toMatchObject({ providerId: "keycloak-alt", issuer: provider.issuer });
  });

  it("keeps credential export denied after all providers are disabled", async () => {
    const api = app();
    const login = await complete(api, await start(api));
    const disabled = app(false, { ssoProviders: [] });
    expect((await request(disabled).post("/api/auth/get-access-token").set("origin", ORIGIN).set("cookie", cookies(login)).send({ providerId: "oidc" })).status).toBe(403);
    expect((await request(disabled).get("/actor").set("cookie", cookies(login))).body.source).toBe("session");
  });

  it("advertises only the active auth manager providers across rebuilds", async () => {
    const manager = createBetterAuthManager(db, app().locals.config, [ORIGIN]);
    expect((await manager.getSsoProviders()).map(p => p.providerId)).toEqual(["oidc"]);
    manager.rebuild([]);
    expect(await manager.getSsoProviders()).toEqual([]);
    manager.rebuild([providerSettings({ providerId: "keycloak-alt", type: "keycloak" })]);
    expect((await manager.getSsoProviders()).map(p => p.providerId)).toEqual(["keycloak-alt"]);
    const api = express();
    api.all("/api/auth/{*path}", manager.handler);
    const flow = await start(api, "", undefined, "keycloak-alt");
    expect((await complete(api, flow)).status).toBe(302);
    expect((await db.select().from(authAccounts))[0]).toMatchObject({ providerId: "keycloak-alt", issuer: provider.issuer });
  });

  it("rejects first-login initiation without the exact origin", async () => {
    const api = app();
    for (const origin of [undefined, "null", "https://evil.example.test"]) {
      const pending = request(api).post("/api/auth/sign-in/social");
      if (origin !== undefined) pending.set("origin", origin);
      expect((await pending.send({ provider: "oidc", callbackURL: "/" })).status).toBe(403);
    }
    expect(await db.select().from(authVerifications)).toHaveLength(0);
  });

  it.each([false, true])("preserves privileged legacy ownership; SSO-only=%s requires recovery before linking", async (ssoOnly) => {
    const api = app();
    const local = await passwordSignup(api);
    const user = (await db.select().from(authUsers))[0];
    if (ssoOnly) await db.delete(authAccounts).where(eq(authAccounts.userId, user.id));
    await db.insert(instanceUserRoles).values({ userId: user.id, role: "instance_admin" });
    const [company] = await db.insert(companies).values({ name: "Legacy Company", issuePrefix: "LEG" }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: user.id,
      status: "active", membershipRole: "owner" });
    const legacyId = randomUUID();
    await db.insert(authAccounts).values({ id: legacyId, providerId: "oidc", accountId: provider.state.sub,
      issuer: "local:oauth:oidc", userId: user.id, createdAt: new Date(), updatedAt: new Date() });
    const login = await complete(api, await start(api));
    expect(login.headers.location).toContain("account_not_linked");
    expect((await db.select().from(authAccounts)).find(a => a.id === legacyId)).toMatchObject({ userId: user.id, issuer: "local:oauth:oidc" });
    if (ssoOnly) {
      // Even a surviving local session cannot invent the missing recovery password.
      const link = await request(api).post("/api/auth/link-social").set("origin", ORIGIN).set("cookie", cookies(local))
        .send({ provider: "oidc", additionalData: { password: PASSWORD }, callbackURL: "/" });
      expect(link.status).toBe(401);
      expect(await db.select().from(authAccounts)).toHaveLength(1);
    } else {
      expect((await complete(api, await start(api, cookies(local), PASSWORD))).headers.location).toContain("/invite/test-invite");
      const login = await complete(api, await start(api));
      expect((await request(api).get("/actor").set("cookie", cookies(login))).body).toMatchObject({ userId: user.id, isInstanceAdmin: true });
    }
    expect(await db.select().from(authUsers)).toHaveLength(1);
    const accounts = await db.select().from(authAccounts);
    expect(accounts).toHaveLength(ssoOnly ? 1 : 3);
    expect(accounts.every(a => a.userId === user.id)).toBe(true);
    if (!ssoOnly) expect(accounts.find(a => a.issuer === provider.issuer)).toMatchObject({ accountId: provider.state.sub, userId: user.id });
    expect(await db.select().from(instanceUserRoles)).toMatchObject([{ userId: user.id, role: "instance_admin" }]);
    expect(await db.select().from(companyMemberships)).toMatchObject([{ principalId: user.id, companyId: company.id, membershipRole: "owner" }]);
  });

});
