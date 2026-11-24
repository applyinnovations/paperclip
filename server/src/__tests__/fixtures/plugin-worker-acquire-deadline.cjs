// Answers environmentAcquireLease with the params it received, so a test can
// read what the host sent to the provider.
const readline = require("node:readline");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true, supportedMethods: ["environmentAcquireLease", "environmentExecute"] } });
    return;
  }
  if (message.method === "environmentAcquireLease" || message.method === "environmentExecute") {
    send({ jsonrpc: "2.0", id: message.id, result: { providerLeaseId: "lease-1", metadata: { received: message.params } } });
    return;
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
