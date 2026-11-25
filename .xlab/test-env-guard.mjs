// Fails when the test environment holds a short host value that the
// run-failure redactor would mask as a whole token in ordinary stack text, as
// NIX_BUILD_CORES=24 and name=test did (APP-472): "recovery.test.ts" became
// "recovery.***REDACTED***.ts" and "@types+node@24.13.3" lost its "24".
// Prints variable names only, never values.
//   node .xlab/test-env-guard.mjs [repo-root]
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? ".");
const { collectHostEnvironmentTokenSecrets } = await import(
  pathToFileURL(join(root, "packages/adapter-utils/src/command-redaction.ts")).href
);

// Text a test stack holds: test file paths and pnpm's versioned package dirs.
let packages = [];
try {
  packages = readdirSync(join(root, "node_modules/.pnpm"));
} catch {
  // Not installed yet: test paths only.
}
const probe = [join(root, "server/src/__tests__/heartbeat-process-recovery.test.ts"), ...packages].join("\n");

// The same whole-token rule as redactRunFailureSecretValues.
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const masks = (value) =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${escape(value)}(?![\\p{L}\\p{N}_])`, "u").test(probe);
// One variable at a time, so an ordinary setting sharing the value
// (NODE_ENV=test) is not named.
const names = Object.entries(process.env)
  .filter(([name, value]) => collectHostEnvironmentTokenSecrets({ [name]: value }).some(masks))
  .map(([name]) => name)
  .sort();

if (names.length > 0) {
  console.error(`test environment holds values the run-failure redactor masks in test stacks: ${names.join(", ")}`);
  console.error("unset them for the tests in .xlab/ci.sh (as_test_user); upstream's runner sets none");
  process.exit(1);
}
console.log("test environment: no short host values masked in test stacks");
