import { and, asc, eq, gt, inArray, isNotNull, ne, or, sql, exists } from "drizzle-orm";
import { isUuidLike } from "@paperclipai/shared";
import { githubPushAttempts, githubRefUpdates, heartbeatRuns, type Db } from "@paperclipai/db";
import type {
  PluginBranchUpdate,
  PluginBranchUpdatePage,
  PluginBranchUpdatePusher,
  PluginPushEvidenceResult,
} from "@paperclipai/plugin-sdk";
import { forbidden, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import type { GitHubAppWebhookVerification } from "./github-app-webhooks.js";

/**
 * Push provenance: which authenticated run updated a GitHub ref.
 *
 * A run's managed `git` launcher reports the ref updates its push sent (an *attempt*). The
 * host records GitHub's own verified `push` delivery for the same transition (*evidence*).
 * An update is `confirmed` only when evidence matches exactly one run's non-failed attempt.
 * State is derived on every read, so evidence and attempts may arrive in any order and any
 * number of times. Identity always comes from server-side run authentication.
 */

export const MAX_PUSH_ATTEMPT_UPDATES = 100;
export const DEFAULT_BRANCH_UPDATE_PAGE = 100;
export const MAX_BRANCH_UPDATE_PAGE = 200;

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OWNER_REPO = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;

/** `owner/name`, a github.com URL, or an SSH remote, reduced to lower-case `owner/name`. */
export function canonicalGitHubRepository(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let value = input.trim();
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/](.+)$/i.exec(value);
  if (ssh) value = ssh[1]!;
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { return null; }
    if (url.hostname.toLowerCase() !== "github.com" && url.hostname.toLowerCase() !== "www.github.com") return null;
    value = url.pathname;
  }
  value = value.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  return OWNER_REPO.test(value) && !value.endsWith("/.") && !value.endsWith("/..") ? value : null;
}

/** A full ref name; a bare branch name becomes `refs/heads/<name>`. */
export function canonicalGitRef(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (!value || value.length > 1024 || /[\s\0\\~^:?*[]|\.\.|@\{|\/\/|\/$|\.lock$/.test(value)) return null;
  return value.startsWith("refs/") ? value : `refs/heads/${value}`;
}

function canonicalSha(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  return SHA.test(value) ? value : null;
}

export type PushAttemptOutcome = "succeeded" | "failed" | "unknown";

export type PushAttemptReport = {
  repository: string;
  exitCode: number | null;
  forced: boolean;
  updates: Array<{ ref: string; before: string; after: string; result: "ok" | "ng" | "unknown" }>;
};

/** Validate a launcher report. Never echoes values into errors. */
export function parsePushAttemptReport(body: unknown): PushAttemptReport {
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const repository = canonicalGitHubRepository(input.repository);
  if (!repository) throw unprocessable("repository must be a github.com owner/name");
  if (!Array.isArray(input.updates) || input.updates.length === 0) throw unprocessable("updates must be a non-empty array");
  if (input.updates.length > MAX_PUSH_ATTEMPT_UPDATES) {
    throw unprocessable(`updates is limited to ${MAX_PUSH_ATTEMPT_UPDATES} per report; send several reports`);
  }
  const updates = input.updates.map((raw, index) => {
    const update = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const ref = typeof update.ref === "string" && update.ref.startsWith("refs/") ? canonicalGitRef(update.ref) : null;
    const before = canonicalSha(update.before);
    const after = canonicalSha(update.after);
    const result: "ok" | "ng" | "unknown" | null =
      update.result === "ok" || update.result === "ng" || update.result === "unknown" ? update.result : null;
    if (!ref || !before || !after || !result || before === after || before.length !== after.length) {
      throw unprocessable(`updates[${index}] needs a full ref, distinct full before/after SHAs and a result`);
    }
    return { ref, before, after, result };
  });
  const exitCode = typeof input.exitCode === "number" && Number.isInteger(input.exitCode) ? input.exitCode : null;
  return { repository, exitCode, forced: input.forced === true, updates };
}

const OUTCOME_RANK = sql`case ${githubPushAttempts.outcome} when 'succeeded' then 2 when 'unknown' then 1 else 0 end`;

async function upsertRefUpdate(
  db: Pick<Db, "insert">,
  values: { companyId: string; repository: string; ref: string; beforeSha: string; afterSha: string },
) {
  const [row] = await db
    .insert(githubRefUpdates)
    .values(values)
    .onConflictDoUpdate({
      target: [
        githubRefUpdates.companyId,
        githubRefUpdates.repository,
        githubRefUpdates.ref,
        githubRefUpdates.beforeSha,
        githubRefUpdates.afterSha,
      ],
      // A no-op assignment so the existing row is returned.
      set: { repository: sql`excluded.repository` },
    })
    .returning({ id: githubRefUpdates.id });
  return row!.id;
}

/**
 * Record the ref updates a run's managed push sent. `run` comes only from verified run
 * authentication; the run must still be running, and its issue is read from the run row.
 */
export async function recordPushAttempts(
  db: Db,
  run: { companyId: string; agentId: string; runId: string },
  body: unknown,
) {
  const report = parsePushAttemptReport(body);
  const [row] = await db
    .select({
      status: heartbeatRuns.status,
      issueId: heartbeatRuns.issueId,
      contextIssueId: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'issueId'`,
      contextTaskId: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'taskId'`,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, run.runId),
      eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.agentId, run.agentId),
    ));
  if (!row || row.status !== "running") throw forbidden("Push reports require this agent's active run");
  const issueId = [row.issueId, row.contextIssueId, row.contextTaskId]
    .find((value): value is string => typeof value === "string" && isUuidLike(value)) ?? null;

  const recorded: Array<{ ref: string; outcome: PushAttemptOutcome }> = [];
  await db.transaction(async (tx) => {
    for (const update of report.updates) {
      const refUpdateId = await upsertRefUpdate(tx, {
        companyId: run.companyId,
        repository: report.repository,
        ref: update.ref,
        beforeSha: update.before,
        afterSha: update.after,
      });
      const outcome: PushAttemptOutcome = update.result === "ok" ? "succeeded" : update.result === "ng" ? "failed" : "unknown";
      await tx
        .insert(githubPushAttempts)
        .values({
          companyId: run.companyId,
          refUpdateId,
          runId: run.runId,
          agentId: run.agentId,
          issueId,
          outcome,
          forceRequested: report.forced,
          exitCode: report.exitCode,
        })
        .onConflictDoUpdate({
          target: [githubPushAttempts.refUpdateId, githubPushAttempts.runId],
          // A retry keeps the strongest outcome: succeeded > unknown > failed.
          set: {
            outcome: sql`case when (case excluded.outcome when 'succeeded' then 2 when 'unknown' then 1 else 0 end) > ${OUTCOME_RANK}
              then excluded.outcome else ${githubPushAttempts.outcome} end`,
            forceRequested: sql`${githubPushAttempts.forceRequested} or excluded.force_requested`,
          },
        });
      recorded.push({ ref: update.ref, outcome });
    }
  });
  await logActivity(db, {
    companyId: run.companyId,
    actorType: "agent",
    actorId: run.agentId,
    agentId: run.agentId,
    runId: run.runId,
    issueId,
    action: "github.push_attempt.recorded",
    entityType: "github_repository",
    entityId: report.repository,
    details: {
      repository: report.repository,
      exitCode: report.exitCode,
      updates: report.updates.map((update) => ({
        ref: update.ref, before: update.before, after: update.after, result: update.result,
      })),
    },
  }).catch(() => undefined);
  return { recorded: recorded.length };
}

