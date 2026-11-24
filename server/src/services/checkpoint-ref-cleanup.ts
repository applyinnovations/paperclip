import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issues, projectWorkspaces } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  createIssueGitRemoteAuthProvider,
  isGitHubHttpsRemoteUrl,
  scrubGitCredentialText,
  type GitRemoteAuthProvider,
} from "./git-credentials.js";

/**
 * Deletes the refs `paperclip-checkpoint` (xlab-containers) pushes for an issue once the issue
 * is done or cancelled:
 *
 * - `refs/paperclip/wip/<ID>` — left behind when a run is killed after its last checkpoint and
 *   the issue is then closed without another run;
 * - `refs/paperclip/kept/<ID>/<sha12>` — written when a restore could not be done safely, and
 *   deleted by nothing else.
 *
 * Anyone who can read the repository can fetch those refs while they exist. This runs after the
 * terminal transition commits, fire-and-forget with a timeout: it must never fail or delay the
 * status change. It does not retry; the next terminal transition re-runs it.
 */

const execFile = promisify(execFileCallback);

export const CHECKPOINT_REF_CLEANUP_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_MAX_BUFFER = 4 * 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// Issue identifiers are `PREFIX-123`. Reject anything that could act as a glob, a path
// separator, or an option, so the ls-remote patterns and push refspecs stay literal.
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type CheckpointRef = { ref: string; sha: string };

export type CheckpointRefDeletion = {
  /** Refs this push deleted. */
  deleted: string[];
  /** Refs listed but already gone by the time of the push: treated as success. */
  alreadyGone: string[];
  /** Refs that moved after listing (lease mismatch) and were left in place. */
  survived: string[];
  /** True when `shouldDelete` returned false and nothing was pushed. */
  skipped: boolean;
};

export class CheckpointRefCleanupGitError extends Error {
  constructor(readonly step: "ls-remote" | "push", readonly exitCode: number | string | null, stderr: string) {
    super(`git ${step} failed (exit ${exitCode ?? "unknown"}): ${scrubGitCredentialText(stderr).trim().slice(0, 500)}`);
    this.name = "CheckpointRefCleanupGitError";
  }
}

export function checkpointRefNames(identifier: string) {
  if (!IDENTIFIER_PATTERN.test(identifier)) throw new Error(`invalid issue identifier for checkpoint refs: ${identifier}`);
  return {
    wip: `refs/paperclip/wip/${identifier}`,
    // The trailing slash keeps `APP-16` from matching `APP-168`.
    keptPrefix: `refs/paperclip/kept/${identifier}/`,
  };
}

/** Exact-name check. `git ls-remote` patterns match ref *tails*, so its output is filtered again. */
export function isIssueCheckpointRef(ref: string, identifier: string) {
  const names = checkpointRefNames(identifier);
  if (ref === names.wip) return true;
  if (!ref.startsWith(names.keptPrefix)) return false;
  const rest = ref.slice(names.keptPrefix.length);
  return rest.length > 0 && !rest.includes("/");
}

