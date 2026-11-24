import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildClaudeTranscriptRestoreCommand,
  buildClaudeTranscriptSizeCommand,
  copyBackClaudeTranscriptFromSandbox,
  describeClaudeTranscriptSkip,
  encodeClaudeProjectDirName,
  resolveClaudeTranscriptStorePath,
  resolveRemoteClaudeTranscriptPath,
  stageClaudeTranscriptForSandbox,
} from "./sandbox-session-transcript.js";

const execFileAsync = promisify(execFile);

const SESSION_ID = "12345678-1234-4abc-9def-123456789012";
const REMOTE_CWD = "/workspace/paperclip-workspace";

describe("Claude sandbox session transcript carry", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function tempDir(prefix: string) {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(dir);
    return dir;
  }

  /** Runs a command in a local directory standing in for the sandbox. */
  async function runLocalShell(command: string) {
    try {
      const { stdout } = await execFileAsync("sh", ["-c", command]);
      return { exitCode: 0, stdout };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string };
      return { exitCode: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "" };
    }
  }

  it("stores the transcript where a host Claude run keeps it, keyed by remote cwd and session", () => {
    expect(encodeClaudeProjectDirName(REMOTE_CWD)).toBe("-workspace-paperclip-workspace");
    expect(resolveClaudeTranscriptStorePath({ storeConfigDir: "/home/me/.claude", remoteCwd: REMOTE_CWD, sessionId: SESSION_ID }))
      .toBe(`/home/me/.claude/projects/-workspace-paperclip-workspace/${SESSION_ID}.jsonl`);
    expect(resolveRemoteClaudeTranscriptPath({ remoteClaudeConfigDir: "/ws/.paperclip-runtime/claude/config", remoteCwd: REMOTE_CWD, sessionId: SESSION_ID }))
      .toBe(`/ws/.paperclip-runtime/claude/config/projects/-workspace-paperclip-workspace/${SESSION_ID}.jsonl`);
  });

  it("carries a transcript from one lease to the next: copy back, stage, restore", async () => {
    const store = await tempDir("paperclip-transcript-store-");
    const firstLease = await tempDir("paperclip-transcript-lease-a-");
    const secondLease = await tempDir("paperclip-transcript-lease-b-");
    const staging = await tempDir("paperclip-transcript-staging-");
    const transcript = `${JSON.stringify({ type: "user", sessionId: SESSION_ID })}\n`;

    // Lease A: Claude wrote the transcript under the lease's config dir.
    const firstConfigDir = path.join(firstLease, "config");
    const firstRemotePath = resolveRemoteClaudeTranscriptPath({
      remoteClaudeConfigDir: firstConfigDir,
      remoteCwd: REMOTE_CWD,
      sessionId: SESSION_ID,
    });
    await mkdir(path.dirname(firstRemotePath), { recursive: true });
    await writeFile(firstRemotePath, transcript);

    const copied = await copyBackClaudeTranscriptFromSandbox({
      remoteClaudeConfigDir: firstConfigDir,
      remoteCwd: REMOTE_CWD,
      sessionId: SESSION_ID,
      storeConfigDir: store,
      runShell: runLocalShell,
      readFile: (remotePath) => readFile(remotePath),
    });
    expect(copied).toEqual({
      copied: true,
      bytes: Buffer.byteLength(transcript),
      path: resolveClaudeTranscriptStorePath({ storeConfigDir: store, remoteCwd: REMOTE_CWD, sessionId: SESSION_ID }),
    });
    if (!copied.copied) throw new Error("unreachable");
    expect(await readFile(copied.path, "utf8")).toBe(transcript);
    expect((await stat(copied.path)).mode & 0o777).toBe(0o600);
    // No partial file is left beside the transcript.
    expect(await readdir(path.dirname(copied.path))).toEqual([`${SESSION_ID}.jsonl`]);

    // Next run: stage it for the upload into lease B.
    const staged = await stageClaudeTranscriptForSandbox({
      storeConfigDir: store,
      remoteCwd: REMOTE_CWD,
      sessionId: SESSION_ID,
      stagingDir: staging,
    });
    expect(staged).toEqual({ staged: true, bytes: Buffer.byteLength(transcript) });
    expect(await readdir(staging)).toEqual([`${SESSION_ID}.jsonl`]);

    // The asset upload lands the staged dir in lease B; restore it where Claude reads it.
    const secondAssetDir = path.join(secondLease, "session-transcript");
    await mkdir(secondAssetDir, { recursive: true });
    await writeFile(path.join(secondAssetDir, `${SESSION_ID}.jsonl`), await readFile(path.join(staging, `${SESSION_ID}.jsonl`)));
    const secondConfigDir = path.join(secondLease, "config");
    const restore = await runLocalShell(buildClaudeTranscriptRestoreCommand({
      remoteAssetDir: secondAssetDir,
      remoteClaudeConfigDir: secondConfigDir,
      remoteCwd: REMOTE_CWD,
      sessionId: SESSION_ID,
    }));
    expect(restore.exitCode).toBe(0);
    expect(await readFile(resolveRemoteClaudeTranscriptPath({
      remoteClaudeConfigDir: secondConfigDir,
      remoteCwd: REMOTE_CWD,
      sessionId: SESSION_ID,
    }), "utf8")).toBe(transcript);
  });

  it("fails the restore command when the staged transcript never arrived", async () => {
    const lease = await tempDir("paperclip-transcript-lease-missing-");
    const restore = await runLocalShell(buildClaudeTranscriptRestoreCommand({
      remoteAssetDir: path.join(lease, "session-transcript"),
      remoteClaudeConfigDir: path.join(lease, "config"),
      remoteCwd: REMOTE_CWD,
      sessionId: SESSION_ID,
    }));
    expect(restore.exitCode).not.toBe(0);
  });

  describe("fail-open", () => {
    it("does not stage a missing or oversized transcript", async () => {
      const store = await tempDir("paperclip-transcript-store-");
      const staging = await tempDir("paperclip-transcript-staging-");
      const input = { storeConfigDir: store, remoteCwd: REMOTE_CWD, sessionId: SESSION_ID, stagingDir: staging };

      expect(await stageClaudeTranscriptForSandbox(input)).toEqual({ staged: false, reason: "missing" });

      const storePath = resolveClaudeTranscriptStorePath(input);
      await mkdir(path.dirname(storePath), { recursive: true });
      await writeFile(storePath, "x".repeat(65));
      expect(await stageClaudeTranscriptForSandbox({ ...input, maxBytes: 64 }))
        .toEqual({ staged: false, reason: "too_large", detail: "65 bytes" });
      expect(await readdir(staging)).toEqual([]);
    });

    it("refuses a session id that is not a UUID instead of building a path from it", async () => {
      const store = await tempDir("paperclip-transcript-store-");
      const runShell = vi.fn();
      expect(await stageClaudeTranscriptForSandbox({
        storeConfigDir: store,
        remoteCwd: REMOTE_CWD,
        sessionId: "../../etc/passwd",
        stagingDir: path.join(store, "staging"),
      })).toMatchObject({ staged: false, reason: "error" });
      expect(await copyBackClaudeTranscriptFromSandbox({
        remoteClaudeConfigDir: "/lease/config",
        remoteCwd: REMOTE_CWD,
        sessionId: "../../etc/passwd",
        storeConfigDir: store,
        runShell,
        readFile: vi.fn(),
      })).toMatchObject({ copied: false, reason: "error" });
      expect(runShell).not.toHaveBeenCalled();
    });

    it("skips a transcript the run never wrote", async () => {
      const store = await tempDir("paperclip-transcript-store-");
      const lease = await tempDir("paperclip-transcript-lease-");
      const readSandboxFile = vi.fn();
      const result = await copyBackClaudeTranscriptFromSandbox({
        remoteClaudeConfigDir: path.join(lease, "config"),
        remoteCwd: REMOTE_CWD,
        sessionId: SESSION_ID,
        storeConfigDir: store,
        runShell: runLocalShell,
        readFile: readSandboxFile,
      });
      expect(result).toEqual({ copied: false, reason: "missing" });
      expect(readSandboxFile).not.toHaveBeenCalled();
      expect(await readdir(store)).toEqual([]);
    });

    it("checks the size before reading, so an oversized transcript is never transferred", async () => {
      const store = await tempDir("paperclip-transcript-store-");
      const readSandboxFile = vi.fn();
      const result = await copyBackClaudeTranscriptFromSandbox({
        remoteClaudeConfigDir: "/lease/config",
        remoteCwd: REMOTE_CWD,
        sessionId: SESSION_ID,
        storeConfigDir: store,
        runShell: async () => ({ exitCode: 0, stdout: "  4096\n" }),
        readFile: readSandboxFile,
        maxBytes: 1024,
      });
      expect(result).toEqual({ copied: false, reason: "too_large", detail: "4096 bytes" });
      expect(readSandboxFile).not.toHaveBeenCalled();
      expect(describeClaudeTranscriptSkip(result as { reason: "too_large"; detail: string }, 1024))
        .toBe("transcript is larger than the 1024-byte cap (4096 bytes)");
    });

    it("never rejects when the sandbox or the read fails, and leaves the stored transcript alone", async () => {
      const store = await tempDir("paperclip-transcript-store-");
      const storePath = resolveClaudeTranscriptStorePath({ storeConfigDir: store, remoteCwd: REMOTE_CWD, sessionId: SESSION_ID });
      await mkdir(path.dirname(storePath), { recursive: true });
      await writeFile(storePath, "previous\n");
      const base = {
        remoteClaudeConfigDir: "/lease/config",
        remoteCwd: REMOTE_CWD,
        sessionId: SESSION_ID,
        storeConfigDir: store,
      };

      await expect(copyBackClaudeTranscriptFromSandbox({
        ...base,
        runShell: async () => { throw new Error("pod is gone"); },
        readFile: vi.fn(),
      })).resolves.toEqual({ copied: false, reason: "error", detail: "pod is gone" });

      await expect(copyBackClaudeTranscriptFromSandbox({
        ...base,
        runShell: async () => ({ exitCode: 1, stdout: "" }),
        readFile: vi.fn(),
      })).resolves.toEqual({ copied: false, reason: "error", detail: "could not read the transcript size" });

      await expect(copyBackClaudeTranscriptFromSandbox({
        ...base,
        runShell: async () => ({ exitCode: 0, stdout: "12\n" }),
        readFile: async () => { throw new Error("exec stream closed"); },
      })).resolves.toEqual({ copied: false, reason: "error", detail: "exec stream closed" });

      expect(await readFile(storePath, "utf8")).toBe("previous\n");
      expect(await readdir(path.dirname(storePath))).toEqual([`${SESSION_ID}.jsonl`]);
    });
  });

  it("quotes paths in the sandbox commands", () => {
    expect(buildClaudeTranscriptSizeCommand("/a b/it's.jsonl"))
      .toBe(`if [ -f '/a b/it'"'"'s.jsonl' ]; then wc -c < '/a b/it'"'"'s.jsonl'; else printf 'missing'; fi`);
  });
});