export type ParsedPushEvidence = {
  repository: string;
  ref: string;
  beforeSha: string;
  afterSha: string;
  forced: boolean;
};

export function parsePushEvidence(rawBody: string): ParsedPushEvidence | null {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const repositoryObject = payload.repository && typeof payload.repository === "object"
    ? payload.repository as Record<string, unknown>
    : {};
  const repository = canonicalGitHubRepository(repositoryObject.full_name);
  const ref = typeof payload.ref === "string" && payload.ref.startsWith("refs/") ? canonicalGitRef(payload.ref) : null;
  const beforeSha = canonicalSha(payload.before);
  const afterSha = canonicalSha(payload.after);
  if (!repository || !ref || !beforeSha || !afterSha || beforeSha === afterSha) return null;
  return { repository, ref, beforeSha, afterSha, forced: payload.forced === true };
}

/**
 * Record GitHub's evidence from a delivery the host has already verified. The company is the
 * verified App's company. Redelivery and repeated transitions are idempotent.
 */
export async function recordPushEvidence(
  db: Db,
  verification: Extract<GitHubAppWebhookVerification, { verified: true }>,
  rawBody: string,
  actor: { pluginId: string },
): Promise<PluginPushEvidenceResult> {
  if (verification.event !== "push") return { recorded: false, reason: "not_push_event" };
  const evidence = parsePushEvidence(rawBody);
  if (!evidence) return { recorded: false, reason: "invalid_payload" };
  const companyId = verification.companyId;
  const refUpdateId = await upsertRefUpdate(db, {
    companyId,
    repository: evidence.repository,
    ref: evidence.ref,
    beforeSha: evidence.beforeSha,
    afterSha: evidence.afterSha,
  });
  // Only the first delivery sets the evidence; later ones report a duplicate.
  const updated = await db
    .update(githubRefUpdates)
    .set({
      evidenceReceivedAt: new Date(),
      evidenceDeliveryId: verification.deliveryId,
      evidenceForced: evidence.forced,
    })
    .where(and(eq(githubRefUpdates.id, refUpdateId), sql`${githubRefUpdates.evidenceReceivedAt} is null`))
    .returning({ id: githubRefUpdates.id });
  const duplicate = updated.length === 0;
  if (!duplicate) {
    await logActivity(db, {
      companyId,
      actorType: "plugin",
      actorId: actor.pluginId,
      action: "github.push_evidence.recorded",
      entityType: "github_repository",
      entityId: evidence.repository,
      details: { ...evidence, deliveryId: verification.deliveryId },
    }).catch(() => undefined);
  }
  return { recorded: true, duplicate };
}

