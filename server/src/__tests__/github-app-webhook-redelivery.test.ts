import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import {
  createGitHubAppWebhookRedeliverer,
  GITHUB_WEBHOOK_DELIVERY_RETENTION_MS,
  nextDeliveriesCursor,
} from "../services/github-app-webhook-redelivery.js";
import { buildHostServices } from "../services/plugin-host-services.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const COMPANY_A = "a9d886a3-e526-461c-95d6-d2d0d6b6c722";
const COMPANY_B = "0b6f3c0e-1c1d-4c39-9d43-6a3f9d1c2e01";
const CONFIG_PATH = "/etc/paperclip/github-apps.json";
const FILE = {
  apps: [
    { companyId: COMPANY_A, appId: "5462605", installationId: "175009740", privateKeyFile: "/var/run/a.pem" },
    { companyId: COMPANY_B, appId: "5462606", installationId: "175009741", privateKeyFile: "/var/run/b.pem" },
  ],
};
const env = { PAPERCLIP_GITHUB_APPS_FILE: CONFIG_PATH };
const readConfigFile = (file: string) => {
  if (file !== CONFIG_PATH) throw new Error("unexpected file");
  return JSON.stringify(FILE);
};

const NOW = new Date("2026-11-24T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

type Attempt = { id: number; guid: string; delivered_at: string; status_code: number; installation_id?: number | null };
const attempt = (id: number, guid: string, minutes: number, statusCode: number, installationId = 175009740): Attempt => ({
  id,
  guid,
  delivered_at: minutesAgo(minutes),
  status_code: statusCode,
  installation_id: installationId,
});

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * A fake GitHub deliveries API. `pages` are served newest first, linked by cursors `c1`, `c2`, …
 * Each request records its URL, method and bearer token.
 */
function fakeGitHub(pages: Attempt[][], options: { listStatus?: number; refuse?: number[] } = {}) {
  const calls: { path: string; method: string; authorization: string | null }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ path: `${url.pathname}${url.search}`, method, authorization });
    if (method === "GET" && url.pathname === "/app/hook/deliveries") {
      if (options.listStatus) return json(options.listStatus, { message: "Bad credentials -----BEGIN RSA PRIVATE KEY-----" });
      const cursor = url.searchParams.get("cursor");
      const index = cursor ? Number(cursor.slice(1)) : 0;
      const next: Record<string, string> = index + 1 < pages.length
        ? { link: `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=c${index + 1}>; rel="next"` }
        : {};
      return json(200, pages[index] ?? [], next);
    }
    const redeliver = /^\/app\/hook\/deliveries\/(\d+)\/attempts$/.exec(url.pathname);
    if (method === "POST" && redeliver) {
      if (options.refuse?.includes(Number(redeliver[1]))) return json(422, { message: "nope" });
      return json(202, {});
    }
    return json(404, { message: "Not Found" });
  });
  const posted = () =>
    calls.filter((call) => call.method === "POST").map((call) => Number(/deliveries\/(\d+)/.exec(call.path)![1]));
  const listed = () => calls.filter((call) => call.method === "GET").map((call) => call.path);
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, posted, listed };
}

function redeliverer(github: ReturnType<typeof fakeGitHub>, overrides: { maxPages?: number; readPrivateKey?: () => Promise<string> } = {}) {
  return createGitHubAppWebhookRedeliverer({
    env,
    readConfigFile,
    fetchImpl: github.fetchImpl,
    readPrivateKey: overrides.readPrivateKey ?? (async () => PEM),
    now: () => NOW,
    maxPages: overrides.maxPages,
  });
}

