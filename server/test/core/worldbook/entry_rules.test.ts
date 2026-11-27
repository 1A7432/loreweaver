// How an imported entry's kind and flags are read — one definition for the card split and
// the lore import (`core/worldbook/entry_rules.ts`) — and the import's refusals: a value it
// cannot read, or a field past its bound, leaves the ENTRY out and counted, never cut.
import { describe, expect, test } from "bun:test";

import { isSecretEntry, isVariableDeclaration as splitIsDeclaration, parseCard, splitCard } from "../../../src/core/card/index.ts";
import {
  entrySecrecy,
  importLorebook,
  isVariableDeclaration,
  MAX_CONDITION_CHARS,
  MAX_KEY_CHARS,
  MAX_KEYS,
  MAX_TITLE_CHARS,
  readStFlag,
  ST_FLAG_SPELLINGS,
  type ImportedEntry,
  type LeftOutEntry,
} from "../../../src/core/worldbook/index.ts";

function stCard(entries: unknown[]): ReturnType<typeof parseCard> {
  const raw = { spec: "chara_card_v2", spec_version: "2.0", data: { name: "Isle", description: "An isle.", character_book: { entries } } };
  return parseCard(new TextEncoder().encode(JSON.stringify(raw)), "card.json");
}

function keeperImport(entries: unknown[]): { entries: readonly ImportedEntry[]; leftOut: readonly LeftOutEntry[] } {
  const result = importLorebook(entries, { trust: "keeper", source: "book" });
  if (!result.ok) throw new Error(result.code);
  return result;
}

describe("secret: one definition, failing closed", () => {
  const truthExtFalse = { comment: "truth", content: "x", keys: ["k"], secret: true, extensions: { secret: false } };

  test("true at either level is secret; extensions cannot make public what the top level marks secret", () => {
    expect(entrySecrecy(truthExtFalse)).toBe("secret");
    expect(entrySecrecy({ secret: false, extensions: { secret: true } })).toBe("secret");
    expect(entrySecrecy({ secret: false })).toBe("public");
    expect(entrySecrecy({ secret: null, extensions: { secret: null } })).toBe("public");
    expect(entrySecrecy({})).toBe("public");
  });

  test("a non-boolean at either level is invalid, whatever the other says", () => {
    for (const value of [1, 0, "true", "false", "", [], {}]) {
      expect([value, entrySecrecy({ secret: value })]).toEqual([value, "invalid"]);
      expect([value, entrySecrecy({ secret: true, extensions: { secret: value } })]).toEqual([value, "invalid"]);
    }
  });

  test("the split and the lore import agree: top-level true over extensions false is a world card AND stored secret", () => {
    const split = splitCard(stCard([truthExtFalse]));
    expect(split.kind).toBe("world");
    expect(split.machinery.secretEntries).toBe(1);
    expect(split.character.book).toEqual([]);
    const lore = keeperImport([...split.world.entries]);
    expect(lore.entries.map((entry) => [entry.title, entry.secret])).toEqual([["truth", true]]);
  });

  test("secret: 1 stays off the character half (counted, warned) and the lore import refuses it, naming the field", () => {
    const split = splitCard(stCard([{ comment: "one", content: "x", keys: ["k"], secret: 1 }]));
    expect(split.kind).toBe("world");
    expect(split.character.book).toEqual([]);
    expect(split.warnings).toEqual([{ code: "secret_unreadable", count: 1 }]);
    expect(isSecretEntry({ secret: 1 })).toBe(true);
    const lore = keeperImport([...split.world.entries]);
    expect(lore.entries).toEqual([]);
    expect(lore.leftOut).toEqual([{ title: "one", reason: "flag_not_boolean", field: "secret" }]);
  });

  test("a player import counts the secret entry it drops", () => {
    const result = importLorebook([{ comment: "s", content: "x", secret: true }], { trust: "player" });
    expect(result.ok && result.leftOut).toEqual([{ title: "s", reason: "secret_untrusted" }]);
  });
});

describe("variable declarations: one recogniser", () => {
  test("the brackets are the marker; the split and the import answer alike", () => {
    const cases: [Record<string, unknown>, boolean][] = [
      [{ comment: "[InitVar] state", content: "a: 1" }, true],
      [{ comment: "initvar notes", content: "a: 1" }, false],
      [{ comment: "MVU INITVAR", content: "a: 1" }, false],
      [{ comment: "[Initial Variables]", content: "a: 1" }, true],
      [{ comment: "notes", content: "@@initial_variables\na: 1" }, true],
      [{ title: 5, comment: "[InitVar]", content: "a: 1" }, true],
    ];
    for (const [entry, expected] of cases) {
      expect([entry, isVariableDeclaration(entry)]).toEqual([entry, expected]);
      expect([entry, splitIsDeclaration(entry as never)]).toEqual([entry, expected]);
    }
  });

  test("an `initvar notes` entry is lore in both: on the character half, and stored by the import", () => {
    const entry = { comment: "initvar notes", content: "The island's lore.", keys: ["isle"] };
    const split = splitCard(stCard([entry]));
    expect(split.kind).toBe("character");
    expect(split.machinery.variableDeclarations).toBe(0);
    expect(split.character.book).toHaveLength(1);
    const lore = keeperImport([...split.world.entries]);
    expect(lore.entries.map((stored) => stored.title)).toEqual(["initvar notes"]);
    expect(lore.leftOut).toEqual([]);
  });

  test("a declaration a player import meets is counted, not silently dropped", () => {
    const result = importLorebook([{ comment: "[InitVar]", content: "a: 1" }], { trust: "player" });
    expect(result.ok && [result.declarations, result.leftOut]).toEqual([[], [{ title: "[InitVar]", reason: "declaration_untrusted" }]]);
  });
});