function gitEnv(auth: Awaited<ReturnType<GitRemoteAuthProvider>>) {
  return { ...process.env, ...auth?.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
}

function execFailure(step: "ls-remote" | "push", error: unknown): CheckpointRefCleanupGitError {
  const failure = error as { code?: number | string; stderr?: string; message?: string };
  return new CheckpointRefCleanupGitError(step, failure.code ?? null, failure.stderr || failure.message || "");
}

async function listCheckpointRefs(repoUrl: string, identifier: string, configArgs: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const names = checkpointRefNames(identifier);
  let stdout: string;
  try {
    ({ stdout } = await execFile("git", [...configArgs, "ls-remote", repoUrl, names.wip, `${names.keptPrefix}*`], {
      env, signal, timeout: CHECKPOINT_REF_CLEANUP_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER,
    }));
  } catch (error) {
    throw execFailure("ls-remote", error);
  }
  const refs: CheckpointRef[] = [];
  for (const line of stdout.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (!sha || !ref || !SHA_PATTERN.test(sha) || !isIssueCheckpointRef(ref, identifier)) continue;
    refs.push({ ref, sha });
  }
  return refs;
}

/**
 * List and delete one issue's checkpoint refs on one remote. Each ref is deleted with a lease on
 * the listed sha, so a ref a newer run moved in between survives. Exported for tests, which run
 * it against a local bare repository.
 */
export async function deleteCheckpointRefs(input: {
  repoUrl: string;
  identifier: string;
  resolveGitAuth: GitRemoteAuthProvider;
  /** Checked after listing, right before pushing; returning false skips the push. */
  shouldDelete?: () => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<CheckpointRefDeletion> {
  const result: CheckpointRefDeletion = { deleted: [], alreadyGone: [], survived: [], skipped: false };
  if (input.repoUrl.startsWith("-")) throw new Error("invalid repository url");
  const auth = await input.resolveGitAuth(input.repoUrl);
  const configArgs = auth?.configArgs ?? [];
  const env = gitEnv(auth);
  const listed = await listCheckpointRefs(input.repoUrl, input.identifier, configArgs, env, input.signal);
  if (listed.length === 0) return result;
  if (input.shouldDelete && !(await input.shouldDelete())) return { ...result, skipped: true };

  // `git push` needs a repository to run in; deleting refs needs no objects, so an empty one does.
  // The push is deliberately not --atomic: one moved ref must not keep the others alive.
  // A remote branch whose full name is itself `refs/paperclip/...` makes the destination
  // ambiguous; git then rejects the whole push, which fails closed and is logged as a warning.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-checkpoint-refs-"));
  let porcelain = "";
  let pushError: unknown = null;
  try {
    const options = { env, signal: input.signal, timeout: CHECKPOINT_REF_CLEANUP_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX_BUFFER };
    await execFile("git", ["init", "-q", "--bare", scratch], options);
    try {
      // paperclip:allow-git-push: server-side, lease-guarded deletion of a closed issue's own refs/paperclip/{wip,kept} checkpoint refs (APP-170); pushes no objects
      ({ stdout: porcelain } = await execFile("git", [...configArgs, "-C", scratch, "push", "--porcelain", "--no-verify", input.repoUrl,
        ...listed.map(({ ref, sha }) => `--force-with-lease=${ref}:${sha}`),
        ...listed.map(({ ref }) => `:${ref}`)], options));
    } catch (error) {
      // A rejected ref exits non-zero but still reports per-ref status on stdout.
      porcelain = (error as { stdout?: string }).stdout ?? "";
      pushError = error;
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }

  const listedNames = new Set(listed.map(({ ref }) => ref));
  const rejected: string[] = [];
  for (const line of porcelain.split("\n")) {
    const [flag, spec] = line.split("\t");
    const ref = spec?.slice(spec.lastIndexOf(":") + 1);
    if (!ref || !listedNames.has(ref)) continue;
    if (flag === "-") result.deleted.push(ref);
    else if (flag === "!") rejected.push(ref);
  }
  if (result.deleted.length === 0 && rejected.length === 0 && pushError) throw execFailure("push", pushError);
  if (rejected.length > 0) {
    // A rejection means the ref no longer had the listed sha: either another run moved it (it
    // survives) or it was deleted in between (already gone, which is success).
    const remaining = new Set((await listCheckpointRefs(input.repoUrl, input.identifier, configArgs, env, input.signal)).map(({ ref }) => ref));
    for (const ref of rejected) (remaining.has(ref) ? result.survived : result.alreadyGone).push(ref);
  }
  return result;
}

async function issueRepositoryUrls(db: Db, issue: {
  id: string; companyId: string; projectId: string | null; projectWorkspaceId: string | null; executionWorkspaceId: string | null;
}) {
  const workspaceRows = await db.select({ repoUrl: executionWorkspaces.repoUrl }).from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, issue.companyId),
    issue.executionWorkspaceId
      ? or(eq(executionWorkspaces.sourceIssueId, issue.id), eq(executionWorkspaces.id, issue.executionWorkspaceId))
      : eq(executionWorkspaces.sourceIssueId, issue.id),
  ));
  let urls = workspaceRows.map(row => row.repoUrl).filter((url): url is string => Boolean(url));
  if (urls.length === 0 && issue.projectId) {
    const projectRows = await db.select({ id: projectWorkspaces.id, repoUrl: projectWorkspaces.repoUrl, isPrimary: projectWorkspaces.isPrimary })
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.companyId, issue.companyId), eq(projectWorkspaces.projectId, issue.projectId)));
    const chosen = projectRows.find(row => row.id === issue.projectWorkspaceId && row.repoUrl)
      ?? projectRows.find(row => row.isPrimary && row.repoUrl);
    urls = chosen?.repoUrl ? [chosen.repoUrl] : [];
  }
  return [...new Set(urls)];
}

