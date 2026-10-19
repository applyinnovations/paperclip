#!/usr/bin/env node
// Run the existing PR policy with read-only metadata access and no bot comments.
import { fileURLToPath } from "node:url";
import { ghFetch } from "./get-bot-token.mjs";
import { fetchAllPullRequestFiles } from "./fetch-pr-files.mjs";
import { checkTemplate } from "./check-pr-template.mjs";
import { checkLinkedIssue } from "./check-pr-linked-issue.mjs";
import { checkDedupSearch } from "./check-pr-dedup-search.mjs";
import { checkTestCoverage } from "./check-pr-test-coverage.mjs";
import { checkLockfile } from "./check-pr-lockfile.mjs";
import { checkDependencies } from "./check-pr-dependencies.mjs";
import { checkReleaseBootstrap } from "./check-pr-release-bootstrap.mjs";
import { checkCoauthors, fetchAllPullRequestCommits } from "./check-pr-coauthors.mjs";

export async function checkForkPullRequest(repo, prNumber, token, fetchGitHub = ghFetch) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)
    || !Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new Error("Expected an owner/repository and positive PR number.");
  }
  const read = (path, credential, options = {}) => {
    if ((options.method ?? "GET") !== "GET") throw new Error("Fork policy permits only GET requests.");
    return fetchGitHub(path, credential, options);
  };
  const [pr, files] = await Promise.all([
    read(`/repos/${repo}/pulls/${prNumber}`, token),
    fetchAllPullRequestFiles(read, repo, prNumber, token),
  ]);
  const body = pr.body ?? "";
  const title = pr.title ?? "";
  const checks = {
    template: checkTemplate(body),
    linkedIssue: checkLinkedIssue(body, title),
    dedup: checkDedupSearch(body, title),
    testCoverage: checkTestCoverage(files, title),
    lockfile: checkLockfile(files, pr.user.login, pr.head.ref),
  };
  const notices = await Promise.all([
    checkDependencies(files, token, repo, prNumber, pr.base.ref, read),
    checkReleaseBootstrap(files, token, repo, prNumber, pr.base.ref, { fetchFromGitHub: read }),
  ]);
  try {
    const commits = await fetchAllPullRequestCommits(read, repo, prNumber, token);
    notices.push(checkCoauthors(commits, pr.user.login));
  } catch {
    notices.push({ informational: ["Coauthor lookup unavailable; review commit authors before merge."] });
  }
  const failures = Object.values(checks).flatMap((result) => result.failures);
  return { passed: failures.length === 0, checks, failures,
    informational: notices.flatMap((result) => result.informational ?? []) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { GH_REPO, PR_NUMBER, GH_TOKEN } = process.env;
  if (!GH_TOKEN) throw new Error("A read-only repository token is required.");
  try {
    const result = await checkForkPullRequest(GH_REPO ?? "", Number(PR_NUMBER), GH_TOKEN);
    console.log(JSON.stringify(result));
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
