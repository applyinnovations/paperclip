import { beforeEach, describe, expect, it, vi } from "vitest";
import { pluginManifestV1Schema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import kubernetesManifest from "../../../packages/plugins/sandbox-providers/kubernetes/src/manifest.js";
import {
  listReadyPluginEnvironmentDrivers,
  resolvePluginSandboxProviderDriverByKey,
} from "../services/plugin-environment-driver.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  listConfigs: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

const PLUGIN_ID = "plugin-capability";
const PLUGIN_KEY = "paperclip.capability-sandbox-provider";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_KEY,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Capability Sandbox Provider",
  description: "Sandbox provider that declares fine-grained capabilities.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "dist/worker.js" },
  environmentDrivers: [
    {
      driverKey: "capability-provider",
      kind: "sandbox_provider",
      displayName: "Capability Provider",
      supportsReusableLeases: true,
      sandboxCapabilities: {
        reusableLeases: true,
        nativeSyncIn: true,
        nativeSyncOut: true,
        persistentProcessSessions: false,
      },
      configSchema: { type: "object", properties: {} },
    },
  ],
};

describe("listReadyPluginEnvironmentDrivers sandbox capability projection", () => {
  beforeEach(() => {
    mockRegistry.getById.mockReset();
    mockRegistry.list.mockReset();
    mockRegistry.listConfigs.mockReset();
    mockRegistry.update.mockReset();
  });

  it("test_capabilities_propagate_from_manifest_to_ready_driver_projection", async () => {
    mockRegistry.list.mockResolvedValue([
      { id: PLUGIN_ID, pluginKey: PLUGIN_KEY, status: "ready", manifestJson: manifest },
    ]);
    const workerManager = {
      isRunning: vi.fn(() => true),
      getWorker: vi.fn(() => ({ status: "running" })),
    } as unknown as PluginWorkerManager;

    const drivers = await listReadyPluginEnvironmentDrivers({
      db: {} as never,
      workerManager,
    });

    expect(drivers).toHaveLength(1);
    // The projection allowlist carries the raw declaration through unchanged, so
    // no reader downstream loses the capability contract.
    expect(drivers[0]?.sandboxCapabilities).toEqual({
      reusableLeases: true,
      nativeSyncIn: true,
      nativeSyncOut: true,
      persistentProcessSessions: false,
    });
    expect(drivers[0]?.supportsReusableLeases).toBe(true);
  });

  // The sign-in routes gate on `resolveProviderSupportsLoginPty`, which reads
  // `supportsLoginPty` from the driver the by-key resolver returns. This runs the
  // shipped Kubernetes manifest through the manifest validator and both readers.
  it("test_kubernetes_manifest_is_login_pty_capable", async () => {
    const parsed = pluginManifestV1Schema.parse(kubernetesManifest) as PaperclipPluginManifestV1;
    const row = { id: "plugin-kubernetes", pluginKey: parsed.id, status: "ready", manifestJson: parsed };
    mockRegistry.list.mockResolvedValue([row]);
    const workerManager = {
      isRunning: vi.fn(() => true),
      getWorker: vi.fn(() => ({ status: "running" })),
    } as unknown as PluginWorkerManager;

    const resolved = await resolvePluginSandboxProviderDriverByKey({ db: {} as never, driverKey: "kubernetes" });
    expect(resolved?.driver.supportsLoginPty).toBe(true);

    const drivers = await listReadyPluginEnvironmentDrivers({ db: {} as never, workerManager });
    expect(drivers.find((driver) => driver.driverKey === "kubernetes")?.supportsLoginPty).toBe(true);
  });
});
