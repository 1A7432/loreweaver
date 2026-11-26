// Direct tests for every place this port follows SillyTavern where the old engine did not.
// Each names the ST source it follows; the vector rows these supersede are skipped by name
// in the vector tests.

import { describe, expect, test } from "bun:test";

import {
  activate,
  EMPTY_TIMERS,
  importLorebook,
  type ImportedEntry,
  type LoreEntry,
  ScanWindow,
  scanText,
  substituteMacros,
} from "../../../src/core/worldbook/index.ts";
import { ScriptedRandom, SeededRandom } from "../../../src/core/random.ts";
import { withIds } from "./adapter.ts";

function importOne(raw: Record<string, unknown>, trust: "keeper" | "player" = "keeper"): ImportedEntry {
  const result = importLorebook([{ comment: "e", content: "x", keys: ["k"], ...raw }], { trust, source: "book" });
  if (!result.ok) throw new Error("import failed");
  const entry = result.entries[0];
  if (entry === undefined) throw new Error("nothing imported");
  return entry;
}

function entries(raws: Record<string, unknown>[]): LoreEntry[] {
  const result = importLorebook(raws, { trust: "keeper", source: "book" });
  if (!result.ok) throw new Error("import failed");
  return withIds(result.entries);
}

function run(book: LoreEntry[], context: string, draws: { lo: number; hi: number; value: number }[] = []) {
  const random = new ScriptedRandom(draws.map((draw) => ({ ...draw, step: 1 })));
  const result = activate({
    entries: book,
    viewer: "keeper",
    transcript: context === "" ? [] : [context],
    timers: EMPTY_TIMERS,
    advanceTimers: true,
    random,
    conditionHolds: () => true,
  });
  expect(random.remaining).toBe(0);
  return result.selected.map((entry) => entry.title);
}

describe("import follows SillyTavern's field sources (world-info.js)", () => {
  test("native `disable: true` imports disabled", () => {
    expect(importOne({ disable: true }).enabled).toBe(false);
    expect(importOne({ disable: false }).enabled).toBe(true);
    expect(importOne({ enabled: false }).enabled).toBe(false);
  });

  test("native `order` is the priority when neither `priority` nor `insertion_order` is given", () => {
    expect(importOne({ order: 9 }).priority).toBe(9);
    expect(importOne({ order: 9, insertion_order: 3 }).priority).toBe(3);
    expect(importOne({ order: 9, priority: 4 }).priority).toBe(4);
  });

  test("V2 trigger fields under `extensions` are read, and win over top-level ones (convertCharacterBook)", () => {
    const entry = importOne({
      probability: 80,
      extensions: {
        probability: 10,
        useProbability: true,
        selectiveLogic: 3,
        group: "g",
        group_weight: 40,
        group_override: true,
        sticky: 2,
        cooldown: 1,
        delay: 4,
        scan_depth: 3,
        case_sensitive: true,
        match_whole_words: true,
        position: 4,
        depth: 7,
        category: "npc",
      },
    });
    expect(entry).toMatchObject({
      probability: 10,
      selectiveLogic: "and_all",
      group: "g",
      groupWeight: 40,
      groupOverride: true,
      sticky: 2,
      cooldown: 1,
      delay: 4,
      scanDepth: 3,
      caseSensitive: true,
      matchWholeWords: true,
      placement: "at_depth",
      depth: 7,
      category: "npc",
    });
    expect(importOne({ probability: 25, extensions: { useProbability: false } }).probability).toBe(100);
  });

  test("ST position codes 0..7 map onto placements", () => {
    const placements = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((position) => importOne({ position }).placement);
    expect(placements).toEqual([
      "before",
      "after",
      "author_note_top",
      "author_note_bottom",
      "at_depth",
      "examples_top",
      "examples_bottom",
      "outlet",
      "default",
    ]);
  });

  test("`groupWeight: 0` stays 0 (`?? DEFAULT_WEIGHT`); negatives clamp to 0, the editor maximum is 10000", () => {
    expect(importOne({ groupWeight: 0 }).groupWeight).toBe(0);
    expect(importOne({ groupWeight: -5 }).groupWeight).toBe(0);
    expect(importOne({ groupWeight: 50_000 }).groupWeight).toBe(10_000);
    expect(importOne({}).groupWeight).toBe(100);
  });

  test("`@@activate` activates like `constant`, for a keeper import only", () => {
    expect(importOne({ content: "@@activate\nbody" }).constant).toBe(true);
    expect(importOne({ content: "@@activate\nbody" }, "player").constant).toBe(false);
  });
});

describe("whole-word matching uses ST's ASCII boundaries", () => {
  const whole = { caseSensitive: false, matchWholeWords: true };
  const find = (key: string, text: string) => new ScanWindow(scanText([text], 0)).matches(key, whole);

  test("CJK letters are boundaries: `gun` is found in `他拿起gun了`", () => {
    expect(find("gun", "他拿起gun了")).toBe(true);
    expect(find("gun", "a gunman")).toBe(false);
    expect(find("gun", "gun")).toBe(true);
  });

  test("a one-word key with punctuation is boundary-checked; a key with spaces is a substring", () => {
    expect(find("dark-elf", "a dark-elfling")).toBe(false);
    expect(find("dark-elf", "a dark-elf.")).toBe(true);
    expect(find("old man", "the bold mankind")).toBe(true);
  });

  test("a later occurrence can satisfy the boundaries", () => {
    expect(find("cat", "concat cat")).toBe(true);
  });

  test("a key never spans two messages", () => {
    const window = new ScanWindow(scanText(["the old", "man"], 0));
    expect(window.matches("old\nman", { caseSensitive: false, matchWholeWords: false })).toBe(false);
  });
});

