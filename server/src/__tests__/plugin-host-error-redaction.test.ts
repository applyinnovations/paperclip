import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostToWorkerMethods } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

// The manager's child logger is this mock, so the test reads exactly what the
// "host handler error" line would have written.
vi.mock("../middleware/logger.js", () => {
  const mockLogger: Record<string, unknown> = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => mockLogger),
  };
  return { logger: mockLogger, httpLogger: vi.fn() };
});

import { logger } from "../middleware/logger.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { redactPluginHostErrorMessage } from "../services/plugin-host-error-redaction.js";
import { createPluginSecretsHandler } from "../services/plugin-secrets-handler.js";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const INVOCATION_SCOPE_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-invocation-scope.cjs");

const MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

// Token-shaped values that must never reach a log line or the worker.
const RAW_TOKEN = "ghp_RawTokenPastedIntoConfig0123456789abcd";
const URL_PASSWORD = "hunter2-url-password";
const URL_QUERY_TOKEN = "query-token-5f3a9c";
const BOUND_PARAM = "bound-param-secret-77";
const HEADER_TOKEN = "sk-live-header-token-42";
const LEAKS = [RAW_TOKEN, URL_PASSWORD, URL_QUERY_TOKEN, BOUND_PARAM, HEADER_TOKEN];

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as never;
}

function loggedText(): string {
  return JSON.stringify([
    ...vi.mocked(logger.error).mock.calls,
    ...vi.mocked(logger.warn).mock.calls,
    ...vi.mocked(logger.info).mock.calls,
    ...vi.mocked(logger.debug).mock.calls,
  ]);
}

function expectNoLeaks(text: string) {
  for (const leak of LEAKS) expect(text).not.toContain(leak);
}

describe("redactPluginHostErrorMessage", () => {
  it("strips URL credentials, query strings and drizzle bound params", () => {
    const redacted = redactPluginHostErrorMessage(
      `request to https://bot:${URL_PASSWORD}@api.example.com/v1/items?token=${URL_QUERY_TOKEN} failed\n` +
        `Failed query: insert into "plugin_x"."t" ("k") values ($1)\nparams: ${BOUND_PARAM}`,
    );
    expectNoLeaks(redacted);
    expect(redacted).toContain("https://api.example.com/v1/items");
    expect(redacted).toContain('Failed query: insert into "plugin_x"."t"');
    expect(redacted).toContain("params: [REDACTED]");
  });

  it("strips bearer credentials", () => {
    expect(redactPluginHostErrorMessage(`upstream rejected Authorization: Bearer ${HEADER_TOKEN}`)).not.toContain(
      HEADER_TOKEN,
    );
  });

  it("leaves denial messages readable", () => {
    const denial = 'Plugin "test.plugin" is not allowed to perform "secrets.resolve"';
    expect(redactPluginHostErrorMessage(denial)).toBe(denial);
  });
});

describe("host handler errors", () => {
  afterEach(() => {
    vi.mocked(logger.error).mockClear();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.debug).mockClear();
  });

  it("keep secret refs, credentialed URLs, headers and query params out of the log and the JSON-RPC error", async () => {
    // Real handlers: each input below is rejected before any database access,
    // so a stub db is enough.
    const secrets = createPluginSecretsHandler({ db: {} as never, pluginId: "test.plugin" });
    const services = buildHostServices({} as never, "test.plugin", "test.plugin", createEventBusStub());
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: MANIFEST,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
      hostHandlers: {
        "secrets.resolve": ((params: never) => secrets.resolve(params)) as never,
        "http.fetch": ((params: never) => services.http.fetch(params)) as never,
        // A wrapped library error that echoes its arguments, as a fetch or
        // drizzle failure would.
        "companies.get": (async () => {
          throw new Error(
            `fetch https://bot:${URL_PASSWORD}@api.example.com/?token=${URL_QUERY_TOKEN} failed\n` +
              `Failed query: select 1\nparams: ${BOUND_PARAM}`,
          );
        }) as never,
      },
    });

    const callHost = (hostMethod: string, hostParams: Record<string, unknown>) =>
      handle.call("getData", {
        key: "probe",
        companyId: "company-1",
        params: { mode: "echo", requestedCompanyId: "company-1", hostMethod, hostParams },
      } as HostToWorkerMethods["getData"][0]);

    const errors: string[] = [];
    const capture = async (promise: Promise<unknown>) => {
      const err = await promise.then(
        () => {
          throw new Error("expected the host call to fail");
        },
        (e: unknown) => e as Error,
      );
      errors.push(err.message);
    };

    try {
      await handle.start();
      // An operator pasted a raw token into the plugin's secret field.
      await capture(callHost("secrets.resolve", { companyId: "company-1", secretRef: RAW_TOKEN }));
      await capture(callHost("secrets.resolve", { companyId: "company-1", secretRef: { [RAW_TOKEN]: true } }));
      await capture(
        callHost("http.fetch", { url: `https://bot:${URL_PASSWORD}@exa mple.com/?token=${URL_QUERY_TOKEN}` }),
      );
      await capture(
        callHost("http.fetch", {
          url: "https://93.184.215.14/",
          init: { headers: { [`x-api-key ${HEADER_TOKEN}`]: "v" } },
        }),
      );
      await capture(callHost("companies.get", { companyId: "company-1" }));
    } finally {
      await handle.stop().catch(() => undefined);
    }

    expect(errors).toEqual([
      expect.stringContaining("Invalid secret reference for plugin: got string"),
      expect.stringContaining("Invalid secret reference for plugin: got object with keys [1 other]"),
      expect.stringContaining("Invalid URL passed to http.fetch"),
      expect.stringContaining("Invalid request headers passed to http.fetch"),
      expect.stringContaining("params: [REDACTED]"),
    ]);
    expectNoLeaks(JSON.stringify(errors));

    const hostErrorLines = vi.mocked(logger.error).mock.calls.filter((call) => call[1] === "host handler error");
    expect(hostErrorLines).toHaveLength(5);
    expectNoLeaks(loggedText());
  });
});
