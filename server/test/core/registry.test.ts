import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { allDocumentTypes } from "../../src/core/registry.ts";
import { builtInPacks, RulePackRegistry } from "../../src/core/rulepacks/index.ts";

const CORE = join(import.meta.dir, "../../src/core");

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return files(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

test("every document type defined in core is in the registry", () => {
  // A type is declared as `name: SOME_TYPE` or `name: "literal"` inside a `DocumentType`
  // value (or the character type's factory); collect the exported constants of that type.
  const declared: string[] = [];
  for (const file of files(CORE)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/export const (\w+): DocumentType</g)) declared.push(match[1] as string);
    for (const match of text.matchAll(/export function (\w+)\([^)]*\): DocumentType</g)) declared.push(match[1] as string);
  }
  const registry = readFileSync(join(CORE, "registry.ts"), "utf8");
  expect(declared.length).toBeGreaterThan(15);
  expect(declared.filter((name) => !new RegExp(`\\.register\\(${name}\\b`).test(registry))).toEqual([]);
});

test("the registry builds, and every type declares what a reset does to it", () => {
  const types = allDocumentTypes(new RulePackRegistry(builtInPacks()));
  expect(types.names().length).toBe(21);
  for (const name of types.names()) expect(types.get(name).lifecycle).toBeDefined();
});
