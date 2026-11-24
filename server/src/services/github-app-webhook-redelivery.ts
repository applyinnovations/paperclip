import { readFile } from "node:fs/promises";
import { githubAppJwt, githubBotRequest } from "./chat-github-client.js";
import {
  githubAppForCompany,
  GITHUB_APP_ENV,
  GITHUB_APPS_FILE_ENV,
  readGitHubAppsConfig,
  type GitHubAppInstallationConfig,
  type GitHubAppsConfigResult,
} from "./github-app-config.js";

/**
 * Host-side redelivery of failed GitHub App webhook deliveries.
 *
 * GitHub does not retry a delivery that failed (for example while the GitHub plugin was down).
 * The only way to get it back is the App deliveries API (`GET /app/hook/deliveries`,
 * `POST /app/hook/deliveries/{id}/attempts`), which takes the App JWT. The host signs that JWT
 * with the company App's private key; neither the key, the JWT nor any delivery payload
 * reaches the plugin. Redelivered deliveries arrive through the normal webhook route, signed
 * by GitHub, and are verified there like any other delivery.
 */

/** GitHub keeps webhook deliveries for three days; looking further back finds nothing. */
export const GITHUB_WEBHOOK_DELIVERY_RETENTION_MS = 3 * 24 * 60 * 60_000;
/** Deliveries per page, GitHub's maximum. */
export const GITHUB_WEBHOOK_DELIVERIES_PAGE_SIZE = 100;
/** Hard stop on paging, so a busy App cannot keep one call running indefinitely. */
export const GITHUB_WEBHOOK_DELIVERIES_MAX_PAGES = 50;
/** Re-sign the App JWT (valid for nine minutes) when it is older than this. */
const JWT_REFRESH_MS = 5 * 60_000;

/** One delivery attempt, as `GET /app/hook/deliveries` lists it. Only the fields used here. */
type DeliveryAttempt = {
  id: number;
  guid: string;
  delivered_at: string;
  status_code: number;
  installation_id?: number | null;
};

export type GitHubAppWebhookRedeliveryResult =
  | { status: "not_applicable" }
  | { status: "denied"; error: string }
  | { status: "unavailable"; error: string }
  | {
      status: "done";
      appId: string;
      /** Delivery GUIDs (`X-GitHub-Delivery`) GitHub accepted a redelivery for, oldest first. */
      redelivered: string[];
      /** GUIDs in the window that were not redelivered because an attempt succeeded. */
      skipped: number;
      /** GUIDs whose redelivery GitHub refused; a later call may retry them. */
      failed: string[];
      /** The start of the window actually searched, after capping to GitHub's retention. */
      since: string;
    };

const UNAVAILABLE =
  "The GitHub App could not list or redeliver webhook deliveries; check the App ID, private key and installation";

const CONFIG_ENV_NAMES = [GITHUB_APPS_FILE_ENV, ...Object.values(GITHUB_APP_ENV)];

function isSuccess(statusCode: unknown): boolean {
  return typeof statusCode === "number" && statusCode >= 200 && statusCode < 300;
}

function isAttempt(value: unknown): value is DeliveryAttempt {
  if (!value || typeof value !== "object") return false;
  const attempt = value as Record<string, unknown>;
  return (
    typeof attempt.id === "number" &&
    Number.isSafeInteger(attempt.id) &&
    attempt.id > 0 &&
    typeof attempt.guid === "string" &&
    attempt.guid !== "" &&
    typeof attempt.delivered_at === "string" &&
    Number.isFinite(Date.parse(attempt.delivered_at))
  );
}

