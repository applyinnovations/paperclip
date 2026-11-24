import { afterAll, afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  checkpointDb,
  closeRegisteredClients,
  createDb,
  databaseConnectionBudget,
  dedicatedConnectionStats,
  fileStorageDb,
  livenessDb,
  withDedicatedDbConnection,
  type Db,
} from "./client.js";
import { dedicatedAdmissionLimit } from "./dedicated-connection-limiter.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1));

describe("withDedicatedDbConnection without a database", () => {
  // postgres.js clients are lazy: an action that issues no query never connects.
  const url = "postgres://fixture:fixture@127.0.0.1:1/dedicated_connection_pool";
  afterEach(() => closeRegisteredClients(url, { scope: "database" }));

  it("holds at most the bound of dedicated clients across many concurrent callers", async () => {
    const db = createDb(url, { dedicatedMaxConnections: 8 });
    let open = 0, maxOpen = 0;
    await Promise.all(Array.from({ length: 40 }, () => withDedicatedDbConnection(db, async () => {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      await tick();
      open -= 1;
    })));
    expect(maxOpen).toBe(dedicatedAdmissionLimit(8, 1));
    expect(dedicatedConnectionStats(db)).toEqual({ max: 8, inUse: 0, waiting: 0, peak: maxOpen });
  });

  it("shares the owner's bound and private pools with every child client", async () => {
    const db = createDb(url, { dedicatedMaxConnections: 4 });
    await withDedicatedDbConnection(db, async dedicated => {
      expect(livenessDb(dedicated)).toBe(livenessDb(db));
      expect(checkpointDb(dedicated)).toBe(checkpointDb(db));
      expect(fileStorageDb(dedicated)).toBe(fileStorageDb(db));
      expect(fileStorageDb(fileStorageDb(db))).toBe(fileStorageDb(db));
      await withDedicatedDbConnection(dedicated, async () => {
        expect(dedicatedConnectionStats(dedicated)).toMatchObject({ max: 4, inUse: 2 });
      });
    });
    expect(dedicatedConnectionStats(db)).toMatchObject({ inUse: 0, peak: 2 });
  });

  it("releases the slot when the action fails", async () => {
    const db = createDb(url, { dedicatedMaxConnections: 4 });
    await expect(withDedicatedDbConnection(db, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(dedicatedConnectionStats(db)).toMatchObject({ inUse: 0 });
  });

  it("states the owner's connection budget from its configuration", () => {
    expect(databaseConnectionBudget(createDb(url, { maxConnections: 5, dedicatedMaxConnections: 16 }))).toEqual({
      total: 29,
      pools: { main: 5, controllerLease: 2, runnerCheckpoint: 3, fileStorage: 2, ownedListener: 1, dedicated: 16 },
    });
    expect(databaseConnectionBudget(createDb(url, {}))?.total).toBe(34);
    expect(databaseConnectionBudget({} as Db)).toBeNull();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("withDedicatedDbConnection against PostgreSQL", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => { while (cleanups.length) await cleanups.pop()!(); });

  it("never has more dedicated backends open than its bound, including nested holders", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-dedicated-pool-");
    cleanups.push(database.cleanup);
    const observer = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(() => observer.end({ timeout: 1 }));
    const bound = 6;
    const db = createDb(database.connectionString, { dedicatedMaxConnections: bound, applicationName: "paperclip-dedicated-test" });
    cleanups.push(() => closeRegisteredClients(database.connectionString, { scope: "database" }));

    let sampling = true, maxBackends = 0;
    const sampler = (async () => {
      while (sampling) {
        const [row] = await observer<{ count: number }[]>`
          select count(*)::int as count from pg_stat_activity
          where application_name = 'paperclip-workspace-finalization-lock'`;
        maxBackends = Math.max(maxBackends, row?.count ?? 0);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })();
    const lockAndSleep = (connection: Db, key: string) => connection.$client.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      await tx`select pg_sleep(0.05)`;
    });
    await Promise.all(Array.from({ length: 24 }, (_, index) => withDedicatedDbConnection(db, async outer => {
      await lockAndSleep(outer, `outer:${index}`);
      if (index % 2 === 0) await withDedicatedDbConnection(outer, inner => lockAndSleep(inner, `inner:${index}`));
    })));
    sampling = false;
    await sampler;

    const stats = dedicatedConnectionStats(db)!;
    expect(stats.inUse).toBe(0);
    expect(stats.peak).toBeLessThanOrEqual(bound);
    expect(stats.peak).toBeGreaterThan(1);
    expect(maxBackends).toBeGreaterThan(1);
    expect(maxBackends).toBeLessThanOrEqual(bound);
  }, 60_000);
});
