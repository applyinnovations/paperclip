import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, executionWorkspaces, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { recoveryPostgresSupport as support, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const scheduled = vi.hoisted(() => [] as Array<{ companyId: string; issueId: string }>);
vi.mock("../services/checkpoint-ref-cleanup.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../services/checkpoint-ref-cleanup.js")>()),
  scheduleIssueCheckpointRefCleanup: (_db: unknown, input: { companyId: string; issueId: string }) => { scheduled.push(input); },
}));

const { checkpointRefNames, cleanupIssueCheckpointRefs, deleteCheckpointRefs, isIssueCheckpointRef } =
  await import("../services/checkpoint-ref-cleanup.js");
const { issueService } = await import("../services/issues.js");

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com" };
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: gitEnv }).trim();
}

const noAuth = async () => null;

describe("checkpoint ref names", () => {
  it("matches the wip ref and kept refs of exactly one issue", () => {
    expect(checkpointRefNames("APP-16")).toEqual({ wip: "refs/paperclip/wip/APP-16", keptPrefix: "refs/paperclip/kept/APP-16/" });
    expect(isIssueCheckpointRef("refs/paperclip/wip/APP-16", "APP-16")).toBe(true);
    expect(isIssueCheckpointRef("refs/paperclip/kept/APP-16/0123456789ab", "APP-16")).toBe(true);
    expect(isIssueCheckpointRef("refs/paperclip/wip/APP-168", "APP-16")).toBe(false);
    expect(isIssueCheckpointRef("refs/paperclip/kept/APP-168/0123456789ab", "APP-16")).toBe(false);
    expect(isIssueCheckpointRef("refs/heads/refs/paperclip/wip/APP-16", "APP-16")).toBe(false);
    expect(isIssueCheckpointRef("refs/paperclip/kept/APP-16/", "APP-16")).toBe(false);
  });

  it("rejects identifiers that would not stay literal in a pattern or refspec", () => {
    for (const bad of ["APP-1/x", "APP-*", "-APP", "APP 1", "", "APP:1"]) expect(() => checkpointRefNames(bad)).toThrow();
  });
});