describe("inclusion groups follow filterByInclusionGroups", () => {
  test("the winner keeps its place among ungrouped entries", () => {
    const book = entries([
      { comment: "a", constant: true, content: "a", group: "g", groupWeight: 30 },
      { comment: "b", constant: true, content: "b", group: "g", groupWeight: 70 },
      { comment: "solo", constant: true, content: "s" },
    ]);
    expect(run(book, "", [{ lo: 1, hi: 100, value: 30 }])).toEqual(["a", "solo"]);
    expect(run(book, "", [{ lo: 1, hi: 100, value: 31 }])).toEqual(["b", "solo"]);
  });

  test("a weight-0 member never wins against a weighted one", () => {
    const book = entries([
      { comment: "zero", constant: true, content: "z", group: "g", groupWeight: 0 },
      { comment: "one", constant: true, content: "o", group: "g", groupWeight: 1 },
    ]);
    expect(run(book, "", [{ lo: 1, hi: 1, value: 1 }])).toEqual(["one"]);
  });

  test("an all-zero group takes its first member without drawing", () => {
    const book = entries([
      { comment: "a", constant: true, content: "a", group: "g", groupWeight: 0 },
      { comment: "b", constant: true, content: "b", group: "g", groupWeight: 0 },
    ]);
    expect(run(book, "")).toEqual(["a"]);
  });

  test("group names are comma-separated: one entry may belong to two groups", () => {
    const book = entries([
      { comment: "both", constant: true, content: "1", group: "x, y", groupWeight: 10 },
      { comment: "x-only", constant: true, content: "2", group: "x", groupWeight: 10 },
      { comment: "y-only", constant: true, content: "3", group: "y", groupWeight: 10 },
    ]);
    // Group x draws first and picks `both`, which removes `x-only`; group y then has
    // `both` and `y-only` left and draws again.
    expect(run(book, "", [{ lo: 1, hi: 20, value: 5 }, { lo: 1, hi: 20, value: 15 }])).toEqual(["y-only"]);
  });

  test("a `groupOverride` member wins without a draw; the highest priority among overriders", () => {
    const book = entries([
      { comment: "plain", constant: true, content: "1", group: "g" },
      { comment: "low", constant: true, content: "2", group: "g", groupOverride: true, order: 1 },
      { comment: "high", constant: true, content: "3", group: "g", groupOverride: true, order: 5 },
    ]);
    expect(run(book, "")).toEqual(["high"]);
  });
});

describe("macros follow evaluateMacros (macros.js, variables.js)", () => {
  const variables = { flat: { flag: true, whole: 2.0, obj: { a: 1 }, list: [1, "x"], zero: 0, none: null }, tree: {} };

  test("values print like sanitizeMacroValue", () => {
    expect(substituteMacros("{{getvar::flag}} {{getvar::whole}} {{getvar::obj}} {{getvar::list}} {{getvar::zero}} [{{getvar::none}}]", { variables })).toBe(
      'true 2 {"a":1} [1,"x"] 0 []',
    );
  });

  test("getvar is case-insensitive and needs the exact `{{getvar::` opening", () => {
    expect(substituteMacros("{{GETVAR::flag}}|{{getvar:: flag }}|{{ getvar::flag }}", { variables })).toBe("true|true|{{ getvar::flag }}");
  });

  test("names: exact and case-insensitive; an empty name substitutes as empty", () => {
    expect(substituteMacros("{{USER}}/{{ user }}/{{char}}", { names: { user: "A", char: "" } })).toBe("A/{{ user }}/");
  });

  test("comments are removed after the names, braces and all", () => {
    expect(substituteMacros("a{{// x {y} }}b{{// {{user}} }}c", { names: { user: "A" } })).toBe("abc");
  });

  test("random keeps empty comma items and splits on `::` without trimming", () => {
    const random = new ScriptedRandom([
      { lo: 0, hi: 3, step: 1, value: 1 },
      { lo: 0, hi: 1, step: 1, value: 0 },
    ]);
    expect(substituteMacros("[{{random: a , , b,c}}][{{random:: a ::b}}]", { random })).toBe("[][ a ]");
  });

  test("roll: colon and space forms, a bare number is 1dN, an invalid formula prints nothing", () => {
    const seen: string[] = [];
    const roll = (formula: string) => {
      seen.push(formula);
      if (formula.startsWith(":")) throw new Error("invalid");
      return 7;
    };
    expect(substituteMacros("{{roll:1d6}} {{roll 2d6}} {{roll:20}} [{{roll::2d6}}]", { roll })).toBe("7 7 7 []");
    expect(seen).toEqual(["1d6", "2d6", "1d20", ":2d6"]);
  });

  test("pick is stable for the same seed and text, and independent of the random source", () => {
    const text = "{{pick::a::b::c::d::e::f::g::h}}";
    const first = substituteMacros(text, { pickSeed: "room-1" });
    expect(substituteMacros(text, { pickSeed: "room-1" })).toBe(first);
    const picks = new Set(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((seed) => substituteMacros(text, { pickSeed: seed })));
    expect(picks.size).toBeGreaterThan(1);
    expect(substituteMacros(text, {})).toBe(text);
  });

  test("{{trim}} removes itself and the surrounding line breaks; {{reverse}} reverses code points", () => {
    expect(substituteMacros("a\n{{trim}}\nb {{reverse:ab好}}", {})).toBe("ab 好ba");
  });

  test("a real dice roller backs {{roll}}", async () => {
    const { diceRoller } = await import("../../../src/core/worldbook/index.ts");
    const total = Number(substituteMacros("{{roll:3d6}}", { roll: diceRoller(new SeededRandom(1)) }));
    expect(total).toBeGreaterThanOrEqual(3);
    expect(total).toBeLessThanOrEqual(18);
  });
});
