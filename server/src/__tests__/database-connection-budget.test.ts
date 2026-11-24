import { afterEach, describe, expect, it } from "vitest";
import { closeRegisteredClients, createDb, type Db } from "@paperclipai/db";
import { serverDatabaseConnectionBudget } from "../database-connection-budget.js";

// postgres.js clients are lazy, so these never connect.
const url = "postgres://fixture:fixture@127.0.0.1:1/server_connection_budget";
const migrationUrl = "postgres://fixture:fixture@127.0.0.1:1/server_connection_budget_migrations";
afterEach(async () => {
  await closeRegisteredClients(url, { scope: "database" });
  await closeRegisteredClients(migrationUrl, { scope: "database" });
});

describe("serverDatabaseConnectionBudget", () => {
  it("adds the deployment-notification listener to the primary owner's pools", () => {
    const db = createDb(url, { maxConnections: 5, dedicatedMaxConnections: 16 });
    expect(serverDatabaseConnectionBudget(db, db)).toEqual({
      total: 30,
      pools: {
        main: 5, controllerLease: 2, runnerCheckpoint: 3, fileStorage: 2, ownedListener: 1, dedicated: 16,
        pluginMigration: 0, deploymentNotifications: 1,
      },
    });
  });

  it("counts only the main pool of a separate plugin migration client", () => {
    const db = createDb(url, { maxConnections: 5, dedicatedMaxConnections: 16 });
    const migrationDb = createDb(migrationUrl, { maxConnections: 3 });
    expect(serverDatabaseConnectionBudget(db, migrationDb)).toMatchObject({ total: 33, pools: { pluginMigration: 3 } });
  });

  it("states no budget for clients createDb did not create", () => {
    const fake = {} as Db;
    expect(serverDatabaseConnectionBudget(fake, fake)).toBeNull();
  });
});
