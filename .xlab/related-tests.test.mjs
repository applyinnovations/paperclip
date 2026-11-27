// Tests for related-tests.mjs. Needs the workspace's node_modules:
//   node --test .xlab/related-tests.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { importSpecifiers, relatedTests } from "./related-tests.mjs";

describe("importSpecifiers", () => {
  it("keeps runtime imports and drops type-only ones", () => {
    const source = `
      import type { A } from "./type-only";
      import { type B } from "./type-bindings-only";
      import { type C, d } from "./mixed";
      import "./side-effect";
      export * from "./star";
      export type { E } from "./type-export";
      export { f } from "./named-export";
      const g = await import("./dynamic");
      const h = await import(\`./template\`);
      const i = await import(name);
      const j = await import(\`./\${name}\`);
    `;
    assert.deepEqual(importSpecifiers("m.ts", source).sort(),
      ["./dynamic", "./mixed", "./named-export", "./side-effect", "./star", "./template"]);
  });

  it("asks Vite's transform for globs and unparsable modules", () => {
    assert.equal(importSpecifiers("m.ts", `const all = import.meta.glob("./x/*.ts");`), null);
    assert.equal(importSpecifiers("m.ts", "import {"), null);
  });
});

describe("relatedTests", () => {
  let root;
  const write = (file, source) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  };
  const select = async (...changed) => (await relatedTests({
    changed, root, options: { config: false, include: ["**/*.test.ts"], setupFiles: ["./setup.ts"] },
  })).files;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "related-tests-"));
    write("package.json", "{}");
    write("setup.ts", "");
    write("src/leaf.ts", "export const leaf = 1;");
    write("src/middle.ts", `export { leaf } from "./leaf";`);
    write("src/lazy.ts", "export const lazy = 1;");
    write("src/typed.ts", "export type T = number;");
    write("src/globbed/one.ts", "export const one = 1;");
    write("src/glob.ts", `export const all = import.meta.glob("./globbed/*.ts", { eager: true });`);
    write("src/a.test.ts", `import { leaf } from "./middle"; leaf;`);
    write("src/b.test.ts", `const lazy = await import("./lazy"); lazy;`);
    write("src/c.test.ts", `import type { T } from "./typed"; export const t: T = 1;`);
    write("src/d.test.ts", `import { all } from "./glob"; all;`);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("selects tests that import the change through other modules", async () => {
    assert.deepEqual(await select("src/leaf.ts"), ["src/a.test.ts"]);
  });

  it("follows literal dynamic imports and Vite globs", async () => {
    assert.deepEqual(await select("src/lazy.ts", "src/globbed/one.ts"), ["src/b.test.ts", "src/d.test.ts"]);
  });

  it("does not follow type-only imports", async () => {
    assert.deepEqual(await select("src/typed.ts"), []);
  });

  it("selects a changed test file itself", async () => {
    assert.deepEqual(await select("src/c.test.ts"), ["src/c.test.ts"]);
  });

  it("selects every test for setup files and Vitest's trigger files", async () => {
    const all = ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts", "src/d.test.ts"];
    assert.deepEqual(await select("setup.ts"), all);
    assert.deepEqual(await select("package.json"), all);
  });

  it("selects nothing for files no test imports", async () => {
    assert.deepEqual(await select("README.md"), []);
  });
});
