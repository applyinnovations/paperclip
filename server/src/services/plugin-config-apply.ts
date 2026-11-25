/**
 * The one path that changes a plugin's company-scoped configuration.
 *
 * `POST /api/plugins/:pluginId/config` and the `PAPERCLIP_PLUGIN_CONFIG_FILE`
 * seam (see plugin-config-file.ts) both call `applyPluginConfig`, so a config
 * from either source is validated, bound to its secrets, persisted and
 * delivered to the running worker the same way.
 */
import type { Db } from "@paperclipai/db";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { unprocessable } from "../errors.js";
import { validateInstanceConfig } from "./plugin-config-validator.js";
import { withPluginConfigDeliveryLock } from "./plugin-config-delivery.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { extractSecretRefBindingsFromConfig } from "./plugin-secrets-handler.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { secretService } from "./secrets.js";

/** The plugin's configuration does not match its manifest's `instanceConfigSchema`. */
export class PluginConfigSchemaError extends Error {
  constructor(readonly fieldErrors: unknown) {
    super("Configuration does not match the plugin's instanceConfigSchema");
    this.name = "PluginConfigSchemaError";
  }
}

export type ApplyPluginConfigPlugin = {
  id: string;
  pluginKey: string;
  manifestJson?: { instanceConfigSchema?: Record<string, unknown> | null } | null;
};

export type ApplyPluginConfigDeps = {
  /** Delivers the new config to a running worker. Without it the worker reads it on its next start. */
  workerManager?: Pick<PluginWorkerManager, "isRunning" | "call" | "setProactiveCompanyScopes">;
  /** Restarts a worker that does not implement `configChanged`. */
  restartWorker?: (pluginId: string) => Promise<void>;
};

/** Every secret a plugin config references must belong to the company and not be deleted. */
export async function validatePluginSecretRefsForCompany(
  db: Db,
  companyId: string,
  refs: ReturnType<typeof extractSecretRefBindingsFromConfig>,
): Promise<void> {
  if (refs.length === 0) return;
  const secretsSvc = secretService(db);
  const checked = new Set<string>();
  for (const ref of refs) {
    if (checked.has(ref.secretId)) continue;
    checked.add(ref.secretId);
    const secret = await secretsSvc.getById(ref.secretId);
    if (!secret || secret.companyId !== companyId) {
      throw unprocessable("Plugin config references a secret outside the selected company");
    }
    if (secret.status === "deleted") {
      throw unprocessable("Plugin config references a deleted secret");
    }
  }
}

/**
 * Validate the config without persisting it: the manifest's
 * `instanceConfigSchema` (throws `PluginConfigSchemaError`), then its secret
 * references (throws an HTTP 422 error). Returns the secret references.
 */
export async function validatePluginConfig(
  db: Db,
  plugin: ApplyPluginConfigPlugin,
  companyId: string,
  configJson: Record<string, unknown>,
) {
  const schema = plugin.manifestJson?.instanceConfigSchema;
  if (schema && Object.keys(schema).length > 0) {
    const validation = validateInstanceConfig(configJson, schema);
    if (!validation.valid) throw new PluginConfigSchemaError(validation.errors);
  }
  const secretRefs = extractSecretRefBindingsFromConfig(configJson, schema ?? undefined);
  await validatePluginSecretRefsForCompany(db, companyId, secretRefs);
  return secretRefs;
}

// One scope refresh (read the rows, then set) at a time per plugin, so a
// refresh that read the rows before another writer's row can never be the
// last to set, dropping that writer's company.
const scopeRefreshes = new Map<string, Promise<void>>();
function refreshProactiveScopes(pluginId: string, refresh: () => Promise<void>): Promise<void> {
  const next = (scopeRefreshes.get(pluginId) ?? Promise.resolve()).then(refresh);
  scopeRefreshes.set(pluginId, next);
  void next.finally(() => {
    if (scopeRefreshes.get(pluginId) === next) scopeRefreshes.delete(pluginId);
  });
  return next;
}

/**
 * Validate, persist and deliver a plugin's company-scoped configuration.
 * Throws before writing anything when validation fails. Delivery to the
 * worker is best-effort: the config is persisted and a worker reads it on its
 * next start.
 */
export async function applyPluginConfig(
  db: Db,
  deps: ApplyPluginConfigDeps,
  input: { plugin: ApplyPluginConfigPlugin; companyId: string; configJson: Record<string, unknown> },
) {
  const { plugin, companyId, configJson } = input;
  const registry = pluginRegistryService(db);
  const secretRefs = await validatePluginConfig(db, plugin, companyId, configJson);
  await secretService(db).syncSecretRefsForTarget(
    companyId,
    { targetType: "plugin", targetId: plugin.id },
    secretRefs,
    { replaceAll: true },
  );
  const row = await registry.upsertConfig(plugin.id, companyId, { companyId, configJson });

  const workerManager = deps.workerManager;

  // Refresh the plugin's authorized proactive company scopes so the
  // just-configured company can be acted on from proactive loops (e.g. the
  // chat gateway's notifier drain) without a restart (LOOA-629). The set is
  // exactly the plugin's configured companies. Done whether or not the worker
  // runs now: the manager keeps the set for a worker that is stopped or still
  // starting from an older read of the rows (APP-262).
  if (workerManager) {
    await refreshProactiveScopes(plugin.id, async () => {
      try {
        const configRows = await registry.listConfigs(plugin.id);
        workerManager.setProactiveCompanyScopes(plugin.id, configRows.map((r) => r.companyId));
      } catch {
        // Non-fatal: the set is rebuilt from the DB on the next worker start.
      }
    });
  }

  // Notify the running worker about the config change (PLUGIN_SPEC §25.4.4).
  // If the worker implements onConfigChanged, send the config via RPC. If it
  // doesn't (METHOD_NOT_IMPLEMENTED), restart the worker so it picks up the
  // config on re-initialize. If no worker is running, skip: it reads the
  // stored config when it starts.
  //
  // The delivery runs in the plugin's config-delivery lock and sends the row
  // read inside it, not this call's input. The loader's startup delivery and
  // crash-respawn replay read their rows in the same lock, so whichever
  // delivery runs last sends the newest row (APP-329).
  if (workerManager) {
    const needsRestart = await withPluginConfigDeliveryLock(plugin.id, async () => {
      if (!workerManager.isRunning(plugin.id)) return false;
      let latest: Record<string, unknown> | null = row.configJson as Record<string, unknown>;
      try {
        const current = await registry.getConfig(plugin.id, companyId);
        latest = current ? ((current.configJson ?? {}) as Record<string, unknown>) : null;
      } catch {
        // Fall back to the row this call just wrote.
      }
      // Removed since this save: nothing to deliver.
      if (!latest) return false;
      try {
        await workerManager.call(plugin.id, "configChanged", { config: latest, companyId });
        return false;
      } catch (rpcErr) {
        // Other RPC errors (timeout, unavailable) are non-fatal: the config
        // is persisted and takes effect on the next worker start.
        return (
          rpcErr instanceof JsonRpcCallError &&
          rpcErr.code === PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED
        );
      }
    });
    // Outside the lock: the restarted worker's startup delivery takes it.
    if (needsRestart) {
      try {
        await deps.restartWorker?.(plugin.id);
      } catch {
        // Restart failure is non-fatal: the config is persisted.
      }
    }
  }

  return { row, secretRefCount: secretRefs.length };
}
