ALTER TABLE "issue_execution_decisions" ADD COLUMN "reviewed_sha_attested" text;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "reviewed_sha_attested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "reviewed_sha_attested_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "reviewed_sha_attested_by_user_id" text;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "reviewed_sha_attested_by_run_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD COLUMN "reviewed_sha_attestation_comment" text;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_reviewed_sha_attested_by_agent_id_agents_id_fk" FOREIGN KEY ("reviewed_sha_attested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_execution_decisions" ADD CONSTRAINT "issue_execution_decisions_reviewed_sha_attested_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("reviewed_sha_attested_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;