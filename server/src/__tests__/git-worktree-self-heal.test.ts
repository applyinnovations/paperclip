import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.ts";
import { selfHealGitWorktreeTarget, staleWorktreeQuarantineDir } from "../services/git-worktree-self-heal.ts";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function git(cwd: string, args: string[]) {
  const { stdout, stderr } = await execFileAsync("git", args, { cwd });
  return `${stdout}${stderr}`.trim();
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-self-heal-"));
  tempDirs.push(repoRoot);
  await git(repoRoot, ["init", "--initial-branch", "main"]);
  await git(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await git(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await git(repoRoot, ["add", "README.md"]);
  await git(repoRoot, ["commit", "-m", "Initial commit"]);
  return repoRoot;
}

function realize(repoRoot: string, strategy: Record<string, unknown> = {}) {
  return realizeExecutionWorkspace({
    base: {
      baseCwd: repoRoot,
      source: "project_primary",
      projectId: "project-1",
      workspaceId: "workspace-1",
      repoUrl: null,
      repoRef: "HEAD",
    },
    config: { workspaceStrategy: { type: "git_worktree", ...strategy } },
    issue: { id: "issue-1", identifier: "PAP-145", title: "Self heal" },
    agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
  });
}

/** Realizes a worktree and commits on its branch, so a recreated worktree must keep that commit. */
async function realizeWithCommit(repoRoot: string, strategy: Record<string, unknown> = {}) {
  const workspace = await realize(repoRoot, strategy);
  await fs.writeFile(path.join(workspace.cwd, "work.txt"), "work\n", "utf8");
  await git(workspace.cwd, ["add", "work.txt"]);
  await git(workspace.cwd, ["commit", "-m", "Agent work"]);
  return { workspace, tip: await git(workspace.cwd, ["rev-parse", "HEAD"]) };
}

async function emptyDirectory(dir: string) {
  for (const entry of await fs.readdir(dir)) {
    await fs.rm(path.join(dir, entry), { recursive: true, force: true });
  }
}

async function registeredWorktrees(repoRoot: string) {
  const raw = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  return raw.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("realizeExecutionWorkspace self-heals a stale worktree target", () => {
  it("recreates a worktree whose directory was emptied while still registered", async () => {
    const repoRoot = await createTempRepo();
    const { workspace, tip } = await realizeWithCommit(repoRoot);
    await emptyDirectory(workspace.cwd);

    const healed = await realize(repoRoot);

    expect(healed.cwd).toBe(workspace.cwd);
    expect(healed.branchName).toBe(workspace.branchName);
    expect(await git(healed.cwd, ["rev-parse", "HEAD"])).toBe(tip);
    expect(existsSync(path.join(healed.cwd, "work.txt"))).toBe(true);
    expect(healed.warnings.join("\n")).toContain("Removed the empty directory");
    expect(existsSync(staleWorktreeQuarantineDir(repoRoot))).toBe(false);
  });

  it("recreates a worktree whose directory is gone but whose registration stayed", async () => {
    const repoRoot = await createTempRepo();
    const { workspace, tip } = await realizeWithCommit(repoRoot);
    await fs.rm(workspace.cwd, { recursive: true, force: true });

    const healed = await realize(repoRoot);

    expect(healed.cwd).toBe(workspace.cwd);
    expect(await git(healed.cwd, ["rev-parse", "HEAD"])).toBe(tip);
    expect(healed.warnings.join("\n")).toContain("Pruned stale git worktree registrations");
  });

  it("prunes every stale registration in the repository, not only the target's", async () => {
    const repoRoot = await createTempRepo();
    await git(repoRoot, ["worktree", "add", "-b", "other-branch", path.join(repoRoot, ".paperclip", "worktrees", "other")]);
    await fs.rm(path.join(repoRoot, ".paperclip", "worktrees", "other"), { recursive: true, force: true });

    await realize(repoRoot);

    expect((await registeredWorktrees(repoRoot)).some((entry) => entry.endsWith(`${path.sep}other`))).toBe(false);
  });

  it("moves aside a non-empty directory without .git and never deletes its files", async () => {
    const repoRoot = await createTempRepo();
    const { workspace, tip } = await realizeWithCommit(repoRoot);
    await fs.rm(path.join(workspace.cwd, ".git"), { force: true });
    await fs.writeFile(path.join(workspace.cwd, "left-behind.txt"), "keep me\n", "utf8");

    const healed = await realize(repoRoot);

    expect(await git(healed.cwd, ["rev-parse", "HEAD"])).toBe(tip);
    const quarantined = await fs.readdir(staleWorktreeQuarantineDir(repoRoot));
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatch(new RegExp(`^${workspace.branchName}-`));
    expect(await fs.readFile(path.join(staleWorktreeQuarantineDir(repoRoot), quarantined[0]!, "left-behind.txt"), "utf8"))
      .toBe("keep me\n");
  });

  it("recreates an emptied worktree for a pinned existing branch", async () => {
    const repoRoot = await createTempRepo();
    const { workspace, tip } = await realizeWithCommit(repoRoot);
    await emptyDirectory(workspace.cwd);

    const healed = await realize(repoRoot, { existingBranch: workspace.branchName });

    expect(healed.branchName).toBe(workspace.branchName);
    expect(await git(healed.cwd, ["rev-parse", "HEAD"])).toBe(tip);
  });

  it("still fails loudly on a directory with real git state, and leaves it in place", async () => {
    const repoRoot = await createTempRepo();
    const { workspace, tip } = await realizeWithCommit(repoRoot);
    await git(workspace.cwd, ["checkout", "-b", "someone-elses-branch"]);
    await fs.writeFile(path.join(workspace.cwd, "uncommitted.txt"), "unsaved\n", "utf8");

    await expect(realize(repoRoot, { existingBranch: workspace.branchName })).rejects.toThrow(/not a reusable checkout/);

    expect(await git(workspace.cwd, ["rev-parse", workspace.branchName!])).toBe(tip);
    expect(await fs.readFile(path.join(workspace.cwd, "uncommitted.txt"), "utf8")).toBe("unsaved\n");
    expect(existsSync(staleWorktreeQuarantineDir(repoRoot))).toBe(false);
  });
});

describe("selfHealGitWorktreeTarget", () => {
  it("leaves a missing path, a file and a symlink alone", async () => {
    const repoRoot = await createTempRepo();
    const file = path.join(repoRoot, "a-file");
    const link = path.join(repoRoot, "a-link");
    await fs.writeFile(file, "x", "utf8");
    await fs.mkdir(path.join(repoRoot, "empty-target"));
    await fs.symlink(path.join(repoRoot, "empty-target"), link);

    const result = await selfHealGitWorktreeTarget({
      repoRoot,
      targetPaths: [path.join(repoRoot, "missing"), file, link],
      runGit: (args, cwd) => git(cwd, args),
    });

    expect(result.actions).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(link)).toBe(true);
  });

  it("reports a failing prune as a warning instead of failing setup", async () => {
    const repoRoot = await createTempRepo();
    const result = await selfHealGitWorktreeTarget({
      repoRoot,
      targetPaths: [],
      runGit: async () => { throw new Error("git exploded"); },
    });
    expect(result.warnings).toEqual(["git worktree prune failed: git exploded"]);
  });
});
