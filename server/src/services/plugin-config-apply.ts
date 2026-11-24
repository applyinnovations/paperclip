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

  // Notify the running worker about the config change (PLUGIN_SPEC §25.4.4).
  // If the worker implements onConfigChanged, send the new config via RPC.
  // If it doesn't (METHOD_NOT_IMPLEMENTED), restart the worker so it picks
  // up the new config on re-initialize. If no worker is running, skip.
  const workerManager = deps.workerManager;
  if (workerManager?.isRunning(plugin.id)) {
    // Refresh the worker's authorized proactive company scopes so the
    // just-configured company can be acted on from proactive loops (e.g.
    // the chat gateway's notifier drain) without requiring a restart
    // (LOOA-629). The set is exactly the plugin's configured companies.
    try {
      const configRows = await registry.listConfigs(plugin.id);
      workerManager.setProactiveCompanyScopes(plugin.id, configRows.map((r) => r.companyId));
    } catch {
      // Non-fatal: the set is rebuilt from the DB on the next worker start.
    }

    try {
      await workerManager.call(plugin.id, "configChanged", { config: configJson, companyId });
    } catch (rpcErr) {
      if (
        rpcErr instanceof JsonRpcCallError &&
        rpcErr.code === PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED
      ) {
        // Worker doesn't handle live config — restart it.
        try {
          await deps.restartWorker?.(plugin.id);
        } catch {
          // Restart failure is non-fatal: the config is persisted.
        }
      }
      // Other RPC errors (timeout, unavailable) are non-fatal — config is
      // already persisted and will take effect on next worker restart.
    }
  }

  return { row, secretRefCount: secretRefs.length };
}
