# OpenID Connect sign-in

Self-hosted instances can configure one OpenID Connect provider. This is an
optional sign-in method for people in `authenticated` mode. Password sign-in,
agent bearer authentication, company access checks and managed workspace
handoffs remain available. No database migration is required.

## Configure a provider

Register a confidential client at your identity provider. Enable Authorization
Code flow and S256 PKCE. Register this exact redirect URI:

```text
https://paperclip.example.com/api/auth/callback/oidc
```

Replace `oidc` with `PAPERCLIP_AUTH_OIDC_PROVIDER_ID` if you set a different ID.
Use a dedicated client. Do not allow wildcard redirect URIs. Disable implicit
and password grants for this client. The provider must publish OIDC discovery
and JWKS documents. Its signed ID token must contain `sub`, `email`, boolean
`email_verified: true`, `iat`, `exp`, the client audience and the request nonce.
For Keycloak, use the realm issuer and the standard `profile` and `email` client
scopes. Ensure the email is verified at the provider.

Set these server variables, then restart Paperclip:

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_AUTH_BASE_URL_MODE=explicit
PAPERCLIP_AUTH_PUBLIC_BASE_URL=https://paperclip.example.com
PAPERCLIP_AUTH_OIDC_ISSUER=https://identity.example.com/realms/team
PAPERCLIP_AUTH_OIDC_CLIENT_ID=paperclip
PAPERCLIP_AUTH_OIDC_CLIENT_SECRET_FILE=/run/secrets/paperclip-oidc-client-secret
```

Mount an existing secret file readable by the server user. Alternatively, set
`PAPERCLIP_AUTH_OIDC_CLIENT_SECRET` through your secret manager. Set exactly one
of the secret variables. Do not commit secrets in config files or images.

Optional variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PAPERCLIP_AUTH_OIDC_PROVIDER_ID` | `oidc` | Stable lowercase provider identifier. |
| `PAPERCLIP_AUTH_OIDC_DISPLAY_NAME` | `OpenID Connect` | Label on the sign-in button. |
| `PAPERCLIP_AUTH_OIDC_TOKEN_ENDPOINT_AUTH_METHOD` | `client_secret_basic` | Set `client_secret_post` if required by the provider. |

Paperclip requests `openid profile email`. It derives discovery from the issuer
and requires an exact issuer match. HTTPS is required except for loopback local
development. Signing algorithms are restricted to supported asymmetric
algorithms. Access-token claims and the userinfo endpoint do not establish the
user's identity. The client cannot submit an ID token directly to bypass the
authorization code flow.

Discovery has a five-second request budget. An unavailable or invalid provider
leaves password sign-in available and hides the provider button. Restore the
provider and restart Paperclip to retry discovery. Config changes also require a
restart. Invalid or partial local configuration refuses startup with a generic
error that excludes secret values. `GET /api/auth/oidc/provider` exposes only the
available provider's ID and label. Authentication warnings omit request details
and token payloads; use the identity provider's audit log for detailed failures.

## Accounts and admission

Paperclip identifies the external account by its exact issuer and immutable
subject. Keep the issuer, provider ID and client registration stable. Changing
the issuer establishes a new identity namespace. Reusing an email does not
transfer access from the old account.

An external identity with the same email as an existing local account cannot
sign in until the user links it explicitly:

1. Sign in with the existing Paperclip password.
2. Open Settings → Profile → Single sign-on.
3. Enter the current Paperclip password and select **Link**.
4. Authenticate at the provider with the same email.

The linking intent expires after five minutes. It requires the same active
Paperclip session on callback. Revoking that session invalidates the intent.
The provider must report a verified email. A subject already attached to another
user cannot be transferred. Passwords are removed from the linking payload
before it is stored in OAuth state. The existing account remains usable through
password sign-in.

`PAPERCLIP_AUTH_DISABLE_SIGN_UP` applies to OIDC too. When signup is enabled, a
new verified identity can create a Paperclip account. This alone grants no
company membership or instance-admin role. Company invitation acceptance and
first-admin bootstrap remain separate operations. Provider roles, email domains
and group claims never grant Paperclip permissions.

When signup is disabled, new OIDC accounts are refused, including users who
return to an invitation URL. Existing linked users can still sign in and accept
valid invitations. This change does not add an invite-only signup exception.
Provision initial password accounts through a controlled setup process before
closing signup. Do not expose a fresh instance with unrestricted signup to
bootstrap an administrator. Use an isolated maintenance path, complete the
existing first-admin claim, close signup, then expose the instance.

## Recovery and session limits

Keep at least one tested local administrator password. OIDC cannot disable
password authentication. Before enabling OIDC, verify password sign-in in a
separate browser session and retain the existing database and authentication
secret backup procedures. A provider outage does not remove local accounts.

Sign-out revokes the local Paperclip session and clears its cookies. It does not
sign out of the identity provider. Signing in again may reuse the provider's
session. Provider account disablement does not revoke an existing Paperclip
session. Operators must also revoke local sessions when offboarding users.
RP-initiated logout, back-channel logout, SCIM, SAML, role mapping, multiple
providers and runtime provider administration are outside this change.

## Verification

The integration suite runs the real Better Auth handler, Drizzle schema and
migrated disposable PostgreSQL against a loopback provider. The provider signs
RS256 ID tokens, exposes JWKS, enforces PKCE and consumes authorization codes.
No live provider credentials are needed.

```sh
pnpm --filter @paperclipai/server exec vitest run src/__tests__/oidc-config.test.ts src/__tests__/oidc.integration.test.ts
pnpm --filter @paperclipai/ui exec vitest run src/components/OidcSignIn.test.tsx src/pages/Auth.test.tsx src/pages/InviteLanding.test.tsx src/pages/ProfileSettings.test.tsx
```

Coverage includes invalid signatures, issuer, audience, lifetime, nonce, state
and callback replay; explicit linking, password recovery, closed signup,
invitations, bootstrap and company isolation; discovery failures and local
logout. A real provider's login screens, MFA and reverse proxy configuration
still need deployment-specific acceptance tests.

The implementation uses the existing MIT-licensed Better Auth 1.7.2 Generic
OAuth plugin for code exchange, S256 PKCE, state and nonce verification. It
uses MIT-licensed JOSE 6.2.10 for the discovery JWKS resolver and parsing the
ID token after Better Auth verifies it. It does not use a paid SSO service.
