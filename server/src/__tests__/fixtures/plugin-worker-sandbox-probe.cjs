// Probes the plugin worker filesystem sandbox from inside a real worker process.
// `environmentProbe` tries one operation and reports the error code (or "ok"),
// so a test can assert what is denied and that the worker keeps serving RPCs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function attempt(op) {
  try {
    op();
    return "ok";
  } catch (error) {
    return (error && error.code) || String(error);
  }
}

// The real SDK (loaded through the tsx --import loader), so module loading
// itself runs under the sandbox's read allowlist.
void Promise.all([
  import("../../../../packages/plugins/sdk/src/define-plugin.ts"),
  import("../../../../packages/plugins/sdk/src/worker-rpc-host.ts"),
]).then(([{ definePlugin }, { startWorkerRpcHost }]) => {
  let ctx;
  let lastSync = null;
  // The worker's own tmp dir stands in for the sandbox the plugin syncs to.
  const sandboxDir = () => path.join(os.tmpdir(), "sandbox");
  async function* sandboxEntries(prefix) {
    for (const name of fs.readdirSync(path.join(sandboxDir(), prefix)).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const full = path.join(sandboxDir(), rel);
      const stat = fs.lstatSync(full);
      const mode = stat.mode & 0o777;
      if (stat.isDirectory()) {
        yield { type: "directory", path: rel, mode, mtimeMs: stat.mtimeMs };
        yield* sandboxEntries(rel);
      } else yield { type: "file", path: rel, mode, mtimeMs: stat.mtimeMs, content: fs.readFileSync(full) };
    }
  }
  startWorkerRpcHost({ plugin: definePlugin({
    async setup(context) { ctx = context; },
    async onHealth() { return { status: "ok" }; },
    // Host-mediated sync: every host byte moves through `io`, never through fs.
    async onEnvironmentSyncIn(params, io) {
      fs.rmSync(sandboxDir(), { recursive: true, force: true });
      fs.mkdirSync(sandboxDir());
      let files = 0;
      for await (const entry of io.readSource({ operationIndex: 0, fileIndex: 0 })) {
        const target = path.join(sandboxDir(), entry.path);
        if (entry.type === "directory") fs.mkdirSync(target, { recursive: true });
        else if (entry.type === "file") {
          const chunks = [];
          for await (const chunk of entry.content) chunks.push(Buffer.from(chunk));
          fs.writeFileSync(target, Buffer.concat(chunks), { mode: entry.mode });
          files += 1;
        }
      }
      const direct = attempt(() => fs.readFileSync(params.config.directRead));
      lastSync = { files, direct };
      return { operations: [{ operationId: params.operations[0].operationId, filesTransferred: files, bytesTransferred: 0 }] };
    },
    async onEnvironmentSyncOut(params, io) {
      fs.writeFileSync(path.join(sandboxDir(), "from-sandbox.txt"), "made in the sandbox");
      const result = await io.writeTarget({ operationIndex: 0, fileIndex: 0 }, sandboxEntries(""));
      const direct = attempt(() => fs.writeFileSync(params.config.directWrite, "x"));
      lastSync = { files: result.filesWritten, direct };
      return { operations: [{ operationId: params.operations[0].operationId, filesTransferred: result.filesWritten, bytesTransferred: result.bytesWritten }] };
    },
    async onEnvironmentProbe(params) {
      const { op, file } = params.config;
      let summary;
      if (op === "read") summary = attempt(() => fs.readFileSync(file, "utf8"));
      else if (op === "write") summary = attempt(() => fs.writeFileSync(file, "x"));
      else if (op === "tmp") summary = attempt(() => {
        const target = path.join(os.tmpdir(), "probe.txt");
        fs.writeFileSync(target, "scratch");
        if (fs.readFileSync(target, "utf8") !== "scratch") throw new Error("tmp roundtrip mismatch");
      });
      else if (op === "localFolderRead") {
        // Local folders are served by the host over RPC, not by worker fs access.
        summary = await ctx.localFolders.readText("company-1", "notes", params.config.relativePath)
          .then((text) => `ok:${text}`, (error) => (error && error.code) || String(error));
      }
      else if (op === "lastSync") summary = JSON.stringify(lastSync);
      else if (op === "signal") summary = attempt(() => process.kill(params.config.pid, "SIGUSR1"));
      else if (op === "sqlite") summary = attempt(() => {
        const { DatabaseSync } = require("node:sqlite");
        new DatabaseSync(file).close();
      });
      else if (op === "spawn") summary = attempt(() => require("node:child_process").execFileSync("true"));
      else summary = "unknown-op";
      return { ok: summary === "ok", summary };
    },
  }) });
});
