import { sql } from "drizzle-orm";
import { bigserial, boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * One observed transition of a GitHub ref (`before` -> `after`) in a company: reported by a
 * run's managed `git push`, evidenced by a host-verified GitHub `push` delivery, or both.
 * Whether it is attributed is derived from its attempts at read time, so evidence and
 * attempts may arrive in either order. Rows hold identifiers, SHAs and times only.
 *
 * Run and agent ids are deliberately not foreign keys: pruning a run must never erase the
 * record that it pushed.
 */
export const githubRefUpdates = pgTable(
  "github_ref_updates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Read order for keyset pagination. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** Canonical lower-case `owner/name` on github.com. */
    repository: text("repository").notNull(),
    ref: text("ref").notNull(),
    beforeSha: text("before_sha").notNull(),
    afterSha: text("after_sha").notNull(),
    /** GitHub's evidence. Null until a verified `push` delivery for this transition arrives. */
    evidenceReceivedAt: timestamp("evidence_received_at", { withTimezone: true }),
    evidenceDeliveryId: text("evidence_delivery_id"),
    evidenceForced: boolean("evidence_forced"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    transitionUq: uniqueIndex("github_ref_updates_transition_uq").on(
      table.companyId,
      table.repository,
      table.ref,
      table.beforeSha,
      table.afterSha,
    ),
    readIdx: index("github_ref_updates_read_idx").on(table.companyId, table.repository, table.ref, table.seq),
  }),
);

/** A run's report that its managed `git push` sent one ref update. One row per update and run. */
export const githubPushAttempts = pgTable(
  "github_push_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    refUpdateId: uuid("ref_update_id").notNull().references(() => githubRefUpdates.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    /** The run's originating issue, from the server-side run record. */
    issueId: uuid("issue_id"),
    /** `succeeded` (remote reported ok), `failed` (remote reported ng) or `unknown` (no report). */
    outcome: text("outcome").notNull(),
    /** The command line asked for a force update. Supporting detail only. */
    forceRequested: boolean("force_requested").notNull().default(false),
    exitCode: integer("exit_code"),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    updateRunUq: uniqueIndex("github_push_attempts_update_run_uq").on(table.refUpdateId, table.runId),
    runIdx: index("github_push_attempts_run_idx").on(table.companyId, table.runId),
    outcomeCheck: check("github_push_attempts_outcome_check", sql`${table.outcome} in ('succeeded', 'failed', 'unknown')`),
  }),
);
