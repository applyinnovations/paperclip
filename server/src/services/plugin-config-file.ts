/**
 * PAPERCLIP_PLUGIN_CONFIG_FILE: plugin configuration from a file.
 *
 * The variable names a JSON file, typically a mounted Kubernetes ConfigMap:
 *
 *   { "<pluginKey>": { "<companyId>": { ...config... } } }
 *
 * Each entry is applied through `applyPluginConfig`, the same path as
 * `POST /api/plugins/:pluginId/config`: validated against the manifest's
 * `instanceConfigSchema` and the company's secrets, persisted, and delivered
 * to the worker. Entries apply at startup, whenever a plugin is activated
 * (install, upgrade, enable, restart), and when the file changes. An entry
 * that equals the stored config writes nothing.
 *
 * A (plugin, company) pair in the file is read-only through the API and UI.
 * Removing a pair from the file stops managing it and leaves its stored config
 * as it is. Failures never stop the server and never clear a config: the last
 * good config stays, and the reason is logged and stored in `last_error`.
 *
 * Unset, nothing here runs.
 */
import { createHash } from "node:crypto";
import { readFileSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import { logger as rootLogger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  applyPluginConfig,
  PluginConfigSchemaError,
  type ApplyPluginConfigDeps,
  type ApplyPluginConfigPlugin,
} from "./plugin-config-apply.js";
import { pluginRegistryService } from "./plugin-registry.js";

export const PLUGIN_CONFIG_FILE_ENV = "PAPERCLIP_PLUGIN_CONFIG_FILE";
/** Activity `details.source` and system actor id of every change the file makes. */
export const PLUGIN_CONFIG_FILE_SOURCE = "plugin-config-file";
/** Prefix of the `plugin_config.last_error` the file writes, so a later good apply can clear it. */
const LAST_ERROR_PREFIX = `${PLUGIN_CONFIG_FILE_ENV}: `;
const DEFAULT_DEBOUNCE_MS = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** pluginKey → companyId → config */
export type PluginConfigFileEntries = ReadonlyMap<string, ReadonlyMap<string, Record<string, unknown>>>;

export type PluginConfigFileParseResult =
  | { ok: true; entries: PluginConfigFileEntries }
  | { ok: false; error: string };

export type PluginConfigManagedBy = { source: "file"; message: string };

/** Answers whether the file owns a (plugin, company) pair's config. */
export type PluginConfigFileManagedCheck = {
  managedBy(pluginKey: string, companyId: string): PluginConfigManagedBy | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the file's shape. Any shape error rejects the whole file, so a
 * malformed commit never half-applies. Whether a company exists and whether a
 * config matches its plugin's schema are checked per entry when applying.
 */
export function parsePluginConfigFile(document: unknown): PluginConfigFileParseResult {
  const invalid = (error: string): PluginConfigFileParseResult => ({ ok: false, error });
  if (!isRecord(document)) return invalid("expected an object of { pluginKey: { companyId: config } }");
  const entries = new Map<string, Map<string, Record<string, unknown>>>();
  for (const [pluginKey, byCompany] of Object.entries(document)) {
    if (pluginKey.trim() === "" || pluginKey !== pluginKey.trim()) {
      return invalid(`plugin key "${pluginKey}" must be a non-empty string without surrounding spaces`);
    }
    if (!isRecord(byCompany)) return invalid(`"${pluginKey}" must be an object of { companyId: config }`);
    const companyConfigs = new Map<string, Record<string, unknown>>();
    for (const [rawCompanyId, config] of Object.entries(byCompany)) {
      const companyId = rawCompanyId.toLowerCase();
      if (!UUID.test(companyId)) return invalid(`"${pluginKey}" has "${rawCompanyId}", which is not a company UUID`);
      if (companyConfigs.has(companyId)) return invalid(`"${pluginKey}" lists company ${companyId} twice`);
      if (!isRecord(config)) return invalid(`"${pluginKey}"."${rawCompanyId}" must be a config object`);
      companyConfigs.set(companyId, config);
    }
    entries.set(pluginKey, companyConfigs);
  }
  return { ok: true, entries };
}

/** JSON with object keys sorted, so equal configs compare and hash equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256OfConfig(config: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

type Logger = Pick<typeof rootLogger, "info" | "warn" | "error">;

export type PluginConfigFileManager = PluginConfigFileManagedCheck & {
  readonly filePath: string;
  /** Read the file now (synchronously), so the managed pairs are known before requests are served. */
  load(): void;
  /** Apply every entry whose plugin is installed. */
  applyAll(): Promise<void>;
  /** Apply one plugin's entries; the loader's `beforeWorkerStart` hook. */
  applyPlugin(plugin: ApplyPluginConfigPlugin): Promise<void>;
  /** Watch the file's directory and re-read and apply on change, debounced. */
  watch(): void;
  /** Resolves once every queued read and apply has finished. */
  idle(): Promise<void>;
  close(): void;
};

export function createPluginConfigFileManager(opts: {
  db: Db;
  filePath: string;
  deps?: ApplyPluginConfigDeps;
  logger?: Logger;
  debounceMs?: number;
}): PluginConfigFileManager {
  const { db, filePath } = opts;
  const log = opts.logger ?? rootLogger.child({ service: PLUGIN_CONFIG_FILE_SOURCE });
  const registry = pluginRegistryService(db);
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  // A worker restart re-activates the plugin, whose beforeWorkerStart hook
  // queues behind the apply that asked for the restart: never await it here.
  const restartWorker = opts.deps?.restartWorker;
  const applyDeps: ApplyPluginConfigDeps = {
    workerManager: opts.deps?.workerManager,
    restartWorker: restartWorker
      ? async (pluginId) => {
          void restartWorker(pluginId).catch((err) => {
            log.warn({ err, pluginId }, `${PLUGIN_CONFIG_FILE_ENV}: worker restart after a config change failed`);
          });
        }
      : undefined,
  };

  /** Last file contents that parsed; null until one does. */
  let entries: PluginConfigFileEntries | null = null;
  let fileSha256: string | null = null;
  let watcher: FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let closed = false;
  // One apply at a time, so a file change and an activation never race on a row.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work).catch((err) => {
      log.error({ err, filePath }, `${PLUGIN_CONFIG_FILE_ENV}: apply failed`);
    });
    return queue;
  };

  function load(): void {
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (err) {
      log.error(
        { filePath, err: err instanceof Error ? err.message : String(err) },
        `${PLUGIN_CONFIG_FILE_ENV}: cannot read the file; keeping the last good plugin config`,
      );
      return;
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (err) {
      log.error(
        { filePath, err: err instanceof Error ? err.message : String(err) },
        `${PLUGIN_CONFIG_FILE_ENV}: invalid JSON; keeping the last good plugin config`,
      );
      return;
    }
    const parsed = parsePluginConfigFile(document);
    if (!parsed.ok) {
      log.error(
        { filePath, reason: parsed.error },
        `${PLUGIN_CONFIG_FILE_ENV}: invalid file (${parsed.error}); keeping the last good plugin config`,
      );
      return;
    }
    entries = parsed.entries;
    fileSha256 = createHash("sha256").update(text).digest("hex");
  }

  async function companyExists(companyId: string): Promise<boolean> {
    const rows = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
    return rows.length > 0;
  }

  function describeError(err: unknown): string {
    if (err instanceof PluginConfigSchemaError) {
      const fields = isRecord(err.fieldErrors)
        ? Object.entries(err.fieldErrors).map(([field, message]) => `${field}: ${String(message)}`)
        : [];
      return fields.length > 0 ? `${err.message} (${fields.join("; ")})` : err.message;
    }
    return err instanceof Error ? err.message : String(err);
  }

  async function applyEntry(
    plugin: ApplyPluginConfigPlugin,
    companyId: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    const context = { pluginKey: plugin.pluginKey, companyId, filePath };
    if (!(await companyExists(companyId))) {
      log.error({ ...context, reason: "unknown company" }, `${PLUGIN_CONFIG_FILE_ENV}: unknown company; entry not applied`);
      return;
    }
    const existing = await registry.getConfig(plugin.id, companyId);
    if (existing && canonicalJson(existing.configJson) === canonicalJson(config)) {
      // Unchanged: write nothing, except to clear an error this file recorded earlier.
      if (existing.lastError?.startsWith(LAST_ERROR_PREFIX)) {
        await registry.setConfigError(plugin.id, companyId, null);
      }
      return;
    }

    try {
      const { secretRefCount } = await applyPluginConfig(db, applyDeps, { plugin, companyId, configJson: config });
      const sha256 = sha256OfConfig(config);
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: PLUGIN_CONFIG_FILE_SOURCE,
        action: "plugin.config.updated",
        entityType: "plugin",
        entityId: plugin.id,
        details: {
          source: PLUGIN_CONFIG_FILE_SOURCE,
          pluginId: plugin.id,
          pluginKey: plugin.pluginKey,
          companyId,
          sha256,
          fileSha256,
          secretRefCount,
          configKeyCount: Object.keys(config).length,
        },
      });
      log.info({ ...context, sha256 }, `${PLUGIN_CONFIG_FILE_ENV}: applied plugin config`);
    } catch (err) {
      const reason = describeError(err);
      log.error(
        { ...context, reason },
        `${PLUGIN_CONFIG_FILE_ENV}: ${plugin.pluginKey} for company ${companyId} not applied (${reason}); keeping the last good config`,
      );
      if (existing) {
        await registry.setConfigError(plugin.id, companyId, `${LAST_ERROR_PREFIX}${reason}`).catch(() => undefined);
      }
    }
  }

  async function applyPluginEntries(plugin: ApplyPluginConfigPlugin): Promise<void> {
    const byCompany = entries?.get(plugin.pluginKey);
    if (!byCompany) return;
    for (const [companyId, config] of byCompany) {
      await applyEntry(plugin, companyId, config);
    }
  }

  async function applyAllNow(): Promise<void> {
    if (!entries) return;
    for (const pluginKey of entries.keys()) {
      const plugin = await registry.getByKey(pluginKey);
      if (!plugin || plugin.status === "uninstalled") {
        log.warn(
          { pluginKey, filePath },
          `${PLUGIN_CONFIG_FILE_ENV}: plugin ${pluginKey} is not installed; its config applies when it is`,
        );
        continue;
      }
      await applyPluginEntries(plugin as ApplyPluginConfigPlugin);
    }
  }

  function scheduleReload(): void {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void enqueue(async () => {
        load();
        await applyAllNow();
      });
    }, debounceMs);
    debounceTimer.unref?.();
  }

  return {
    filePath,
    managedBy(pluginKey, companyId) {
      if (!entries) {
        return {
          source: "file",
          message: `Plugin configuration is managed by ${PLUGIN_CONFIG_FILE_ENV}, which has not been read successfully; fix the file to change plugin configuration`,
        };
      }
      if (!entries.get(pluginKey)?.has(companyId.toLowerCase())) return null;
      return {
        source: "file",
        message: `This plugin's configuration for this company is managed by ${PLUGIN_CONFIG_FILE_ENV}; change it in that file`,
      };
    },
    load,
    applyAll: () => enqueue(applyAllNow),
    applyPlugin: (plugin) => enqueue(() => applyPluginEntries(plugin)),
    watch() {
      if (watcher || closed) return;
      // A Kubernetes ConfigMap mount updates by swapping a `..data` symlink in
      // the file's directory, which a watch on the file itself never sees.
      const directory = path.dirname(filePath);
      try {
        watcher = watch(directory, { persistent: false }, () => scheduleReload());
        watcher.on("error", (err) => {
          log.error({ err, directory }, `${PLUGIN_CONFIG_FILE_ENV}: watching the file's directory failed`);
        });
      } catch (err) {
        log.error(
          { directory, err: err instanceof Error ? err.message : String(err) },
          `${PLUGIN_CONFIG_FILE_ENV}: cannot watch the file's directory; changes apply on restart`,
        );
      }
    },
    idle: () => queue,
    close() {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      watcher?.close();
      watcher = null;
    },
  };
}

/** The manager for PAPERCLIP_PLUGIN_CONFIG_FILE, or null when the variable is unset. */
export function createPluginConfigFileManagerFromEnv(
  env: NodeJS.ProcessEnv,
  opts: Omit<Parameters<typeof createPluginConfigFileManager>[0], "filePath">,
): PluginConfigFileManager | null {
  const raw = env[PLUGIN_CONFIG_FILE_ENV]?.trim();
  if (!raw) return null;
  return createPluginConfigFileManager({ ...opts, filePath: path.resolve(raw) });
}
