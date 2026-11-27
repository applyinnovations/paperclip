import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({}),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

const pluginId = "11111111-1111-4111-8111-111111111111";
const deliveryId = "22222222-2222-4222-8222-222222222222";

const plugin = {
  id: pluginId,
  pluginKey: "example.github",
  status: "ready",
  manifestJson: {
    id: "example.github",
    capabilities: ["webhooks.receive"],
    webhooks: [{ endpointKey: "github", displayName: "GitHub" }],
  },
};

function fakeDb() {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({ values: () => ({ returning: async () => [{ id: deliveryId }] }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: async () => undefined };
      },
    }),
  };
  return { db, updates };
}

async function createApp(call: () => Promise<unknown>) {
  const { pluginRoutes } = await import("../routes/plugins.js");
  const { db, updates } = fakeDb();
  const workerManager = { call: vi.fn(call), isRunning: vi.fn().mockReturnValue(true) };
  mockRegistry.getById.mockResolvedValue(plugin);
  mockRegistry.getByKey.mockResolvedValue(plugin);
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    pluginRoutes(db as never, { installPlugin: vi.fn() } as never, undefined, { workerManager } as never),
  );
  return { app, updates, workerManager };
}

function deliver(app: express.Express) {
  return request(app)
    .post(`/api/plugins/${pluginId}/webhooks/github`)
    .set("x-github-event", "ping")
    .send({ zen: "Keep it logically awesome." });
}

describe("plugin webhook response status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers 200 and records success when the plugin returns nothing", async () => {
    const { app, updates } = await createApp(async () => undefined);
    const res = await deliver(app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deliveryId, status: "success" });
    expect(updates[0]).toMatchObject({ status: "success", error: null });
  });

  it.each([401, 503])("answers %i and records a failed delivery when the plugin rejects it", async (status) => {
    const { app, updates } = await createApp(async () => ({ status }));
    const res = await deliver(app);
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ deliveryId, status: "failed" });
    expect(updates[0]).toMatchObject({
      status: "failed",
      error: `Plugin rejected the delivery with HTTP ${status}`,
    });
  });

  it("passes a 2xx status through as a success", async () => {
    const { app, updates } = await createApp(async () => ({ status: 202 }));
    const res = await deliver(app);
    expect(res.status).toBe(202);
    expect(updates[0]).toMatchObject({ status: "success" });
  });

  it.each([[{ status: 302 }], [{ status: 99 }], [{ status: 401.5 }], [{ status: "401" }], [{}], ["401"]])(
    "answers 200 for a result without a usable status (%j)",
    async (result) => {
      const { app } = await createApp(async () => result);
      const res = await deliver(app);
      expect(res.status).toBe(200);
    },
  );

  it("still answers 502 when the worker call fails", async () => {
    const { app, updates } = await createApp(async () => {
      throw new Error("worker unavailable");
    });
    const res = await deliver(app);
    expect(res.status).toBe(502);
    expect(updates[0]).toMatchObject({ status: "failed", error: "worker unavailable" });
  });
});
