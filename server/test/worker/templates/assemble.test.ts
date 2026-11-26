// `assembleLore`: the one worker exchange for the lore step.

import { describe, expect, test } from "bun:test";

import { EMPTY_TIMERS, importLorebook, type LoreEntry } from "../../../src/core/worldbook/index.ts";
import { assembleLore, type LoreAssemblyRequest } from "../../../src/worker/templates/index.ts";
import { withIds } from "../../core/worldbook/adapter.ts";

function book(raws: Record<string, unknown>[]): LoreEntry[] {
  const result = importLorebook(raws, { trust: "keeper", source: "book" });
  if (!result.ok) throw new Error("import failed");
  return withIds(result.entries);
}

function request(entries: LoreEntry[], extra: Partial<LoreAssemblyRequest> = {}): LoreAssemblyRequest {
  return {
    entries,
    viewer: "keeper",
    transcript: ["the ritual begins"],
    timers: EMPTY_TIMERS,
    advanceTimers: true,
    variables: { flat: { fear: 3 }, tree: {} },
    seed: "turn-1",
    nowMs: 0,
    limits: { perTemplateMs: 100, perAssemblyMs: 1000 },
    ...extra,
  };
}

describe("assembleLore", () => {
  const entries = book([
    { comment: "rules", constant: true, content: "Fear is <%= getvar('fear') %>. {{random::a::b::c}}" },
    { comment: "omen", content: "<% incvar('omens') %>An omen.", keys: ["ritual"], probability: 50 },
    { comment: "broken", constant: true, content: "<% throw new Error('x') %>never shown" },
    { comment: "hidden", content: "SECRET TEXT", keys: ["zz"], secret: true },
    { comment: "reader", constant: true, content: "[<%- getwi('hidden') %>]" },
    { comment: "js-gate", constant: true, content: "@@if [3].includes(variables.fear)\ngated" },
  ]);

  test("renders, records failures by call index, and returns writes", () => {
    const result = assembleLore(request(entries));
    expect(result.text).not.toContain("never shown");
    expect(result.text).not.toContain("<%");
    expect(result.failures).toEqual([expect.objectContaining({ kind: "render", title: "broken", code: "runtime" })]);
    expect(result.injected.map((entry) => entry.title)).toContain("js-gate");
    expect(result.text).toContain("[SECRET TEXT]");
    expect(result.turn).toBe(1);
  });

  test("a player-grade assembly cannot read a secret entry, not even through getwi", () => {
    const result = assembleLore(request(entries, { viewer: "player", transcript: ["zz"] }));
    expect(result.text).not.toContain("SECRET");
    expect(result.text).toContain("[]");
    expect(result.activatedTitles).not.toContain("hidden");
  });

  test("the same request gives the same result, and both shapes survive structured cloning", () => {
    const req = request(entries);
    expect(structuredClone(req)).toEqual(req);
    const a = assembleLore(req);
    const b = assembleLore(structuredClone(req));
    expect(b).toEqual(a);
    expect(structuredClone(a)).toEqual(a);
  });

  test("a retry against the post-turn state does not count the turn again", () => {
    const first = assembleLore(request(entries));
    const retry = assembleLore(request(entries, { timers: first.timers, advanceTimers: false }));
    expect(retry.turn).toBe(first.turn);
    expect(retry.timers).toEqual(first.timers);
  });
});
