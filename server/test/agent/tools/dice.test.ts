import { describe, expect, test } from "bun:test";

import { TurnLedger } from "../../../src/agent/tools/index.ts";
import { CHARACTER_TYPE } from "../../../src/core/characters/index.ts";
import { INITIATIVE_ID, INITIATIVE_TYPE } from "../../../src/core/clock/index.ts";
import { ADA, NOBODY, bench, stored } from "./bench.ts";

function sheetOf(room: ReturnType<typeof bench>, id: string): Record<string, unknown> {
  return (stored(room, CHARACTER_TYPE, id)?.sheet ?? {}) as Record<string, unknown>;
}

describe("roll_dice", () => {
  test("rolls with the room's randomness and shows the table a roll event", async () => {
    const room = bench();
    room.random.push(4, 6);
    const outcome = await room.call(room.catalog(), "roll_dice", { expression: "2d6+1" });
    expect(outcome.status).toBe("ok");
    expect(outcome.text).toContain("= 11");
    expect(outcome.bookkeeping.dice).toBe(true);
    expect(outcome.events).toEqual([{ kind: "dice", data: { actor: "Ada", kind: "roll", expr: "2d6 + 1", rolls: [4, 6], total: 11, detail: { criticalSuccess: false, criticalFailure: false } } }]);
  });

  test("names a non-player actor, and refuses bad notation", async () => {
    const room = bench();
    const ghoul = await room.call(room.catalog(), "roll_dice", { expression: "1d20", actor: "Ghoul" });
    expect(ghoul.events[0]?.kind === "dice" && ghoul.events[0].data.actor).toBe("Ghoul");
    const bad = await room.call(room.catalog(), "roll_dice", { expression: "2d" });
    expect(bad.status).toBe("refused");
    expect(bad.code).toBe("invalid_expression");
    expect(bad.events).toEqual([]);
  });
});

describe("skill_check", () => {
  test("rolls the acting character's skill and grades it by the pack, labelled in the room's language", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    room.random.push(12);
    const outcome = await room.call(room.catalog(), "skill_check", { skill_name: "Spot Hidden" }, { context: room.context({ locale: "zh" }) });
    expect(outcome.status).toBe("ok");
    expect(outcome.text).toContain("Target value: 60");
    expect(outcome.text).toContain("Success");
    const event = outcome.events[0];
    if (event?.kind !== "dice") throw new Error("expected a dice event");
    expect(event.data.kind).toBe("check");
    expect(event.data.target).toBe(60);
    expect(event.data.total).toBe(12);
    expect(event.data.outcome?.success).toBe(true);
    // The table's label is the pack's, in the room's language.
    expect(event.data.outcome?.label).not.toBe(event.data.outcome?.id);
    expect(event.data.expr).toBe("侦查");
  });

  test("refuses an unknown skill rather than rolling against 0", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    const outcome = await room.call(room.catalog(), "skill_check", { skill_name: "Basket Weaving Mastery" });
    expect(outcome.code).toBe("unknown_skill");
    expect(outcome.events).toEqual([]);
  });

  test("a non-player actor needs its number; with it, no sheet is read", async () => {
    const room = bench();
    const missing = await room.call(room.catalog(), "skill_check", { skill_name: "Listen", actor: "Ghoul" }, { context: room.context({ who: NOBODY }) });
    expect(missing.code).toBe("npc_target_required");
    room.random.push(90);
    const rolled = await room.call(room.catalog(), "skill_check", { skill_name: "Listen", actor: "Ghoul", npc_target: 40 }, { context: room.context({ who: NOBODY }) });
    expect(rolled.status).toBe("ok");
    const event = rolled.events[0];
    expect(event?.kind === "dice" && [event.data.actor, event.data.target, event.data.outcome?.success]).toEqual(["Ghoul", 40, false]);
  });

  test("with nobody seated and no actor there is no sheet to check", async () => {
    const room = bench();
    const outcome = await room.call(room.catalog(), "skill_check", { skill_name: "Listen" }, { context: room.context({ who: NOBODY }) });
    expect(outcome.code).toBe("no_character");
  });

  test("a d20 system rolls against a DC with the sheet's modifier", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada", {
      pack: "dnd5e",
      sheet: { name: "Ada", attributes: { STR: 14, DEX: 16, CON: 12, INT: 10, WIS: 13, CHA: 8 } },
    });
    room.random.push(10);
    const outcome = await room.call(room.catalog({ pack: room.pack("dnd5e") }), "skill_check", { skill_name: "DEX", dc: 12 }, { context: room.context({ pack: "dnd5e" }) });
    expect(outcome.status).toBe("ok");
    expect(outcome.text).toContain("vs target 12");
  });

  test("a pool system takes its roll parameters, bounded", async () => {
    const room = bench();
    const context = room.context({ pack: "wod", who: NOBODY });
    const catalog = room.catalog({ pack: room.pack("wod") });
    room.random.push(8, 3, 1);
    const rolled = await room.call(catalog, "skill_check", { skill_name: "x", params: { pool: 3, difficulty: 6 } }, { context });
    expect(rolled.status).toBe("ok");
    expect(rolled.text).toContain("Successes: 1");
    const outOfRange = await room.call(catalog, "skill_check", { skill_name: "x", params: { pool: 0 } }, { context });
    expect(outOfRange.code).toBe("param_out_of_range");
    const unknown = await room.call(catalog, "skill_check", { skill_name: "x", params: { dice: 2 } }, { context });
    expect(unknown.code).toBe("unknown_param");
  });

  test("a roll-under check is recorded for a later spend", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    room.random.push(70);
    const ledger = new TurnLedger();
    await room.call(room.catalog(), "skill_check", { skill_name: "侦查" }, { ledger });
    expect(ledger.checks.get("ada")).toMatchObject({ skill: "侦查", target: 60, roll: 70 });
  });
});

