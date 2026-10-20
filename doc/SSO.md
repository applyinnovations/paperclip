# Native SSO / OIDC

This local convergence candidate retains PR #3040's instance settings UI/API,
multiple providers and operator configuration. It targets Better Auth 1.7.2.
It is not qualified for production until the recorded migration/build and live
Keycloak acceptance gates are complete.

## Configuration source

Use authenticated mode and an explicit public origin in `auth.publicBaseUrl`
(`auth.baseUrlMode: "explicit"`). HTTPS is required outside loopback development.
Register an exact callback for each stable provider ID:

```
https://paperclip.example.test/api/auth/callback/keycloak
```

Instance Settings → SSO selects one source:

- **Operator configuration:** `PAPERCLIP_SSO_PROVIDERS` JSON takes precedence over
  `auth.ssoProviders` in the config file. An explicit empty JSON array means no
  providers. Malformed environment JSON/provider entries fail startup instead of
  silently falling back. Mounting the ordinary config file works for cluster
  secrets; do not commit real client secrets to Git.
- **Instance settings:** the stored `enabled` flag and provider list are
  authoritative. Disabled or empty stays disabled across save and restart.
  Selecting Operator configuration explicitly returns to the environment/file.

For existing #3040 settings without a source field, enabled/nonempty database
settings remain authoritative; other legacy settings retain its documented
operator fallback. Malformed stored SSO settings disable SSO instead of
activating fallback. Saving in the new UI records the source explicitly.
Startup and live saves use the same resolver. Login buttons reflect providers
registered by the active auth manager after discovery, not a stale startup list.
A failed or stalled provider discovery is bounded and leaves local login usable.
Activating SSO without a valid explicit public origin is rejected before saving.
If an existing stored configuration is invalid, SSO stays unavailable and local
password login remains available for recovery.
Environment/file changes require a restart; database settings rebuild the handler.

## Provider configuration

Up to eight unique providers are supported. IDs use lowercase letters, numbers
and hyphens, start with a letter, and cannot be `credential`. Presets are
Keycloak, Auth0, Okta, Microsoft Entra ID and generic OIDC. A renamed preset uses
its configured ID in both login buttons and callbacks. Keep IDs/issuers/client
registrations stable after accounts have been linked.

Example operator configuration (synthetic values only):

```json
[
  {
    "providerId": "keycloak",
    "type": "keycloak",
    "issuer": "https://identity.example.test/realms/businesses",
    "clientId": "paperclip",
    "clientSecret": "REPLACE_USING_SECRET_CONFIGURATION",
    "displayName": "Company sign-in",
    "tokenEndpointAuth": "client_secret_post",
    "requiredRoles": { "claimPath": "realm_access.roles", "roles": ["paperclip-user"] }
  }
]
```

Keycloak/Okta use `issuer`; Auth0 uses `domain` or `issuer`; Entra requires a
concrete tenant GUID. Generic OIDC uses `discoveryUrl`; also supply `issuer` when
that location does not end in the standard `/.well-known/openid-configuration`.
Discovery must return the preset's canonical issuer (or the exact configured
generic OIDC issuer), code flow, usable asymmetric
signing algorithms and JWKS. Endpoints must use HTTPS, except loopback fixtures.
`tokenEndpointAuth` supports client_secret_post (default) and client_secret_basic.
Optional scopes are owned by the operator; openid is always included. Browsers
cannot add scopes, resource/audience/prompt or other authorization parameters.

Configure the IdP to emit `sub`, email, literal boolean `email_verified: true`,
issued-at and expiry in the ID token. Optional role admission reads only the
verified ID token, not an unverified access-token payload. Keycloak's role
mapper must include the chosen roles in ID tokens. Role admission grants no
Paperclip company membership or administrator role. The regular invitation and
join-request paths control company access.

## Existing users and recovery

Create and preserve a local administrator password before enabling/closing SSO
signup. Existing users sign in locally, open Profile, confirm the current local
password, then authenticate with an IdP identity using the same verified email.
Email equality alone never links accounts. Confirmation is bound to the same
live session and expires after five minutes. Changing/revoking that session or
replaying the callback cannot complete linking. Linking password attempts use
Better Auth's three-attempt/ten-second IP/path limit; this is not an account-wide
lockout and respects the existing explicit rate-limit disable override.

Closed signup also applies to SSO. An invitation does not bypass the instance's
signup policy. Local password login remains usable after linking and during IdP
outage. SSO-only users do not automatically acquire a local password.

Sessions are ordinary Paperclip sessions. Logout revokes the local session and
requires the configured origin. This does not add IdP single logout, SCIM,
back-channel logout or immediate offboarding. Disabling a provider/changing a
role affects subsequent authentication; existing sessions need explicit local
revocation. Provider token retrieval, refresh and account-info APIs are blocked,
including old rows after a provider is disabled. Provider tokens still reside in
the account table: protect database access and backups.

## Storage, identity and rollback

The SSO settings column is additive JSONB. In database mode, client secrets remain
in that JSONB and are editable only through the instance-admin SSO API. General
settings responses omit the secrets even for admins; ordinary members cannot use
the dedicated SSO endpoint. Audit details record provider count and changed keys,
not secret values. Application-level encryption of this JSONB is not added here.
Operator mode avoids copying operator secrets into database settings on startup.

Preserve the database, uploads/storage, local encrypted-secret master keys,
Better Auth session secret and operator/IdP configuration together. A database
backup alone does not cover file storage or encryption keys. Do not drop auth
rows, change user IDs, relabel issuers or regenerate keys as a rollback shortcut.

Current Better Auth account identity is `(issuer, subject)`; company permissions
remain attached to the same Paperclip user. Our qualified candidate's actual
issuer/subject rows are compatible. Older #3040 accounts upgraded through core
migration 0230 have `local:oauth:<providerId>` namespaces. Provider ID alone does
not prove the old issuer, so this candidate does not automatically relabel or
implicitly email-link those rows. Accounts with local credentials can explicitly
link while retaining user/company identity; legacy SSO-only accounts need a
separately reviewed, verified issuer mapping or recovery plan before adoption.
Renaming a provider or repointing its issuer is not an identity migration.

For an application rollback, retain the additive SSO column/configuration and
all auth rows, files and keys. An older application may ignore the extra column;
it must not be assumed compatible with newer account semantics. Restore a full
compatible backup into an isolated target when schema/auth versions require it.
Validate both restored data and local recovery before any real rollout.

## Local Keycloak acceptance

The inherited compose/realm/bootstrap recipe is a development fixture, not
production acceptance. The callback has been updated to the standard Better Auth
1.7 path. Do not run the bootstrap script against an existing/live instance.
Synthetic signed-provider tests exercise issuer/audience/signature/JWKS/algorithm,
nonce, PKCE, state/replay, admission, linking, token guards and local sessions.
They do not prove live Keycloak reverse-proxy/TLS/realm configuration, browser
cookies, upgrade of real accounts, backup restoration or execution isolation.
Before rollout, qualify those against an isolated Keycloak realm with synthetic
accounts. Agent execution and deployment remain separate, disabled workstreams.
