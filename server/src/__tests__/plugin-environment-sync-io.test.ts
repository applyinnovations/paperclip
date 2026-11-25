import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENVIRONMENT_SYNC_IO_METHODS, type PluginSyncOperation } from "@paperclipai/plugin-sdk";
import {
  activeEnvironmentSyncHostIoSessions,
  beginEnvironmentSyncHostIo,
  createEnvironmentSyncHostService,
  findSyncHostRootRefusal,
} from "../services/plugin-environment-sync-io.js";

const PLUGIN = "acme.sandbox";
const COMPANY = "company-1";
const context = { invocationScope: { companyId: COMPANY } };

let scratch: string;
let instanceRoot: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sync-io-policy-"));
  instanceRoot = path.join(scratch, "home/instances/default");
  fs.mkdirSync(instanceRoot, { recursive: true });
  vi.stubEnv("PAPERCLIP_HOME", path.join(scratch, "home"));
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(scratch, { recursive: true, force: true });
});

function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      out.push(`${path.relative(root, full)} ${stat.isDirectory() ? "dir" : fs.readFileSync(full, "base64")}`);
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

async function readAll(handle: string, fileIndex = 0) {
  const service = createEnvironmentSyncHostService(PLUGIN);
  const { streamId } = await service.dispatch("environmentSync.openSource", { handle, operationIndex: 0, fileIndex }, context);
  const records = [];
  for (;;) {
    const batch = await service.dispatch("environmentSync.readSource", { handle, streamId }, context);
    records.push(...batch.records);
    if (batch.done) return records;
  }
}

function session(direction: "in" | "out", files: PluginSyncOperation["files"], hostRoots: string[]) {
  return beginEnvironmentSyncHostIo({ pluginId: PLUGIN, companyId: COMPANY, direction,
    operations: [{ operationId: "op", files }], hostRoots })!;
}

describe("host-mediated sync I/O host policy", () => {
  it("serves a per-run workspace under the instance tree", async () => {
    const ws = path.join(instanceRoot, "workspaces/agent-1");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "a.txt"), "a");
    const s = session("in", [{ sourcePath: ws, targetPath: "/remote", kind: "directory" }], [ws]);
    try {
      expect(await readAll(s.handle)).toEqual([
        { entry: expect.objectContaining({ type: "file", path: "a.txt", size: 1 }) },
        { data: Buffer.from("a").toString("base64") },
      ]);
    } finally { await s.end(); }
    expect(activeEnvironmentSyncHostIoSessions()).toBe(0);
  });

  it("refuses a root that contains a protected secret file, and writes nothing", async () => {
    const ws = path.join(scratch, "run-ws");
    fs.mkdirSync(path.join(ws, "out"), { recursive: true });
    const key = path.join(ws, "approvals.pem");
    fs.writeFileSync(key, "PRIVATE KEY", { mode: 0o600 });
    vi.stubEnv("PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE", key);
    const before = snapshot(scratch);
    const read = session("in", [{ sourcePath: key, targetPath: "/remote/k", kind: "file" }], [ws]);
    const write = session("out", [{ sourcePath: "/remote/x", targetPath: path.join(ws, "out"), kind: "directory" }], [ws]);
    try {
      await expect(readAll(read.handle)).rejects.toMatchObject({ syncIoCode: "protected_path" });
      await expect(createEnvironmentSyncHostService(PLUGIN).dispatch("environmentSync.openTarget",
        { handle: write.handle, operationIndex: 0, fileIndex: 0 }, context)).rejects.toMatchObject({ syncIoCode: "protected_path" });
    } finally { await read.end(); await write.end(); }
    expect(snapshot(scratch)).toEqual(before);
  });

  it("refuses shared parents of several workspaces or runs as roots", () => {
    const projects = path.join(instanceRoot, "projects");
    fs.mkdirSync(path.join(projects, "company/project/repo"), { recursive: true });
    for (const root of [
      "/",
      os.tmpdir(),
      os.homedir(),
      path.join(scratch, "home"),
      instanceRoot,
      path.join(instanceRoot, "workspaces"),
      projects,
      path.join(projects, "company"),
      path.join(projects, "company/project"),
    ]) {
      // `/` also contains protected paths, so either refusal is fine; none may pass.
      expect(findSyncHostRootRefusal(root), root).toMatchObject({ code: expect.stringMatching(/^(confinement|protected_path)$/) });
    }
    for (const root of [path.join(instanceRoot, "workspaces"), projects, path.join(projects, "company/project")]) {
      expect(findSyncHostRootRefusal(root), root).toMatchObject({ code: "confinement" });
    }
    expect(findSyncHostRootRefusal(path.join(projects, "company/project/repo"))).toBeNull();
    expect(findSyncHostRootRefusal(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-syncin-")))).toBeNull();
  });

  it("refuses a sibling workspace under the same parent, and a declared shared parent", async () => {
    const parent = path.join(instanceRoot, "workspaces");
    const mine = path.join(parent, "run-a");
    const sibling = path.join(parent, "run-b");
    fs.mkdirSync(mine, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, "other.txt"), "not yours");
    const viaMine = session("in", [{ sourcePath: sibling, targetPath: "/r", kind: "directory" }], [mine]);
    const viaParent = session("in", [{ sourcePath: sibling, targetPath: "/r", kind: "directory" }], [parent]);
    try {
      await expect(readAll(viaMine.handle)).rejects.toMatchObject({ syncIoCode: "confinement" });
      await expect(readAll(viaParent.handle)).rejects.toMatchObject({ syncIoCode: "confinement" });
    } finally { await viaMine.end(); await viaParent.end(); }
  });

  it("mints no handle when the caller declared no host roots", () => {
    expect(beginEnvironmentSyncHostIo({ pluginId: PLUGIN, companyId: COMPANY, direction: "in", operations: [], hostRoots: undefined })).toBeNull();
    expect(beginEnvironmentSyncHostIo({ pluginId: PLUGIN, companyId: COMPANY, direction: "in", operations: [], hostRoots: [] })).toBeNull();
  });

  it("binds every method to the issuing plugin and company", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sync-bind-"));
    const s = session("in", [{ sourcePath: ws, targetPath: "/r", kind: "directory" }], [ws]);
    try {
      for (const method of ENVIRONMENT_SYNC_IO_METHODS) {
        const params = { handle: s.handle, operationIndex: 0, fileIndex: 0, streamId: "x", records: [] };
        await expect(createEnvironmentSyncHostService("other.plugin").dispatch(method, params as never, context))
          .rejects.toMatchObject({ syncIoCode: "invalid_handle" });
        await expect(createEnvironmentSyncHostService(PLUGIN).dispatch(method, params as never, { invocationScope: { companyId: "company-2" } }))
          .rejects.toMatchObject({ syncIoCode: "invalid_handle" });
        await expect(createEnvironmentSyncHostService(PLUGIN).dispatch(method, params as never, { invalidInvocationScope: true }))
          .rejects.toMatchObject({ syncIoCode: "invalid_handle" });
      }
    } finally {
      await s.end();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
