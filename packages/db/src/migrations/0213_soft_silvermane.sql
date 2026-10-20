-- Better Auth 1.7 added a required "issuer" field to its `account` model: the
-- account namespace that pairs with "account_id" as the stable provider-side
-- key. Sign-up writes it, sign-in matches on it, and the Drizzle adapter
-- rejects the whole table when the column is missing.
--
-- The column has to land NOT NULL, but an upgraded deployment already has
-- rows, so backfill every one of them before the constraint goes on. The
-- values mirror Better Auth's own issuer helpers: `local:credential` for
-- email/password accounts (createLocalAccountIssuer) and
-- `local:oauth:<provider_id>` for social accounts that do not declare an
-- issuer of their own (createOAuthAccountIssuer). Existing social rows retain their legacy provider namespace. This migration
-- does not infer an external issuer or merge identities; existing SSO owners
-- must explicitly link after verifying the configured provider identity.
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" text;--> statement-breakpoint
UPDATE "account"
SET "issuer" = CASE
  WHEN "provider_id" = 'credential' THEN 'local:credential'
  ELSE 'local:oauth:' || "provider_id"
END
WHERE "issuer" IS NULL;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "account_issuer_account_id_uq" ON "account" USING btree ("issuer","account_id");
