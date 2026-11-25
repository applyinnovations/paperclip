CREATE TABLE "github_push_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"ref_update_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"outcome" text NOT NULL,
	"force_requested" boolean DEFAULT false NOT NULL,
	"exit_code" integer,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_push_attempts_outcome_check" CHECK ("github_push_attempts"."outcome" in ('succeeded', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "github_ref_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"company_id" uuid NOT NULL,
	"repository" text NOT NULL,
	"ref" text NOT NULL,
	"before_sha" text NOT NULL,
	"after_sha" text NOT NULL,
	"evidence_received_at" timestamp with time zone,
	"evidence_delivery_id" text,
	"evidence_forced" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_push_attempts" ADD CONSTRAINT "github_push_attempts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_push_attempts" ADD CONSTRAINT "github_push_attempts_ref_update_id_github_ref_updates_id_fk" FOREIGN KEY ("ref_update_id") REFERENCES "public"."github_ref_updates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_ref_updates" ADD CONSTRAINT "github_ref_updates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_push_attempts_update_run_uq" ON "github_push_attempts" USING btree ("ref_update_id","run_id");--> statement-breakpoint
CREATE INDEX "github_push_attempts_run_idx" ON "github_push_attempts" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_ref_updates_transition_uq" ON "github_ref_updates" USING btree ("company_id","repository","ref","before_sha","after_sha");--> statement-breakpoint
CREATE INDEX "github_ref_updates_read_idx" ON "github_ref_updates" USING btree ("company_id","repository","ref","seq");