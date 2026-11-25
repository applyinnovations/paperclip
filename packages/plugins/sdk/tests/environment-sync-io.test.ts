import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEnvironmentSyncHostIo,
  createSyncExcludeMatcher,
  findArchiveMemberEscape,
  PluginSyncIoError,
  SYNC_IO_BATCH_BYTES,
  type PluginEnvironmentSyncHostIo,
  type PluginSyncTargetEntry,
} from "../src/environment-sync-io.js";
import { createSyncHostIoRegistry } from "../src/environment-sync-io-host.js";
import type {
  PluginEnvironmentSyncInParams,
  PluginEnvironmentSyncOutParams,
  PluginSyncFileMapping,
} from "../src/protocol.js";
import { createEnvironmentTestHarness } from "../src/testing.js";

const MANIFEST = {
  id: "paperclip.sync-io-test",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Sync I/O Test",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {},
} as const;

const LEASE = { providerLeaseId: "lease-1" };

let scratch: string;
let workspaces: string;
let ws: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "sync-io-test-"));
  // Several per-run workspaces under one parent, like the instance workspace tree.
  workspaces = path.join(scratch, "workspaces");
  ws = path.join(workspaces, "run-a");
  await fs.mkdir(ws, { recursive: true });
});

afterEach(async () => {
  await fs.chmod(scratch, 0o700).catch(() => undefined);
  await fs.rm(scratch, { recursive: true, force: true });
});

/** Every entry under `root` with its type, mode and content: the "nothing changed" check. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix: string) => {
    const names = (await fs.readdir(dir)).sort();
    for (const name of names) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = await fs.lstat(full);
      // Permission bits only: some tmp filesystems hand new directories a setgid bit.
      const mode = (stat.mode & 0o777).toString(8);
      if (stat.isSymbolicLink()) out[rel] = `link ${await fs.readlink(full)}`;
      else if (stat.isDirectory()) {
        out[rel] = `dir ${mode}`;
        await walk(full, rel);
      } else out[rel] = `file ${mode} ${(await fs.readFile(full)).toString("base64")}`;
    }
  };
  await walk(root, "");
  return out;
}

function harness(driver: {
  onSyncIn?: (params: PluginEnvironmentSyncInParams, io: PluginEnvironmentSyncHostIo) => Promise<unknown>;
  onSyncOut?: (params: PluginEnvironmentSyncOutParams, io: PluginEnvironmentSyncHostIo) => Promise<unknown>;
}) {
  const done = async () => ({ operations: [] });
  return createEnvironmentTestHarness({
    manifest: MANIFEST as never,
    environmentDriver: {
      driverKey: "fake",
      onSyncIn: async (params, io) => { await driver.onSyncIn?.(params, io); return done(); },
      onSyncOut: async (params, io) => { await driver.onSyncOut?.(params, io); return done(); },
    },
  });
}

function params<T extends "in" | "out">(files: PluginSyncFileMapping[]): T extends "in" ? PluginEnvironmentSyncInParams : PluginEnvironmentSyncOutParams {
  return {
    driverKey: "fake",
    companyId: "company-1",
    environmentId: "env-1",
    config: {},
    lease: LEASE,
    operations: [{ operationId: "op-1", files }],
  } as never;
}

/** A plugin-side "sandbox": the sandbox tree the plugin moves bytes to and from. */
async function pullInto(io: PluginEnvironmentSyncHostIo, sandboxDir: string, fileIndex = 0) {
  for await (const entry of io.readSource({ operationIndex: 0, fileIndex })) {
    const target = path.join(sandboxDir, entry.path);
    if (entry.type === "directory") await fs.mkdir(target, { recursive: true, mode: entry.mode });
    else if (entry.type === "symlink") await fs.symlink(entry.linkname, target);
    else {
      const chunks: Buffer[] = [];
      for await (const chunk of entry.content) chunks.push(Buffer.from(chunk));
      await fs.writeFile(target, Buffer.concat(chunks), { mode: entry.mode });
      await fs.chmod(target, entry.mode);
    }
  }
}

