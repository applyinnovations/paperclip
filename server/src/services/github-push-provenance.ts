import { randomBytes } from "node:crypto";
import { and, asc, eq, exists, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { isUuidLike } from "@paperclipai/shared";
import { externalObjects, heartbeatRuns, type Db } from "@paperclipai/db";
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
 *
 * Records are stored in `external_objects` under a dedicated terminal provider key
 * (`github_push_provenance`, `isTerminal: true`, `nextRefreshAt: null`, no mentions, no FK
 * to `heartbeat_runs` or `agents`) so pruning a run never erases what it pushed and
 * background external-object refresh never touches them.
 */

export const PUSH_PROVENANCE_PROVIDER_KEY = "github_push_provenance";
export const PUSH_PROVENANCE_REF_UPDATE_TYPE = "github_ref_update";
export const PUSH_PROVENANCE_ATTEMPT_TYPE = "github_push_attempt";

export const MAX_PUSH_ATTEMPT_UPDATES = 100;
export const DEFAULT_BRANCH_UPDATE_PAGE = 100;
export const MAX_BRANCH_UPDATE_PAGE = 200;

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CURSOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER_REPO = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;

let lastUuidMs = 0;
let lastUuidSeq = 0;

/** RFC 9562 UUIDv7 with a per-process 12-bit monotonic counter so `ORDER BY id ASC` is oldest-first. */
function nextMonotonicUuidV7(): string {
  const now = Date.now();
  if (now > lastUuidMs) {
    lastUuidMs = now;
    lastUuidSeq = 0;
  } else {
    lastUuidSeq += 1;
    if (lastUuidSeq > 0x0fff) {
      lastUuidMs += 1;
      lastUuidSeq = 0;
    }
  }
  const bytes = randomBytes(16);
  const ms = BigInt(lastUuidMs);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = 0x70 | ((lastUuidSeq >> 8) & 0x0f);
  bytes[7] = lastUuidSeq & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function refDisplayKey(repository: string, ref: string): string {
  return `${repository}\t${ref}`;
}

function refUpdateExternalId(repository: string, ref: string, beforeSha: string, afterSha: string): string {
  return `${repository}\t${ref}\t${beforeSha}\t${afterSha}`;
}

function pushAttemptExternalId(refUpdateId: string, runId: string): string {
  return `${refUpdateId}\t${runId}`;
}

type RefUpdateData = {
  v: 1;
  repository: string;
  ref: string;
  beforeSha: string;
  afterSha: string;
  evidenceForced: boolean | null;
};

type PushAttemptData = {
  v: 1;
  refUpdateId: string;
  runId: string;
  agentId: string;
  issueId: string | null;
  outcome: PushAttemptOutcome;
  forceRequested: boolean;
  exitCode: number | null;
};

function readRefUpdateData(raw: Record<string, unknown>): RefUpdateData {
  return {
    v: 1,
    repository: typeof raw.repository === "string" ? raw.repository : "",
    ref: typeof raw.ref === "string" ? raw.ref : "",
    beforeSha: typeof raw.beforeSha === "string" ? raw.beforeSha : "",
    afterSha: typeof raw.afterSha === "string" ? raw.afterSha : "",
    evidenceForced: typeof raw.evidenceForced === "boolean" ? raw.evidenceForced : null,
  };
}

function readPushAttemptData(raw: Record<string, unknown>): PushAttemptData {
  return {
    v: 1,
    refUpdateId: typeof raw.refUpdateId === "string" ? raw.refUpdateId : "",
    runId: typeof raw.runId === "string" ? raw.runId : "",
    agentId: typeof raw.agentId === "string" ? raw.agentId : "",
    issueId: typeof raw.issueId === "string" ? raw.issueId : null,
    outcome: raw.outcome === "succeeded" || raw.outcome === "failed" ? raw.outcome : "unknown",
    forceRequested: raw.forceRequested === true,
    exitCode: typeof raw.exitCode === "number" && Number.isInteger(raw.exitCode) ? raw.exitCode : null,
  };
}

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

const OUTCOME_RANK = sql`case ${externalObjects.statusKey} when 'succeeded' then 2 when 'unknown' then 1 else 0 end`;
const STRONGEST_OUTCOME = sql`case when (case excluded.status_key when 'succeeded' then 2 when 'unknown' then 1 else 0 end) > ${OUTCOME_RANK}
  then excluded.status_key else ${externalObjects.statusKey} end`;

async function upsertRefUpdate(
  db: Pick<Db, "insert">,
  values: { companyId: string; repository: string; ref: string; beforeSha: string; afterSha: string },
) {
  const data: RefUpdateData = {
    v: 1,
    repository: values.repository,
    ref: values.ref,
    beforeSha: values.beforeSha,
    afterSha: values.afterSha,
    evidenceForced: null,
  };
  const [row] = await db
    .insert(externalObjects)
    .values({
      id: nextMonotonicUuidV7(),
      companyId: values.companyId,
      providerKey: PUSH_PROVENANCE_PROVIDER_KEY,
      objectType: PUSH_PROVENANCE_REF_UPDATE_TYPE,
      externalId: refUpdateExternalId(values.repository, values.ref, values.beforeSha, values.afterSha),
      displayKey: refDisplayKey(values.repository, values.ref),
      statusKey: values.afterSha,
      statusCategory: "unknown",
      statusTone: "neutral",
      liveness: "unknown",
      isTerminal: true,
      nextRefreshAt: null,
      data,
    })
    .onConflictDoUpdate({
      target: [
        externalObjects.companyId,
        externalObjects.providerKey,
        externalObjects.objectType,
        externalObjects.externalId,
      ],
      // A no-op assignment so the existing row's id and firstSeenAt stay unchanged.
      set: { providerKey: sql`excluded.provider_key` },
    })
    .returning({ id: externalObjects.id });
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
      const data: PushAttemptData = {
        v: 1,
        refUpdateId,
        runId: run.runId,
        agentId: run.agentId,
        issueId,
        outcome,
        forceRequested: report.forced,
        exitCode: report.exitCode,
      };
      await tx
        .insert(externalObjects)
        .values({
          id: nextMonotonicUuidV7(),
          companyId: run.companyId,
          providerKey: PUSH_PROVENANCE_PROVIDER_KEY,
          objectType: PUSH_PROVENANCE_ATTEMPT_TYPE,
          externalId: pushAttemptExternalId(refUpdateId, run.runId),
          displayKey: refUpdateId,
          statusKey: outcome,
          remoteVersion: run.runId,
          statusCategory: "unknown",
          statusTone: "neutral",
          liveness: "unknown",
          isTerminal: true,
          nextRefreshAt: null,
          data,
        })
        .onConflictDoUpdate({
          target: [
            externalObjects.companyId,
            externalObjects.providerKey,
            externalObjects.objectType,
            externalObjects.externalId,
          ],
          // A retry keeps the strongest outcome: succeeded > unknown > failed.
          set: {
            statusKey: STRONGEST_OUTCOME,
            data: sql`jsonb_set(
              jsonb_set(
                ${externalObjects.data},
                '{outcome}',
                to_jsonb(${STRONGEST_OUTCOME}),
                true
              ),
              '{forceRequested}',
              to_jsonb(coalesce((${externalObjects.data}->>'forceRequested')::boolean, false) or coalesce((excluded.data->>'forceRequested')::boolean, false)),
              true
            )`,
            updatedAt: new Date(),
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
  const now = new Date();
  const updated = await db
    .update(externalObjects)
    .set({
      lastResolvedAt: now,
      etag: verification.deliveryId,
      updatedAt: now,
      data: sql`jsonb_set(${externalObjects.data}, '{evidenceForced}', ${evidence.forced ? sql`'true'::jsonb` : sql`'false'::jsonb`}, true)`,
    })
    .where(and(eq(externalObjects.id, refUpdateId), isNull(externalObjects.lastResolvedAt)))
    .returning({ id: externalObjects.id });
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

function encodeCursor(afterId: string) {
  return Buffer.from(JSON.stringify({ v: 1, afterId }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; afterId?: unknown };
    if (value.v === 1 && typeof value.afterId === "string" && CURSOR_UUID.test(value.afterId)) return value.afterId;
  } catch {
    // Fall through.
  }
  throw unprocessable("cursor is not a cursor returned by listBranchUpdates");
}

const attemptObjects = alias(externalObjects, "github_push_attempt_objects");

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
  const afterId = input.cursor ? decodeCursor(input.cursor) : null;

  const rows = await db
    .select()
    .from(externalObjects)
    .where(and(
      eq(externalObjects.companyId, companyId),
      eq(externalObjects.providerKey, PUSH_PROVENANCE_PROVIDER_KEY),
      eq(externalObjects.objectType, PUSH_PROVENANCE_REF_UPDATE_TYPE),
      eq(externalObjects.displayKey, refDisplayKey(repository, ref)),
      afterSha ? eq(externalObjects.statusKey, afterSha) : undefined,
      afterId !== null ? gt(externalObjects.id, afterId) : undefined,
      or(
        isNotNull(externalObjects.lastResolvedAt),
        exists(db
          .select({ one: sql`1` })
          .from(attemptObjects)
          .where(and(
            eq(attemptObjects.companyId, externalObjects.companyId),
            eq(attemptObjects.providerKey, PUSH_PROVENANCE_PROVIDER_KEY),
            eq(attemptObjects.objectType, PUSH_PROVENANCE_ATTEMPT_TYPE),
            eq(attemptObjects.displayKey, sql`${externalObjects.id}::text`),
            ne(attemptObjects.statusKey, "failed"),
          ))),
      ),
    ))
    .orderBy(asc(externalObjects.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const more = rows.length > limit;

  const attempts = page.length === 0 ? [] : await db
    .select()
    .from(externalObjects)
    .where(and(
      eq(externalObjects.companyId, companyId),
      eq(externalObjects.providerKey, PUSH_PROVENANCE_PROVIDER_KEY),
      eq(externalObjects.objectType, PUSH_PROVENANCE_ATTEMPT_TYPE),
      inArray(externalObjects.displayKey, page.map((row) => row.id)),
      ne(externalObjects.statusKey, "failed"),
    ))
    .orderBy(asc(externalObjects.createdAt), asc(externalObjects.id));
  const pushersByUpdate = new Map<string, PluginBranchUpdatePusher[]>();
  for (const attempt of attempts) {
    const details = readPushAttemptData(attempt.data);
    const refUpdateId = attempt.displayKey ?? details.refUpdateId;
    const list = pushersByUpdate.get(refUpdateId) ?? [];
    list.push({
      agentId: details.agentId,
      runId: details.runId,
      issueId: details.issueId,
      outcome: attempt.statusKey === "succeeded" ? "succeeded" : "unknown",
      reportedAt: attempt.createdAt.toISOString(),
    });
    pushersByUpdate.set(refUpdateId, list);
  }

  const updates: PluginBranchUpdate[] = page.map((row) => {
    const details = readRefUpdateData(row.data);
    const pushers = pushersByUpdate.get(row.id) ?? [];
    const evidenced = row.lastResolvedAt !== null;
    const state = !evidenced ? "attempted"
      : pushers.length === 0 ? "unattributed"
      : pushers.length === 1 ? "confirmed"
      : "ambiguous";
    const confirmed = state === "confirmed" ? pushers[0]! : null;
    return {
      id: row.id,
      state,
      repository: details.repository,
      ref: details.ref,
      beforeSha: details.beforeSha,
      afterSha: details.afterSha,
      forced: details.evidenceForced,
      pushers,
      agentId: confirmed?.agentId ?? null,
      runId: confirmed?.runId ?? null,
      issueId: confirmed?.issueId ?? null,
      firstSeenAt: row.createdAt.toISOString(),
      githubReceivedAt: row.lastResolvedAt?.toISOString() ?? null,
    };
  });
  const last = page.at(-1);
  return {
    updates,
    nextCursor: more && last ? encodeCursor(last.id) : null,
    complete: !more,
  };
}
