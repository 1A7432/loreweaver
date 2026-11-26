// Activation and the lore step beyond the vectors: retries, secrecy by construction,
// bounds, and names that are ordinary keys.

import { describe, expect, test } from "bun:test";

import {
  activate,
  EMPTY_TIMERS,
  EMPTY_VARIABLES,
  importLorebook,
  type LoreEntry,
  readVariable,
  runLoreStep,
  type TemplateRenderer,
  type TimerState,
  type ViewerGrade,
} from "../../../src/core/worldbook/index.ts";
import { ScriptedRandom, SeededRandom } from "../../../src/core/random.ts";
import { withIds } from "./adapter.ts";

function book(raws: Record<string, unknown>[]): LoreEntry[] {
  const result = importLorebook(raws, { trust: "keeper", source: "book" });
  if (!result.ok) throw new Error("import failed");
  return withIds(result.entries);
}

function turn(entries: LoreEntry[], context: string, timers: TimerState, advanceTimers: boolean, viewer: ViewerGrade = "keeper") {
  return activate({
    entries,
    viewer,
    transcript: [context],
    timers,
    advanceTimers,
    random: new SeededRandom(1),
    conditionHolds: () => true,
  });
}

describe("timers and retries", () => {
  test("a retry (advanceTimers: false) re-selects what the turn selected and ages nothing", () => {
    const entries = book([
      { comment: "once", content: "[once]", keys: ["ritual"], cooldown: 2 },
      { comment: "omen", content: "[omen]", keys: ["ritual"], sticky: 2 },
    ]);
    const first = turn(entries, "ritual", EMPTY_TIMERS, true);
    expect(first.selected.map((entry) => entry.title)).toEqual(["once", "omen"]);
    expect(first.turn).toBe(1);
    const retry = turn(entries, "ritual", first.timers, false);
    expect(retry.selected.map((entry) => entry.title)).toEqual(["once", "omen"]);
    expect(retry.turn).toBe(1);
    expect(retry.timers).toBe(first.timers);
    // The next real turn still sees the cooldown the first assembly opened.
    const next = turn(entries, "ritual", retry.timers, true);
    expect(next.selected.map((entry) => entry.title)).toEqual(["omen"]);
    expect(next.turn).toBe(2);
  });

  test("windows opened by an earlier turn stay in force in a hold run", () => {
    const entries = book([{ comment: "omen", content: "[omen]", keys: ["ritual"], sticky: 3 }]);
    const fired = turn(entries, "ritual", EMPTY_TIMERS, true);
    const quiet = turn(entries, "nothing", fired.timers, true);
    expect(quiet.selected.map((entry) => entry.title)).toEqual(["omen"]);
    expect(turn(entries, "nothing", quiet.timers, false).selected.map((entry) => entry.title)).toEqual(["omen"]);
  });

  test("timer state of entries that left the book is dropped; a secret entry's survives a player turn", () => {
    const entries = book([{ comment: "s", content: "[s]", keys: ["k"], sticky: 5, secret: true }]);
    const keeperTurn = turn(entries, "k", EMPTY_TIMERS, true, "keeper");
    expect(keeperTurn.timers.entries.length).toBe(1);
    const playerTurn = turn(entries, "k", keeperTurn.timers, true, "player");
    expect(playerTurn.selected).toEqual([]);
    expect(playerTurn.timers.entries.length).toBe(1);
    expect(turn([], "k", playerTurn.timers, true).timers.entries).toEqual([]);
  });
});

describe("secrecy is structural", () => {
  const entries = book([
    { comment: "public", constant: true, content: "public text" },
    { comment: "secret", constant: true, content: "SECRET {{user}} <% activewi('x') %>", secret: true, probability: 50 },
    { comment: "pulled", content: "SECRET pulled", keys: ["never"], secret: true },
  ]);

  test("a player-grade run never selects, renders, pulls in or draws for a secret entry", () => {
    const rendered: string[] = [];
    const renderer: TemplateRenderer = {
      render(content) {
        rendered.push(content);
        return content;
      },
      evalCondition: () => true,
      takeActivations: () => ["pulled", "secret"],
    };
    const random = new ScriptedRandom([]);
    const result = runLoreStep(
      { entries, viewer: "player", transcript: [], timers: EMPTY_TIMERS, advanceTimers: true, random, variables: EMPTY_VARIABLES },
      renderer,
    );
    expect(result.activatedTitles).toEqual(["public"]);
    expect(result.text).toBe("public text");
    expect(result.pulledInTitles).toEqual([]);
    expect(rendered.some((content) => content.includes("SECRET"))).toBe(false);
    expect(random.consumed).toBe(0);
  });

  test("the keeper sees them", () => {
    const random = new ScriptedRandom([{ lo: 1, hi: 100, step: 1, value: 1 }]);
    const result = activate({ entries, viewer: "keeper", transcript: [], timers: EMPTY_TIMERS, advanceTimers: true, random, conditionHolds: () => true });
    expect(result.selected.map((entry) => entry.title)).toEqual(["public", "secret"]);
  });
});

