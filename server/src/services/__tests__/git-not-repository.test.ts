import { afterEach, describe, expect, it, vi } from "vitest";
import { isGitNotARepositoryFailure } from "../git-not-repository.js";

const PARENT_DIRECTORIES = "fatal: not a git repository (or any of the parent directories): .git\n";
const MOUNT_POINT = "fatal: not a git repository (or any parent up to mount point /tmp)\n" +
  "Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n";
const failure = (stderr: string, extra: Record<string, unknown> = {}) => ({ code: 128, signal: null, stderr, ...extra });

describe("isGitNotARepositoryFailure", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["parent directories", PARENT_DIRECTORIES],
    ["mount point", MOUNT_POINT],
    ["mount point with spaces and CRLF", MOUNT_POINT.replace("/tmp", "/mnt/My Volume (1)").replaceAll("\n", "\r\n")],
  ])("recognises Git's %s message", (_name, stderr) => {
    expect(isGitNotARepositoryFailure(failure(stderr))).toBe(true);
  });

  it.each([
    ["another fatal error", failure("fatal: bad object HEAD\n")],
    ["mount point line without the boundary line", failure("fatal: not a git repository (or any parent up to mount point /tmp)\n")],
    ["extra output", failure(`${PARENT_DIRECTORIES}warning: something else\n`)],
    ["a different exit code", failure(PARENT_DIRECTORIES, { code: 1 })],
    ["a signal", failure(PARENT_DIRECTORIES, { code: null, signal: "SIGTERM" })],
    ["non-string stderr", failure(Buffer.from(PARENT_DIRECTORIES) as unknown as string)],
    ["a missing git binary", { code: "ENOENT" }],
    ["null", null],
  ])("rejects %s", (_name, error) => {
    expect(isGitNotARepositoryFailure(error)).toBe(false);
  });

  it.each(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"])("rejects when %s redirects discovery", (name) => {
    vi.stubEnv(name, "/elsewhere");
    expect(isGitNotARepositoryFailure(failure(MOUNT_POINT))).toBe(false);
  });
});
