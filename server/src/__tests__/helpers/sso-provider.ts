import express from "express";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export async function startOidcProvider() {
  const key = await generateKeyPair("RS256");
  const wrongKey = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(key.publicKey), kid: "test-signing-key", alg: "RS256", use: "sig" };
  const codes = new Map<string, URLSearchParams>();
  const state = {
    accessToken: "test-access-token", algorithm: "RS256" as "RS256" | "HS256", kid: "test-signing-key",
    email: "person@example.test", sub: "person-subject", emailVerified: true,
    claims: {} as Record<string, unknown>, wrongSignature: false, missingToken: false,
    discoveryIssuer: undefined as string | undefined, outage: false, tokenRequests: 0,
    discoveryRequests: 0, stallDiscovery: false, endpointQuery: false, authMethod: "client_secret_basic", lastAuthorization: null as URLSearchParams | null,
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  let issuer = "";
  app.get("/.well-known/openid-configuration", (_req, res) => {
    state.discoveryRequests++;
    if (state.stallDiscovery) return;
    if (state.outage) { res.sendStatus(503); return; }
    const query = state.endpointQuery ? "?tenant=example" : "";
    res.json({ issuer: state.discoveryIssuer ?? issuer, authorization_endpoint: `${issuer}/authorize${query}`,
      token_endpoint: `${issuer}/token${query}`, jwks_uri: `${issuer}/jwks${query}`,
      id_token_signing_alg_values_supported: ["RS256"], response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: [state.authMethod] });
  });
  app.get("/jwks", (_req, res) => res.json({ keys: [jwk] }));
  app.get("/authorize", (req, res) => {
    const params = new URL(req.originalUrl, issuer).searchParams;
    state.lastAuthorization = params;
    if (params.get("client_id") !== "test-client" || params.get("response_type") !== "code" ||
      !params.get("state")) {
      res.sendStatus(400); return;
    }
    const code = randomUUID();
    codes.set(code, params);
    const target = new URL(params.get("redirect_uri")!);
    target.searchParams.set("code", code);
    target.searchParams.set("state", params.get("state")!);
    res.redirect(target.href);
  });
  app.post("/token", async (req, res) => {
    state.tokenRequests++;
    if (state.endpointQuery && req.query.tenant !== "example") { res.sendStatus(400); return; }
    const params = codes.get(req.body.code);
    codes.delete(req.body.code);
    const authenticated = state.authMethod === "client_secret_basic"
      ? req.headers.authorization === `Basic ${Buffer.from("test-client:test-client-secret").toString("base64")}`
      : req.body.client_id === "test-client" && req.body.client_secret === "test-client-secret";
    if (!params || !authenticated ||
      req.body.redirect_uri !== params.get("redirect_uri") || req.body.grant_type !== "authorization_code" ||
      (params.has("code_challenge") && createHash("sha256").update(req.body.code_verifier ?? "").digest("base64url") !== params.get("code_challenge"))) {
      res.status(400).json({ error: "invalid_grant" }); return;
    }
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ iss: issuer, sub: state.sub, aud: "test-client", iat: now, exp: now + 300,
      nonce: params.get("nonce"), email: state.email, email_verified: state.emailVerified, name: "OIDC Person", ...state.claims })
      .setProtectedHeader({ alg: state.algorithm, kid: state.kid }).sign(state.algorithm === "HS256" ? new TextEncoder().encode("synthetic-hmac-key-for-rejection-only") : state.wrongSignature ? wrongKey.privateKey : key.privateKey);
    res.json({ access_token: state.accessToken, token_type: "Bearer", expires_in: 300,
      ...(state.missingToken ? {} : { id_token: token }) });
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { issuer, state, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