describe("deleteCheckpointRefs against a local bare repository", () => {
  let root: string;
  let remote: string;
  let work: string;
  let first: string;
  let second: string;
  const refs = () => git(root, "ls-remote", "--refs", remote).split("\n").filter(Boolean).map(line => line.split("\t")[1]).sort();
  const put = (ref: string, sha = first) => git(work, "push", "-q", "--force", remote, `${sha}:${ref}`);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-checkpoint-refs-test-"));
    remote = path.join(root, "remote.git");
    work = path.join(root, "work");
    git(root, "init", "-q", "--bare", "-b", "master", remote);
    git(root, "init", "-q", "-b", "master", work);
    git(work, "commit", "-q", "--allow-empty", "-m", "one");
    first = git(work, "rev-parse", "HEAD");
    git(work, "commit", "-q", "--allow-empty", "-m", "two");
    second = git(work, "rev-parse", "HEAD");
    put("refs/heads/master", second);
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("deletes the issue's wip ref and every kept ref", async () => {
    put("refs/paperclip/wip/APP-1");
    put("refs/paperclip/kept/APP-1/aaaaaaaaaaaa");
    put("refs/paperclip/kept/APP-1/bbbbbbbbbbbb", second);
    const outcome = await deleteCheckpointRefs({ repoUrl: remote, identifier: "APP-1", resolveGitAuth: noAuth });
    expect(outcome.deleted.sort()).toEqual(["refs/paperclip/kept/APP-1/aaaaaaaaaaaa", "refs/paperclip/kept/APP-1/bbbbbbbbbbbb", "refs/paperclip/wip/APP-1"]);
    expect(outcome.survived).toEqual([]);
    expect(refs()).toEqual(["refs/heads/master"]);
  });

  it("leaves refs of issues whose identifier shares a prefix alone", async () => {
    for (const id of ["APP-1", "APP-16", "APP-168"]) {
      put(`refs/paperclip/wip/${id}`);
      put(`refs/paperclip/kept/${id}/aaaaaaaaaaaa`);
    }
    put("refs/heads/refs/paperclip/kept/APP-1/cccccccccccc");
    await deleteCheckpointRefs({ repoUrl: remote, identifier: "APP-1", resolveGitAuth: noAuth });
    expect(refs()).toEqual([
      "refs/heads/master",
      "refs/heads/refs/paperclip/kept/APP-1/cccccccccccc",
      "refs/paperclip/kept/APP-16/aaaaaaaaaaaa",
      "refs/paperclip/kept/APP-168/aaaaaaaaaaaa",
      "refs/paperclip/wip/APP-16",
      "refs/paperclip/wip/APP-168",
    ]);
  });

  it("keeps a ref that moved after listing and treats a vanished ref as gone", async () => {
    put("refs/paperclip/wip/APP-1");
    put("refs/paperclip/kept/APP-1/aaaaaaaaaaaa");
    put("refs/paperclip/kept/APP-1/bbbbbbbbbbbb");
    const outcome = await deleteCheckpointRefs({
      repoUrl: remote, identifier: "APP-1", resolveGitAuth: noAuth,
      shouldDelete: async () => {
        put("refs/paperclip/wip/APP-1", second); // a new run checkpointed in between
        git(work, "push", "-q", remote, ":refs/paperclip/kept/APP-1/bbbbbbbbbbbb");
        return true;
      },
    });
    expect(outcome).toEqual({
      deleted: ["refs/paperclip/kept/APP-1/aaaaaaaaaaaa"],
      alreadyGone: ["refs/paperclip/kept/APP-1/bbbbbbbbbbbb"],
      survived: ["refs/paperclip/wip/APP-1"],
      skipped: false,
    });
    expect(git(root, "ls-remote", remote, "refs/paperclip/wip/APP-1").split("\t")[0]).toBe(second);
  });

  it("is a no-op when the issue has no refs", async () => {
    put("refs/paperclip/wip/APP-16");
    const shouldDelete = vi.fn(async () => true);
    const outcome = await deleteCheckpointRefs({ repoUrl: remote, identifier: "APP-1", resolveGitAuth: noAuth, shouldDelete });
    expect(outcome).toEqual({ deleted: [], alreadyGone: [], survived: [], skipped: false });
    expect(shouldDelete).not.toHaveBeenCalled();
  });

  it("pushes nothing when the issue was reopened before the push", async () => {
    put("refs/paperclip/wip/APP-1");
    const outcome = await deleteCheckpointRefs({ repoUrl: remote, identifier: "APP-1", resolveGitAuth: noAuth, shouldDelete: async () => false });
    expect(outcome.skipped).toBe(true);
    expect(refs()).toContain("refs/paperclip/wip/APP-1");
  });

  it("reports a git failure with its exit code", async () => {
    await expect(deleteCheckpointRefs({ repoUrl: path.join(root, "missing.git"), identifier: "APP-1", resolveGitAuth: noAuth }))
      .rejects.toMatchObject({ name: "CheckpointRefCleanupGitError", step: "ls-remote" });
  });
});

