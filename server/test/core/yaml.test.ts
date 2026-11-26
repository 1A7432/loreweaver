import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadYaml, YamlError } from "../../src/core/yaml.ts";

function code(text: string): string {
  try {
    loadYaml(text);
  } catch (error) {
    if (error instanceof YamlError) return error.code;
    throw error;
  }
  return "ok";
}

test("plain data loads, and a mapping keeps the order it was written in", () => {
  const value = loadYaml("name: 侦查\nranks:\n  - {id: crit, tier: 5}\nlabels: {zh: 理智, en: Sanity}\n") as Record<string, unknown>;
  expect(value).toEqual({ name: "侦查", ranks: [{ id: "crit", tier: 5 }], labels: { zh: "理智", en: "Sanity" } });
  expect(Object.keys(value.labels as object)).toEqual(["zh", "en"]);
});

test("YAML 1.2: yes/no/on/off are words and 010 is ten", () => {
  expect(loadYaml("a: yes\nb: off\nc: 010\nd: true\ne: 1e3\n")).toEqual({ a: "yes", b: "off", c: 10, d: true, e: 1000 });
});

test("anchors, aliases and merge keys are refused", () => {
  expect(code("a: &x [1, 2]\nb: *x\n")).toBe("alias");
  expect(code("base: &b {k: 1}\n")).toBe("alias");
  expect(code("a: 1\na: 2\n")).toBe("syntax");
});

test("__proto__ is refused as a key, at any depth", () => {
  expect(code("__proto__: {admin: true}\n")).toBe("forbidden_key");
  expect(code("a:\n  - {__proto__: 1}\n")).toBe("forbidden_key");
  expect(loadYaml("constructor: 1\ntoString: 2\n")).toEqual({ constructor: 1, toString: 2 } as never);
});

test("a mapping JavaScript would reorder is refused; one it would not is fine", () => {
  expect(code("levels:\n  10: ten\n  2: two\n")).toBe("key_order");
  expect(code("levels:\n  name: x\n  1: one\n")).toBe("key_order");
  expect(loadYaml("levels:\n  1: one\n  2: two\n  name: x\n")).toEqual({ levels: { 1: "one", 2: "two", name: "x" } });
  // An unquoted 01 is the number 1, so this mapping would be reordered too.
  expect(code("dice:\n  1d6: a\n  01: b\n")).toBe("key_order");
  expect(loadYaml('dice:\n  1d6: a\n  "01": b\n')).toEqual({ dice: { "1d6": "a", "01": "b" } });
});

test("a syntax error carries its line", () => {
  try {
    loadYaml("a: 1\nb: [1, 2\nc: 3\n");
    throw new Error("expected a YamlError");
  } catch (error) {
    expect(error).toBeInstanceOf(YamlError);
    expect((error as YamlError).code).toBe("syntax");
    expect((error as YamlError).line).toBeGreaterThanOrEqual(2);
  }
});

test("every built-in rule pack loads", () => {
  const dir = join(import.meta.dir, "..", "..", "..", "rulepacks");
  const names = readdirSync(dir).filter((name) => name.endsWith(".yaml")).sort();
  expect(names).toEqual(["coc7.yaml", "dnd5e.yaml", "wod.yaml"]);
  for (const name of names) {
    const pack = loadYaml(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
    expect([name, Array.isArray(pack.names)]).toEqual([name, true]);
  }
});