/** The `cursor` of the `rel="next"` link. Only the cursor is taken; the URL is never followed. */
export function nextDeliveriesCursor(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]*)>\s*;\s*rel="next"/.exec(part);
    if (!match) continue;
    try {
      const cursor = new URL(match[1]).searchParams.get("cursor");
      return cursor && cursor.trim() ? cursor : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Pick the GUIDs to redeliver: those whose latest attempt is in the window and that have no
 * successful attempt among the ones seen. Attempts for another installation of the App are
 * ignored; the webhook route would refuse them anyway.
 */
export function selectFailedDeliveries(
  attempts: DeliveryAttempt[],
  options: { sinceMs: number; installationId: string },
): { redeliver: DeliveryAttempt[]; skipped: number } {
  const byGuid = new Map<string, { latest: DeliveryAttempt; succeeded: boolean }>();
  for (const attempt of attempts) {
    if (attempt.installation_id != null && String(attempt.installation_id) !== options.installationId) continue;
    const entry = byGuid.get(attempt.guid);
    if (!entry) {
      byGuid.set(attempt.guid, { latest: attempt, succeeded: isSuccess(attempt.status_code) });
      continue;
    }
    entry.succeeded ||= isSuccess(attempt.status_code);
    const newer =
      Date.parse(attempt.delivered_at) - Date.parse(entry.latest.delivered_at) || attempt.id - entry.latest.id;
    if (newer > 0) entry.latest = attempt;
  }
  const redeliver: DeliveryAttempt[] = [];
  let skipped = 0;
  for (const { latest, succeeded } of byGuid.values()) {
    if (Date.parse(latest.delivered_at) < options.sinceMs) continue;
    if (succeeded) skipped += 1;
    else redeliver.push(latest);
  }
  redeliver.sort((a, b) => Date.parse(a.delivered_at) - Date.parse(b.delivered_at) || a.id - b.id);
  return { redeliver, skipped };
}

export function createGitHubAppWebhookRedeliverer(deps: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readPrivateKey?: (path: string) => Promise<string>;
  readConfigFile?: (path: string) => string;
  now?: () => Date;
  maxPages?: number;
} = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const readPrivateKey = deps.readPrivateKey ?? ((path: string) => readFile(path, "utf8"));
  const now = deps.now ?? (() => new Date());
  const maxPages = deps.maxPages ?? GITHUB_WEBHOOK_DELIVERIES_MAX_PAGES;

  let configMemo: { key: string; result: GitHubAppsConfigResult } | null = null;
  const currentConfig = (): GitHubAppsConfigResult => {
    const env = deps.env ?? process.env;
    const key = JSON.stringify(CONFIG_ENV_NAMES.map((name) => env[name] ?? null));
    if (configMemo?.key === key) return configMemo.result;
    const result = readGitHubAppsConfig(env, deps.readConfigFile);
    configMemo = result.status === "invalid" ? null : { key, result };
    return result;
  };

  const run = async (app: GitHubAppInstallationConfig, sinceMs: number) => {
    const privateKey = await readPrivateKey(app.privateKeyFile);
    let signed: { jwt: string; atMs: number } | null = null;
    const jwt = () => {
      const at = now();
      if (!signed || at.getTime() - signed.atMs > JWT_REFRESH_MS) {
        signed = { jwt: githubAppJwt(app.appId, privateKey, at), atMs: at.getTime() };
      }
      return signed.jwt;
    };

    // Newest first: stop at the first page that reaches back past the window.
    const attempts: DeliveryAttempt[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      let link: string | null = null;
      const query = `per_page=${GITHUB_WEBHOOK_DELIVERIES_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body = await githubBotRequest<unknown>(fetchImpl, jwt(), `/app/hook/deliveries?${query}`, {
        onHeaders: (headers) => {
          link = headers.get("link");
        },
      });
      if (!Array.isArray(body)) throw new Error("GitHub returned an invalid deliveries page");
      const valid = body.filter(isAttempt);
      attempts.push(...valid);
      const reachedWindowStart = valid.some((attempt) => Date.parse(attempt.delivered_at) < sinceMs);
      cursor = nextDeliveriesCursor(link);
      if (reachedWindowStart || !cursor || body.length === 0) break;
    }

    const { redeliver, skipped } = selectFailedDeliveries(attempts, { sinceMs, installationId: app.installationId });
    const redelivered: string[] = [];
    const failed: string[] = [];
    for (const attempt of redeliver) {
      try {
        await githubBotRequest<unknown>(fetchImpl, jwt(), `/app/hook/deliveries/${attempt.id}/attempts`, {
          method: "POST",
        });
        redelivered.push(attempt.guid);
      } catch {
        failed.push(attempt.guid);
      }
    }
    return { redelivered, skipped, failed };
  };

  return {
    /** Redeliver one company's failed deliveries since `since` (capped to GitHub's retention). */
    async redeliverFailed(companyId: string, since: Date): Promise<GitHubAppWebhookRedeliveryResult> {
      const configResult = currentConfig();
      if (configResult.status === "disabled") return { status: "not_applicable" };
      if (configResult.status === "invalid") return { status: "unavailable", error: configResult.error };
      const app = githubAppForCompany(configResult.config, companyId);
      if (!app) return { status: "not_applicable" };
      // The deliveries API is per App. An App shared by several companies would redeliver
      // other companies' deliveries, and its deliveries are not attributed to one company.
      if (app.companyIds.size !== 1) {
        return {
          status: "denied",
          error: "Webhook redelivery needs a GitHub App that belongs to exactly one company",
        };
      }
      const sinceMs = Math.max(since.getTime(), now().getTime() - GITHUB_WEBHOOK_DELIVERY_RETENTION_MS);
      try {
        const result = await run(app, sinceMs);
        return { status: "done", appId: app.appId, since: new Date(sinceMs).toISOString(), ...result };
      } catch {
        // Never surface provider bodies or key-parsing errors: they can echo credential material.
        return { status: "unavailable", error: UNAVAILABLE };
      }
    },
  };
}

let defaultRedeliverer: ReturnType<typeof createGitHubAppWebhookRedeliverer> | null = null;

export function githubAppWebhookRedeliverer() {
  defaultRedeliverer ??= createGitHubAppWebhookRedeliverer();
  return defaultRedeliverer;
}
