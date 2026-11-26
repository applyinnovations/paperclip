import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";
const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("managed GitHub launchers", () => {

  it("uses a private interpreter without selecting Node from PATH", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-interpreter-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const managed = path.join(root, "managed"), real = path.join(root, "real");
    await mkdir(managed); await mkdir(real);
    const source = githubLauncherSource({ interpreterPath: process.execPath });
    const defaultSource = githubLauncherSource();
    expect(defaultSource.split("\n")[0]).toBe("#!/usr/bin/env node");
    expect(source.split("\n")[0]).toBe(`#!${process.execPath}`);
    expect(source.slice(source.indexOf("\n"))).toBe(defaultSource.slice(defaultSource.indexOf("\n")));
    const launcher = path.join(managed, "git");
    await writeFile(launcher, source, { mode: 0o700 });
    await writeFile(path.join(real, "node"), "#!/bin/sh\nexit 126\n", { mode: 0o700 });
    await writeFile(path.join(real, "git"), "#!/bin/sh\nprintf 'private interpreter works'\n", { mode: 0o700 });
    const env = { ...githubBrokerEnvironment({}, { url: "", token: "" }), HOME: root,
      GH_CONFIG_DIR: path.join(root, "config"), PATH: `${managed}${path.delimiter}${real}` };
    expect((await exec(launcher, ["--version"], { env })).stdout).toBe("private interpreter works");
  });

  it.each(["", "relative/node", "/runtime/node --flag", "/runtime/node\nexit 1", "/runtime/node\0"])(
    "rejects an invalid interpreter path %j", interpreterPath => {
      expect(() => githubLauncherSource({ interpreterPath })).toThrow("absolute path without whitespace");
    },
  );
  it.each([false, true])("rejects a PATH shim that re-enters the same helper before it can recurse (broker file: %s)", async brokerFile => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-recursion-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const managed = path.join(root, "managed"), shim = path.join(root, "shim"), calls = path.join(root, "calls");
    await mkdir(managed); await mkdir(shim);
    const launcher = path.join(managed, "git");
    await writeFile(launcher, githubLauncherSource({ brokerFile }), { mode: 0o700 });
    // Bound the pre-fix reproduction: the fixture stops at three invocations.
    await writeFile(path.join(shim, "git"), `#!${process.execPath}
const fs = require("node:fs"), {spawnSync} = require("node:child_process");
fs.appendFileSync(${JSON.stringify(calls)}, "call\\n");
if (fs.readFileSync(${JSON.stringify(calls)}, "utf8").trim().split("\\n").length >= 3) process.exit(99);
const result = spawnSync(${JSON.stringify(launcher)}, process.argv.slice(2), {env: process.env, stdio: "inherit"});
process.exit(result.status ?? 98);
`, { mode: 0o700 });
    const env = { ...process.env, ...githubBrokerEnvironment({}, {url: "", token: ""}),
      PATH: `${managed}${path.delimiter}${shim}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin` };
    await expect(exec(launcher, ["--version"], {env, timeout: 5000})).rejects.toMatchObject({
      code: 126, stderr: expect.stringContaining("launcher_recursion_rejected"),
    });
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(["call"]);
  });

  it("snapshots a staged tree and reports unstaged files without capturing GitHub credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-snapshot-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), repo = path.join(root, "repo");
    await mkdir(bin); await mkdir(repo);
    await exec("git", ["init", "-q", repo]);
    await writeFile(path.join(repo, "tracked.txt"), "staged contents\n");
    await exec("git", ["-C", repo, "add", "tracked.txt"]);
    const expectedTree = (await exec("git", ["-C", repo, "write-tree"])).stdout;
    await writeFile(path.join(repo, "tracked.txt"), "unstaged contents\n");
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    let captures = 0;
    const server = createServer((_req, res) => {
      captures++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "unavailable", reason: "No GitHub connection" }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const env = { ...process.env, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "run-capability" }), PATH: `${bin}:${process.env.PATH}` };
    const git = (...args: string[]) => exec(path.join(bin, "git"), args, { cwd: root, env });
    const tree = await git("--git-dir", path.join(repo, ".git"), "--work-tree", repo, "write-tree");
    const diff = await git("-C", repo, "-c", "core.quotepath=false", "diff-files", "--name-only", "-z", "--", ".");
    expect(tree.stdout).toBe(expectedTree);
    expect(diff.stdout).toBe("tracked.txt\0");
    expect(captures).toBe(0);
  });

  it.each(["missing", "absent", "unavailable", "rejected"])("commits local work without an identity when GitHub access is %s", async (access) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-default-author-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", root]);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const server = createServer((_req, res) => {
      res.writeHead(access === "rejected" ? 403 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: access, env: {
        GH_TOKEN: "rejected-token", GIT_AUTHOR_NAME: "Rejected", GIT_AUTHOR_EMAIL: "rejected@example.test",
        GIT_COMMITTER_NAME: "Rejected", GIT_COMMITTER_EMAIL: "rejected@example.test",
      } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const env = { ...process.env, ...githubBrokerEnvironment({
      GH_TOKEN: "host-token", GIT_AUTHOR_NAME: "Host", GIT_AUTHOR_EMAIL: "host@example.test",
      GIT_COMMITTER_NAME: "Host", GIT_COMMITTER_EMAIL: "host@example.test",
    }, { url: `http://127.0.0.1:${port}`, token: access === "missing" ? "" : "run-capability" }),
      PATH: `${bin}:${process.env.PATH}` };
    await writeFile(path.join(root, "work.txt"), "saved work\n");
    await exec(path.join(bin, "git"), ["add", "work.txt"], { cwd: root, env });
    await exec(path.join(bin, "git"), ["commit", "-m", "Save local work"], { cwd: root, env });
    expect((await exec("git", ["-C", root, "log", "-1", "--format=%an <%ae>|%cn <%ce>"])).stdout.trim())
      .toBe("Paperclip <noreply@paperclip.ing>|Paperclip <noreply@paperclip.ing>");
    expect((await exec("git", ["-C", root, "show", "HEAD:work.txt"])).stdout).toBe("saved work\n");
    await expect(exec("git", ["-C", root, "config", "--local", "--get", "user.name"])).rejects.toThrow();
    await expect(exec("git", ["-C", root, "config", "--local", "--get", "user.email"])).rejects.toThrow();
  });
  it.each(["repository", "command"])("uses explicit %s identity for local commits without managed credentials", async (identitySource) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-local-identity-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", root]);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const env = { ...process.env, ...githubBrokerEnvironment({
      GH_TOKEN: "host-token", GIT_AUTHOR_NAME: "Host", GIT_COMMITTER_NAME: "Host",
    }, { url: "", token: "" }), PATH: `${bin}:${process.env.PATH}` };
    const git = async (...args: string[]) => (await exec(path.join(bin, "git"), args, { cwd: root, env })).stdout.trim();
    expect(await git("var", "GIT_AUTHOR_IDENT")).toMatch(/^Paperclip <noreply@paperclip.ing>/);
    expect(await git("var", "GIT_COMMITTER_IDENT")).toMatch(/^Paperclip <noreply@paperclip.ing>/);
    if (identitySource === "repository") {
      await git("config", "user.name", "Local Author");
      await git("config", "user.email", "local@example.test");
    }
    await git(...(identitySource === "command" ? ["-c", "user.name=Local Author", "-c", "user.email=local@example.test"] : []),
      "commit", "--allow-empty", "-m", "Local work");
    expect(await git("log", "-1", "--format=%an <%ae>|%cn <%ce>"))
      .toBe("Local Author <local@example.test>|Local Author <local@example.test>");
  });

  it.each(["broker-offline", "config-unwritable", "capability-rejected"])("keeps real local Git usable when %s", async (failure) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-failure-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", root]);
    await exec("git", ["-C", root, "config", "user.name", "Local Author"]);
    await exec("git", ["-C", root, "config", "user.email", "local@example.test"]);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const server = createServer((_req, res) => { res.writeHead(403); res.end(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    if (failure === "broker-offline") await new Promise<void>(resolve => server.close(() => resolve()));
    else cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const configRoot = path.join(root, "config");
    if (failure === "config-unwritable") await writeFile(configRoot, "not a directory");
    const result = await exec(path.join(bin, "git"), ["remote"], { cwd: root, env: {
      ...process.env, ...githubBrokerEnvironment({ GH_TOKEN: "host-must-not-leak" }, { url: `http://127.0.0.1:${port}`, token: "private-capability" }),
      GH_CONFIG_DIR: configRoot, PATH: `${bin}:${process.env.PATH}`,
    } });
    expect(result.stderr).toContain(failure === "broker-offline" ? "broker_transport_unavailable" : failure === "config-unwritable" ? "configuration_directory_unavailable" : "capability_rejected");
    expect(result.stderr).not.toMatch(/host-must-not-leak|private-capability/);
    await exec(path.join(bin, "git"), ["commit", "--allow-empty", "-m", "Offline work"], { cwd: root, env: {
      ...process.env, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "private-capability" }),
      GH_CONFIG_DIR: configRoot, PATH: `${bin}:${process.env.PATH}`,
    } });
  }, 15_000); // broker-offline retries the transport twice per command before it falls back
  it("falls back to the run's API URL (the callback bridge) when the broker URL can't be reached", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-bridge-fallback-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", root]);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const offline = createServer((_req, res) => { res.writeHead(500); res.end(); });
    await new Promise<void>(resolve => offline.listen(0, "127.0.0.1", resolve));
    const offlinePort = (offline.address() as { port: number }).port;
    await new Promise<void>(resolve => offline.close(() => resolve()));
    const seen: Array<{ url?: string; capability?: string | string[] }> = [];
    const bridge = createServer((req, res) => {
      seen.push({ url: req.url, capability: req.headers["x-paperclip-github-capability"] });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "available", env: {
        GIT_AUTHOR_NAME: "Bridge Bot", GIT_AUTHOR_EMAIL: "bridge@example.test",
        GIT_COMMITTER_NAME: "Bridge Bot", GIT_COMMITTER_EMAIL: "bridge@example.test",
      } }));
    });
    await new Promise<void>(resolve => bridge.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => bridge.close(() => resolve())));
    const bridgePort = (bridge.address() as { port: number }).port;
    const env = { ...process.env, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${offlinePort}`, token: "run-capability" }),
      PAPERCLIP_API_URL: `http://127.0.0.1:${bridgePort}/api`, PATH: `${bin}:${process.env.PATH}` };
    const result = await exec(path.join(bin, "git"), ["commit", "--allow-empty", "-m", "Through the bridge"], { cwd: root, env });
    expect(result.stderr).not.toContain("broker_transport_unavailable");
    expect(seen).toEqual([{ url: "/runtime-tools/github/credentials", capability: "run-capability" }]);
    expect((await exec("git", ["-C", root, "log", "-1", "--format=%an <%ae>"])).stdout.trim()).toBe("Bridge Bot <bridge@example.test>");
  });

  it("explains unavailable access while allowing local work without credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-diagnostic-"));
    cleanups.push(() => rm(root, {recursive:true,force:true}));
    const bin = path.join(root,"managed"), realBin = path.join(root,"real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin,"gh"), githubLauncherSource(), {mode:0o700});
    await writeFile(path.join(realBin,"gh"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({token:process.env.GH_TOKEN ?? null}));', {mode:0o700});
    const server = createServer((_req,res) => {
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify({status:"unavailable",reason:"More than one managed GitHub identity matches this run",env:{GH_TOKEN:"must-not-be-used"}}));
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    cleanups.push(() => new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())));
    const {port} = server.address() as {port:number};
    const result = await exec(path.join(bin,"gh"), [], {env:{...process.env,...githubBrokerEnvironment({GH_TOKEN:"host-token"},{url:`http://127.0.0.1:${port}`,token:"run-capability"}),PATH:`${bin}:${realBin}:${process.env.PATH}`}});
    expect(JSON.parse(result.stdout)).toEqual({token:null});
    expect(result.stderr).toContain("More than one managed GitHub identity matches this run");
    expect(result.stderr).not.toMatch(/host-token|must-not-be-used|run-capability/);
  });
  it("sends repository creation and forks to the connection's tools when a connection is in use", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-repository-tools-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), realBin = path.join(root, "real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin, "gh"), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(realBin, "gh"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),token:process.env.GH_TOKEN ?? null}));', { mode: 0o700 });
    let status = "available";
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status, env: { GH_TOKEN: "managed-token" } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const env = { ...process.env, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "run-capability" }),
      PATH: `${bin}:${realBin}:${process.env.PATH}` };
    const gh = (...args: string[]) => exec(path.join(bin, "gh"), args, { env });
    for (const [args, tool] of [
      [["repo", "create", "demo", "--private"], "create_repository"],
      [["repo", "new", "demo"], "create_repository"],
      [["repo", "fork", "octo-org/tools", "--org", "acme"], "fork_repository"],
    ] as const) {
      const failure = await gh(...args).catch((error: { code?: number; stdout?: string; stderr?: string }) => error);
      expect(failure).toMatchObject({ code: 1, stdout: "" });
      expect(failure.stderr).toContain(`GitHub connection's ${tool} tool`);
      expect(failure.stderr).not.toContain("managed-token");
    }
    expect(JSON.parse((await gh("repo", "create", "--help")).stdout))
      .toEqual({ args: ["repo", "create", "--help"], token: "managed-token" });
    expect(JSON.parse((await gh("repo", "view", "octo-org/tools")).stdout))
      .toEqual({ args: ["repo", "view", "octo-org/tools"], token: "managed-token" });
    // Without a connection there are no connection tools; gh runs unchanged.
    status = "absent";
    expect(JSON.parse((await gh("repo", "create", "demo")).stdout)).toEqual({ args: ["repo", "create", "demo"], token: null });
  });
  it.each(["before-write", "partial-write"])("keeps Git and managed credentials available after a %s failure", async (failure) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-default-write-failure-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), realBin = path.join(root, "real");
    await mkdir(bin); await mkdir(realBin);
    await exec("git", ["init", root]);
    for (const name of ["git", "gh"]) await writeFile(path.join(bin, name), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(realBin, "gh"), '#!/usr/bin/env node\nprocess.stdout.write(process.env.GH_TOKEN || "anonymous");', { mode: 0o700 });
    const fault = path.join(root, "write-fault.cjs");
    await writeFile(fault, `const fs = require('node:fs'); const write = fs.writeFileSync;
fs.writeFileSync = (file, ...args) => {
  if (String(file).endsWith('/gitconfig')) {
    if (${failure === "partial-write"}) write(file, '[user', { mode: 0o600 });
    throw new Error('fixture disk full');
  }
  return write(file, ...args);
};`);
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "available", env: { GH_TOKEN: "managed-token" } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const env = {
      ...process.env, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "run-capability" }),
      PATH: `${bin}:${realBin}:${process.env.PATH}`,
    };
    const result = await exec(process.execPath, ["--require", fault, path.join(bin, "gh")], { cwd: root, env });
    expect(result.stdout).toBe("managed-token");
    expect(result.stderr).toContain("configuration_directory_unavailable");
    const git = (...args: string[]) => exec(process.execPath, ["--require", fault, path.join(bin, "git"), ...args], { cwd: root, env });
    expect((await git("status", "--porcelain", "--untracked-files=no")).stdout).toBe("");
    await expect(git("commit", "--allow-empty", "-m", "No default")).rejects.toMatchObject({ stderr: expect.stringContaining("Author identity unknown") });
    await git("-c", "user.name=Explicit", "-c", "user.email=explicit@example.test", "commit", "--allow-empty", "-m", "Explicit identity");
    expect((await exec("git", ["-C", root, "log", "-1", "--format=%an <%ae>|%cn <%ce>"])).stdout.trim())
      .toBe("Explicit <explicit@example.test>|Explicit <explicit@example.test>");
  });
  // The first broker request fails, the second succeeds: the managed token must still reach gh.
  it.each([
    ["connection drops before the response", (res: import("node:http").ServerResponse) => { res.socket?.destroy(); }],
    ["body read fails mid-response", (res: import("node:http").ServerResponse) => {
      res.writeHead(200, {"content-type":"application/json"}); res.write('{"status":'); setTimeout(() => res.socket?.destroy(), 20);
    }],
  ])("retries when the %s and still uses managed credentials", async (_label, fail) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-retry-"));
    cleanups.push(() => rm(root, {recursive:true,force:true}));
    const bin = path.join(root,"managed"), realBin = path.join(root,"real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin,"gh"), githubLauncherSource(), {mode:0o700});
    await writeFile(path.join(realBin,"gh"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({token:process.env.GH_TOKEN ?? null}));', {mode:0o700});
    let requests = 0;
    const server = createServer((_req,res) => {
      requests++;
      if (requests === 1) return fail(res);
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify({status:"available",env:{GH_TOKEN:"managed-token"}}));
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const {port} = server.address() as {port:number};
    const result = await exec(path.join(bin,"gh"), [], {env:{...process.env,...githubBrokerEnvironment({GH_TOKEN:"host-token"},{url:`http://127.0.0.1:${port}`,token:"run-capability"}),PATH:`${bin}:${realBin}:${process.env.PATH}`}});
    expect(JSON.parse(result.stdout)).toEqual({token:"managed-token"});
    expect(requests).toBe(2);
    expect(result.stderr).not.toContain("broker_transport_unavailable");
    expect(result.stderr).not.toMatch(/host-token|run-capability/);
  });
  it("captures each command's identity and clears host credentials when the next person has none", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-launcher-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), realBin = path.join(root, "real"), repo = path.join(root, "repo");
    for (const dir of [bin, realBin, repo, path.join(bin, "gh-config")]) await mkdir(dir, { recursive: true });
    for (const name of ["git", "gh"]) await writeFile(path.join(bin, name), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(realBin, "gh"), `#!/usr/bin/env node
const {execFileSync}=require('node:child_process');
const identity=execFileSync('git',['var','GIT_AUTHOR_IDENT'],{encoding:'utf8'}).trim();
process.stdout.write(JSON.stringify({identity, token:process.env.GH_TOKEN ?? null, global:process.env.GIT_CONFIG_GLOBAL, config:process.env.GH_CONFIG_DIR}));
`, { mode: 0o700 });
    let user: string | null = "A", captures = 0;
    let heldCapture: (() => void) | null = null;
    let releaseCapture: (() => void) | null = null;
    const server = createServer((req, res) => {
      captures++;
      expect(req.headers.authorization).toBe("Bearer run-capability");
      const selected = user;
      res.setHeader("content-type", "application/json");
      const finish = () => res.end(JSON.stringify(selected ? { status: "available", env: {
        GH_TOKEN: `credential-${selected}`, GITHUB_TOKEN: `credential-${selected}`,
        GIT_AUTHOR_NAME: selected, GIT_AUTHOR_EMAIL: `${selected}@example.test`,
        GIT_COMMITTER_NAME: selected, GIT_COMMITTER_EMAIL: `${selected}@example.test`,
      } } : { status: "absent", env: {} }));
      if (heldCapture) { const captured = heldCapture; heldCapture = null; releaseCapture = finish; captured(); }
      else finish();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address() as { port: number };
    const env: NodeJS.ProcessEnv = { ...process.env, ...githubBrokerEnvironment({
      GH_TOKEN: "ambient-host-token", GIT_AUTHOR_NAME: "Host", GIT_AUTHOR_EMAIL: "host@example.test",
    }, { url: `http://127.0.0.1:${address.port}`, token: "run-capability" }), PATH: `${bin}:${realBin}:${process.env.PATH}` };
    const git = async (...args: string[]) => (await exec(path.join(bin, "git"), args, { cwd: repo, env })).stdout.trim();
    await git("init");
    await git("config", "user.name", "Repository Author");
    await git("config", "user.email", "repository@example.test");
    await git("commit", "--allow-empty", "-m", "A");
    user = "B";
    await git("commit", "--allow-empty", "-m", "B");
    user = "A";
    await git("commit", "--allow-empty", "-m", "A again");
    expect(await git("log", "--format=%an <%ae>|%cn <%ce>" )).toBe("A <A@example.test>|A <A@example.test>\nB <B@example.test>|B <B@example.test>\nA <A@example.test>|A <A@example.test>");
    const before = captures;
    const gh = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    expect(gh.identity).toContain("A <A@example.test>");
    expect(gh.token).toBe("credential-A");
    expect(captures - before).toBe(1); // gh's child Git retains the same capture.
    const captured = new Promise<void>(resolve => { heldCapture = resolve; });
    const operationA = exec(path.join(bin, "gh"), [], { cwd: repo, env });
    await captured;
    user = "B";
    const operationB = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    releaseCapture!();
    const completedA = JSON.parse((await operationA).stdout);
    expect(completedA.token).toBe("credential-A");
    expect(operationB.token).toBe("credential-B");
    expect(completedA.config).not.toBe(operationB.config);
    user = null;
    await git("commit", "--allow-empty", "-m", "Local identity");
    expect(await git("log", "-1", "--format=%an <%ae>|%cn <%ce>"))
      .toBe("Repository Author <repository@example.test>|Repository Author <repository@example.test>");
    const anonymous = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    expect(anonymous.token).toBeNull();
    await git("config", "--unset", "user.name");
    await git("config", "--unset", "user.email");
    await git("commit", "--allow-empty", "-m", "Default identity after revocation");
    expect(await git("log", "-1", "--format=%an <%ae>|%cn <%ce>"))
      .toBe("Paperclip <noreply@paperclip.ing>|Paperclip <noreply@paperclip.ing>");
    expect(await git("status", "--porcelain")).toBe(""); // unrelated public/local Git still works
    expect(env.GH_TOKEN).toBe("");
    expect(env.GIT_AUTHOR_NAME).toBe("");
  });
  it("keeps local Git commands off the broker and still asks for the rest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-local-skip-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    let posts = 0;
    const server = createServer((_req, res) => {
      posts++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "available", env: {
        GH_TOKEN: "managed-token", GIT_AUTHOR_NAME: "Managed", GIT_AUTHOR_EMAIL: "managed@example.test",
        GIT_COMMITTER_NAME: "Managed", GIT_COMMITTER_EMAIL: "managed@example.test",
      } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const env = { ...process.env, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "run-capability" }), PATH: `${bin}:${process.env.PATH}` };
    const git = async (...args: string[]) => {
      const before = posts;
      const { stdout } = await exec(path.join(bin, "git"), args, { cwd: root, env }).catch(() => ({ stdout: "" }));
      return { stdout: stdout.trim(), posts: posts - before };
    };
    for (const args of [
      ["init", "-q", "repo"],
      ["-C", "repo", "status", "--short"],
      ["-C", "repo", "-c", "core.quotepath=off", "--no-pager", "diff"],
      ["--git-dir=repo/.git", "rev-parse", "--git-dir"],
      ["--git-dir", "repo/.git", "--work-tree", "repo", "status"],
      ["-C", "repo", "config", "user.useConfigOnly"],
      ["--version"],
    ]) expect((await git(...args)).posts, args.join(" ")).toBe(0);
    expect((await git("-C", "repo", "config", "user.useConfigOnly")).stdout).toBe("true");
    for (const args of [
      ["-C", "repo", "remote"],
      ["-C", "repo", "var", "GIT_AUTHOR_IDENT"],
      ["-C", "repo", "fetch", "--dry-run"],
      ["-C", "repo", "-c", "alias.noop=!true", "noop"],
      ["-C", "repo", "--unknown-option", "status"],
      ["-C"],
    ]) expect((await git(...args)).posts, args.join(" ")).toBe(1);
    expect((await git("-C", "repo", "var", "GIT_AUTHOR_IDENT")).stdout).toMatch(/^Managed <managed@example.test>/);
    expect((await git("-C", "repo", "commit", "--allow-empty", "-m", "Managed work")).posts).toBe(1);
    expect((await git("-C", "repo", "log", "-1", "--format=%an <%ae>")).stdout).toBe("Managed <managed@example.test>");
  }, 20_000);
});