(support.supported ? describe : describe.skip)("issue checkpoint ref cleanup", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let root: string;
  let remote: string;
  let work: string;
  const refs = () => git(root, "ls-remote", remote, "refs/paperclip/*").split("\n").filter(Boolean).map(line => line.split("\t")[1]).sort();
  const put = (ref: string) => git(work, "push", "-q", "--force", remote, `HEAD:${ref}`);
  const localDeps = { resolveGitAuth: noAuth, isEligibleRemote: () => true };

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("checkpoint-refs-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });
  beforeEach(async () => {
    scheduled.length = 0;
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-checkpoint-cleanup-test-"));
    remote = path.join(root, "remote.git");
    work = path.join(root, "work");
    git(root, "init", "-q", "--bare", "-b", "master", remote);
    git(root, "init", "-q", "-b", "master", work);
    git(work, "commit", "-q", "--allow-empty", "-m", "one");
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  async function seed(status: "todo" | "done" | "cancelled", repo: "execution" | "project" = "execution") {
    const companyId = randomUUID(), projectId = randomUUID(), issueId = randomUUID();
    const prefix = `C${companyId.slice(0, 6).replace(/[^0-9a-z]/gi, "")}`.toUpperCase();
    await db.insert(companies).values({ id: companyId, name: "Checkpoint", issuePrefix: prefix });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project" });
    await db.insert(projectWorkspaces).values({ companyId, projectId, name: "Primary", isPrimary: true,
      repoUrl: repo === "project" ? remote : null });
    const identifier = `${prefix}-1`;
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Work", status, identifier, issueNumber: 1 });
    if (repo === "execution") {
      await db.insert(executionWorkspaces).values({ companyId, projectId, sourceIssueId: issueId, mode: "isolated_workspace",
        strategyType: "git_worktree", name: "ws", status: "active", providerType: "git_worktree", repoUrl: remote });
    }
    return { companyId, issueId, identifier };
  }
  const activities = (issueId: string) => db.select().from(activityLog)
    .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.checkpoint_refs_deleted")));

  it.each(["done", "cancelled"] as const)("deletes refs of an issue that is %s and logs one activity entry", async status => {
    const { companyId, issueId, identifier } = await seed(status);
    put(`refs/paperclip/wip/${identifier}`);
    put(`refs/paperclip/kept/${identifier}/aaaaaaaaaaaa`);
    put(`refs/paperclip/wip/${identifier}0`);
    await cleanupIssueCheckpointRefs(db, { companyId, issueId }, localDeps);
    expect(refs()).toEqual([`refs/paperclip/wip/${identifier}0`]);
    const [entry, ...rest] = await activities(issueId);
    expect(rest).toEqual([]);
    expect(entry.details).toMatchObject({ identifier, repositories: [{ repoUrl: remote,
      deletedRefs: expect.arrayContaining([`refs/paperclip/wip/${identifier}`, `refs/paperclip/kept/${identifier}/aaaaaaaaaaaa`]) }] });
  });

  it("falls back to the project's primary workspace repository", async () => {
    const { companyId, issueId, identifier } = await seed("done", "project");
    put(`refs/paperclip/wip/${identifier}`);
    await cleanupIssueCheckpointRefs(db, { companyId, issueId }, localDeps);
    expect(refs()).toEqual([]);
  });

  it("leaves refs of an issue that is not terminal, and only touches GitHub https remotes by default", async () => {
    const open = await seed("todo");
    put(`refs/paperclip/wip/${open.identifier}`);
    await cleanupIssueCheckpointRefs(db, open, localDeps);
    const closed = await seed("done");
    put(`refs/paperclip/wip/${closed.identifier}`);
    await cleanupIssueCheckpointRefs(db, closed, { resolveGitAuth: noAuth });
    expect(refs()).toEqual([`refs/paperclip/wip/${closed.identifier}`, `refs/paperclip/wip/${open.identifier}`].sort());
  });

  it("does not throw on a git or auth failure and logs nothing", async () => {
    const { companyId, issueId, identifier } = await seed("done");
    put(`refs/paperclip/wip/${identifier}`);
    await expect(cleanupIssueCheckpointRefs(db, { companyId, issueId }, {
      isEligibleRemote: () => true, resolveGitAuth: async () => { throw new Error("credential resolution failed"); },
    })).resolves.toBeUndefined();
    await db.update(executionWorkspaces).set({ repoUrl: path.join(root, "missing.git") }).where(eq(executionWorkspaces.sourceIssueId, issueId));
    await expect(cleanupIssueCheckpointRefs(db, { companyId, issueId }, localDeps)).resolves.toBeUndefined();
    expect(await activities(issueId)).toEqual([]);
    expect(refs()).toEqual([`refs/paperclip/wip/${identifier}`]);
  });

  it("is scheduled after an issue goes done or cancelled, not on other transitions", async () => {
    const svc = issueService(db);
    const { companyId, issueId } = await seed("todo");
    await svc.update(issueId, { status: "in_progress" });
    expect(scheduled).toEqual([]);
    await svc.update(issueId, { status: "done" });
    expect(scheduled).toEqual([{ companyId, issueId }]);
    await svc.update(issueId, { status: "cancelled" });
    expect(scheduled).toEqual([{ companyId, issueId }, { companyId, issueId }]);
  });
});
