/**
 * Guard for the board inbox (APP-527): counts board items that should already
 * have closed or gone back to an agent because everything they link to has
 * resolved.
 *
 * A "resolved stale board item" is an issue that
 * - is assigned to a user (`assignee_user_id` set), not hidden, and open
 *   (status not `done`/`cancelled`),
 * - has not been updated for more than `staleAfterDays` days,
 * - has at least one link, and every link is resolved:
 *   - a `pull_request` work product is resolved when its status is `merged`,
 *     `closed` or `archived`;
 *   - a mention of an external `pull_request` object is resolved when the
 *     object is terminal (a mention not yet resolved to an object counts as
 *     unresolved);
 *   - a `blocks` relation pointing at the issue is resolved when the blocker is
 *     `done` or `cancelled`.
 *
 * One query covers every company. It reads only open issues (the open-issue
 * partial indexes and `issues_company_status_idx`), then probes each link
 * table by its `(company_id, issue)` index for the stale user-assigned ones, so
 * its cost follows the number of open issues, not the size of the issue
 * table. Measured on 100,000 issues (5,000 open, 3,333 candidates, 40,000 PR
 * work products): 34 ms, all buffer hits. The server caches the result for a
 * scrape interval (`cachedLoader`).
 */
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

export const DEFAULT_STALE_BOARD_ITEM_DAYS = 3;
export const DEFAULT_BOARD_ITEM_METRICS_CACHE_MS = 60_000;

const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
const RESOLVED_PULL_REQUEST_WORK_PRODUCT_STATUSES = ["merged", "closed", "archived"] as const;

export interface ResolvedStaleBoardItemCount {
  companyId: string;
  issuePrefix: string;
  count: number;
}

export function staleBoardItemDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCLIP_METRICS_STALE_BOARD_ITEM_DAYS?.trim();
  if (!raw) return DEFAULT_STALE_BOARD_ITEM_DAYS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`PAPERCLIP_METRICS_STALE_BOARD_ITEM_DAYS must be a positive number of days, got "${raw}"`);
  }
  return days;
}

function sqlTextList(values: readonly string[]) {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

/**
 * Counts resolved stale board items per company. Every company that is not
 * archived gets a row, with `count: 0` when it has none, so an alert sees a
 * series rather than an absence.
 */
export async function countResolvedStaleBoardItems(
  db: Db,
  input: { staleAfterDays: number; now?: Date },
): Promise<ResolvedStaleBoardItemCount[]> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - input.staleAfterDays * 86_400_000);
  const rows = await db.execute<{ company_id: string; issue_prefix: string; count: number }>(sql`
    with candidates as (
      select i.id, i.company_id
      from issues i
      where i.assignee_user_id is not null
        and i.status in (${sqlTextList(OPEN_ISSUE_STATUSES)})
        and i.hidden_at is null
        and i.updated_at < ${cutoff.toISOString()}::timestamptz
    ),
    links as (
      select wp.issue_id, wp.status in (${sqlTextList(RESOLVED_PULL_REQUEST_WORK_PRODUCT_STATUSES)}) as resolved
      from candidates c
      join issue_work_products wp
        on wp.company_id = c.company_id and wp.issue_id = c.id and wp.type = 'pull_request'
      union all
      select m.source_issue_id, coalesce(eo.is_terminal, false)
      from candidates c
      join external_object_mentions m
        on m.company_id = c.company_id and m.source_issue_id = c.id
      left join external_objects eo on eo.id = m.object_id
      where coalesce(eo.object_type, m.object_type) = 'pull_request'
      union all
      select r.related_issue_id, b.status in ('done', 'cancelled')
      from candidates c
      join issue_relations r
        on r.company_id = c.company_id and r.related_issue_id = c.id and r.type = 'blocks'
      join issues b on b.id = r.issue_id
    ),
    resolved_items as (
      select issue_id from links group by issue_id having bool_and(resolved)
    )
    select co.id as company_id, co.issue_prefix, count(c.id)::int as count
    from companies co
    left join candidates c
      on c.company_id = co.id and c.id in (select issue_id from resolved_items)
    where co.status <> 'archived'
    group by co.id, co.issue_prefix
    order by co.issue_prefix
  `);
  return Array.from(rows, (row) => ({
    companyId: row.company_id,
    issuePrefix: row.issue_prefix,
    count: Number(row.count),
  }));
}

/**
 * Wraps `load` so that scrapes within `ttlMs` share one result and concurrent
 * scrapes share one in-flight query. A failed load is not cached.
 */
export function cachedLoader<T>(
  load: () => Promise<T>,
  options: { ttlMs: number; now?: () => number },
): () => Promise<T> {
  const now = options.now ?? Date.now;
  let cached: { value: T; at: number } | null = null;
  let inFlight: Promise<T> | null = null;
  return () => {
    if (cached && now() - cached.at < options.ttlMs) return Promise.resolve(cached.value);
    if (inFlight) return inFlight;
    inFlight = load().then(
      (value) => {
        cached = { value, at: now() };
        inFlight = null;
        return value;
      },
      (error: unknown) => {
        inFlight = null;
        throw error;
      },
    );
    return inFlight;
  };
}
