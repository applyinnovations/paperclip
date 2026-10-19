import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkForkPullRequest } from "../run-fork-quality-gates.mjs";

const body = `## Thinking Path
> - Paperclip manages AI-agent companies.
> - Human sign-in needs an optional provider.
> - This change preserves local accounts.
## Linked Issues or Issue Description
Refs #3040
## What Changed
Add optional sign-in.
## Verification
Tests passed.
## Risks
Provider availability.
## Model Used
OpenAI Codex / GPT-6; tools and code execution.
## Checklist
- [x] I have searched GitHub for duplicate or related PRs and linked them above
`;
function fixture(overrides = {}) {
  const requests = [];
  const pr = { title: "feat(auth): optional sign-in", body, user: { login: "author" },
    head: { ref: "feat/oidc" }, base: { ref: "master" }, ...overrides };
  return { requests, fetch: async (path, token, options) => {
    requests.push({ path, token, method: options?.method ?? "GET" });
    if (path.includes("/comments")) throw new Error("No comment endpoint is allowed.");
    if (path.includes("/files?")) return [{ filename: "server/src/auth.test.ts", status: "added" }];
    if (path.includes("/commits?")) return [];
    if (path.endsWith("/pulls/1")) return pr;
    throw new Error(`Unexpected request: ${path}`);
  } };
}
test("fork policy runs all blocking checks without comments or write requests", async () => {
  const f = fixture();
  const result = await checkForkPullRequest("owner/repo", 1, "fixture-token", f.fetch);
  assert.equal(result.passed, true);
  assert.equal(Object.keys(result.checks).length, 5);
  assert.ok(f.requests.length >= 3);
  assert.ok(f.requests.every(({ method }) => method === "GET"));
});
test("invalid PR metadata remains a blocking result", async () => {
  const f = fixture({ body: "" });
  const result = await checkForkPullRequest("owner/repo", 1, "fixture-token", f.fetch);
  assert.equal(result.passed, false);
  assert.equal(result.checks.template.passed, false);
  assert.ok(result.failures.length > 0);
});
test("invalid target is refused before any request", async () => {
  const f = fixture();
  for (const [repo, number] of [["owner/repo/elsewhere", 1], ["owner/repo", 0], ["owner/repo", 1.5]]) {
    await assert.rejects(checkForkPullRequest(repo, number, "fixture-token", f.fetch));
  }
  assert.deepEqual(f.requests, []);
});
test("optional author lookup does not hide blocking policy failures", async () => {
  const f = fixture({ body: "" });
  const result = await checkForkPullRequest("owner/repo", 1, "fixture-token", async (...args) => {
    if (args[0].includes("/commits?")) throw new Error("Unavailable");
    return f.fetch(...args);
  });
  assert.equal(result.passed, false);
  assert.match(result.informational.join(), /Coauthor lookup unavailable/);
});
test("fork workflow retains read-only policy, base checkout and local full validation", () => {
  const pr = readFileSync(new URL("../../workflows/pr.yml", import.meta.url), "utf8");
  const trusted = readFileSync(new URL("../../workflows/pr-trusted.yml", import.meta.url), "utf8");
  const bot = readFileSync(new URL("../../workflows/commitperclip-review.yml", import.meta.url), "utf8");
  assert.match(pr, /name: PR/);
  assert.match(pr, /fork_quality:[\s\S]*ref: \$\{\{ github.event.pull_request.base.sha \}\}/);
  assert.match(pr, /uses: actions\/dependency-review-action@/);
  assert.match(pr, /fork_ci:[\s\S]*needs: \[fork_quality\]/);
  assert.match(pr, /uses: \.\/\.github\/workflows\/pr-trusted.yml/);
  assert.match(trusted, /uses: \.\/\.github\/workflows\/ci-routing.yml/);
  assert.doesNotMatch(pr, /secrets\.|: write/);
  assert.match(bot, /review:\n    if: github.repository == 'paperclipai\/paperclip'/);
});
