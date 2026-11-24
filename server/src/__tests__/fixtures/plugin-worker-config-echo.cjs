// Records the company configs this worker process has received through
// configChanged and reports them (with its pid) from health, so a test can see
// what a respawned process was given.
const readline = require("node:readline");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const configs = {};
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const method = message && typeof message.method === "string" ? message.method : null;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true, supportedMethods: ["configChanged", "health"] } });
    return;
  }
  if (method === "configChanged") {
    configs[message.params.companyId] = message.params.config;
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (method === "health") {
    send({ jsonrpc: "2.0", id: message.id, result: { status: "ok", details: { pid: process.pid, configs } } });
    return;
  }
  if (method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setImmediate(() => process.exit(0));
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unhandled method: ${method}` } });
  }
});
