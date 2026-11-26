import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { checkImports } from "./imports.ts";

const SRC = join(import.meta.dir, "..", "..", "src");

function tree(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

function rules(entries: Record<string, string>): number[] {
  return checkImports(tree(entries)).map((violation) => violation.rule);
}

test("a lower layer importing a higher one is refused", () => {
  expect(rules({ "core/dice.ts": 'import { x } from "../agent/loop.ts";', "agent/loop.ts": "export const x = 1;" })).toEqual([1]);
});

test("a higher layer importing a lower one is allowed", () => {
  expect(rules({ "agent/loop.ts": 'import { x } from "../core/dice.ts";', "core/dice.ts": "export const x = 1;" })).toEqual([]);
});

test("the worker reaches infra and core only, and nothing imports the worker", () => {
  expect(rules({ "worker/main.ts": 'import "../agent/loop.ts";', "agent/loop.ts": "" })).toEqual([1]);
  expect(rules({ "worker/main.ts": 'import "../core/dice.ts";', "core/dice.ts": "" })).toEqual([]);
  expect(rules({ "net/session.ts": 'import "../worker/main.ts";', "worker/main.ts": "" })).toEqual([1]);
});

test("Bun-specific APIs stay under infra/runtime", () => {
  expect(rules({ "core/store.ts": 'import { Database } from "bun:sqlite"; export const d = Database;' })).toEqual([2]);
  expect(rules({ "gateway/hub.ts": "export const f = () => Bun.file('x');" })).toEqual([2]);
  expect(rules({ "infra/runtime/sqlite.ts": 'import { Database } from "bun:sqlite"; export const d = Database;' })).toEqual([]);
  expect(rules({ "infra/runtime/fs.ts": "export const f = () => Bun.file('x');" })).toEqual([]);
});

test("a comment or a type that mentions Bun is not a use of it", () => {
  expect(rules({ "core/notes.ts": "// Bun.serve is wrapped in infra/runtime\nexport type T = typeof Bun.version;\nexport const x = 1;" })).toEqual([]);
});

test("nothing reachable from the worker imports the database", () => {
  expect(
    rules({
      "worker/main.ts": 'import "../core/lore.ts";',
      "core/lore.ts": 'import "../infra/runtime/sqlite.ts";',
      "infra/runtime/sqlite.ts": 'import { Database } from "bun:sqlite"; export const d = Database;',
    }),
  ).toEqual([3]);
});

test("a relative import names its extension", () => {
  expect(rules({ "core/a.ts": 'import "./b";', "core/b.ts": "" })).toEqual([4]);
});

test("from outside src/, only data may be imported by path", () => {
  expect(rules({ "infra/i18n.ts": 'import en from "../../locales/en/net.json" with { type: "json" }; export const c = en;' })).toEqual([]);
  expect(rules({ "core/packs.ts": 'import coc from "../../../rulepacks/coc7.yaml" with { type: "text" }; export const c = coc;' })).toEqual([]);
  expect(rules({ "worker/templates/vendor.ts": 'import ejs from "../../../../assets/vendor/ejs.min.js" with { type: "text" }; export const e = ejs;' })).toEqual([]);
  expect(rules({ "infra/x.ts": 'import "../../../scripts/tool.js";' })).toEqual([5]);
  expect(rules({ "infra/x.ts": 'import "../../test/helpers.ts";' })).toEqual([5]);
});

test("only core and the Keeper's tools read stored documents whole", () => {
  const raw = { "core/documents/raw.ts": "export const x = 1;" };
  expect(rules({ ...raw, "gateway/room.ts": 'import "../core/documents/raw.ts";' })).toEqual([6]);
  expect(rules({ ...raw, "net/session.ts": 'import "../core/documents/raw.ts";' })).toEqual([6]);
  expect(rules({ ...raw, "agent/tools.ts": 'import "../core/documents/raw.ts";' })).toEqual([]);
  expect(rules({ ...raw, "core/lore.ts": 'import "./documents/raw.ts";' })).toEqual([]);
  expect(rules({ "core/documents/views.ts": "", "gateway/room.ts": 'import "../core/documents/views.ts";' })).toEqual([]);
});

test("the server tree keeps the rules", () => {
  const files = new Map<string, string>();
  for (const entry of readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    const path = join(SRC, entry);
    files.set(relative(SRC, path).split(sep).join("/"), readFileSync(path, "utf8"));
  }
  expect(files.size).toBeGreaterThan(0);
  expect(checkImports(files)).toEqual([]);
});
