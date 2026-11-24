import { posix } from "node:path";

/**
 * Trusted server startup opt-in: deliver a saved Google subscription
 * (Antigravity sign-in) to remote execution targets. Off by default, so a
 * subscription stays on the Paperclip host unless the operator chooses
 * otherwise. Agent and environment configuration cannot set it.
 *
 * When enabled:
 * - the run's selected token generation is sent to the remote Runner exactly
 *   as it is for a local Runner, and a refreshed token is read back from the
 *   remote runtime home after the provider retires (the same generation-checked
 *   copy-back and saved-credential writeback as the local path);
 * - a run's authentication failure never revokes a shared Google sign-in:
 *   sandboxes fail for reasons a run cannot tell apart from a rejected token
 *   (eviction, out-of-memory, network), and Google offers no usage probe to
 *   confirm. The failure is recorded; reconnecting is an explicit choice.
 */
export const ANTIGRAVITY_REMOTE_SUBSCRIPTION_ENV = "PAPERCLIP_ANTIGRAVITY_REMOTE_SUBSCRIPTION";

export function antigravityRemoteSubscriptionEnabled(hostEnvironment: NodeJS.ProcessEnv = process.env): boolean {
  return hostEnvironment[ANTIGRAVITY_REMOTE_SUBSCRIPTION_ENV]?.trim().toLowerCase() === "true";
}

type RemoteCommandRunner = {
  execute(input: { command: string; args: string[]; bypassSession: true; timeoutMs: number }): Promise<{
    exitCode: number | null; timedOut: boolean; stdout: string;
  }>;
};

// Reads one private credential file without following links: a regular file,
// owned by the Runner's user, mode 0600, at most 64 KiB. Exit 66 means absent.
const READ_PRIVATE_FILE = "const fs=require('node:fs');let fd;try{fd=fs.openSync(process.argv[1],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const st=fs.fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid()||(st.mode&511)!==384||st.size>65536)throw Error('credential');const b=Buffer.alloc(65537);let n=0;while(n<b.length){const k=fs.readSync(fd,b,n,b.length-n,n);if(!k)break;n+=k;}if(n>65536)throw Error('size');process.stdout.write(b.subarray(0,n).toString('base64'));b.fill(0);}catch(e){process.exitCode=e.code==='ENOENT'?66:1;}finally{if(fd!==undefined)fs.closeSync(fd);}";

/** Runtime-home file access for a Runner whose files live on a remote target. */
export function remoteAntigravityRuntimeFiles(input: { runner: RemoteCommandRunner; runtimeHome: string }) {
  const directory = posix.join(input.runtimeHome, "antigravity-acp");
  return {
    read: async (name: string): Promise<string> => {
      const result = await input.runner.execute({ command: "node", args: ["-e", READ_PRIVATE_FILE, posix.join(directory, name)],
        bypassSession: true, timeoutMs: 10_000 });
      if (result.exitCode === 66 && !result.timedOut) throw Object.assign(new Error("Google Antigravity credential is absent"), { code: "ENOENT" });
      if (result.exitCode !== 0 || result.timedOut) throw new Error("Google Antigravity credential refresh handoff is unavailable.");
      return Buffer.from(result.stdout.trim(), "base64").toString("utf8");
    },
    remove: async (names: string[]): Promise<void> => {
      const result = await input.runner.execute({ command: "rm", args: ["-f", "--", ...names.map(name => posix.join(directory, name))],
        bypassSession: true, timeoutMs: 10_000 });
      if (result.exitCode !== 0 || result.timedOut) throw new Error("Google Antigravity credential cleanup failed.");
    },
  };
}
