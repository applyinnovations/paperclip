/**
 * Ordering and logging rules shared by every path that delivers a plugin's
 * stored company config to its worker through `configChanged`: an operator
 * save or `PAPERCLIP_PLUGIN_CONFIG_FILE` (plugin-config-apply.ts), the
 * loader's startup delivery and its crash-respawn replay (plugin-loader.ts).
 */

const deliveryQueues = new Map<string, Promise<unknown>>();

/**
 * Run `task` after every config delivery already queued for this plugin.
 *
 * Each task reads the stored config inside the lock, then delivers it. A save
 * queues its task only after it writes the row, so whichever task runs last
 * reads a row at least as new as every save before it: the worker always ends
 * on the latest stored config, whatever order a save and a replay race in.
 *
 * Never call anything that waits on this lock from inside `task` (for example
 * a worker restart, whose startup delivery takes the lock), or it deadlocks.
 */
export function withPluginConfigDeliveryLock<T>(pluginId: string, task: () => Promise<T>): Promise<T> {
  const previous = deliveryQueues.get(pluginId) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(() => undefined, () => undefined);
  deliveryQueues.set(pluginId, tail);
  void tail.then(() => {
    if (deliveryQueues.get(pluginId) === tail) deliveryQueues.delete(pluginId);
  });
  return run;
}

/**
 * Log fields for a delivery or config-read error. Error messages are left out
 * on purpose: a worker's `configChanged` handler (or a database driver) can
 * put config values, including secrets, in its message.
 */
export function configDeliveryErrorFields(err: unknown): { errorName: string; code?: number | string } {
  const errorName = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" || typeof code === "string" ? { errorName, code } : { errorName };
}