describe("bounds and odd names", () => {
  test("limit and budget are clamped to their ceilings", () => {
    const entries = book(Array.from({ length: 5 }, (_, index) => ({ comment: `c${index}`, constant: true, content: "x".repeat(10) })));
    const run = (maxEntries: number, budgetChars: number) =>
      activate({ entries, viewer: "keeper", transcript: [], timers: EMPTY_TIMERS, advanceTimers: false, random: new SeededRandom(1), maxEntries, budgetChars, conditionHolds: () => true })
        .selected.length;
    expect(run(-3, 1000)).toBe(0);
    expect(run(2, 1000)).toBe(2);
    expect(run(100, 25)).toBe(2);
    expect(run(Number.NaN, 1000)).toBe(5);
  });

  test("the budget counts code points, not UTF-16 units", () => {
    const entries = book([{ comment: "emoji", constant: true, content: "😀😀" }]);
    const selected = activate({ entries, viewer: "keeper", transcript: [], timers: EMPTY_TIMERS, advanceTimers: false, random: new SeededRandom(1), budgetChars: 2, conditionHolds: () => true }).selected;
    expect(selected.length).toBe(1);
  });

  test("an import over the entry cap fails whole; one over the content cap is skipped", () => {
    expect(importLorebook(Array.from({ length: 201 }, () => ({ content: "x" })), { trust: "keeper" })).toEqual({ ok: false, code: "TOO_MANY_ENTRIES" });
    const result = importLorebook([{ comment: "big", content: "字".repeat(16_001) }, { comment: "ok", content: "字".repeat(16_000) }], { trust: "keeper" });
    expect(result.ok && result.skippedTitles).toEqual(["big"]);
  });

  test("`__proto__`, `constructor` and number-like names are ordinary keys", () => {
    const parsed = JSON.parse('{"entries": {"__proto__": {"comment": "__proto__", "content": "p", "keys": ["constructor"]}, "10": {"comment": "ten", "content": "t"}}}');
    const result = importLorebook(parsed, { trust: "keeper" });
    expect(result.ok && result.entries.map((entry) => entry.title).sort()).toEqual(["__proto__", "ten"]);
    const variables = { flat: JSON.parse('{"__proto__": 5}'), tree: { a: { constructor: 1 } } };
    expect(readVariable(variables, "__proto__")).toBe(5);
    expect(readVariable(variables, "toString")).toBeUndefined();
    expect(readVariable(variables, "a.constructor")).toBe(1);
    expect(readVariable(variables, "a.hasOwnProperty")).toBeUndefined();
  });

  test("a player import keeps no secret, no constant and no declaration", () => {
    const result = importLorebook(
      [
        { comment: "s", content: "x", secret: true },
        { comment: "e", content: "x", extensions: { secret: true } },
        { comment: "c", content: "x", constant: true },
        { comment: "[InitVar]", content: "{a: 1}" },
      ],
      { trust: "player" },
    );
    expect(result.ok && result.entries.map((entry) => [entry.title, entry.constant])).toEqual([["c", false]]);
    expect(result.ok && result.declarations).toEqual([]);
  });

  test("a keeper import hands declarations over instead of storing them", () => {
    const result = importLorebook([{ comment: "x", content: "@@initial_variables\na: 1" }, { comment: "lore", content: "y" }], { trust: "keeper" });
    expect(result.ok && result.declarations).toEqual([{ title: "x", body: "a: 1" }]);
    expect(result.ok && result.entries.map((entry) => entry.title)).toEqual(["lore"]);
  });
});
