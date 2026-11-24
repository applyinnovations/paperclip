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
  startWorkerRpcHost({ plugin: definePlugin({
    async setup(context) { ctx = context; },
    async onHealth() { return { status: "ok" }; },
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
