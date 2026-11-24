#!/usr/bin/env -S node --import tsx
import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import {
  findListeningProcessPid,
  resolveHotRestartIntentPath,
  writeHotRestartIntent,
} from "../server/src/services/hot-restart.js";

function usage(): never {
  console.error([
    "Usage: tsx scripts/request-hot-restart.ts (--server-pid <pid> | --server-port <port>) [--drain-required]",
    "",
    "Writes an instance-scoped hot-restart intent plus a legacy home-root handoff marker.",
    "--server-port resolves the PID of the process listening on that TCP port (Linux /proc).",
  ].join("\n"));
  process.exit(2);
}

function readPositiveInteger(raw: string | undefined, max = Number.MAX_SAFE_INTEGER) {
  if (!raw) usage();
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) usage();
  return parsed;
}

function readArgs(argv: string[]) {
  let serverPid: number | null = null;
  let serverPort: number | null = null;
  let drainRequired = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--server-pid") {
      serverPid = readPositiveInteger(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--server-port") {
      serverPort = readPositiveInteger(argv[index + 1], 65_535);
      index += 1;
      continue;
    }
    if (arg === "--drain-required") {
      drainRequired = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") usage();
    console.error(`Unknown argument: ${arg}`);
    usage();
  }

  if ((serverPid === null) === (serverPort === null)) usage();
  return { serverPid, serverPort, drainRequired };
}

function normalizeApiBase(raw: string | undefined) {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "").replace(/\/api$/, "");
}

async function readPreviousServerInfo() {
  const apiBase = normalizeApiBase(process.env.PAPERCLIP_API_URL);
  if (!apiBase) return { version: null, identity: null };
  try {
    const apiKey = process.env.PAPERCLIP_API_KEY?.trim();
    const response = await fetch(`${apiBase}/api/health`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return { version: null, identity: null };
    const body = await response.json() as Record<string, unknown>;
    const serverInfo = body.serverInfo && typeof body.serverInfo === "object"
      ? body.serverInfo as Record<string, unknown>
      : null;
    return {
      version: typeof body.serverVersion === "string"
        ? body.serverVersion
        : typeof body.version === "string"
          ? body.version
          : null,
      identity: typeof serverInfo?.processStartedAt === "string"
        ? serverInfo.processStartedAt
        : null,
    };
  } catch {
    return { version: null, identity: null };
  }
}

async function readPreflightActiveRunIds() {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);
  try {
    const rows = await db.$client<{ id: string }[]>`
      SELECT id
      FROM heartbeat_runs
      WHERE status = 'running'
    `;
    return rows.map((row) => row.id);
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

const args = readArgs(process.argv.slice(2));
const { drainRequired } = args;
const serverPid = args.serverPid ?? await findListeningProcessPid(args.serverPort!);
const preflightActiveRunIds = drainRequired ? [] : await readPreflightActiveRunIds();
const previousServerInfo = await readPreviousServerInfo();
const intent = await writeHotRestartIntent({
  previousServerPid: serverPid,
  previousServerIdentity: previousServerInfo.identity,
  previousServerVersion: previousServerInfo.version,
  drainRequired,
  requestedByRunId: process.env.PAPERCLIP_RUN_ID?.trim() || null,
  preflightActiveRunIds,
});

console.log(JSON.stringify({
  status: "hot_restart_intent_written",
  intentPath: resolveHotRestartIntentPath(),
  previousServerPid: intent.previousServerPid,
  previousServerIdentity: intent.previousServerIdentity,
  previousServerStartedAt: intent.previousServerStartedAt,
  previousServerVersion: intent.previousServerVersion,
  drainRequired: intent.drainRequired,
  preflightActiveRunIds: intent.preflightActiveRunIds,
}, null, 2));
