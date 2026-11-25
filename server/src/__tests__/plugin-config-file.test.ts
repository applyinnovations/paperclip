import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, pluginConfig, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  createHostClientHandlers,
  PLUGIN_RPC_ERROR_CODES,
  type HostServices,
  type HostToWorkerMethods,
} from "@paperclipai/plugin-sdk";
import { errorHandler } from "../middleware/index.js";
import { pluginRoutes } from "../routes/plugins.js";
import {
  canonicalJson,
  createPluginConfigFileManager,
  parsePluginConfigFile,
  PLUGIN_CONFIG_FILE_SOURCE,
  sha256OfConfig,
  type PluginConfigFileManager,
} from "../services/plugin-config-file.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { createPluginWorkerManager, type PluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("parsePluginConfigFile", () => {
  const companyId = "8b1c5f43-1f43-4a39-9d3c-3b2b3c1d9a01";

  it("accepts { pluginKey: { companyId: config } } and lower-cases company ids", () => {
    const parsed = parsePluginConfigFile({ "acme.gate": { [companyId.toUpperCase()]: { mode: "shadow" } } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries.get("acme.gate")?.get(companyId)).toEqual({ mode: "shadow" });
  });

  it.each([
    ["a non-object root", []],
    ["a plugin whose value is not an object", { "acme.gate": "x" }],
    ["a company key that is not a UUID", { "acme.gate": { "not-a-company": {} } }],
    ["a config that is not an object", { "acme.gate": { [companyId]: [1] } }],
    ["a company listed twice", { "acme.gate": { [companyId]: {}, [companyId.toUpperCase()]: {} } }],
    ["an empty plugin key", { "": {} }],
  ])("rejects the whole file for %s", (_name, document) => {
    expect(parsePluginConfigFile(document).ok).toBe(false);
  });

  it("compares and hashes configs independently of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }))
      .toBe('{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
    expect(sha256OfConfig({ a: 1, b: 2 })).toBe(sha256OfConfig({ b: 2, a: 1 }));
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping PAPERCLIP_PLUGIN_CONFIG_FILE tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const GATE_KEY = "acme.approval-gate";
// Answers a getData call by making a worker→host call; mode "omit" makes it a
// proactive call (no invocation id), as a background job's would be.
const PROACTIVE_WORKER_ENTRYPOINT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "plugin-worker-invocation-scope.cjs",
);
const SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["shadow", "enforce"] },
    approvers: { type: "array", items: { type: "string" } },
  },
  required: ["mode"],
  additionalProperties: false,
};

