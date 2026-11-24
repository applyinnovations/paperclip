import { databaseConnectionBudget, type Db } from "@paperclipai/db";

/** The deployment-notification listener's own single-connection client. */
export const DEPLOYMENT_NOTIFICATION_CONNECTIONS = 1;

/**
 * The most PostgreSQL connections one server process holds at once, from its
 * configuration. Set the database role's connection limit to at least this,
 * times the number of server processes that can run together (a rollout
 * briefly runs two), plus headroom for operators and migrations.
 *
 * A separate plugin migration client (`DATABASE_MIGRATION_URL`) only ever uses
 * its main pool, so only that pool is counted for it. Returns `null` when the
 * clients did not come from `createDb`.
 */
export function serverDatabaseConnectionBudget(db: Db, pluginMigrationDb: Db) {
  const primary = databaseConnectionBudget(db);
  const migration = pluginMigrationDb === db ? null : databaseConnectionBudget(pluginMigrationDb);
  if (!primary || (pluginMigrationDb !== db && !migration)) return null;
  const pools = {
    ...primary.pools,
    pluginMigration: migration?.pools.main ?? 0,
    deploymentNotifications: DEPLOYMENT_NOTIFICATION_CONNECTIONS,
  };
  return { total: Object.values(pools).reduce((sum, value) => sum + value, 0), pools };
}
