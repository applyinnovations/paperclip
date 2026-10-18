import express from "express";
import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authAccounts, authSessions, authUsers, authVerifications, companies, companyMemberships, createDb, instanceUserRoles, invites } from "@paperclipai/db";
import { createBetterAuthHandler, createBetterAuthInstance, resolveBetterAuthSession } from "../auth/better-auth.js";
import { actorMiddleware } from "../middleware/auth.js";
import { assertCompanyAccess } from "../routes/authz.js";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/error-handler.js";
import type { Config } from "../config.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { startOidcProvider } from "./helpers/oidc-provider.js";

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
    for (const key of Object.keys(process.env)) if (key.startsWith("PAPERCLIP_AUTH_OIDC_")) delete process.env[key];
    process.env.PAPERCLIP_AUTH_OIDC_ISSUER = provider.issuer;
    process.env.PAPERCLIP_AUTH_OIDC_CLIENT_ID = "test-client";
    process.env.PAPERCLIP_AUTH_OIDC_CLIENT_SECRET = "test-client-secret";
    delete process.env.PAPERCLIP_AUTH_OIDC_CLIENT_SECRET_FILE;
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
  });

  function app(disableSignUp = false) {
    const config = { deploymentMode: "authenticated", deploymentExposure: "private", authBaseUrlMode: "explicit",
      authPublicBaseUrl: ORIGIN, authDisableSignUp: disableSignUp, allowedHostnames: ["127.0.0.1"], port: 41999 } as Config;
    const auth = createBetterAuthInstance(db, config, [ORIGIN]);
    const api = express();
    api.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
    api.use(express.json());
    api.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: (req) => resolveBetterAuthSession(auth, req) }));
    api.get("/actor", (req, res) => res.json(req.actor));
    api.get("/company", (req, res) => { assertCompanyAccess(req, "22222222-2222-4222-8222-222222222222"); res.json({ ok: true }); });
    api.use("/api", accessRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: ["127.0.0.1"] }));
    api.use(errorHandler);
    return api;
  }
  async function start(api: express.Express, session = "", linkPassword?: string) {
    const response = await request(api).post(`/api/auth/${linkPassword === undefined ? "sign-in/social" : "link-social"}`)
      .set("origin", ORIGIN).set("cookie", session).send({ provider: "oidc", callbackURL: "/invite/test-invite",
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

  it("creates an issuer/subject account and session without company or admin grants", async () => {
    const api = app();
    const metadata = await request(api).get("/api/auth/oidc/provider");
    expect(metadata.body).toEqual({ provider: { providerId: "oidc", displayName: "OpenID Connect" } });
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
    process.env.PAPERCLIP_AUTH_OIDC_TOKEN_ENDPOINT_AUTH_METHOD = "client_secret_post";
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
    for (const [body, status] of [[{ callbackURL: "https://evil.example/" }, 403], [{ errorCallbackURL: "https://evil.example/" }, 403],
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
    state.serverContext.paperclipOidcLink.confirmedAt = Date.now() - 5 * 60_000 - 1;
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
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
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
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
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
    const csrf = await request(api).post("/api/auth/sign-out").set("origin", "https://evil.example").set("cookie", session).send({});
    expect(csrf.status).toBe(403);
    expect(await db.select().from(authSessions)).toHaveLength(1);
    const logout = await request(api).post("/api/auth/sign-out").set("origin", ORIGIN).set("cookie", session).send({});
    expect(logout.status).toBe(200);
    expect(await db.select().from(authSessions)).toHaveLength(0);
    expect((await request(api).get("/actor").set("cookie", session)).body.type).toBe("none");
  });

  it.each(["outage", "issuer mismatch"])("keeps password recovery available during discovery %s", async (failure) => {
    provider.state.outage = failure === "outage";
    provider.state.discoveryIssuer = failure === "issuer mismatch" ? "https://wrong.example.test" : undefined;
    const api = app();
    expect((await request(api).get("/api/auth/oidc/provider")).body).toEqual({ provider: null });
    expect((await passwordSignup(api)).status).toBe(200);
    expect((await request(api).post("/api/auth/sign-in/email").set("origin", ORIGIN)
      .send({ email: "person@example.test", password: PASSWORD })).status).toBe(200);
  });

  it("bounds a stalled discovery request and keeps password recovery usable", async () => {
    provider.state.stallDiscovery = true;
    const api = app();
    const startTime = Date.now();
    expect((await request(api).get("/api/auth/oidc/provider")).body).toEqual({ provider: null });
    expect(Date.now() - startTime).toBeLessThan(8000);
    expect((await passwordSignup(api)).status).toBe(200);
  });

  it("leaves password authentication unchanged when OIDC is not configured", async () => {
    for (const key of Object.keys(process.env)) if (key.startsWith("PAPERCLIP_AUTH_OIDC_")) delete process.env[key];
    const api = app();
    expect((await request(api).get("/api/auth/oidc/provider")).body).toEqual({ provider: null });
    expect((await passwordSignup(api)).status).toBe(200);
  });
});