export type CheckpointRefCleanupDeps = {
  resolveGitAuth?: GitRemoteAuthProvider;
  /** Production allows only `https://github.com/...` remotes; tests widen it to local paths. */
  isEligibleRemote?: (repoUrl: string) => boolean;
  timeoutMs?: number;
};

/** Clean up one terminal issue's checkpoint refs. Never throws. */
export async function cleanupIssueCheckpointRefs(db: Db, input: { companyId: string; issueId: string }, deps: CheckpointRefCleanupDeps = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? CHECKPOINT_REF_CLEANUP_TIMEOUT_MS);
  timer.unref?.();
  try {
    const loadIssue = async () => (await db.select({
      id: issues.id, companyId: issues.companyId, identifier: issues.identifier, status: issues.status,
      projectId: issues.projectId, projectWorkspaceId: issues.projectWorkspaceId, executionWorkspaceId: issues.executionWorkspaceId,
    }).from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))))[0] ?? null;
    const isTerminal = (status: string | undefined) => status === "done" || status === "cancelled";

    const issue = await loadIssue();
    if (!issue || !isTerminal(issue.status) || !issue.identifier || !IDENTIFIER_PATTERN.test(issue.identifier)) return;
    const identifier = issue.identifier;
    const eligible = deps.isEligibleRemote ?? isGitHubHttpsRemoteUrl;
    const repoUrls = (await issueRepositoryUrls(db, issue)).filter(eligible);
    if (repoUrls.length === 0) return;

    const resolveGitAuth = deps.resolveGitAuth ?? createIssueGitRemoteAuthProvider(db, issue.companyId, issue.id);
    const repositories: Array<{ repoUrl: string; deletedRefs: string[]; alreadyGoneRefs: string[]; survivedRefs: string[] }> = [];
    for (const repoUrl of repoUrls) {
      try {
        const outcome = await deleteCheckpointRefs({
          repoUrl, identifier, resolveGitAuth, signal: controller.signal,
          // A reopened issue may have a run checkpointing again; leave its refs alone.
          shouldDelete: async () => isTerminal((await loadIssue())?.status),
        });
        if (outcome.deleted.length + outcome.alreadyGone.length + outcome.survived.length > 0) {
          repositories.push({ repoUrl: scrubGitCredentialText(repoUrl), deletedRefs: outcome.deleted,
            alreadyGoneRefs: outcome.alreadyGone, survivedRefs: outcome.survived });
        }
      } catch (error) {
        logger.warn({
          issueId: issue.id, companyId: issue.companyId, repoUrl: scrubGitCredentialText(repoUrl),
          gitStep: error instanceof CheckpointRefCleanupGitError ? error.step : null,
          gitExitCode: error instanceof CheckpointRefCleanupGitError ? error.exitCode : null,
          error: scrubGitCredentialText(error instanceof Error ? error.message : String(error)),
        }, "checkpoint ref cleanup failed; it re-runs on the next terminal transition");
      }
    }
    if (!repositories.some(repository => repository.deletedRefs.length > 0)) return;
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "checkpoint_ref_cleanup",
      action: "issue.checkpoint_refs_deleted",
      entityType: "issue",
      entityId: issue.id,
      issueId: issue.id,
      details: { identifier, repositories },
    });
  } catch (error) {
    logger.warn({ issueId: input.issueId, companyId: input.companyId, err: error }, "checkpoint ref cleanup failed");
  } finally {
    clearTimeout(timer);
  }
}

/** Start cleanup without awaiting it. Only call after the terminal transition has committed. */
export function scheduleIssueCheckpointRefCleanup(db: Db, input: { companyId: string; issueId: string }) {
  void cleanupIssueCheckpointRefs(db, input).catch(() => undefined);
}