describe("SillyTavern flags: a named set of spellings", () => {
  test("exactly true/false, 1/0, \"true\"/\"false\"/\"1\"/\"0\" and null (false) are read; anything else is invalid", () => {
    expect([...ST_FLAG_SPELLINGS]).toEqual([
      [true, true],
      [null, false],
      [false, false],
      [1, true],
      [0, false],
      ["true", true],
      ["false", false],
      ["1", true],
      ["0", false],
    ]);
    expect(readStFlag(undefined)).toBe("absent");
    for (const value of ["yes", "no", "TRUE", " true", 2, -1, 0.5, [], {}, "on"]) expect([value, readStFlag(value)]).toEqual([value, "invalid"]);
  });

  test("accepted spellings mean what they say", () => {
    const { entries } = keeperImport([
      { comment: "a", content: "x", keys: ["k"], enabled: "false" },
      { comment: "b", content: "x", keys: ["k"], disable: 1 },
      { comment: "c", content: "x", keys: ["k"], constant: "1", selective: 0, secondary_keys: ["s"] },
      { comment: "d", content: "x", keys: ["k"], extensions: { case_sensitive: "true", match_whole_words: 1, group_override: true } },
      { comment: "e", content: "x", keys: ["k"], enabled: null },
    ]);
    expect(entries.map((entry) => [entry.title, entry.enabled])).toEqual([
      ["a", false],
      ["b", false],
      ["c", true],
      ["d", true],
      ["e", false],
    ]);
    expect(entries[2]).toMatchObject({ constant: true, secondaryKeys: [] });
    expect(entries[3]).toMatchObject({ caseSensitive: true, matchWholeWords: true, groupOverride: true });
  });

  test("an unread spelling refuses the entry, naming the field; the rest of the book imports", () => {
    const { entries, leftOut } = keeperImport([
      { comment: "a", content: "x", keys: ["k"], enabled: "no" },
      { comment: "b", content: "x", keys: ["k"], constant: 2 },
      { comment: "c", content: "x", keys: ["k"], extensions: { useProbability: "yes" } },
      { comment: "ok", content: "x", keys: ["k"] },
    ]);
    expect(entries.map((entry) => entry.title)).toEqual(["ok"]);
    expect(leftOut).toEqual([
      { title: "a", reason: "flag_not_boolean", field: "enabled" },
      { title: "b", reason: "flag_not_boolean", field: "constant" },
      { title: "c", reason: "flag_not_boolean", field: "useProbability" },
    ]);
  });
});

describe("nothing is cut to fit", () => {
  test("a condition over the bound refuses the entry (half a condition is a different rule); one at the bound is stored whole", () => {
    const head = "a == 1 || ";
    const long = `${head}${"x".repeat(MAX_CONDITION_CHARS - head.length - 6)}b == 2`;
    expect(long.length).toBe(MAX_CONDITION_CHARS);
    const { entries, leftOut } = keeperImport([
      { comment: "over", content: `@@if ${long}z\nx` },
      { comment: "at", content: `@@if ${long}\nx` },
    ]);
    expect(entries.map((entry) => [entry.title, entry.condition])).toEqual([["at", long]]);
    expect(leftOut).toEqual([{ title: "over", reason: "condition_too_long", field: "condition" }]);
  });

  test("a title, key or group over its bound, or too many keys, refuses the entry", () => {
    const { entries, leftOut } = keeperImport([
      { comment: "字".repeat(MAX_TITLE_CHARS + 1), content: "x" },
      { comment: "key", content: "x", keys: ["k".repeat(MAX_KEY_CHARS + 1)] },
      { comment: "keys", content: "x", keys: Array.from({ length: MAX_KEYS + 1 }, (_, index) => `k${index}`) },
      { comment: "second", content: "x", keys: ["k"], secondary_keys: Array.from({ length: MAX_KEYS + 1 }, (_, index) => `s${index}`) },
      { comment: "group", content: "x", group: "g".repeat(MAX_TITLE_CHARS + 1) },
      { comment: "fits", content: "x", keys: Array.from({ length: MAX_KEYS }, (_, index) => `k${index}`), group: "g".repeat(MAX_TITLE_CHARS) },
    ]);
    expect(entries.map((entry) => [entry.title, entry.keys.length, entry.group.length])).toEqual([["fits", MAX_KEYS, MAX_TITLE_CHARS]]);
    expect(leftOut.map((entry) => [entry.reason, entry.field])).toEqual([
      ["title_too_long", "title"],
      ["key_too_long", "keys"],
      ["too_many_keys", "keys"],
      ["too_many_keys", "secondary_keys"],
      ["group_too_long", "group"],
    ]);
  });

  test("the bounds hold after {{char}} is bound", () => {
    const result = importLorebook([{ comment: `{{char}}${"t".repeat(MAX_TITLE_CHARS - 5)}`, content: "x" }], { trust: "keeper", charName: "Longname" });
    expect(result.ok && [result.entries, result.leftOut.map((entry) => entry.reason)]).toEqual([[], ["title_too_long"]]);
  });

  test("an entry left empty by its decorators is counted", () => {
    const { leftOut } = keeperImport([{ comment: "only", content: "@@activate" }]);
    expect(leftOut).toEqual([{ title: "only", reason: "empty" }]);
  });
});
