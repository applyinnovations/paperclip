import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const issueExecutionDecisions = pgTable(
  "issue_execution_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    stageId: uuid("stage_id").notNull(),
    stageType: text("stage_type").notNull(),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id),
    actorUserId: text("actor_user_id"),
    outcome: text("outcome").notNull(),
    body: text("body").notNull(),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    /**
     * Reviewed-SHA attestation: a commit the decision's own actor named after
     * the decision was recorded, because the body had no valid
     * `Reviewed-SHA:` line. Set at most once; `body` is never rewritten.
     */
    reviewedShaAttested: text("reviewed_sha_attested"),
    reviewedShaAttestedAt: timestamp("reviewed_sha_attested_at", { withTimezone: true }),
    reviewedShaAttestedByAgentId: uuid("reviewed_sha_attested_by_agent_id").references(() => agents.id),
    reviewedShaAttestedByUserId: text("reviewed_sha_attested_by_user_id"),
    reviewedShaAttestedByRunId: uuid("reviewed_sha_attested_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    reviewedShaAttestationComment: text("reviewed_sha_attestation_comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("issue_execution_decisions_company_issue_idx").on(table.companyId, table.issueId),
    stageIdx: index("issue_execution_decisions_stage_idx").on(table.issueId, table.stageId, table.createdAt),
  }),
);