it("captures the current task broker file once per invocation and never falls back to inherited authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-task-github-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "managed"), real = path.join(root, "real");
  await mkdir(bin); await mkdir(real);
  await writeFile(path.join(bin, "gh"), githubLauncherSource({ brokerFile: true }), { mode: 0o700 });
  await writeFile(path.join(real, "gh"), '#!/usr/bin/env node\nprocess.stdout.write(process.env.GH_TOKEN || "anonymous");\n', { mode: 0o700 });
  const captured: string[] = [];
  const server = createServer((req, res) => {
    captured.push(req.headers.authorization!);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "available", env: { GH_TOKEN: req.headers.authorization!.slice(7) + "-credential" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = { ...process.env, PATH: `${bin}:${real}:${process.env.PATH}`, GH_TOKEN: "ambient-secret",
    PAPERCLIP_GITHUB_BROKER_URL: url, PAPERCLIP_GITHUB_BROKER_TOKEN: "stale-capability", PAPERCLIP_API_KEY: "unrelated-api-key" };
  const run = () => exec(path.join(bin, "gh"), [], { env });
  for (const token of ["first-run", "next-run"]) {
    await writeFile(path.join(bin, "broker.json"), JSON.stringify({ url, token }));
    expect((await run()).stdout).toBe(token + "-credential");
  }
  await rm(path.join(bin, "broker.json"));
  expect((await run()).stdout).toBe("anonymous");
  expect(captured).toEqual(["Bearer first-run", "Bearer next-run"]);
});

describe("managed push provenance reports", () => {
  const before = "cd24b048da21e60a9fb6fdc45051c403fc2cd86e";
  const after = "7d091de1de2e70c45b98967fdfca3dd3820bf4f2";
  const other = "1111111111111111111111111111111111111111";
  const secondBefore = "2222222222222222222222222222222222222222";
  const secondAfter = "3333333333333333333333333333333333333333";
  const hookBefore = "4444444444444444444444444444444444444444";
  const hookAfter = "5555555555555555555555555555555555555555";
  // Interleaved GIT_TRACE_PACKET + GIT_TRACE2_EVENT lines in git's append-file order.
  // The receive-pack lines (local transports) must be ignored; tokens in URLs are redacted by git.
  const defaultTrace = [
    JSON.stringify({ event: "start", sid: "S0", argv: ["git", "push", "--force", "origin", "main", "rejected"] }),
    JSON.stringify({ event: "child_start", sid: "S0", child_id: 0, child_class: "remote-https",
      argv: ["git", "remote-https", "origin", "https://x-access-token:<REDACTED>@github.com/Acme/Widgets.git"] }),
    `11:05:53.072437 pkt-line.c:85           packet:          git< ${before} refs/heads/main\\0report-status delete-refs side-band-64k`,
    `11:05:53.072460 pkt-line.c:85           packet:          git< ${other} refs/heads/rejected`,
    JSON.stringify({ event: "child_start", sid: "S0/S1/S2", child_id: 0, child_class: "?",
      argv: ["git", "send-pack", "--stateless-rpc", "--helper-status", "--thin", "--no-progress",
        "https://x-access-token:<REDACTED>@github.com/Acme/Widgets.git/", "--stdin"] }),
    `11:05:53.072654 pkt-line.c:85           packet:          git> ${before} ${after} refs/heads/main\\0 report-status-v2 side-band-64k quiet`,
    `11:05:53.072655 pkt-line.c:85           packet:          git> ${other} ${after} refs/heads/rejected`,
    `11:05:53.072656 pkt-line.c:85           packet: receive-pack< ${other} ${before} refs/heads/forged`,
    `11:05:53.072664 pkt-line.c:85           packet:          git> 0000`,
    `11:05:53.091804 pkt-line.c:85           packet:     sideband< \\1000eunpack ok0017ok refs/heads/main0000`,
    `11:05:53.091836 pkt-line.c:85           packet:          git< unpack ok`,
    `11:05:53.091846 pkt-line.c:85           packet:          git< ok refs/heads/main`,
    `11:05:53.091847 pkt-line.c:85           packet:          git< ng refs/heads/rejected protected branch hook declined`,
    JSON.stringify({ event: "child_exit", sid: "S0/S1/S2", child_id: 0, code: 0 }),
    JSON.stringify({ event: "child_exit", sid: "S0", child_id: 0, code: 0 }),
  ].join("\n") + "\n";

  async function fixture(options: { trace?: string; status?: number; brokerStatus?: number } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-push-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), real = path.join(root, "real"), seenEnv = path.join(root, "env.json");
    await mkdir(bin); await mkdir(real);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(real, "git"), `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(seenEnv)}, JSON.stringify({ packet: process.env.GIT_TRACE_PACKET || null, trace2: process.env.GIT_TRACE2_EVENT || null }));
if (process.argv[2] === "push" && process.env.GIT_TRACE_PACKET) {
  fs.appendFileSync(process.env.GIT_TRACE_PACKET, ${JSON.stringify(options.trace ?? defaultTrace)});
}
process.exit(${options.status ?? 0});
`, { mode: 0o700 });
    const reports: Array<{ headers: Record<string, unknown>; body: unknown }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        if (req.url === "/runtime-tools/github/push-attempts") {
          reports.push({ headers: { capability: req.headers["x-paperclip-github-capability"] }, body: JSON.parse(body) });
          res.writeHead(options.brokerStatus ?? 200, { "content-type": "application/json" });
          res.end(JSON.stringify({ recorded: 1 }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "available", env: { GH_TOKEN: "secret-installation-token" } }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const env = { ...process.env, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "run-capability" }),
      GH_CONFIG_DIR: path.join(root, "config"), PATH: `${bin}${path.delimiter}${real}${path.delimiter}${process.env.PATH}` };
    const run = (args: string[]) => exec(path.join(bin, "git"), args, { env, cwd: root });
    const tracedWith = async () => JSON.parse(await readFile(seenEnv, "utf8")) as { packet: string | null; trace2: string | null };
    return { run, reports, tracedWith, root };
  }

  it("reports exactly the ref updates the remote received, with the remote's per-ref result", async () => {
    const { run, reports, tracedWith } = await fixture();
    await run(["push", "--force", "origin", "main", "rejected"]);
    expect(reports).toEqual([{ headers: { capability: "run-capability" }, body: {
      repository: "acme/widgets", exitCode: 0, forced: true,
      updates: [
        { ref: "refs/heads/main", before, after, result: "ok" },
        { ref: "refs/heads/rejected", before: other, after, result: "ng" },
      ],
    } }]);
    // No URL, token or trace text leaves the launcher, and the private trace file is gone.
    expect(JSON.stringify(reports)).not.toMatch(/secret|REDACTED|x-access-token|https:/);
    const traced = await tracedWith();
    expect(traced.packet).toMatch(/push-packets\.trace$/);
    expect(traced.trace2).toBe(traced.packet);
    await expect(readFile(traced.packet!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("emits separate per-transport reports across multiple push URLs with the same ref, different SHAs, and mixed results", async () => {
    const multiPushUrlTrace = [
      JSON.stringify({ event: "start", sid: "S0", argv: ["git", "push", "origin", "main", "feature"] }),
      // First pushurl: acme/first (main ok, feature ng)
      JSON.stringify({ event: "child_start", sid: "S0", child_id: 0, child_class: "remote-https",
        argv: ["git", "remote-https", "origin", "https://x-access-token:<REDACTED>@github.com/Acme/First.git"] }),
      JSON.stringify({ event: "child_start", sid: "S0/S1/S2", child_id: 0, child_class: "?",
        argv: ["git", "send-pack", "--stateless-rpc", "--helper-status", "--thin", "--no-progress",
          "https://x-access-token:<REDACTED>@github.com/Acme/First.git/", "--stdin"] }),
      `11:05:53.010001 pkt-line.c:85           packet:          git> ${before} ${after} refs/heads/main\\0 report-status-v2`,
      `11:05:53.010002 pkt-line.c:85           packet:          git> ${other} ${after} refs/heads/feature`,
      `11:05:53.020001 pkt-line.c:85           packet:          git< unpack ok`,
      `11:05:53.020002 pkt-line.c:85           packet:          git< ok refs/heads/main`,
      `11:05:53.020003 pkt-line.c:85           packet:          git< ng refs/heads/feature protected branch`,
      JSON.stringify({ event: "child_exit", sid: "S0/S1/S2", child_id: 0, code: 1 }),
      JSON.stringify({ event: "child_exit", sid: "S0", child_id: 0, code: 1 }),
      // Second pushurl: acme/second (same ref names, different before/after SHAs, opposite ok/ng results)
      JSON.stringify({ event: "child_start", sid: "S0", child_id: 1, child_class: "remote-https",
        argv: ["git", "remote-https", "origin", "https://x-access-token:<REDACTED>@github.com/Acme/Second.git"] }),
      JSON.stringify({ event: "child_start", sid: "S0/S3/S4", child_id: 0, child_class: "?",
        argv: ["git", "send-pack", "--stateless-rpc", "--helper-status", "--thin", "--no-progress",
          "https://x-access-token:<REDACTED>@github.com/Acme/Second.git/", "--stdin"] }),
      `11:05:53.030001 pkt-line.c:85           packet:          git> ${secondBefore} ${secondAfter} refs/heads/main\\0 report-status-v2`,
      `11:05:53.030002 pkt-line.c:85           packet:          git> ${hookBefore} ${hookAfter} refs/heads/feature`,
      `11:05:53.040001 pkt-line.c:85           packet:          git< unpack ok`,
      `11:05:53.040002 pkt-line.c:85           packet:          git< ng refs/heads/main pre-receive hook declined`,
      `11:05:53.040003 pkt-line.c:85           packet:          git< ok refs/heads/feature`,
      JSON.stringify({ event: "child_exit", sid: "S0/S3/S4", child_id: 0, code: 1 }),
      JSON.stringify({ event: "child_exit", sid: "S0", child_id: 1, code: 1 }),
    ].join("\n") + "\n";

    const { run, reports } = await fixture({ trace: multiPushUrlTrace, status: 1 });
    await expect(run(["push", "origin", "main", "feature"])).rejects.toMatchObject({ code: 1 });
    expect(reports).toEqual([
      {
        headers: { capability: "run-capability" },
        body: {
          repository: "acme/first",
          exitCode: 1,
          forced: false,
          updates: [
            { ref: "refs/heads/main", before, after, result: "ok" },
            { ref: "refs/heads/feature", before: other, after, result: "ng" },
          ],
        },
      },
      {
        headers: { capability: "run-capability" },
        body: {
          repository: "acme/second",
          exitCode: 1,
          forced: false,
          updates: [
            { ref: "refs/heads/main", before: secondBefore, after: secondAfter, result: "ng" },
            { ref: "refs/heads/feature", before: hookBefore, after: hookAfter, result: "ok" },
          ],
        },
      },
    ]);
  });

  it("keeps a pre-push hook's nested transports separate from the outer push and ignores non-GitHub transports", async () => {
    const hookTrace = [
      JSON.stringify({ event: "start", sid: "S0", argv: ["git", "push", "origin", "main"] }),
      // Outer remote-https starts and pauses while pre-push hook runs
      JSON.stringify({ event: "child_start", sid: "S0", child_id: 0, child_class: "remote-https",
        argv: ["git", "remote-https", "origin", "https://x-access-token:<REDACTED>@github.com/Acme/First.git"] }),
      JSON.stringify({ event: "child_start", sid: "S0", child_id: 1, child_class: "hook",
        argv: [".git/hooks/pre-push", "origin", "https://github.com/Acme/First.git"] }),
      // Hook first pushes to a local file:// bare repo (must never be attributed to acme/first)
      JSON.stringify({ event: "child_start", sid: "S0/Sh1", child_id: 0, child_class: "transport/file",
        argv: ["git-receive-pack '/tmp/local-backup.git'"] }),
      `11:05:53.010001 pkt-line.c:85           packet:         push> ${other} ${secondAfter} refs/heads/main\\0 report-status-v2`,
      `11:05:53.010002 pkt-line.c:85           packet:         push< ok refs/heads/main`,
      JSON.stringify({ event: "child_exit", sid: "S0/Sh1", child_id: 0, code: 0 }),
      // Hook next pushes to a non-GitHub HTTPS remote (must be ignored)
      JSON.stringify({ event: "child_start", sid: "S0/Sh2", child_id: 0, child_class: "remote-https",
        argv: ["git", "remote-https", "mirror", "https://gitlab.example.com/acme/mirror.git"] }),
      JSON.stringify({ event: "child_start", sid: "S0/Sh2/Sa/Sb", child_id: 0, child_class: "?",
        argv: ["git", "send-pack", "--stateless-rpc", "https://gitlab.example.com/acme/mirror.git/", "--stdin"] }),
      `11:05:53.015001 pkt-line.c:85           packet:          git> ${secondBefore} ${secondAfter} refs/heads/main`,
      `11:05:53.015002 pkt-line.c:85           packet:          git< ok refs/heads/main`,
      JSON.stringify({ event: "child_exit", sid: "S0/Sh2/Sa/Sb", child_id: 0, code: 0 }),
      JSON.stringify({ event: "child_exit", sid: "S0/Sh2", child_id: 0, code: 0 }),
      // Hook also pushes to a separate GitHub repo acme/hook-target
      JSON.stringify({ event: "child_start", sid: "S0/Sh3", child_id: 0, child_class: "remote-https",
        argv: ["git", "remote-https", "hook-remote", "https://x-access-token:<REDACTED>@github.com/Acme/Hook-Target.git"] }),
      JSON.stringify({ event: "child_start", sid: "S0/Sh3/Sa/Sb", child_id: 0, child_class: "?",
        argv: ["git", "send-pack", "--stateless-rpc", "https://x-access-token:<REDACTED>@github.com/Acme/Hook-Target.git/", "--stdin"] }),
      `11:05:53.020001 pkt-line.c:85           packet:          git> ${hookBefore} ${hookAfter} refs/heads/main`,
      `11:05:53.020002 pkt-line.c:85           packet:          git< ok refs/heads/main`,
      JSON.stringify({ event: "child_exit", sid: "S0/Sh3/Sa/Sb", child_id: 0, code: 0 }),
      JSON.stringify({ event: "child_exit", sid: "S0/Sh3", child_id: 0, code: 0 }),
      JSON.stringify({ event: "child_exit", sid: "S0", child_id: 1, code: 0 }),
      // Outer acme/first now sends its own updates
      JSON.stringify({ event: "child_start", sid: "S0/S1/S2", child_id: 0, child_class: "?",
        argv: ["git", "send-pack", "--stateless-rpc", "https://x-access-token:<REDACTED>@github.com/Acme/First.git/", "--stdin"] }),
      `11:05:53.030001 pkt-line.c:85           packet:          git> ${before} ${after} refs/heads/main`,
      `11:05:53.030002 pkt-line.c:85           packet:          git< ok refs/heads/main`,
      JSON.stringify({ event: "child_exit", sid: "S0/S1/S2", child_id: 0, code: 0 }),
      JSON.stringify({ event: "child_exit", sid: "S0", child_id: 0, code: 0 }),
    ].join("\n") + "\n";

    const { run, reports } = await fixture({ trace: hookTrace });
    await run(["push", "origin", "main"]);
    expect(reports).toEqual([
      {
        headers: { capability: "run-capability" },
        body: {
          repository: "acme/hook-target",
          exitCode: 0,
          forced: false,
          updates: [{ ref: "refs/heads/main", before: hookBefore, after: hookAfter, result: "ok" }],
        },
      },
      {
        headers: { capability: "run-capability" },
        body: {
          repository: "acme/first",
          exitCode: 0,
          forced: false,
          updates: [{ ref: "refs/heads/main", before, after, result: "ok" }],
        },
      },
    ]);
  });

  it("does not manufacture a repository match when transport correlation is missing or ambiguous", async () => {
    // 1) Orphan packets with no active transport (packets arrive after child_exit)
    const orphanTrace = [
      JSON.stringify({ event: "child_start", sid: "S0", child_id: 0, child_class: "remote-https",
        argv: ["git", "remote-https", "origin", "https://github.com/Acme/First.git"] }),
      JSON.stringify({ event: "child_exit", sid: "S0", child_id: 0, code: 0 }),
      `11:05:53.010001 pkt-line.c:85           packet:          git> ${before} ${after} refs/heads/main`,
      `11:05:53.010002 pkt-line.c:85           packet:          git< ok refs/heads/main`,
    ].join("\n") + "\n";
    const orphan = await fixture({ trace: orphanTrace });
    await orphan.run(["push", "origin", "main"]);
    expect(orphan.reports).toEqual([]);

    // 2) Two remote-https transports opened without closing the first: packets are ambiguous
    const overlappingHelpersTrace = [
      JSON.stringify({ event: "child_start", sid: "S0", child_id: 0, child_class: "remote-https",
        argv: ["git", "remote-https", "origin", "https://github.com/Acme/First.git"] }),
      JSON.stringify({ event: "child_start", sid: "S0", child_id: 1, child_class: "remote-https",
        argv: ["git", "remote-https", "origin", "https://github.com/Acme/Second.git"] }),
      `11:05:53.010001 pkt-line.c:85           packet:         push> ${before} ${after} refs/heads/main`,
      `11:05:53.010002 pkt-line.c:85           packet:         push< ok refs/heads/main`,
    ].join("\n") + "\n";
    const overlappingHelpers = await fixture({ trace: overlappingHelpersTrace });
    await overlappingHelpers.run(["push", "origin", "main"]);
    expect(overlappingHelpers.reports).toEqual([]);

    // 3) One clean transport finishes, then two concurrent send-pack transports overlap:
    //    only the unambiguous transport is reported; overlapping transports fail closed.
    const partialOverlapTrace = [
      JSON.stringify({ event: "child_start", sid: "S0", child_id: 0, child_class: "remote-https",
        argv: ["git", "remote-https", "origin", "https://github.com/Acme/Clean.git"] }),
      JSON.stringify({ event: "child_start", sid: "S0/S1", child_id: 0, child_class: "?",
        argv: ["git", "send-pack", "--stateless-rpc", "https://github.com/Acme/Clean.git/", "--stdin"] }),
      `11:05:53.010001 pkt-line.c:85           packet:          git> ${before} ${after} refs/heads/main`,
      `11:05:53.010002 pkt-line.c:85           packet:          git< ok refs/heads/main`,
      JSON.stringify({ event: "child_exit", sid: "S0/S1", child_id: 0, code: 0 }),
      JSON.stringify({ event: "child_exit", sid: "S0", child_id: 0, code: 0 }),
      // Concurrent send-pack overlap for OverlapA and OverlapB
      JSON.stringify({ event: "child_start", sid: "S0/S2", child_id: 0, child_class: "?",
        argv: ["git", "send-pack", "--stateless-rpc", "https://github.com/Acme/OverlapA.git/", "--stdin"] }),
      JSON.stringify({ event: "child_start", sid: "S0/S3", child_id: 0, child_class: "?",
        argv: ["git", "send-pack", "--stateless-rpc", "https://github.com/Acme/OverlapB.git/", "--stdin"] }),
      `11:05:53.020001 pkt-line.c:85           packet:          git> ${secondBefore} ${secondAfter} refs/heads/main`,
      `11:05:53.020002 pkt-line.c:85           packet:          git< ok refs/heads/main`,
      JSON.stringify({ event: "child_exit", sid: "S0/S2", child_id: 0, code: 0 }),
      JSON.stringify({ event: "child_exit", sid: "S0/S3", child_id: 0, code: 0 }),
    ].join("\n") + "\n";
    const partialOverlap = await fixture({ trace: partialOverlapTrace });
    await partialOverlap.run(["push", "origin", "main"]);
    expect(partialOverlap.reports).toEqual([{
      headers: { capability: "run-capability" },
      body: {
        repository: "acme/clean",
        exitCode: 0,
        forced: false,
        updates: [{ ref: "refs/heads/main", before, after, result: "ok" }],
      },
    }]);
  });

  it("reports nothing for a push that sent no ref update, and never traces other commands", async () => {
    const noopTrace = [
      JSON.stringify({ event: "child_start", sid: "S0", child_id: 0, child_class: "remote-https",
        argv: ["git", "remote-https", "origin", "https://github.com/Acme/Widgets.git"] }),
      `11:05:53.072437 pkt-line.c:85           packet:          git< ${before} refs/heads/main`,
      JSON.stringify({ event: "child_exit", sid: "S0", child_id: 0, code: 0 }),
    ].join("\n") + "\n";
    const noop = await fixture({ trace: noopTrace });
    await noop.run(["push", "origin", "main"]);
    expect(noop.reports).toEqual([]);
    const fetch = await fixture();
    await fetch.run(["fetch", "origin"]);
    expect(await fetch.tracedWith()).toEqual({ packet: null, trace2: null });
    expect(fetch.reports).toEqual([]);
  });

  it("keeps the push's exit status when the push fails or the report is rejected", async () => {
    const failed = await fixture({ status: 1 });
    await expect(failed.run(["push", "origin", "main"])).rejects.toMatchObject({ code: 1 });
    expect(failed.reports).toHaveLength(1);
    expect((failed.reports[0]!.body as { exitCode: number }).exitCode).toBe(1);
    const rejected = await fixture({ brokerStatus: 403 });
    const result = await rejected.run(["push", "origin", "main"]);
    expect(result.stderr).toContain("push provenance not recorded (rejected_403)");
    expect(rejected.reports).toHaveLength(1);
  });
});
