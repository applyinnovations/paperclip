import fs from "node:fs/promises";
import path from "node:path";

/**
 * Self-heal for a managed git worktree target before `git worktree add`.
 *
 * Two broken states make setup fail on every attempt, forever:
 *
 * 1. A directory sits at the target path but holds no `.git` entry (it is
 *    empty, or its checkout was removed while the directory stayed). git then
 *    resolves the path up to the enclosing repository, so validation reports
 *    "git resolves this path to a different repository root".
 * 2. The repository still registers a worktree (`.git/worktrees/<name>`)
 *    whose directory no longer exists, so the branch lookup finds a
 *    registration that can never be reused.
 *
 * Neither holds git state: the branch and its commits live in the repository,
 * not in the worktree directory. So an empty directory is removed (`rmdir`,
 * which cannot delete files), a non-empty one is moved aside (never deleted),
 * and `git worktree prune` drops registrations whose directory is gone. A
 * directory that still has a `.git` entry is never touched: it may hold
 * uncommitted or unpushed work, so its validation failure stays loud.
 */

export type GitWorktreeSelfHealAction =
  | { kind: "removed_empty_directory"; path: string }
  | { kind: "quarantined_directory"; path: string; quarantinePath: string };

export interface GitWorktreeSelfHealResult {
  actions: GitWorktreeSelfHealAction[];
  /** Stale registrations `git worktree prune` removed, as reported by git. */
  prunedRegistrations: string[];
  warnings: string[];
}

export function staleWorktreeQuarantineDir(repoRoot: string) {
  return path.join(repoRoot, ".paperclip", "stale-worktrees");
}

async function hasGitEntry(dir: string) {
  return fs.lstat(path.join(dir, ".git")).then(() => true, () => false);
}

/**
 * Clears a directory at `targetPath` that cannot be a worktree because it has
 * no `.git` entry. Returns null when the path is absent, is not a plain
 * directory, or has a `.git` entry.
 */
async function clearGitlessDirectory(input: {
  repoRoot: string;
  targetPath: string;
  now: Date;
}): Promise<GitWorktreeSelfHealAction | null> {
  const stats = await fs.lstat(input.targetPath).catch(() => null);
  if (!stats?.isDirectory()) return null;
  if (await hasGitEntry(input.targetPath)) return null;

  const entries = await fs.readdir(input.targetPath);
  if (entries.length === 0) {
    try {
      await fs.rmdir(input.targetPath);
      return { kind: "removed_empty_directory", path: input.targetPath };
    } catch (error) {
      // Something wrote into the directory after readdir: quarantine below.
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    }
  }

  const quarantineDir = staleWorktreeQuarantineDir(input.repoRoot);
  await fs.mkdir(quarantineDir, { recursive: true });
  const stamp = input.now.toISOString().replace(/[:.]/g, "-");
  const quarantinePath = path.join(quarantineDir, `${path.basename(input.targetPath)}-${stamp}`);
  await fs.rename(input.targetPath, quarantinePath);
  return { kind: "quarantined_directory", path: input.targetPath, quarantinePath };
}

function parsePrunedRegistrations(output: string) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Removing "))
    .map((line) => line.slice("Removing ".length).replace(/:.*$/, "").replace(/^worktrees\//, ""));
}

export async function selfHealGitWorktreeTarget(input: {
  repoRoot: string;
  /** Paths to clear when they hold no `.git` entry: the target, and any path the branch is registered at. */
  targetPaths: string[];
  /** Runs `git <args>` in `cwd` and resolves to its combined output; rejects on a non-zero exit. */
  runGit: (args: string[], cwd: string) => Promise<string>;
  now?: Date;
}): Promise<GitWorktreeSelfHealResult> {
  const now = input.now ?? new Date();
  const actions: GitWorktreeSelfHealAction[] = [];
  const warnings: string[] = [];

  for (const targetPath of new Set(input.targetPaths.map((value) => path.resolve(value)))) {
    try {
      const action = await clearGitlessDirectory({ repoRoot: input.repoRoot, targetPath, now });
      if (action) actions.push(action);
    } catch (error) {
      // Leave the directory for validation to report; never fail setup here.
      warnings.push(
        `Could not clear the stale worktree directory "${targetPath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // `prune` removes only registrations whose directory is gone (and skips
  // locked ones, including a concurrent `worktree add` still initializing),
  // so it cannot drop a live worktree.
  let prunedRegistrations: string[] = [];
  try {
    prunedRegistrations = parsePrunedRegistrations(
      await input.runGit(["worktree", "prune", "--verbose"], input.repoRoot),
    );
  } catch (error) {
    warnings.push(`git worktree prune failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const action of actions) {
    warnings.push(
      action.kind === "removed_empty_directory"
        ? `Removed the empty directory at worktree path "${action.path}" so the worktree could be recreated.`
        : `Moved the directory at worktree path "${action.path}", which had no .git, to "${action.quarantinePath}" so the worktree could be recreated.`,
    );
  }
  if (prunedRegistrations.length > 0) {
    warnings.push(`Pruned stale git worktree registrations whose directory was missing: ${prunedRegistrations.join(", ")}.`);
  }

  return { actions, prunedRegistrations, warnings };
}
