// Every sentence the command layer can produce has a catalog entry in both languages.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { COMMANDS_CATALOG } from "../../../src/gateway/commands/index.ts";
import { ADMIN, bench } from "./bench.ts";

const SOURCE = join(import.meta.dir, "..", "..", "..", "src", "gateway", "commands");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [readFileSync(join(dir, entry.name), "utf8")] : [],
  );
}

function has(key: string): boolean {
  return Object.hasOwn(COMMANDS_CATALOG.en ?? {}, key) && Object.hasOwn(COMMANDS_CATALOG.zh ?? {}, key);
}

describe("the commands catalog", () => {
  test("every message key the code names exists in en and zh", () => {
    const text = sources(SOURCE).join("\n");
    const keys = new Set<string>();
    for (const match of text.matchAll(/(?:say|tell)\(\s*(?:[^"()]*\?\s*)?"([a-z_]+(?:\.[a-z_]+)+)"/g)) keys.add(match[1] as string);
    for (const match of text.matchAll(/"([a-z_]+\.[a-z_]+(?:\.[a-z_]+)?)"\s*[:)]/g)) if (/^(sheet|var|npc|chronicle|habits|help|init|bot|lore|rule|reset|pc|list|recap)\./.test(match[1] as string)) keys.add(match[1] as string);
    for (const match of text.matchAll(/refuse\(\s*"([a-z_]+)"\s*[,)]/g)) keys.add(`error.${match[1] as string}`);
    expect(keys.size).toBeGreaterThan(100);
    expect([...keys].filter((key) => !has(key))).toEqual([]);
  });

  test("every command has a title, a description and a usage line", async () => {
    for (const system of ["coc7", "dnd5e", "wod", null]) {
      const b = bench({ system });
      const context = b.context(ADMIN);
      for (const spec of b.registry.specs(context)) {
        for (const part of ["title", "description", "usage"]) expect([spec.id, has(`${spec.key}.${part}`)]).toEqual([spec.id, true]);
      }
      const view = await b.registry.view(context, "zh");
      for (const entry of view.commands) expect(entry.title).not.toContain(".title");
    }
  });

  test("the refusals the engine passes through have their sentences", () => {
    for (const code of ["unknown_skill", "not_numeric", "taken", "no_initiative_roll", "unknown_arg", "too_many_inline_rolls", "generic", "usage"].map((name) => `error.${name}`)) {
      expect([code, has(code)]).toEqual([code, true]);
    }
    for (const reason of ["observer", "no_rule_system", "not_in_system", "unavailable"]) expect(has(`reason.${reason}`)).toBe(true);
    for (const scope of ["story", "chars", "all"]) expect(has(`reset.scope.${scope}`)).toBe(true);
  });
});
