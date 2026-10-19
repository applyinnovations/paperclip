# OpenID Connect sign-in

Self-hosted instances can configure one optional OIDC provider in authenticated
mode. Password sign-in and existing company authorization remain available.

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

Restart after configuration changes. Invalid local settings refuse startup.
Provider discovery has a five-second timeout; failure hides the provider button
and preserves password sign-in. Restore the provider and restart to retry.
`GET /api/auth/oidc/provider` returns only the available provider ID and label.
Authentication warnings omit provider request details; use the provider audit
log for diagnosis.

## Accounts and recovery

Existing users must sign in with their local password, open Settings → Profile
→ Single sign-on, enter that password and select **Link**, then authenticate
with the same verified email at the provider. Linking expires after five minutes
and requires the same live Paperclip session. Email matching alone never links
accounts or transfers access.

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