describe("GitHub App webhook redelivery", () => {
  it("redelivers only failed GUIDs, oldest first, and skips GUIDs that later succeeded", async () => {
    const github = fakeGitHub([
      [
        attempt(9, "g-retried-ok", 5, 200), // a later redelivery succeeded
        attempt(8, "g-failed-twice", 10, 502),
        attempt(7, "g-ok", 20, 202),
        attempt(6, "g-failed-twice", 30, 0), // timed out
        attempt(5, "g-retried-ok", 40, 500),
        attempt(4, "g-failed-once", 50, 503),
      ],
    ]);
    const result = await redeliverer(github).redeliverFailed(COMPANY_A, new Date(minutesAgo(60)));
    expect(result).toMatchObject({
      status: "done",
      appId: "5462605",
      redelivered: ["g-failed-once", "g-failed-twice"],
      skipped: 2,
      failed: [],
    });
    // The latest attempt of each failed GUID is the one redelivered.
    expect(github.posted()).toEqual([4, 8]);
  });

  it("respects since: stops paging past it and ignores older deliveries", async () => {
    const github = fakeGitHub([
      [attempt(30, "g-new", 10, 500), attempt(29, "g-old", 90, 500)],
      [attempt(20, "g-older", 120, 500)],
    ]);
    const result = await redeliverer(github).redeliverFailed(COMPANY_A, new Date(minutesAgo(60)));
    expect(result).toMatchObject({ status: "done", redelivered: ["g-new"], skipped: 0, since: minutesAgo(60) });
    expect(github.listed()).toHaveLength(1);
    expect(github.posted()).toEqual([30]);
  });

  it("paginates by cursor until the window is covered", async () => {
    const github = fakeGitHub([
      [attempt(30, "g-3", 10, 500)],
      [attempt(20, "g-2", 20, 200)],
      [attempt(10, "g-1", 30, 404), attempt(9, "g-0", 200, 500)],
    ]);
    const result = await redeliverer(github).redeliverFailed(COMPANY_A, new Date(minutesAgo(60)));
    expect(result).toMatchObject({ status: "done", redelivered: ["g-1", "g-3"], skipped: 1 });
    expect(github.listed()).toEqual([
      "/app/hook/deliveries?per_page=100",
      "/app/hook/deliveries?per_page=100&cursor=c1",
      "/app/hook/deliveries?per_page=100&cursor=c2",
    ]);
  });

  it("stops at the page cap", async () => {
    const github = fakeGitHub([[attempt(30, "g-3", 10, 500)], [attempt(20, "g-2", 20, 500)], [attempt(10, "g-1", 30, 500)]]);
    const result = await redeliverer(github, { maxPages: 2 }).redeliverFailed(COMPANY_A, new Date(minutesAgo(60)));
    expect(result).toMatchObject({ redelivered: ["g-2", "g-3"] });
    expect(github.listed()).toHaveLength(2);
  });

  it("caps the lookback to GitHub's three-day retention", async () => {
    const github = fakeGitHub([[attempt(1, "g", 10, 500)]]);
    const result = await redeliverer(github).redeliverFailed(COMPANY_A, new Date("2020-01-01T00:00:00Z"));
    expect(result).toMatchObject({
      status: "done",
      since: new Date(NOW.getTime() - GITHUB_WEBHOOK_DELIVERY_RETENTION_MS).toISOString(),
    });
  });

  it("ignores deliveries for another installation of the App", async () => {
    const github = fakeGitHub([[attempt(2, "g-other", 10, 500, 999), attempt(1, "g-app", 20, 500)]]);
    const result = await redeliverer(github).redeliverFailed(COMPANY_A, new Date(minutesAgo(60)));
    expect(result).toMatchObject({ redelivered: ["g-app"] });
    expect(github.posted()).toEqual([1]);
  });

  it("reports refused redeliveries and carries on", async () => {
    const github = fakeGitHub([[attempt(2, "g-2", 10, 500), attempt(1, "g-1", 20, 500)]], { refuse: [1] });
    const result = await redeliverer(github).redeliverFailed(COMPANY_A, new Date(minutesAgo(60)));
    expect(result).toMatchObject({ status: "done", redelivered: ["g-2"], failed: ["g-1"] });
  });

  it("calls GitHub with the company's own App JWT", async () => {
    const github = fakeGitHub([[attempt(1, "g", 10, 500)]]);
    await redeliverer(github).redeliverFailed(COMPANY_B, new Date(minutesAgo(60)));
    const [, payload] = github.calls[0]!.authorization!.replace(/^Bearer /, "").split(".");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ iss: "5462606" });
  });

  it("does nothing for a company without an App, and refuses an App shared by several companies", async () => {
    const github = fakeGitHub([[attempt(1, "g", 10, 500)]]);
    await expect(
      redeliverer(github).redeliverFailed("7c2a5d4e-8f60-4b1a-a3c2-1d9e8f7a6b55", new Date(minutesAgo(60))),
    ).resolves.toEqual({ status: "not_applicable" });
    const shared = createGitHubAppWebhookRedeliverer({
      env: {
        PAPERCLIP_GITHUB_APP_ID: "5462605",
        PAPERCLIP_GITHUB_APP_INSTALLATION_ID: "175009740",
        PAPERCLIP_GITHUB_APP_PRIVATE_KEY_FILE: "/var/run/a.pem",
        PAPERCLIP_GITHUB_APP_COMPANY_IDS: `${COMPANY_A},${COMPANY_B}`,
      },
      fetchImpl: github.fetchImpl,
      readPrivateKey: async () => PEM,
      now: () => NOW,
    });
    await expect(shared.redeliverFailed(COMPANY_A, new Date(minutesAgo(60)))).resolves.toMatchObject({ status: "denied" });
    expect(github.calls).toHaveLength(0);
  });

  it("fails without leaking the JWT, the key or GitHub's error body", async () => {
    const github = fakeGitHub([], { listStatus: 401 });
    const result = await redeliverer(github).redeliverFailed(COMPANY_A, new Date(minutesAgo(60)));
    expect(result.status).toBe("unavailable");
    const jwt = github.calls[0]!.authorization!.replace(/^Bearer /, "");
    const text = JSON.stringify(result);
    expect(text).not.toContain(jwt);
    expect(text).not.toMatch(/PRIVATE KEY|eyJ|Bad credentials/);

    const badKey = await redeliverer(fakeGitHub([]), { readPrivateKey: async () => "-----BEGIN RSA PRIVATE KEY-----\nsecret" })
      .redeliverFailed(COMPANY_A, new Date(minutesAgo(60)));
    expect(badKey.status).toBe("unavailable");
    expect(JSON.stringify(badKey)).not.toMatch(/PRIVATE KEY|secret/);
  });

  it("takes only the cursor from the next link", () => {
    expect(
      nextDeliveriesCursor(
        '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1_9>; rel="next", <https://api.github.com/x>; rel="prev"',
      ),
    ).toBe("v1_9");
    expect(nextDeliveriesCursor('<https://api.github.com/x>; rel="prev"')).toBeNull();
    expect(nextDeliveriesCursor(null)).toBeNull();
  });
});