describeEmbeddedPostgres("PAPERCLIP_PLUGIN_CONFIG_FILE", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let dir: string;
  const managers: PluginConfigFileManager[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-config-file-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "plugin-config-file-"));
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) manager.close();
    rmSync(dir, { recursive: true, force: true });
    await db.delete(activityLog);
    await db.delete(pluginConfig);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlugin(pluginKey = GATE_KEY) {
    const id = randomUUID();
    await db.insert(plugins).values({
      id,
      pluginKey,
      packageName: `@acme/${pluginKey}`,
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: pluginKey,
        apiVersion: 1,
        version: "0.0.1",
        displayName: pluginKey,
        description: "Test plugin",
        author: "Acme",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
        instanceConfigSchema: SCHEMA,
      } as never,
      status: "ready",
      installOrder: 1,
    });
    return (await pluginRegistryService(db).getById(id))!;
  }

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `Co ${id.slice(0, 6)}`,
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return id;
  }

  function fakeWorkerManager() {
    return {
      isRunning: vi.fn(() => true),
      call: vi.fn(async () => undefined),
      setProactiveCompanyScopes: vi.fn(),
    };
  }

  function startManager(
    filePath: string,
    workerManager: unknown = fakeWorkerManager(),
    options: { watch?: boolean } = {},
  ) {
    const manager = createPluginConfigFileManager({
      db,
      filePath,
      deps: { workerManager: workerManager as never },
      debounceMs: 50,
    });
    managers.push(manager);
    // As app.ts does: watch first, then read, so no change falls between.
    if (options.watch) manager.watch();
    manager.load();
    return { manager, workerManager: workerManager as ReturnType<typeof fakeWorkerManager> };
  }

  /** Kubernetes ConfigMap layout: file -> ..data/file, ..data -> ..<version>/ */
  function configMapDir() {
    const filePath = path.join(dir, "plugin-config.json");
    let current: string | null = null;
    const publish = (version: string, document: unknown) => {
      mkdirSync(path.join(dir, version));
      writeFileSync(path.join(dir, version, "plugin-config.json"), JSON.stringify(document));
      if (current === null) {
        symlinkSync(version, path.join(dir, "..data"));
        symlinkSync(path.join("..data", "plugin-config.json"), filePath);
      } else {
        symlinkSync(version, path.join(dir, "..data_tmp"));
        renameSync(path.join(dir, "..data_tmp"), path.join(dir, "..data"));
        rmSync(path.join(dir, current), { recursive: true });
      }
      current = version;
    };
    return { filePath, publish };
  }

  function writeConfigFile(document: unknown, name = "plugin-config.json") {
    const filePath = path.join(dir, name);
    writeFileSync(filePath, typeof document === "string" ? document : JSON.stringify(document));
    return filePath;
  }

  async function configRow(pluginId: string, companyId: string) {
    const rows = await db
      .select()
      .from(pluginConfig)
      .where(and(eq(pluginConfig.pluginId, pluginId), eq(pluginConfig.companyId, companyId)));
    return rows[0] ?? null;
  }

  async function fileActivities() {
    const rows = await db.select().from(activityLog).where(eq(activityLog.actorId, PLUGIN_CONFIG_FILE_SOURCE));
    return rows;
  }

  it("applies at startup, notifies the worker and records an activity; a second start writes nothing", async () => {
    const plugin = await seedPlugin();
    const companyId = await seedCompany();
    const config = { mode: "shadow", approvers: ["alice"] };
    const filePath = writeConfigFile({ [GATE_KEY]: { [companyId]: config } });

    const first = startManager(filePath);
    await first.manager.applyAll();

    const row = await configRow(plugin.id, companyId);
    expect(row?.configJson).toEqual(config);
    expect(first.workerManager.call).toHaveBeenCalledWith(plugin.id, "configChanged", { config, companyId });
    const activities = await fileActivities();
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      companyId,
      actorType: "system",
      action: "plugin.config.updated",
      entityId: plugin.id,
    });
    expect(activities[0]!.details).toMatchObject({
      source: PLUGIN_CONFIG_FILE_SOURCE,
      pluginKey: GATE_KEY,
      companyId,
      sha256: sha256OfConfig(config),
    });

    first.manager.close();
    const second = startManager(filePath);
    await second.manager.applyAll();

    expect(second.workerManager.call).not.toHaveBeenCalled();
    expect((await configRow(plugin.id, companyId))?.updatedAt).toEqual(row?.updatedAt);
    expect(await fileActivities()).toHaveLength(1);
  });

  it("re-applies after a ConfigMap-style symlink swap, debounced", async () => {
    const plugin = await seedPlugin();
    const companyId = await seedCompany();
    // Kubernetes layout: file -> ..data/file, ..data -> ..<timestamp>/
    const writeVersion = (version: string, mode: string) => {
      mkdirSync(path.join(dir, version));
      writeFileSync(
        path.join(dir, version, "plugin-config.json"),
        JSON.stringify({ [GATE_KEY]: { [companyId]: { mode } } }),
      );
    };
    writeVersion("..v1", "shadow");
    symlinkSync("..v1", path.join(dir, "..data"));
    symlinkSync(path.join("..data", "plugin-config.json"), path.join(dir, "plugin-config.json"));

    const { manager, workerManager } = startManager(path.join(dir, "plugin-config.json"));
    await manager.applyAll();
    manager.watch();
    expect((await configRow(plugin.id, companyId))?.configJson).toEqual({ mode: "shadow" });

    writeVersion("..v2", "enforce");
    symlinkSync("..v2", path.join(dir, "..data_tmp"));
    renameSync(path.join(dir, "..data_tmp"), path.join(dir, "..data"));
    rmSync(path.join(dir, "..v1"), { recursive: true });

    await vi.waitFor(async () => {
      await manager.idle();
      expect((await configRow(plugin.id, companyId))?.configJson).toEqual({ mode: "enforce" });
    }, { timeout: 5_000, interval: 50 });
    expect(workerManager.call).toHaveBeenLastCalledWith(plugin.id, "configChanged", {
      config: { mode: "enforce" },
      companyId,
    });
    expect(await fileActivities()).toHaveLength(2);
  });

  it("keeps the last good config and sets last_error for an invalid entry, and still applies the others", async () => {
    const plugin = await seedPlugin();
    const goodCompany = await seedCompany();
    const badCompany = await seedCompany();
    const unknownCompany = randomUUID();
    await pluginRegistryService(db).upsertConfig(plugin.id, badCompany, {
      companyId: badCompany,
      configJson: { mode: "shadow" },
    });
    const filePath = writeConfigFile({
      [GATE_KEY]: {
        [goodCompany]: { mode: "enforce" },
        [badCompany]: { mode: "off" },
        [unknownCompany]: { mode: "enforce" },
      },
    });

    const { manager } = startManager(filePath);
    await expect(manager.applyAll()).resolves.toBeUndefined();

    expect((await configRow(plugin.id, goodCompany))?.configJson).toEqual({ mode: "enforce" });
    const bad = await configRow(plugin.id, badCompany);
    expect(bad?.configJson).toEqual({ mode: "shadow" });
    expect(bad?.lastError).toMatch(/^PAPERCLIP_PLUGIN_CONFIG_FILE: Configuration does not match/);
    expect(await configRow(plugin.id, unknownCompany)).toBeNull();

    // An invalid file keeps everything (and what is managed) as it was.
    writeConfigFile("{ not json");
    manager.load();
    await manager.applyAll();
    expect((await configRow(plugin.id, goodCompany))?.configJson).toEqual({ mode: "enforce" });
    expect(manager.managedBy(GATE_KEY, goodCompany)).not.toBeNull();

    // Fixing the entry back to the stored config clears the error without a write.
    writeConfigFile({ [GATE_KEY]: { [goodCompany]: { mode: "enforce" }, [badCompany]: { mode: "shadow" } } });
    manager.load();
    await manager.applyAll();
    expect((await configRow(plugin.id, badCompany))?.lastError).toBeNull();
  });

  it("applies a plugin's entry when the plugin is installed after boot", async () => {
    const companyId = await seedCompany();
    const filePath = writeConfigFile({ [GATE_KEY]: { [companyId]: { mode: "shadow" } } });
    const { manager } = startManager(filePath);
    await manager.applyAll(); // not installed yet: warns, writes nothing
    expect(await db.select().from(pluginConfig)).toHaveLength(0);

    const plugin = await seedPlugin();
    // The loader calls this (beforeWorkerStart) on activation, before the worker starts.
    await manager.applyPlugin(plugin as never);
    expect((await configRow(plugin.id, companyId))?.configJson).toEqual({ mode: "shadow" });
  });

  it("removing an entry stops managing the pair and leaves its config", async () => {
    const plugin = await seedPlugin();
    const companyId = await seedCompany();
    const filePath = writeConfigFile({ [GATE_KEY]: { [companyId]: { mode: "enforce" } } });
    const { manager } = startManager(filePath);
    await manager.applyAll();

    writeConfigFile({});
    manager.load();
    await manager.applyAll();
    expect(manager.managedBy(GATE_KEY, companyId)).toBeNull();
    expect((await configRow(plugin.id, companyId))?.configJson).toEqual({ mode: "enforce" });
  });

  it("re-applies a symlink swap made right after the first read, with no later change", async () => {
    const plugin = await seedPlugin();
    const companyId = await seedCompany();
    const { filePath, publish } = configMapDir();
    publish("..v1", { [GATE_KEY]: { [companyId]: { mode: "shadow" } } });

    // Startup: the file is read before plugins start; the swap lands while
    // they are starting, and nothing changes after it.
    const { manager } = startManager(filePath, fakeWorkerManager(), { watch: true });
    publish("..v2", { [GATE_KEY]: { [companyId]: { mode: "enforce" } } });

    await vi.waitFor(async () => {
      await manager.idle();
      expect((await configRow(plugin.id, companyId))?.configJson).toEqual({ mode: "enforce" });
    }, { timeout: 5_000, interval: 50 });
    expect(manager.managedBy(GATE_KEY, companyId)).not.toBeNull();
  });

  it("reload() at the end of startup picks up a change made after the first read", async () => {
    const plugin = await seedPlugin();
    const companyId = await seedCompany();
    const { filePath, publish } = configMapDir();
    publish("..v1", { [GATE_KEY]: { [companyId]: { mode: "shadow" } } });
    const { manager } = startManager(filePath); // no watch: no change event at all

    publish("..v2", { [GATE_KEY]: { [companyId]: { mode: "enforce" } } });
    await manager.reload();

    expect((await configRow(plugin.id, companyId))?.configJson).toEqual({ mode: "enforce" });
  });

  describe("proactive company scopes", () => {
    const workerManagers: PluginWorkerManager[] = [];

    afterEach(async () => {
      for (const workerManager of workerManagers.splice(0)) await workerManager.stopAll();
    });

    const manifest: PaperclipPluginManifestV1 = {
      id: GATE_KEY,
      apiVersion: 1,
      version: "0.0.1",
      displayName: GATE_KEY,
      description: "Test plugin",
      author: "Acme",
      categories: ["automation"],
      capabilities: [],
      entrypoints: { worker: "./dist/worker.js" },
    };

    /** What the loader does: read the scope generation, then the rows, then start the worker. */
    function readStartScopes(workerManager: PluginWorkerManager, pluginId: string) {
      const generation = workerManager.proactiveScopeGeneration(pluginId);
      return pluginRegistryService(db).listConfigs(pluginId).then((rows) => ({
        generation,
        companyIds: rows.map((row) => row.companyId),
      }));
    }

    async function startWorker(
      workerManager: PluginWorkerManager,
      pluginId: string,
      scopes: { generation: number; companyIds: string[] },
    ) {
      const registry = pluginRegistryService(db);
      await workerManager.startWorker(pluginId, {
        entrypointPath: PROACTIVE_WORKER_ENTRYPOINT,
        manifest,
        config: {},
        instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
        apiVersion: 1,
        hostHandlers: createHostClientHandlers({
          pluginId,
          capabilities: [],
          services: {
            config: {
              get: async ({ companyId }: { companyId?: string }) =>
                (await registry.getConfig(pluginId, companyId!))?.configJson ?? {},
            },
          } as unknown as HostServices,
        }),
        proactiveCompanyScopes: scopes.companyIds,
        proactiveCompanyScopesGeneration: scopes.generation,
      });
    }

    /** `ctx.config.get(companyId)` from a background job: no invocation. */
    function proactiveConfigGet(workerManager: PluginWorkerManager, pluginId: string, companyId: string) {
      return workerManager.call(pluginId, "getData", {
        params: { mode: "omit", hostMethod: "config.get", requestedCompanyId: companyId },
      } as unknown as HostToWorkerMethods["getData"][0]);
    }

    function realWorkerManager() {
      const workerManager = createPluginWorkerManager();
      workerManagers.push(workerManager);
      return workerManager;
    }

    it("authorizes a company configured at startup, before the worker starts", async () => {
      const plugin = await seedPlugin();
      const companyId = await seedCompany();
      const workerManager = realWorkerManager();
      const { manager } = startManager(writeConfigFile({ [GATE_KEY]: { [companyId]: { mode: "shadow" } } }), workerManager);

      await manager.applyPlugin(plugin as never); // beforeWorkerStart
      await startWorker(workerManager, plugin.id, await readStartScopes(workerManager, plugin.id));

      await expect(proactiveConfigGet(workerManager, plugin.id, companyId)).resolves.toEqual({ mode: "shadow" });
    });

    it("authorizes a company written between the loader's row read and the worker start", async () => {
      const plugin = await seedPlugin();
      const companyId = await seedCompany();
      const workerManager = realWorkerManager();
      const { manager } = startManager(writeConfigFile({ [GATE_KEY]: { [companyId]: { mode: "shadow" } } }), workerManager);

      const staleScopes = await readStartScopes(workerManager, plugin.id);
      expect(staleScopes.companyIds).toEqual([]);
      await manager.applyAll(); // no worker registered: isRunning is false
      await startWorker(workerManager, plugin.id, staleScopes);

      await expect(proactiveConfigGet(workerManager, plugin.id, companyId)).resolves.toEqual({ mode: "shadow" });
    });

    it("a later start from a fresh read uses that read, not an older kept set", async () => {
      const plugin = await seedPlugin();
      const companyId = await seedCompany();
      const workerManager = realWorkerManager();
      const { manager } = startManager(writeConfigFile({ [GATE_KEY]: { [companyId]: { mode: "shadow" } } }), workerManager);
      await manager.applyAll();
      // The row goes away (outside this seam); the next start reads after the kept set.
      await db.delete(pluginConfig);
      await startWorker(workerManager, plugin.id, await readStartScopes(workerManager, plugin.id));

      await expect(proactiveConfigGet(workerManager, plugin.id, companyId)).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
      });
    });

    it("authorizes a company added by a file change, without a worker restart", async () => {
      const plugin = await seedPlugin();
      const first = await seedCompany();
      const added = await seedCompany();
      const workerManager = realWorkerManager();
      const filePath = writeConfigFile({ [GATE_KEY]: { [first]: { mode: "shadow" } } });
      const { manager } = startManager(filePath, workerManager);
      await manager.applyPlugin(plugin as never);
      await startWorker(workerManager, plugin.id, await readStartScopes(workerManager, plugin.id));
      await expect(proactiveConfigGet(workerManager, plugin.id, added)).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
      });

      writeConfigFile({ [GATE_KEY]: { [first]: { mode: "shadow" }, [added]: { mode: "enforce" } } });
      await manager.reload();

      await expect(proactiveConfigGet(workerManager, plugin.id, added)).resolves.toEqual({ mode: "enforce" });
      expect(workerManager.isRunning(plugin.id)).toBe(true);
    });
  });

  it("treats every pair as managed until the file has been read once", () => {
    const { manager } = startManager(path.join(dir, "missing.json"));
    expect(manager.managedBy(GATE_KEY, randomUUID())).toMatchObject({ source: "file" });
  });

  describe("config routes", () => {
    function createApp(manager: PluginConfigFileManager, companyIds: string[]) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = {
          type: "board",
          userId: "admin-1",
          source: "local_implicit",
          isInstanceAdmin: true,
          companyIds,
        } as typeof req.actor;
        next();
      });
      app.use(
        "/api",
        pluginRoutes(db, {} as never, undefined, undefined, undefined, undefined, undefined, manager),
      );
      app.use(errorHandler);
      return app;
    }

    it("refuses writes to a managed pair with 409, allows unmanaged pairs, and flags managed reads", async () => {
      const plugin = await seedPlugin();
      const managed = await seedCompany();
      const unmanaged = await seedCompany();
      const filePath = writeConfigFile({ [GATE_KEY]: { [managed]: { mode: "enforce" } } });
      const { manager } = startManager(filePath);
      await manager.applyAll();
      const app = createApp(manager, [managed, unmanaged]);

      const refused = await request(app)
        .post(`/api/plugins/${plugin.id}/config`)
        .send({ companyId: managed, configJson: { mode: "shadow" } });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toContain("PAPERCLIP_PLUGIN_CONFIG_FILE");
      expect((await configRow(plugin.id, managed))?.configJson).toEqual({ mode: "enforce" });

      const allowed = await request(app)
        .post(`/api/plugins/${plugin.id}/config`)
        .send({ companyId: unmanaged, configJson: { mode: "shadow" } });
      expect(allowed.status).toBe(200);
      expect((await configRow(plugin.id, unmanaged))?.configJson).toEqual({ mode: "shadow" });

      const managedRead = await request(app).get(`/api/plugins/${plugin.id}/config?companyId=${managed}`);
      expect(managedRead.status).toBe(200);
      expect(managedRead.body).toMatchObject({ configJson: { mode: "enforce" }, managedBy: "file" });

      const unmanagedRead = await request(app).get(`/api/plugins/${plugin.id}/config?companyId=${unmanaged}`);
      expect(unmanagedRead.body.managedBy).toBeUndefined();
    });

    it("flags a managed pair with no stored config as managed, and refuses writes to it", async () => {
      const plugin = await seedPlugin();
      const companyId = await seedCompany();
      // The entry fails validation, so no row is stored.
      const { manager } = startManager(writeConfigFile({ [GATE_KEY]: { [companyId]: { mode: "off" } } }));
      await manager.applyAll();
      expect(await configRow(plugin.id, companyId)).toBeNull();
      const app = createApp(manager, [companyId]);

      const read = await request(app).get(`/api/plugins/${plugin.id}/config?companyId=${companyId}`);
      expect(read.status).toBe(200);
      expect(read.body).toEqual({
        id: null,
        pluginId: plugin.id,
        companyId,
        configJson: {},
        lastError: null,
        managedBy: "file",
        createdAt: null,
        updatedAt: null,
      });

      const refused = await request(app)
        .post(`/api/plugins/${plugin.id}/config`)
        .send({ companyId, configJson: { mode: "shadow" } });
      expect(refused.status).toBe(409);

      const unmanaged = await seedCompany();
      const unmanagedRead = await request(createApp(manager, [unmanaged]))
        .get(`/api/plugins/${plugin.id}/config?companyId=${unmanaged}`);
      expect(unmanagedRead.body).toBeNull();
    });

    it("rejects a config that does not match the schema through the shared path", async () => {
      const plugin = await seedPlugin();
      const companyId = await seedCompany();
      const { manager } = startManager(writeConfigFile({}));
      const app = createApp(manager, [companyId]);

      const res = await request(app)
        .post(`/api/plugins/${plugin.id}/config`)
        .send({ companyId, configJson: { mode: "off" } });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Configuration does not match the plugin's instanceConfigSchema");
      expect(res.body.fieldErrors).toBeDefined();
    });
  });
});
