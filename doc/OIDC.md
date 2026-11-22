# OpenID Connect sign-in

Self-hosted instances can configure one optional OIDC provider in authenticated
mode. Password sign-in and existing company authorization remain available,
unless you turn on [OIDC-only sign-in](#oidc-only-sign-in).

## Configuration

Register a confidential client with Authorization Code flow and S256 PKCE.
Use the exact redirect URI `https://paperclip.example.com/api/auth/callback/oidc`;
replace `oidc` if you change the provider ID. Do not allow wildcard redirects,
implicit grants or password grants. The provider must publish discovery and
JWKS and issue signed ID tokens with `sub`, `email`, boolean
`email_verified: true`, `iat`, `exp`, the client audience and request nonce.
For Keycloak, use the realm issuer and the standard `profile` and `email` scopes.

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated
PAPERCLIP_AUTH_BASE_URL_MODE=explicit
PAPERCLIP_AUTH_PUBLIC_BASE_URL=https://paperclip.example.com
PAPERCLIP_AUTH_OIDC_ISSUER=https://identity.example.com/realms/team
PAPERCLIP_AUTH_OIDC_CLIENT_ID=paperclip
PAPERCLIP_AUTH_OIDC_CLIENT_SECRET_FILE=/run/secrets/paperclip-oidc-client-secret
```

Mount a secret file readable by the server user, or inject
`PAPERCLIP_AUTH_OIDC_CLIENT_SECRET`. Set exactly one secret variable. Never
commit its value. Optional settings:

| Variable | Default |
| --- | --- |
| `PAPERCLIP_AUTH_OIDC_PROVIDER_ID` | `oidc` |
| `PAPERCLIP_AUTH_OIDC_DISPLAY_NAME` | `OpenID Connect` |
| `PAPERCLIP_AUTH_OIDC_TOKEN_ENDPOINT_AUTH_METHOD` | `client_secret_basic`; also accepts `client_secret_post` |

The public base URL must be an origin without a path. HTTPS is required except
for loopback development. Paperclip requests `openid profile email` and matches
the issuer exactly. Keep the issuer, provider ID and client registration stable.
Client requests cannot add scopes or authorization parameters. This provider is
for sign-in only: Better Auth's provider-token retrieval, refresh and account-info
APIs are unavailable while OIDC is configured, including for preexisting account
rows. Better Auth still stores provider tokens; protect the database and its
backups. Restrict the IdP client registration to the identity scopes above.

Restart after configuration changes. Invalid local settings refuse startup.
Provider discovery has a five-second timeout; failure hides the provider button
and preserves password sign-in. Restore the provider and restart to retry.
`GET /api/auth/oidc/provider` returns only the available provider ID and label.
Authentication warnings omit provider request details; use the provider audit
log for diagnosis.

## OIDC-only sign-in

Set `PAPERCLIP_AUTH_DISABLE_PASSWORD_LOGIN=true` to make OIDC the only way to
sign in. The default is `false`, which keeps password sign-in. The value must be
`true` or `false`; any other value refuses startup.

When the flag is on:

- The server refuses every email and password endpoint with `403`:
  `/api/auth/sign-in/email` and every other `/api/auth/sign-in/*` path except
  `/sign-in/social`, `/sign-up/*`, `/request-password-reset`,
  `/reset-password` (including `/reset-password/:token`), `/change-password`,
  `/verify-password`, `/set-password` and `/forget-password`. Better Auth's
  `emailAndPassword` option is also off.
- `/sign-in/social` accepts only the configured provider ID.
- `/link-social` (password-confirmed linking) and `/unlink-account` are refused.
  Link accounts before you turn the flag on.
- Stored password hashes stay in the database but are never checked. Nothing is
  deleted.
- `GET /api/health` returns `passwordLoginDisabled: true`. The UI then hides the
  email and password forms, account creation and the Profile linking panel.
- Existing sessions stay valid until they expire or you revoke them, including
  sessions that started with a password before you turned the flag on.
- Board API keys, agent keys and CLI sign-in (`paperclipai auth login`, which a
  signed-in board session approves in the browser) keep working.

Startup fails closed. Paperclip refuses to start when the flag is on and:

- the deployment mode is not `authenticated`;
- the OIDC variables are missing or invalid; or
- provider discovery fails. In this mode, a provider outage at startup stops the
  server instead of leaving it with no sign-in method. Your process supervisor
  restarts it; it starts when the provider is reachable again.

Before you turn the flag on, confirm that each administrator has linked an OIDC
identity (Settings → Profile → Single sign-on) and can sign in with it. An
account without a linked OIDC identity cannot sign in. To recover, set the flag
to `false` and restart. Then sign in with the password and link the account.

`PAPERCLIP_AUTH_DISABLE_SIGN_UP` still controls whether a new OIDC identity can
create an account. New invitees can join only through OIDC.

## Accounts and recovery

Existing users must sign in with their local password, open Settings → Profile
→ Single sign-on, enter that password and select **Link**, then authenticate
with the same verified email at the provider. Linking expires after five minutes
and requires the same live Paperclip session. Email matching alone never links
accounts or transfers access. Password confirmation uses Better Auth's strict
three-attempt, ten-second per-IP/path policy when authentication rate limiting is
enabled, matching password sign-in. The existing explicit rate-limit override
still applies; this does not introduce a shared per-account lockout.

`PAPERCLIP_AUTH_DISABLE_SIGN_UP` also applies to OIDC, including invitees.
When signup is enabled, a new verified identity can create an account but gains
no company membership or administrator role. Invitations and the first-admin
claim remain separate. Provider roles, groups and email domains grant no access.
For closed signup, provision initial password accounts through an isolated
maintenance path, complete the first-admin claim, then close signup before
public exposure. There is no invite-only signup exception.

Keep a tested local administrator password and existing database/authentication
secret backups. Sign-out revokes the local Paperclip session only. It does not
end the provider session. Provider offboarding does not immediately revoke
Paperclip sessions; revoke those separately. This integration does not add
RP-initiated or back-channel logout, SAML, SCIM, role mapping, multiple providers
or runtime provider administration. Verify your provider and reverse proxy
before production use.
