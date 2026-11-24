import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";

/**
 * Carries one Claude session transcript across disposable sandbox leases.
 *
 * Claude Code keeps a session's transcript at
 * `<CLAUDE_CONFIG_DIR>/projects/<encoded cwd>/<sessionId>.jsonl`. In a sandbox
 * that directory lives under the lease's `.paperclip-runtime`, which the
 * workspace copy-back excludes, so a new lease cannot `--resume`. At the end of
 * a run this copies back only that one file, into the same place a host run of
 * Claude keeps it (the host's shared Claude config dir), and restores it into
 * the next lease before `--resume`.
 *
 * Every step is fail-open: a missing, oversized or unreadable transcript is
 * logged and the run starts a fresh session instead of failing.
 */

/** Transcripts above this size are not carried; the next run starts fresh. */
export const CLAUDE_SANDBOX_TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;

/** Runtime asset key that uploads the staged transcript into the lease. */
export const CLAUDE_SANDBOX_TRANSCRIPT_ASSET_KEY = "session-transcript";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isClaudeTranscriptSessionId(value: string | null | undefined): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

/** Mirrors Claude Code's project-dir encoding: non-alphanumeric chars become "-". */
export function encodeClaudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

export function resolveClaudeTranscriptStorePath(input: {
  storeConfigDir: string;
  remoteCwd: string;
  sessionId: string;
}): string {
  return path.join(
    input.storeConfigDir,
    "projects",
    encodeClaudeProjectDirName(input.remoteCwd),
    `${input.sessionId}.jsonl`,
  );
}

export function resolveRemoteClaudeTranscriptPath(input: {
  remoteClaudeConfigDir: string;
  remoteCwd: string;
  sessionId: string;
}): string {
  return path.posix.join(
    input.remoteClaudeConfigDir,
    "projects",
    encodeClaudeProjectDirName(input.remoteCwd),
    `${input.sessionId}.jsonl`,
  );
}

function errorDetail(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : String(error);
}

export type ClaudeTranscriptStageResult =
  | { staged: true; bytes: number }
  | { staged: false; reason: "missing" | "too_large" | "error"; detail?: string };

/**
 * Copies the stored transcript for `sessionId` into `stagingDir` (as
 * `<sessionId>.jsonl`) so the runtime asset upload carries it into the lease.
 */
export async function stageClaudeTranscriptForSandbox(input: {
  storeConfigDir: string;
  remoteCwd: string;
  sessionId: string;
  stagingDir: string;
  maxBytes?: number;
}): Promise<ClaudeTranscriptStageResult> {
  if (!isClaudeTranscriptSessionId(input.sessionId)) {
    return { staged: false, reason: "error", detail: "invalid session id" };
  }
  const maxBytes = input.maxBytes ?? CLAUDE_SANDBOX_TRANSCRIPT_MAX_BYTES;
  const sourcePath = resolveClaudeTranscriptStorePath(input);
  try {
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) return { staged: false, reason: "missing" };
    if (stat.size > maxBytes) return { staged: false, reason: "too_large", detail: `${stat.size} bytes` };
    await fs.mkdir(input.stagingDir, { recursive: true });
    await fs.copyFile(sourcePath, path.join(input.stagingDir, `${input.sessionId}.jsonl`));
    return { staged: true, bytes: stat.size };
  } catch (error) {
    if (errorDetail(error) === "ENOENT") return { staged: false, reason: "missing" };
    return { staged: false, reason: "error", detail: errorDetail(error) };
  }
}

/** Shell command that moves the uploaded transcript to where Claude reads it. */
export function buildClaudeTranscriptRestoreCommand(input: {
  remoteAssetDir: string;
  remoteClaudeConfigDir: string;
  remoteCwd: string;
  sessionId: string;
}): string {
  const source = path.posix.join(input.remoteAssetDir, `${input.sessionId}.jsonl`);
  const target = resolveRemoteClaudeTranscriptPath(input);
  return `mkdir -p ${shellQuote(path.posix.dirname(target))} && cp ${shellQuote(source)} ${shellQuote(target)}`;
}

/** Shell command that prints the transcript's byte size, or `missing`. */
export function buildClaudeTranscriptSizeCommand(remotePath: string): string {
  const quoted = shellQuote(remotePath);
  return `if [ -f ${quoted} ]; then wc -c < ${quoted}; else printf 'missing'; fi`;
}

export type ClaudeTranscriptCopyBackResult =
  | { copied: true; bytes: number; path: string }
  | { copied: false; reason: "missing" | "too_large" | "error"; detail?: string };

/**
 * Reads the run's transcript back from the sandbox and stores it on the host.
 * Never throws: the caller runs it during teardown, where a rejection would
 * fail the workspace restore.
 */
export async function copyBackClaudeTranscriptFromSandbox(input: {
  remoteClaudeConfigDir: string;
  remoteCwd: string;
  sessionId: string;
  storeConfigDir: string;
  /** Runs a shell command in the sandbox and returns its stdout. */
  runShell: (command: string) => Promise<{ exitCode: number | null; stdout: string }>;
  readFile: (remotePath: string) => Promise<Buffer>;
  maxBytes?: number;
}): Promise<ClaudeTranscriptCopyBackResult> {
  try {
    if (!isClaudeTranscriptSessionId(input.sessionId)) {
      return { copied: false, reason: "error", detail: "invalid session id" };
    }
    const maxBytes = input.maxBytes ?? CLAUDE_SANDBOX_TRANSCRIPT_MAX_BYTES;
    const remotePath = resolveRemoteClaudeTranscriptPath(input);
    const sizeResult = await input.runShell(buildClaudeTranscriptSizeCommand(remotePath));
    const sizeText = sizeResult.stdout.trim();
    if (sizeText === "missing") return { copied: false, reason: "missing" };
    const size = Number.parseInt(sizeText, 10);
    if (sizeResult.exitCode !== 0 || !/^\d+$/.test(sizeText) || !Number.isFinite(size)) {
      return { copied: false, reason: "error", detail: "could not read the transcript size" };
    }
    if (size > maxBytes) return { copied: false, reason: "too_large", detail: `${size} bytes` };
    const contents = await input.readFile(remotePath);
    if (contents.length > maxBytes) {
      return { copied: false, reason: "too_large", detail: `${contents.length} bytes` };
    }
    const targetPath = resolveClaudeTranscriptStorePath(input);
    await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    const partialPath = `${targetPath}.${randomUUID()}.partial`;
    try {
      await fs.writeFile(partialPath, contents, { mode: 0o600 });
      await fs.rename(partialPath, targetPath);
    } catch (error) {
      await fs.rm(partialPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return { copied: true, bytes: contents.length, path: targetPath };
  } catch (error) {
    return { copied: false, reason: "error", detail: errorDetail(error) };
  }
}

export function describeClaudeTranscriptSkip(
  result: { reason: "missing" | "too_large" | "error"; detail?: string },
  maxBytes: number = CLAUDE_SANDBOX_TRANSCRIPT_MAX_BYTES,
): string {
  if (result.reason === "missing") return "no saved transcript";
  if (result.reason === "too_large") {
    return `transcript is larger than the ${maxBytes}-byte cap${result.detail ? ` (${result.detail})` : ""}`;
  }
  return `transcript could not be transferred${result.detail ? ` (${result.detail})` : ""}`;
}
