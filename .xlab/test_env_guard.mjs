// Fails when the test environment holds a value that the run-failure redactor
// masks as a whole token inside ordinary stack text, e.g. `test` in
// `recovery.test.ts` or `24` in `@types+node@24.13.3` (APP-472). Tests that
// assert on reported stacks then fail on xlab but pass on upstream's runner.
// Prints variable names only, never values.
import { readdirSync } from "node:fs";
import { collectHostEnvironmentTokenSecrets } from "../packages/adapter-utils/src/command-redaction.ts";

const stackText = [
  new Error("probe").stack ?? "",
  "server/src/__tests__/heartbeat-process-recovery.test.ts:1:1",
  "ui/src/components/IssueRow.spec.tsx:1:1",
  `node:internal/modules/run_main:1:1 node ${process.version}`,
  ...readdirSync("node_modules/.pnpm").map((entry) => `node_modules/.pnpm/${entry}/node_modules`),
].join("\n");
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const masked = new Set(collectHostEnvironmentTokenSecrets(process.env).filter((value) =>
  new RegExp(`(?<![\\p{L}\\p{N}_])${escape(value)}(?![\\p{L}\\p{N}_])`, "u").test(stackText)));
const names = Object.entries(process.env).filter(([, value]) => masked.has(value)).map(([name]) => name).sort();
if (names.length > 0) {
  console.error(`The test environment sets ${names.join(", ")} to short values the run-failure redactor masks`);
  console.error("inside stack paths. Unset them in as_test_user (.xlab/ci.sh); upstream's runner sets none.");
  process.exit(1);
}