describe("hp_manager", () => {
  test("shows, damages and heals the acting character through the sheet layer", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    const catalog = room.catalog();
    const shown = await room.call(catalog, "hp_manager", { action: "show" });
    expect(shown.text).toMatch(/Ada HP: 12\/12/);
    const hurt = await room.call(catalog, "hp_manager", { action: "sub", value: 5 });
    expect(hurt.text).toContain("7/12");
    expect(hurt.text).toContain("Lightly Wounded");
    const healed = await room.call(catalog, "hp_manager", { action: "add", value: 50 });
    expect(healed.text).toContain("12/12");
    expect(JSON.stringify(sheetOf(room, "ada"))).toContain('"HP",12');
  });

  test("refuses an unknown action, and a member with no character", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    expect((await room.call(room.catalog(), "hp_manager", { action: "heal" })).code).toBe("unknown_action");
    expect((await room.call(room.catalog(), "hp_manager", { action: "show" }, { context: room.context({ who: NOBODY }) })).code).toBe("no_character");
  });
});

describe("initiative_tracker", () => {
  test("adds (rolling the active character's own), lists, advances and clears", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    const catalog = room.catalog();
    room.random.push(30);
    const rolled = await room.call(catalog, "initiative_tracker", { action: "add" }, { context: room.context({ who: ADA }) });
    // coc7: 1d100 + DEX (70).
    expect(rolled.text).toBe("Added Ada's initiative: 100");
    expect(rolled.events[0]?.kind === "dice" && rolled.events[0].data.kind).toBe("init");
    await room.call(catalog, "initiative_tracker", { action: "add", name: "Ghoul", initiative: 120 });
    const listed = await room.call(catalog, "initiative_tracker", { action: "list" });
    expect(listed.text).toContain("1. Ghoul: 120");
    expect(listed.text).toContain("2. Ada: 100");
    // Ada was acting when the Ghoul joined ahead of her; her turn passes into round 2.
    const next = await room.call(catalog, "initiative_tracker", { action: "next" });
    expect(next.text).toBe("Current turn: Ghoul (round 2)");
    await room.call(catalog, "initiative_tracker", { action: "clear" }, { ledger: new TurnLedger() });
    expect(stored(room, INITIATIVE_TYPE, INITIATIVE_ID)).toMatchObject({ order: [] });
  });

  test("refuses a named combatant without a value, a repeat, and an unknown action", async () => {
    const room = bench();
    const catalog = room.catalog();
    expect((await room.call(catalog, "initiative_tracker", { action: "add", name: "Ghoul" })).code).toBe("initiative_required");
    await room.call(catalog, "initiative_tracker", { action: "add", name: "Ghoul", initiative: 5 });
    expect((await room.call(catalog, "initiative_tracker", { action: "add", name: "Ghoul", initiative: 6 })).code).toBe("already_listed");
    expect((await room.call(catalog, "initiative_tracker", { action: "sort" })).code).toBe("unknown_action");
    expect((await room.call(room.catalog(), "initiative_tracker", { action: "next" }, { context: room.context() })).status).toBe("ok");
  });
});
