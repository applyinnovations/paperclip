import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { antigravityCredentialTurn, prepareAntigravityRunnerCredentials } from "./antigravity-runner-credentials.js";
import {
  ANTIGRAVITY_REMOTE_SUBSCRIPTION_ENV,
  antigravityRemoteSubscriptionEnabled,
  remoteAntigravityRuntimeFiles,
} from "./antigravity-remote-subscription.js";

const roots: string[] = [];
const credential = (token: string) => JSON.stringify({
  client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com", client_secret: "fixture-client-secret",
  refresh_token: token, token_uri: "https://oauth2.googleapis.com/token", scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"],
});
async function home() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "antigravity-remote-test-")));
  roots.push(root);
  await mkdir(join(root, "antigravity-acp"), { mode: 0o700 });
  return root;
}
/** Stands in for a remote execution target: runs the exact command locally. */
function remoteRunner(fault?: { exitCode?: number; timedOut?: boolean }) {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    execute: async (input: { command: string; args: string[] }) => {
      calls.push({ command: input.command, args: input.args });
      if (fault) return { exitCode: fault.exitCode ?? 0, timedOut: fault.timedOut ?? false, stdout: "" };
      const result = spawnSync(input.command, input.args, { encoding: "utf8" });
      return { exitCode: result.status, timedOut: false, stdout: result.stdout };
    },
  };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("Antigravity subscription on remote targets", () => {
  it("is off unless the operator sets the startup opt-in to true", () => {
    expect(antigravityRemoteSubscriptionEnabled({})).toBe(false);
    for (const value of ["1", "yes", "", "false"]) expect(antigravityRemoteSubscriptionEnabled({ [ANTIGRAVITY_REMOTE_SUBSCRIPTION_ENV]: value })).toBe(false);
    expect(antigravityRemoteSubscriptionEnabled({ [ANTIGRAVITY_REMOTE_SUBSCRIPTION_ENV]: "true" })).toBe(true);
    expect(antigravityRemoteSubscriptionEnabled({ [ANTIGRAVITY_REMOTE_SUBSCRIPTION_ENV]: " TRUE " })).toBe(true);
  });

  it("refuses a remote subscription without the opt-in", async () => {
    const managedHome = await home();
    await writeFile(join(managedHome, "antigravity-acp", "acp_token.json"), credential("fixture-selected"), { mode: 0o600 });
    await expect(prepareAntigravityRunnerCredentials({ remote: true, managedHome, environment: {} })).rejects.toThrow("not qualified for remote");
    await expect(prepareAntigravityRunnerCredentials({ remote: true, managedHome, environment: {}, remoteSubscription: false })).rejects.toThrow("not qualified for remote");
  });

  it("delivers only the selected token to a remote Runner when opted in, and still refuses warm sessions", async () => {
    const managedHome = await home();
    await writeFile(join(managedHome, "antigravity-acp", "acp_token.json"), credential("fixture-selected"), { mode: 0o600 });
    expect(await prepareAntigravityRunnerCredentials({ remote: true, remoteSubscription: true, managedHome,
      environment: { GEMINI_HOME: "/untrusted", GOOGLE_API_KEY: "ambient", PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: credential("fixture-spoofed") } })).toEqual({
      home: managedHome, credential: credential("fixture-selected"),
      environment: { PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET: credential("fixture-selected") },
    });
    await expect(prepareAntigravityRunnerCredentials({ remote: true, remoteSubscription: true, managedHome, environment: {}, lifecycleMode: "warm" }))
      .rejects.toThrow("warm sessions are not qualified");
    await expect(prepareAntigravityRunnerCredentials({ remote: true, remoteSubscription: true, environment: {} }))
      .rejects.toThrow("selected managed Google account");
  });

  it("installs the remote Runner's refreshed token in the run's home, then scrubs the remote copies", async () => {
    const managedHome = await home(), remoteHome = await home(), runner = remoteRunner();
    const destination = join(managedHome, "antigravity-acp", "acp_token.json"), remote = join(remoteHome, "antigravity-acp");
    await writeFile(destination, credential("fixture-original"), { mode: 0o600 });
    // The Runner hands a consumed refresh back as auth-refresh.json after the provider closes.
    await writeFile(join(remote, "auth-refresh.json"), credential("fixture-refreshed"), { mode: 0o600 });
    await writeFile(join(remote, "auth-refresh.json.tmp"), "partial", { mode: 0o600 });
    const turn = antigravityCredentialTurn({ managedHome, runtimeHome: "/unused-local-home", credential: credential("fixture-original"),
      runtimeFiles: remoteAntigravityRuntimeFiles({ runner, runtimeHome: remoteHome }) });
    await turn.copyBack();
    expect(await readFile(destination, "utf8")).toBe(credential("fixture-refreshed"));
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    await turn.remove();
    for (const name of ["acp_token.json", "auth-refresh.json", "auth-refresh.json.tmp"]) {
      await expect(access(join(remote, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    // Every remote command is bounded and bypasses the agent's shell session.
    expect(runner.calls.map(call => call.command)).toEqual(["node", "node", "rm"]);
  });

  it("treats a remote Runner that never started as having nothing to hand back", async () => {
    const managedHome = await home(), remoteHome = await home();
    const destination = join(managedHome, "antigravity-acp", "acp_token.json");
    await writeFile(destination, credential("fixture-original"), { mode: 0o600 });
    await antigravityCredentialTurn({ managedHome, runtimeHome: "/unused", credential: credential("fixture-original"),
      runtimeFiles: remoteAntigravityRuntimeFiles({ runner: remoteRunner(), runtimeHome: remoteHome }) }).copyBack();
    expect(await readFile(destination, "utf8")).toBe(credential("fixture-original"));
  });

  it("serialises concurrent copy-backs under the home lock: one refresh wins, the other never clobbers it", async () => {
    const managedHome = await home(), first = await home(), second = await home();
    const destination = join(managedHome, "antigravity-acp", "acp_token.json");
    await writeFile(destination, credential("fixture-original"), { mode: 0o600 });
    await writeFile(join(first, "antigravity-acp", "acp_token.json"), credential("fixture-refreshed-a"), { mode: 0o600 });
    await writeFile(join(second, "antigravity-acp", "acp_token.json"), credential("fixture-refreshed-b"), { mode: 0o600 });
    const turn = (runtimeHome: string) => antigravityCredentialTurn({ managedHome, runtimeHome: "/unused", credential: credential("fixture-original"),
      runtimeFiles: remoteAntigravityRuntimeFiles({ runner: remoteRunner(), runtimeHome }) });
    const results = await Promise.allSettled([turn(first).copyBack(), turn(second).copyBack()]);
    const won = results.findIndex(result => result.status === "fulfilled");
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results[1 - won]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("destination changed") }) });
    expect(await readFile(destination, "utf8")).toBe(credential(won === 0 ? "fixture-refreshed-a" : "fixture-refreshed-b"));
    // The losing refresh is left in its own runtime home for the retained-cleanup owner.
    expect(await readFile(join(won === 0 ? second : first, "antigravity-acp", "acp_token.json"), "utf8"))
      .toBe(credential(won === 0 ? "fixture-refreshed-b" : "fixture-refreshed-a"));
  });

  it.each([
    ["an unreachable target", { exitCode: 1 }],
    ["a timed-out read", { exitCode: null as unknown as number, timedOut: true }],
  ])("keeps the selected token on %s and fails closed", async (_label, fault) => {
    const managedHome = await home(), remoteHome = await home();
    const destination = join(managedHome, "antigravity-acp", "acp_token.json");
    await writeFile(destination, credential("fixture-original"), { mode: 0o600 });
    await writeFile(join(remoteHome, "antigravity-acp", "acp_token.json"), credential("fixture-refreshed"), { mode: 0o600 });
    const turn = antigravityCredentialTurn({ managedHome, runtimeHome: "/unused", credential: credential("fixture-original"),
      runtimeFiles: remoteAntigravityRuntimeFiles({ runner: remoteRunner(fault), runtimeHome: remoteHome }) });
    await expect(turn.copyBack()).rejects.toThrow("handoff is invalid");
    await expect(turn.remove()).rejects.toThrow("cleanup failed");
    expect(await readFile(destination, "utf8")).toBe(credential("fixture-original"));
    // Nothing was scrubbed: the remote refresh survives for a retry.
    expect(await readFile(join(remoteHome, "antigravity-acp", "acp_token.json"), "utf8")).toBe(credential("fixture-refreshed"));
  });

  it("refuses a remote token that is not a private regular file", async () => {
    const managedHome = await home(), remoteHome = await home();
    const destination = join(managedHome, "antigravity-acp", "acp_token.json"), source = join(remoteHome, "antigravity-acp", "acp_token.json");
    await writeFile(destination, credential("fixture-original"), { mode: 0o600 });
    await writeFile(source, credential("fixture-refreshed"), { mode: 0o600 });
    await chmod(source, 0o644);
    await expect(antigravityCredentialTurn({ managedHome, runtimeHome: "/unused", credential: credential("fixture-original"),
      runtimeFiles: remoteAntigravityRuntimeFiles({ runner: remoteRunner(), runtimeHome: remoteHome }) }).copyBack()).rejects.toThrow("handoff is invalid");
    expect(await readFile(destination, "utf8")).toBe(credential("fixture-original"));
  });
});
