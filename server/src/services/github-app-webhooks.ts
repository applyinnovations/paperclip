import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readGitHubAppsConfig, type GitHubAppsConfigResult } from "./github-app-config.js";

/**
 * Host-side verification of GitHub App webhook deliveries.
 *
 * A plugin hands over the delivery headers and raw body; the host finds the App by the
 * `X-GitHub-Hook-Installation-Target-ID` header, checks `X-Hub-Signature-256` against that
 * App's webhook secret file, and reports which company the App belongs to. The plugin never
 * reads the secret. Only the per-company file form (PAPERCLIP_GITHUB_APPS_FILE) names webhook
 * secrets. Replay protection is the caller's job: deduplicate on `X-GitHub-Delivery`.
 */

export type GitHubAppWebhookVerification =
  | {
      verified: true;
      companyId: string;
      appId: string;
      /** From the payload's `installation.id`; null for App-level events that carry none. */
      installationId: string | null;
      event: string | null;
      deliveryId: string | null;
    }
  | {
      verified: false;
      reason:
        | "not_configured"
        | "not_github_app_delivery"
        | "unknown_app"
        | "no_webhook_secret"
        | "missing_signature"
        | "bad_signature"
        | "installation_mismatch";
    };

function header(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === "string" && first.trim() ? first.trim() : null;
  }
  return null;
}

function payloadInstallationId(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as { installation?: { id?: unknown } } | null;
    const id = parsed?.installation?.id;
    return typeof id === "number" || typeof id === "string" ? String(id) : null;
  } catch {
    return null;
  }
}

export function createGitHubAppWebhookVerifier(deps: {
  env?: NodeJS.ProcessEnv;
  readConfigFile?: (path: string) => string;
  readSecret?: (path: string) => Promise<string>;
  readConfig?: () => GitHubAppsConfigResult;
} = {}) {
  const readSecret = deps.readSecret ?? ((path: string) => readFile(path, "utf8"));
  // The configuration only changes on restart; a failed read is retried on the next delivery.
  let memo: GitHubAppsConfigResult | null = null;
  const readConfig = deps.readConfig ?? (() => {
    if (memo) return memo;
    const result = readGitHubAppsConfig(deps.env ?? process.env, deps.readConfigFile);
    if (result.status !== "invalid") memo = result;
    return result;
  });

  return {
    async verify(input: {
      headers: Record<string, string | string[] | undefined>;
      rawBody: string;
    }): Promise<GitHubAppWebhookVerification> {
      const config = readConfig();
      if (config.status !== "enabled") return { verified: false, reason: "not_configured" };
      const targetType = header(input.headers, "x-github-hook-installation-target-type");
      const appId = header(input.headers, "x-github-hook-installation-target-id");
      if (targetType !== "integration" || !appId) return { verified: false, reason: "not_github_app_delivery" };
      const app = config.config.apps.find((candidate) => candidate.appId === appId);
      if (!app) return { verified: false, reason: "unknown_app" };
      if (!app.webhookSecretFile) return { verified: false, reason: "no_webhook_secret" };
      const signature = header(input.headers, "x-hub-signature-256");
      if (!signature || !signature.startsWith("sha256=")) return { verified: false, reason: "missing_signature" };

      let secret: string;
      try {
        secret = (await readSecret(app.webhookSecretFile)).trim();
      } catch {
        return { verified: false, reason: "no_webhook_secret" };
      }
      if (!secret) return { verified: false, reason: "no_webhook_secret" };
      const expected = Buffer.from(
        `sha256=${createHmac("sha256", secret).update(Buffer.from(input.rawBody, "utf8")).digest("hex")}`,
      );
      const received = Buffer.from(signature);
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
        return { verified: false, reason: "bad_signature" };
      }

      // The App is meant to be installed once, on its company's account. A delivery for any
      // other installation is not attributed to the company.
      const installationId = payloadInstallationId(input.rawBody);
      if (installationId !== null && installationId !== app.installationId) {
        return { verified: false, reason: "installation_mismatch" };
      }
      const [companyId] = [...app.companyIds];
      if (!companyId || app.companyIds.size !== 1) return { verified: false, reason: "not_configured" };
      return {
        verified: true,
        companyId,
        appId,
        installationId,
        event: header(input.headers, "x-github-event"),
        deliveryId: header(input.headers, "x-github-delivery"),
      };
    },
  };
}

let defaultVerifier: ReturnType<typeof createGitHubAppWebhookVerifier> | null = null;

export function githubAppWebhookVerifier() {
  defaultVerifier ??= createGitHubAppWebhookVerifier();
  return defaultVerifier;
}
