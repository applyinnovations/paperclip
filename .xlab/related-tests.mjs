// Lists the test files that import any of the given files, directly or
// through other modules, across the root Vitest projects: the selection of
// `vitest related`, without running anything. ci.sh uses it to add a pull
// request's importing tests to the tests it changes.
//
//   node .xlab/related-tests.mjs <changed file>...
//
// Prints repo-relative test files, one per line, on stdout; a summary on
// stderr.
//
// Why not `vitest related` itself: it runs the tests (there is no
// `vitest list --related`), so the selection cannot be capped first, and it
// builds its graph by fully transforming every module of every project
// (about 215s for this repository on a CI-class core, 112s of it the server
// project). This walk reads the same edges from a parse and Vite's resolver,
// in about 40s. Measured on the last 21 xlab merges it selected every file
// `vitest related` did, plus four on three PRs: imports used only as types,
// which the TypeScript transform removes.
//
// Edges, as in Vite's module graph: static imports and re-exports that are
// not type-only, and dynamic imports with a literal specifier; each
// resolved by the project's own Vite resolver (aliases, package exports,
// tsconfig paths). Modules that use import.meta.glob, or that do not parse,
// take their edges from Vite's transform instead. Changes Vitest treats as
// affecting everything (its forceRerunTriggers: package.json, Vite and
// Vitest configs) select every test, and a changed setup file selects its
// project's tests.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { createVitest } from "vitest/node";

const sourceFile = /\.[cm]?[jt]sx?$/;
const literalSpecifier = /^(['"]).*\1$|^`[^`$]*`$/s;

export async function relatedTests({ changed, root = process.cwd(), options = {} }) {
  root = path.resolve(root);
  if (!changed.length) return { files: [], projects: 0, everything: false, seconds: 0 };
  const started = performance.now();
  const related = changed.map((file) => path.resolve(root, file));
  const vitest = await createVitest("test", { root, watch: false, run: true, reporters: [], ...options }, {},
    { stdout: process.stderr });
  try {
    const everything = related.some((file) =>
      vitest.config.forceRerunTriggers.some((pattern) => path.matchesGlob(file, pattern)));
    const parsed = new Map(); // file -> specifiers; projects share sources
    const selected = new Set();
    for (const project of vitest.projects) {
      const { testFiles } = await project.globTestFiles();
      const setup = [project.config.setupFiles, project.config.globalSetup].flat().filter(Boolean);
      if (everything || related.some((file) => setup.includes(file))) {
        for (const file of testFiles) selected.add(file);
        continue;
      }
      const environment = project.vite.environments.ssr;
      const importers = new Map();
      const visited = new Set();
      const dependencies = async (file) => {
        let specifiers = parsed.get(file);
        if (specifiers === undefined) {
          specifiers = importSpecifiers(file, await readFile(file, "utf8"));
          parsed.set(file, specifiers);
        }
        if (specifiers === null) {
          const transformed = await environment.transformRequest(file);
          return [...(transformed?.deps ?? []), ...(transformed?.dynamicDeps ?? [])].map((id) =>
            id.startsWith("/@fs/") ? id.slice(4) : path.join(project.config.root, id));
        }
        return Promise.all(specifiers.map(async (specifier) => {
          try {
            return (await environment.pluginContainer.resolveId(specifier, file))?.id;
          } catch {
            return undefined; // unresolvable here: not an edge Vite would follow either
          }
        }));
      };
      const visit = async (file) => {
        if (visited.has(file)) return;
        visited.add(file);
        if (!sourceFile.test(file)) return;
        await Promise.all((await dependencies(file)).map(async (id) => {
          const dependency = id?.split("?")[0];
          if (!dependency || !path.isAbsolute(dependency) || dependency.includes(`${path.sep}node_modules${path.sep}`)) return;
          let by = importers.get(dependency);
          if (!by) importers.set(dependency, by = new Set());
          by.add(file);
          await visit(dependency);
        }));
      };
      await Promise.all(testFiles.map(visit));
      const affected = new Set(related);
      const queue = [...related];
      while (queue.length) {
        for (const importer of importers.get(queue.pop()) ?? []) {
          if (!affected.has(importer)) {
            affected.add(importer);
            queue.push(importer);
          }
        }
      }
      for (const file of testFiles) if (affected.has(file)) selected.add(file);
    }
    return {
      files: [...selected].map((file) => path.relative(root, file)).sort(),
      projects: vitest.projects.length,
      everything,
      seconds: (performance.now() - started) / 1000,
    };
  } finally {
    await vitest.close();
  }
}

// The specifiers a module imports at runtime, or null to ask Vite's transform.
export function importSpecifiers(file, source) {
  if (source.includes("import.meta.glob")) return null;
  const { module, errors } = parseSync(file, source);
  if (errors.length) return null;
  const specifiers = new Set();
  for (const entry of module.staticImports) {
    // `import "x"` has no entries and still runs x.
    if (!entry.entries.length || entry.entries.some((binding) => !binding.isType)) specifiers.add(entry.moduleRequest.value);
  }
  for (const entry of module.staticExports) {
    for (const binding of entry.entries) {
      if (binding.moduleRequest && !binding.isType) specifiers.add(binding.moduleRequest.value);
    }
  }
  for (const entry of module.dynamicImports) {
    const specifier = source.slice(entry.moduleRequest.start, entry.moduleRequest.end);
    if (literalSpecifier.test(specifier)) specifiers.add(specifier.slice(1, -1));
  }
  return [...specifiers];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await relatedTests({ changed: process.argv.slice(2) });
  for (const file of result.files) console.log(file);
  console.error(`::: related: ${result.files.length} test files import the change`
    + `${result.everything ? " (a change to a Vitest trigger file selects every test)" : ""};`
    + ` ${result.projects} projects in ${result.seconds.toFixed(1)}s`);
}