function encodeCursor(seq: number) {
  return Buffer.from(JSON.stringify({ v: 1, seq }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; seq?: unknown };
    if (value.v === 1 && typeof value.seq === "number" && Number.isSafeInteger(value.seq) && value.seq >= 0) return value.seq;
  } catch {
    // Fall through.
  }
  throw unprocessable("cursor is not a cursor returned by listBranchUpdates");
}

/**
 * Branch update provenance for one ref of one repository in `companyId`, oldest first.
 * Updates seen only through failed attempts are omitted: they never changed the ref.
 */
export async function listBranchUpdates(
  db: Db,
  companyId: string,
  input: { repository: string; ref: string; afterSha?: string | null; cursor?: string | null; limit?: number | null },
): Promise<PluginBranchUpdatePage> {
  const repository = canonicalGitHubRepository(input.repository);
  const ref = canonicalGitRef(input.ref);
  if (!repository) throw unprocessable("repository must be a github.com owner/name");
  if (!ref) throw unprocessable("ref must be a valid Git ref or branch name");
  const afterSha = input.afterSha === undefined || input.afterSha === null ? null : canonicalSha(input.afterSha);
  if (input.afterSha !== undefined && input.afterSha !== null && !afterSha) throw unprocessable("afterSha must be a full SHA");
  if (input.limit !== undefined && input.limit !== null &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_BRANCH_UPDATE_PAGE)) {
    throw unprocessable(`limit must be an integer from 1 to ${MAX_BRANCH_UPDATE_PAGE}`);
  }
  const limit = input.limit ?? DEFAULT_BRANCH_UPDATE_PAGE;
  const afterSeq = input.cursor ? decodeCursor(input.cursor) : null;

  const rows = await db
    .select()
    .from(githubRefUpdates)
    .where(and(
      eq(githubRefUpdates.companyId, companyId),
      eq(githubRefUpdates.repository, repository),
      eq(githubRefUpdates.ref, ref),
      afterSha ? eq(githubRefUpdates.afterSha, afterSha) : undefined,
      afterSeq !== null ? gt(githubRefUpdates.seq, afterSeq) : undefined,
      or(
        isNotNull(githubRefUpdates.evidenceReceivedAt),
        exists(db
          .select({ one: sql`1` })
          .from(githubPushAttempts)
          .where(and(
            eq(githubPushAttempts.refUpdateId, githubRefUpdates.id),
            ne(githubPushAttempts.outcome, "failed"),
          ))),
      ),
    ))
    .orderBy(asc(githubRefUpdates.seq))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const more = rows.length > limit;

  const attempts = page.length === 0 ? [] : await db
    .select()
    .from(githubPushAttempts)
    .where(and(
      eq(githubPushAttempts.companyId, companyId),
      inArray(githubPushAttempts.refUpdateId, page.map((row) => row.id)),
      ne(githubPushAttempts.outcome, "failed"),
    ))
    .orderBy(asc(githubPushAttempts.reportedAt), asc(githubPushAttempts.id));
  const pushersByUpdate = new Map<string, PluginBranchUpdatePusher[]>();
  for (const attempt of attempts) {
    const list = pushersByUpdate.get(attempt.refUpdateId) ?? [];
    list.push({
      agentId: attempt.agentId,
      runId: attempt.runId,
      issueId: attempt.issueId,
      outcome: attempt.outcome === "succeeded" ? "succeeded" : "unknown",
      reportedAt: attempt.reportedAt.toISOString(),
    });
    pushersByUpdate.set(attempt.refUpdateId, list);
  }

  const updates: PluginBranchUpdate[] = page.map((row) => {
    const pushers = pushersByUpdate.get(row.id) ?? [];
    const evidenced = row.evidenceReceivedAt !== null;
    const state = !evidenced ? "attempted"
      : pushers.length === 0 ? "unattributed"
      : pushers.length === 1 ? "confirmed"
      : "ambiguous";
    const confirmed = state === "confirmed" ? pushers[0]! : null;
    return {
      id: row.id,
      state,
      repository: row.repository,
      ref: row.ref,
      beforeSha: row.beforeSha,
      afterSha: row.afterSha,
      forced: row.evidenceForced,
      pushers,
      agentId: confirmed?.agentId ?? null,
      runId: confirmed?.runId ?? null,
      issueId: confirmed?.issueId ?? null,
      firstSeenAt: row.createdAt.toISOString(),
      githubReceivedAt: row.evidenceReceivedAt?.toISOString() ?? null,
    };
  });
  const last = page.at(-1);
  return {
    updates,
    nextCursor: more && last ? encodeCursor(last.seq) : null,
    complete: !more,
  };
}