describe("plugin webhook redelivery host service", () => {
  const eventBus = { forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn() }) } as never;
  // No database: the activity log entry fails, which must never break the call.
  const db = {} as never;
  const setup = (github = fakeGitHub([[attempt(1, "g-1", 10, 500)]])) => {
    const services = buildHostServices(db, "plugin-record-id", "paperclip.github", eventBus, undefined, {
      githubAppRedeliveries: redeliverer(github),
    });
    const handlers = (capabilities: string[]) =>
      createHostClientHandlers({ pluginId: "paperclip.github", capabilities: capabilities as never, services });
    return { github, handlers };
  };
  const scope = (companyId: string) => ({ invocationScope: { companyId } });

  it("redelivers for the invocation's company and returns no payloads", async () => {
    const { handlers } = setup();
    const result = await handlers(["github.app.webhooks.redeliver"])["githubApp.redeliverFailedDeliveries"](
      { since: minutesAgo(60) },
      scope(COMPANY_A),
    );
    expect(result).toEqual({
      redelivered: ["g-1"],
      skipped: 0,
      failed: [],
      since: minutesAgo(60),
      appId: "5462605",
      companyId: COMPANY_A,
    });
  });

  it("denies another company, a missing since, and calls without the capability", async () => {
    const { github, handlers } = setup();
    const call = handlers(["github.app.webhooks.redeliver"])["githubApp.redeliverFailedDeliveries"];
    await expect(call({ since: minutesAgo(60), companyId: COMPANY_B }, scope(COMPANY_A))).rejects.toThrow(/scoped to company/);
    await expect(call({ since: minutesAgo(60) }, {})).rejects.toThrow(/company context is required/);
    await expect(call({ since: "yesterday" }, scope(COMPANY_A))).rejects.toThrow(/requires since/);
    await expect(
      handlers(["github.app.token", "github.app.webhooks.verify"])["githubApp.redeliverFailedDeliveries"](
        { since: minutesAgo(60) },
        scope(COMPANY_A),
      ),
    ).rejects.toThrow(/github\.app\.webhooks\.redeliver/);
    expect(github.calls).toHaveLength(0);
  });

  it("rejects with the generic error when GitHub fails", async () => {
    const { handlers } = setup(fakeGitHub([], { listStatus: 401 }));
    await expect(
      handlers(["github.app.webhooks.redeliver"])["githubApp.redeliverFailedDeliveries"]({ since: minutesAgo(60) }, scope(COMPANY_A)),
    ).rejects.toThrow(/^The GitHub App could not list or redeliver webhook deliveries/);
  });
});