async function* pushFrom(sandboxDir: string, prefix = ""): AsyncGenerator<PluginSyncTargetEntry> {
  for (const name of (await fs.readdir(path.join(sandboxDir, prefix))).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = path.join(sandboxDir, rel);
    const stat = await fs.lstat(full);
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) yield { type: "symlink", path: rel, mode, mtimeMs: stat.mtimeMs, linkname: await fs.readlink(full) };
    else if (stat.isDirectory()) {
      yield { type: "directory", path: rel, mode, mtimeMs: stat.mtimeMs };
      yield* pushFrom(sandboxDir, rel);
    } else yield { type: "file", path: rel, mode, mtimeMs: stat.mtimeMs, content: await fs.readFile(full) };
  }
}

async function expectSyncIoError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(PluginSyncIoError);
  expect((error as PluginSyncIoError).syncIoCode).toBe(code);
}

describe("host-mediated sync I/O: round trip", () => {
  it("syncs a nested tree in and back out, with deletion, rename, modes and in-root symlinks", async () => {
    const src = path.join(ws, "src");
    await fs.mkdir(path.join(src, "a/b/c"), { recursive: true });
    await fs.writeFile(path.join(src, "a/b/c/deep.txt"), "deep");
    await fs.writeFile(path.join(src, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    await fs.chmod(path.join(src, "run.sh"), 0o755);
    await fs.writeFile(path.join(src, "secret.key"), "k", { mode: 0o600 });
    await fs.writeFile(path.join(src, "old-name.txt"), "rename me");
    await fs.writeFile(path.join(src, "delete-me.txt"), "bye");
    await fs.writeFile(path.join(src, "._sidecar"), "appledouble");
    await fs.mkdir(path.join(src, "node_modules/pkg"), { recursive: true });
    await fs.writeFile(path.join(src, "node_modules/pkg/index.js"), "x");
    await fs.symlink("a/b/c/deep.txt", path.join(src, "shortcut"));
    const sandbox = path.join(scratch, "sandbox");
    await fs.mkdir(sandbox);

    const h = harness({ onSyncIn: async (_p, io) => { expect(io.available).toBe(true); await pullInto(io, sandbox); } });
    await h.syncIn(params<"in">([{ sourcePath: src, targetPath: "/sandbox/ws", kind: "directory", exclude: ["node_modules"] }]), { hostRoots: [ws] });

    // Excludes honoured (pattern and the implicit `._*`), symlink kept as a link.
    expect(await snapshot(sandbox)).toEqual({
      a: expect.stringMatching(/^dir /),
      "a/b": expect.stringMatching(/^dir /),
      "a/b/c": expect.stringMatching(/^dir /),
      "a/b/c/deep.txt": `file ${(0o644 & ~process.umask()).toString(8)} ${Buffer.from("deep").toString("base64")}`,
      "delete-me.txt": expect.stringMatching(/^file /),
      "old-name.txt": expect.stringMatching(/^file /),
      "run.sh": expect.stringMatching(/^file 755 /),
      "secret.key": expect.stringMatching(/^file 600 /),
      shortcut: "link a/b/c/deep.txt",
    });

    // The agent works in the sandbox: rename, delete, add.
    await fs.rename(path.join(sandbox, "old-name.txt"), path.join(sandbox, "new-name.txt"));
    await fs.rm(path.join(sandbox, "delete-me.txt"));
    await fs.mkdir(path.join(sandbox, "a/new"));
    await fs.writeFile(path.join(sandbox, "a/new/file.txt"), "added");

    const out = path.join(ws, "out");
    await fs.mkdir(out);
    await fs.writeFile(path.join(out, "stale.txt"), "from an earlier sync");
    const h2 = harness({ onSyncOut: async (_p, io) => {
      const result = await io.writeTarget({ operationIndex: 0, fileIndex: 0 }, pushFrom(sandbox));
      expect(result.filesWritten).toBe(6);
    } });
    await h2.syncOut(params<"out">([{ sourcePath: "/sandbox/ws", targetPath: out, kind: "directory" }]), { hostRoots: [ws] });

    expect(await snapshot(out)).toEqual(await snapshot(sandbox));
    expect(await fs.readFile(path.join(out, "a/new/file.txt"), "utf8")).toBe("added");
    await expect(fs.access(path.join(out, "stale.txt"))).rejects.toThrow();
    await expect(fs.access(path.join(out, "old-name.txt"))).rejects.toThrow();
    expect((await fs.lstat(path.join(out, "shortcut"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(out, "shortcut"), "utf8")).toBe("deep");
  });

  it("dereferences in-root symlinks with followSymlinks", async () => {
    const src = path.join(ws, "src");
    await fs.mkdir(path.join(src, "real"), { recursive: true });
    await fs.writeFile(path.join(src, "real/f.txt"), "f");
    await fs.symlink("real", path.join(src, "via-link"));
    const seen: string[] = [];
    const h = harness({ onSyncIn: async (_p, io) => {
      for await (const entry of io.readSource({ operationIndex: 0, fileIndex: 0 })) seen.push(`${entry.type}:${entry.path}`);
    } });
    await h.syncIn(params<"in">([{ sourcePath: src, targetPath: "/s", kind: "directory", followSymlinks: true }]), { hostRoots: [ws] });
    expect(seen).toEqual(["directory:real", "file:real/f.txt", "directory:via-link", "file:via-link/f.txt"]);
  });

  it("replaces a single-file target atomically with the mapping's mode", async () => {
    const target = path.join(ws, "auth/token.json");
    const h = harness({ onSyncOut: async (_p, io) => {
      await io.writeTarget({ operationIndex: 0, fileIndex: 0 }, [
        { type: "file", path: "", mode: 0o644, mtimeMs: Date.now(), content: Buffer.from("{}") },
      ]);
    } });
    await h.syncOut(params<"out">([{ sourcePath: "/s/token.json", targetPath: target, kind: "file", mode: 0o600 }]), { hostRoots: [ws] });
    expect(await fs.readFile(target, "utf8")).toBe("{}");
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.dirname(target)))).toEqual(["token.json"]);
  });
});

describe("host-mediated sync I/O: refusals change nothing", () => {
  const badStreams: Array<[string, PluginSyncTargetEntry[], string]> = [
    ["an absolute member name", [{ type: "file", path: "/etc/evil", mode: 0o644, mtimeMs: 0, content: Buffer.from("x") }], "unsafe_member"],
    ["a .. member name", [{ type: "file", path: "../escape.txt", mode: 0o644, mtimeMs: 0, content: Buffer.from("x") }], "unsafe_member"],
    ["a nested .. member name", [{ type: "file", path: "a/../../escape.txt", mode: 0o644, mtimeMs: 0, content: Buffer.from("x") }], "unsafe_member"],
    ["a file written through a symlink", [
      { type: "symlink", path: "link", mode: 0o777, mtimeMs: 0, linkname: "sub" },
      { type: "file", path: "link/evil.txt", mode: 0o644, mtimeMs: 0, content: Buffer.from("x") },
    ], "unsafe_member"],
    ["an escaping symlink", [{ type: "symlink", path: "a/l", mode: 0o777, mtimeMs: 0, linkname: "../../outside" }], "unsafe_member"],
    ["an absolute symlink", [{ type: "symlink", path: "l", mode: 0o777, mtimeMs: 0, linkname: "/etc/passwd" }], "unsafe_member"],
    ["a duplicate name", [
      { type: "file", path: "f", mode: 0o644, mtimeMs: 0, content: Buffer.from("1") },
      { type: "symlink", path: "f", mode: 0o777, mtimeMs: 0, linkname: "g" },
    ], "unsafe_member"],
    ["a hardlink entry", [{ type: "hardlink", path: "h", mode: 0o644, mtimeMs: 0, linkname: "f" } as never], "unsupported_entry"],
    ["a device entry", [{ type: "char-device", path: "d", mode: 0o644, mtimeMs: 0 } as never], "unsupported_entry"],
  ];

  for (const [label, entries, code] of badStreams) {
    it(`refuses ${label}`, async () => {
      const out = path.join(ws, "out");
      await fs.mkdir(path.join(out, "sub"), { recursive: true });
      await fs.writeFile(path.join(out, "keep.txt"), "original");
      const before = await snapshot(scratch);
      const h = harness({ onSyncOut: async (_p, io) => {
        await expectSyncIoError(io.writeTarget({ operationIndex: 0, fileIndex: 0 }, [
          { type: "file", path: "ok-first.txt", mode: 0o644, mtimeMs: 0, content: Buffer.from("staged") },
          ...entries,
        ]), code);
      } });
      await h.syncOut(params<"out">([{ sourcePath: "/s", targetPath: out, kind: "directory" }]), { hostRoots: [ws] });
      expect(await snapshot(scratch)).toEqual(before);
    });
  }

  it("refuses a followSymlinks target outside the source root", async () => {
    const src = path.join(ws, "src");
    await fs.mkdir(src);
    await fs.writeFile(path.join(ws, "outside-src.txt"), "not in the source root");
    await fs.symlink("../outside-src.txt", path.join(src, "escape"));
    const h = harness({ onSyncIn: async (_p, io) => {
      await expectSyncIoError((async () => { for await (const _ of io.readSource({ operationIndex: 0, fileIndex: 0 })) { /* drain */ } })(), "confinement");
    } });
    await h.syncIn(params<"in">([{ sourcePath: src, targetPath: "/s", kind: "directory", followSymlinks: true }]), { hostRoots: [ws] });
  });

  it("refuses a mapping outside the call's roots, including a sibling workspace under the same parent", async () => {
    const sibling = path.join(workspaces, "run-b");
    await fs.mkdir(path.join(sibling, "src"), { recursive: true });
    await fs.writeFile(path.join(sibling, "src/other-run.txt"), "not yours");
    await fs.mkdir(path.join(sibling, "out"));
    const before = await snapshot(scratch);
    const h = harness({
      onSyncIn: async (_p, io) => {
        await expectSyncIoError(io.readSource({ operationIndex: 0, fileIndex: 0 })[Symbol.asyncIterator]().next(), "confinement");
        await expectSyncIoError(io.readSource({ operationIndex: 0, fileIndex: 1 })[Symbol.asyncIterator]().next(), "confinement");
        await expectSyncIoError(io.readSource({ operationIndex: 0, fileIndex: 2 })[Symbol.asyncIterator]().next(), "confinement");
      },
      onSyncOut: async (_p, io) => {
        await expectSyncIoError(io.writeTarget({ operationIndex: 0, fileIndex: 0 }, [
          { type: "file", path: "x", mode: 0o644, mtimeMs: 0, content: Buffer.from("x") },
        ]), "confinement");
      },
    });
    await h.syncIn(params<"in">([
      { sourcePath: path.join(sibling, "src"), targetPath: "/s", kind: "directory" },
      { sourcePath: `${ws}/../run-b/src`, targetPath: "/s", kind: "directory" },
      { sourcePath: "/etc/hostname", targetPath: "/s", kind: "file" },
    ]), { hostRoots: [ws] });
    await h.syncOut(params<"out">([{ sourcePath: "/s", targetPath: path.join(sibling, "out"), kind: "directory" }]), { hostRoots: [ws] });
    expect(await snapshot(scratch)).toEqual(before);
  });

  it("refuses a root the host policy rejects (for example a protected secret path)", async () => {
    const keyDir = path.join(ws, "keys");
    await fs.mkdir(keyDir);
    await fs.writeFile(path.join(keyDir, "app.pem"), "PRIVATE", { mode: 0o600 });
    const realWs = await fs.realpath(ws);
    const h = createEnvironmentTestHarness({
      manifest: MANIFEST as never,
      // Stands in for the server policy: this root holds a protected key file.
      syncHostRootPolicy: (realRoot) => realRoot === realWs
        ? { code: "protected_path", reason: "root contains a protected secret path" }
        : null,
      environmentDriver: {
        driverKey: "fake",
        onSyncIn: async (_p, io) => {
          await expectSyncIoError(io.readSource({ operationIndex: 0, fileIndex: 0 })[Symbol.asyncIterator]().next(), "protected_path");
          return { operations: [] };
        },
      },
    });
    await h.syncIn(params<"in">([{ sourcePath: path.join(keyDir, "app.pem"), targetPath: "/s", kind: "file" }]), { hostRoots: [ws] });
  });

  it("refuses a stale handle after the call returns, and a foreign plugin's or company's use of a live one", async () => {
    let kept: PluginEnvironmentSyncHostIo | null = null;
    await fs.writeFile(path.join(ws, "f.txt"), "f");
    const h = harness({ onSyncIn: async (_p, io) => { kept = io; } });
    await h.syncIn(params<"in">([{ sourcePath: path.join(ws, "f.txt"), targetPath: "/s", kind: "file" }]), { hostRoots: [ws] });
    await expectSyncIoError(kept!.readSource({ operationIndex: 0, fileIndex: 0 })[Symbol.asyncIterator]().next(), "invalid_handle");

    const registry = createSyncHostIoRegistry();
    const session = registry.begin({ pluginId: "plugin-a", companyId: "company-1", direction: "in",
      operations: [{ operationId: "op", files: [{ sourcePath: path.join(ws, "f.txt"), targetPath: "/s", kind: "file" }] }], hostRoots: [ws] });
    const open = { handle: session.handle, operationIndex: 0, fileIndex: 0 };
    await expectSyncIoError(registry.dispatch("environmentSync.openSource", open, { pluginId: "plugin-b", companyId: "company-1" }), "invalid_handle");
    await expectSyncIoError(registry.dispatch("environmentSync.openSource", open, { pluginId: "plugin-a", companyId: "company-2" }), "invalid_handle");
    await expectSyncIoError(registry.dispatch("environmentSync.openSource", open, { pluginId: "plugin-a", companyId: "company-1", invalidScope: true }), "invalid_handle");
    await expect(registry.dispatch("environmentSync.openSource", open, { pluginId: "plugin-a", companyId: "company-1" })).resolves.toHaveProperty("streamId");
    await session.end();
    expect(registry.activeSessionCount()).toBe(0);
    await expectSyncIoError(registry.dispatch("environmentSync.openSource", open, { pluginId: "plugin-a", companyId: "company-1" }), "invalid_handle");
  });

  it("refuses the wrong direction and reports unavailable without host roots", async () => {
    await fs.writeFile(path.join(ws, "f.txt"), "f");
    const h = harness({
      onSyncIn: async (_p, io) => {
        await expectSyncIoError(io.writeTarget({ operationIndex: 0, fileIndex: 0 }, []), "wrong_direction");
      },
    });
    await h.syncIn(params<"in">([{ sourcePath: path.join(ws, "f.txt"), targetPath: "/s", kind: "file" }]), { hostRoots: [ws] });
    const h2 = harness({
      onSyncIn: async (_p, io) => {
        expect(io.available).toBe(false);
        await expectSyncIoError(io.readSource({ operationIndex: 0, fileIndex: 0 })[Symbol.asyncIterator]().next(), "unavailable");
      },
    });
    await h2.syncIn(params<"in">([{ sourcePath: path.join(ws, "f.txt"), targetPath: "/s", kind: "file" }]));
  });
});

describe("host-mediated sync I/O: bounded memory", () => {
  it("moves a large file in bounded RPC batches in both directions", async () => {
    const size = 9 * 1024 * 1024 + 123;
    const big = Buffer.alloc(size);
    for (let i = 0; i < size; i += 4096) big[i] = i % 251;
    await fs.writeFile(path.join(ws, "big.bin"), big);
    const registry = createSyncHostIoRegistry();
    const largest: number[] = [];
    const transport = (caller: { pluginId: string; companyId: string }) => async (method: never, params: never) => {
      const request = JSON.stringify(params);
      const result = await registry.dispatch(method, JSON.parse(request), caller);
      largest.push(Math.max(request.length, JSON.stringify(result).length));
      return result as never;
    };
    const caller = { pluginId: "p", companyId: "c" };

    const inSession = registry.begin({ ...caller, direction: "in", hostRoots: [ws],
      operations: [{ operationId: "op", files: [{ sourcePath: path.join(ws, "big.bin"), targetPath: "/s", kind: "file" }] }] });
    const reader = createEnvironmentSyncHostIo(inSession.handle, transport(caller));
    const chunks: Buffer[] = [];
    for await (const entry of reader.readSource({ operationIndex: 0, fileIndex: 0 })) {
      if (entry.type === "file") for await (const chunk of entry.content) chunks.push(Buffer.from(chunk));
    }
    await inSession.end();
    expect(Buffer.concat(chunks).equals(big)).toBe(true);

    const outSession = registry.begin({ ...caller, direction: "out", hostRoots: [ws],
      operations: [{ operationId: "op", files: [{ sourcePath: "/s", targetPath: path.join(ws, "copy.bin"), kind: "file" }] }] });
    const writer = createEnvironmentSyncHostIo(outSession.handle, transport(caller));
    async function* pieces() { for (let i = 0; i < size; i += 100_000) yield big.subarray(i, i + 100_000); }
    await writer.writeTarget({ operationIndex: 0, fileIndex: 0 }, [{ type: "file", path: "", mode: 0o644, mtimeMs: 0, content: pieces() }]);
    await outSession.end();
    expect((await fs.readFile(path.join(ws, "copy.bin"))).equals(big)).toBe(true);

    // No single RPC carries more than one batch (base64 overhead included).
    expect(Math.max(...largest)).toBeLessThan(SYNC_IO_BATCH_BYTES * 2);
    expect(largest.length).toBeGreaterThan(10);
  });
});

describe("archive member confinement (shared with the Kubernetes provider)", () => {
  it("accepts in-tree names and links and rejects escapes", () => {
    expect(findArchiveMemberEscape({ name: "a/b.txt" })).toBeNull();
    expect(findArchiveMemberEscape({ name: "a/l", linkTarget: "../b" })).toBeNull();
    expect(findArchiveMemberEscape({ name: "/abs" })).not.toBeNull();
    expect(findArchiveMemberEscape({ name: "../x" })).not.toBeNull();
    expect(findArchiveMemberEscape({ name: "a/l", linkTarget: "../../x" })).not.toBeNull();
    expect(findArchiveMemberEscape({ name: "l", linkTarget: "/etc/passwd" })).not.toBeNull();
  });
});

describe("exclude matching", () => {
  it("follows tar's default --exclude semantics", () => {
    const excluded = createSyncExcludeMatcher({ exclude: ["node_modules", "*.log", "build/out"] }, "out");
    expect(excluded("node_modules")).toBe(true);
    expect(excluded("node_modules/pkg/index.js")).toBe(true);
    expect(excluded("a/node_modules/x")).toBe(true);
    expect(excluded("a/b/debug.log")).toBe(true);
    expect(excluded("build/out/x")).toBe(true);
    expect(excluded("x/build/out")).toBe(true);
    expect(excluded("._sidecar")).toBe(true);
    expect(excluded("node_modules_backup/x")).toBe(false);
    expect(excluded("src/main.ts")).toBe(false);
  });

  it("treats preserveSourceEntries excludes as literal root-relative paths", () => {
    const excluded = createSyncExcludeMatcher({ exclude: ["./a/b/", "*.log"], preserveSourceEntries: true }, "out");
    expect(excluded("a/b")).toBe(true);
    expect(excluded("a/b/c")).toBe(true);
    expect(excluded("x/a/b")).toBe(false);
    expect(excluded("debug.log")).toBe(false);
    expect(excluded("._kept")).toBe(false);
  });
});
