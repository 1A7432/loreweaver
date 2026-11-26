// Sentinels: a marker sits in every field a player may not see; no command a player can
// run returns it — not in the text, not in the data, not in an event, not in a refusal.
import { describe, expect, test } from "bun:test";

import type { CommandOutcome } from "../../../src/gateway/commands/index.ts";
import { ADA, ADMIN, bench, type Bench, code, ok } from "./bench.ts";
import { SECRET, seedChronicle, seedHabits, seedLore, seedNpc, seedRoster, seedVariables } from "./seed.ts";

function seeded(): Bench {
  const b = bench();
  seedLore(b);
  seedNpc(b);
  seedVariables(b);
  seedChronicle(b);
  seedHabits(b);
  seedRoster(b);
  return b;
}

const PLAYER_MARKERS = [SECRET.lore, SECRET.loreTitle, SECRET.npcAgenda, SECRET.npcPersona, SECRET.npcFact, SECRET.variable, SECRET.recordKeeper, SECRET.summaryMargin, SECRET.thread, SECRET.habit, "PREGEN-KEEPER-NOTE"];

function leaks(outcome: unknown, markers: readonly string[]): string[] {
  const text = JSON.stringify(outcome);
  return markers.filter((marker) => text.includes(marker));
}

async function asPlayer(b: Bench, id: string, args: Record<string, unknown>): Promise<CommandOutcome> {
  return b.run(ADA, id, args);
}

describe("lore", () => {
  test("a player's list holds only the table view of non-secret entries", async () => {
    const b = seeded();
    const listed = ok(await asPlayer(b, "lore", { op: "list" }));
    expect(listed.text).toContain("Arkham");
    expect(leaks(listed, PLAYER_MARKERS)).toEqual([]);
    expect(code(await asPlayer(b, "lore", { op: "list", disabled: true }))).toBe("forbidden");
  });

  test("the admin sees a secret entry's title, never its content", async () => {
    const b = seeded();
    const listed = ok(await b.run(ADMIN, "lore", { op: "list" }));
    expect(listed.text).toContain(SECRET.loreTitle);
    expect(leaks(listed, [SECRET.lore])).toEqual([]);
  });
});

describe("NPCs", () => {
  test("a player is refused, and the refusal names nothing", async () => {
    const b = seeded();
    for (const args of [{ op: "list" }, { op: "show", name: "Mr Smith" }]) {
      const outcome = await asPlayer(b, "npc", args);
      expect(code(outcome)).toBe("forbidden");
      expect(leaks(outcome, PLAYER_MARKERS.concat(["Mr Smith", "grocer"]))).toEqual([]);
    }
  });

  test("the admin's whole-record answer is a result to the admin alone, never an event", async () => {
    const b = seeded();
    const shown = ok(await b.run(ADMIN, "npc", { op: "show", name: "Mr Smith" }));
    expect(shown.text).toContain(SECRET.npcAgenda);
    expect(shown.events).toEqual([]);
    const typed = await b.input(ADMIN, ".npc show mr smith");
    expect(typed.kind === "command" && typed.outcome.ok ? typed.outcome.events : null).toEqual([]);
  });
});

describe("variables", () => {
  test("a player cannot list variables; the admin sees unexposed ones flagged", async () => {
    const b = seeded();
    const refused = await asPlayer(b, "var", { op: "list" });
    expect(code(refused)).toBe("forbidden");
    expect(leaks(refused, PLAYER_MARKERS)).toEqual([]);
    const listed = ok(await b.run(ADMIN, "var", { op: "list" }));
    expect(listed.text).toContain(`plot.ending = ${SECRET.variable} [hidden]`);
    expect(listed.text).toContain("stats.hp = 10");
    expect(listed.events).toEqual([]);
  });
});

describe("the chronicle", () => {
  test("the recap is built from public views: no annotation, no margin, no thread", async () => {
    const b = seeded();
    const recap = ok(await asPlayer(b, "recap", {}));
    expect(recap.text).toContain("The story began in Arkham.");
    expect(recap.text).toContain("They found the cellar.");
    // The record already folded into the summary (turn 1 ≤ through-turn 2) is not repeated.
    expect(recap.text).not.toContain("reached the farm");
    expect(leaks(recap, PLAYER_MARKERS)).toEqual([]);
  });

  test("the admin's console reads the Keeper's records and answers the admin alone", async () => {
    const b = seeded();
    const list = ok(await b.run(ADMIN, "chronicle", { op: "list" }));
    expect(list.text).toContain(SECRET.recordKeeper);
    const threads = ok(await b.run(ADMIN, "chronicle", { op: "threads" }));
    expect(threads.text).toContain(SECRET.thread);
    const summary = ok(await b.run(ADMIN, "chronicle", { op: "summary" }));
    expect(summary.text).toContain(SECRET.summaryMargin);
    for (const outcome of [list, threads, summary]) expect(outcome.events).toEqual([]);
    ok(await b.run(ADMIN, "chronicle", { op: "note", text: "NEW-MARGIN" }));
    expect(leaks(ok(await asPlayer(b, "recap", {})), ["NEW-MARGIN"])).toEqual([]);
  });
});

describe("everything a player can run", () => {
  test("no player command returns a secret marker", async () => {
    const b = seeded();
    await b.input(ADA, ".coc Alice");
    const outcomes: unknown[] = [];
    for (const line of [".lore", ".recap", ".pc", ".help", ".st", ".init", ".rule", ".bot", ".npc", ".var", ".chronicle", ".habits", ".save"]) {
      outcomes.push(await b.input(ADA, line));
    }
    outcomes.push(await b.registry.view(b.context(ADA), "en"));
    expect(leaks(outcomes, PLAYER_MARKERS)).toEqual([]);
  });

  test("the habits ledger is the admin's only", async () => {
    const b = seeded();
    expect(code(await asPlayer(b, "habits", { op: "show" }))).toBe("forbidden");
    expect(ok(await b.run(ADMIN, "habits", { op: "show" })).text).toContain(SECRET.habit);
    ok(await b.run(ADMIN, "habits", { op: "forget", text: SECRET.habit }));
    expect(ok(await b.run(ADMIN, "habits", { op: "show" })).text).not.toContain(SECRET.habit);
  });
});
