// Semantic hits: ids a vector recall found trigger an entry as a key match would, and pass
// every other step (the reference's `match` / `_semantic_hits`).

import { expect, test } from "bun:test";

import { activate, EMPTY_TIMERS, importLorebook, type LoreEntry, type TimerState, type ViewerGrade } from "../../../src/core/worldbook/index.ts";
import { SeededRandom } from "../../../src/core/random.ts";
import { withIds } from "./adapter.ts";

function book(raws: Record<string, unknown>[]): LoreEntry[] {
  const result = importLorebook(raws, { trust: "keeper", source: "book" });
  if (!result.ok) throw new Error("import failed");
  return withIds(result.entries);
}

function run(entries: LoreEntry[], hits: readonly string[] | undefined, viewer: ViewerGrade = "keeper", timers: TimerState = EMPTY_TIMERS) {
  return activate({
    entries,
    viewer,
    transcript: ["the harbour at dusk"],
    timers,
    advanceTimers: true,
    random: new SeededRandom(1),
    conditionHolds: () => true,
    ...(hits === undefined ? {} : { semanticHits: hits }),
  });
}

const entries = book([
  { comment: "lighthouse", content: "[lighthouse]", keys: ["beacon"] },
  { comment: "keeper", content: "[keeper secret]", keys: ["beacon"], secret: true },
  { comment: "drowned", content: "[drowned]", keys: ["ghost"], disable: true },
  { comment: "tide", content: "[tide]", keys: ["moon"], cooldown: 3 },
]);
const id = (title: string): string => entries.find((entry) => entry.title === title)?.id ?? "";

test("without hits, only lexical triggers select; a hit selects its entry", () => {
  expect(run(entries, undefined).selected).toEqual([]);
  expect(run(entries, [id("lighthouse"), "no-such-id"]).selected.map((entry) => entry.title)).toEqual(["lighthouse"]);
});

test("a hit never admits a disabled entry, nor a secret one for a player", () => {
  expect(run(entries, [id("drowned")]).selected).toEqual([]);
  const secret = id("keeper");
  expect(run(entries, [secret], "keeper").selected.map((entry) => entry.title)).toEqual(["keeper"]);
  expect(run(entries, [secret], "player").selected).toEqual([]);
});

test("a hit respects timers: an entry in its cooldown stays out", () => {
  const first = run(entries, [id("tide")]);
  expect(first.selected.map((entry) => entry.title)).toEqual(["tide"]);
  expect(run(entries, [id("tide")], "keeper", first.timers).selected).toEqual([]);
});
