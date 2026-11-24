// Git reports "no repository here" with one of two messages (under LC_ALL=C):
// - "fatal: not a git repository (or any of the parent directories): .git"
// - "fatal: not a git repository (or any parent up to mount point <dir>)"
//   followed by "Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set)."
// The second appears whenever the directory is on a different filesystem from
// its parent (Kubernetes PVC or emptyDir, Docker bind mount, tmpfs /tmp).
const GIT_NOT_A_REPOSITORY_STDERR =
  /^fatal: not a git repository \((?:or any of the parent directories\): \.git|or any parent up to mount point [^\r\n]+\)\r?\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.)\r?\n?$/;

/**
 * True when a failed `git` invocation (from promisified `execFile`) exited
 * normally with Git's "not a git repository" result and no environment
 * variable redirected repository discovery. Any other failure (missing Git,
 * permissions, corruption, signals) returns false so it stays reportable.
 */
export function isGitNotARepositoryFailure(error: unknown): boolean {
  const failure = error as { code?: unknown; signal?: unknown; stderr?: unknown } | null;
  return failure != null && failure.code === 128 && failure.signal == null &&
    typeof failure.stderr === "string" && GIT_NOT_A_REPOSITORY_STDERR.test(failure.stderr) &&
    !process.env.GIT_DIR && !process.env.GIT_WORK_TREE && !process.env.GIT_COMMON_DIR;
}
