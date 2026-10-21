-- Read-only inventory for the SSO issuer upgrade. Run on an isolated restore:
-- PGOPTIONS='-c default_transaction_read_only=on' psql "$DATABASE_URL" -X \
--   --set ON_ERROR_STOP=on --file scripts/sso-upgrade-preflight.sql
-- Deliberately uses only pre-0213 columns. No credential material is selected.
SELECT u.id AS user_id, u.email,
  EXISTS (
    SELECT 1 FROM instance_user_roles r
    WHERE r.user_id = u.id AND r.role = 'instance_admin'
  ) AS instance_admin,
  EXISTS (
    SELECT 1 FROM company_memberships m
    WHERE m.principal_type = 'user' AND m.principal_id = u.id
      AND m.status = 'active' AND m.membership_role IN ('owner', 'admin')
  ) AS company_admin,
  EXISTS (
    SELECT 1 FROM account c
    WHERE c.user_id = u.id AND c.provider_id = 'credential'
      AND c.password IS NOT NULL AND c.password <> ''
  ) AS local_password,
  EXISTS (
    SELECT 1 FROM account d
    GROUP BY d.provider_id, d.account_id
    HAVING count(*) > 1 AND bool_or(d.user_id = u.id)
  ) AS duplicate_account_key,
  array_agg(DISTINCT a.provider_id ORDER BY a.provider_id) AS social_providers
FROM "user" u
JOIN account a ON a.user_id = u.id AND a.provider_id <> 'credential'
GROUP BY u.id, u.email
ORDER BY instance_admin DESC, company_admin DESC, u.id;
