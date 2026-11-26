import { describe, expect, test } from "bun:test";

import { CHARACTER_TYPE } from "../../../src/core/characters/index.ts";
import { GAME_CLOCK_ID, GAME_CLOCK_TYPE } from "../../../src/core/clock/index.ts";
import { intentLogData, KEEPER_NOTES_ID, KEEPER_NOTES_TYPE, NPC_INTENTS_ID, NPC_INTENTS_TYPE, SCENE_ID, SCENE_TYPE } from "../../../src/core/notes/index.ts";
import { NOBODY, bench, stored } from "./bench.ts";

describe("character sheets", () => {
  test("get_character_sheet reads the acting character", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    const outcome = await room.call(room.catalog(), "get_character_sheet", {});
    expect(outcome.status).toBe("ok");
    expect(outcome.text).toContain("Character sheet: Ada");
    expect(outcome.text).toContain("STR: 50");
    expect(outcome.text).toContain("侦查: 60");
    expect((await room.call(room.catalog(), "get_character_sheet", {}, { context: room.context({ who: NOBODY }) })).code).toBe("no_character");
  });

  test("an unreadable character is refused without a write", async () => {
    const room = bench();
    room.writer().docPut(CHARACTER_TYPE, "ada", 1, "{not json", "{}");
    const outcome = await room.call(room.catalog(), "hp_manager", { action: "sub", value: 1 });
    expect(outcome.code).toBe("character_unreadable");
    expect(room.services.documents.get("room-1", CHARACTER_TYPE, "ada")?.corrupt).toBe(true);
  });

  test("list_party_sheets shows every seated character", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    room.addCharacter("bao", "Bao");
    const outcome = await room.call(room.catalog(), "list_party_sheets", {}, { context: room.context({ who: NOBODY }) });
    expect(outcome.text).toContain("Party sheets (2):");
    expect(outcome.text).toContain("— Ada (coc7)");
    expect(outcome.text).toContain("— Bao (coc7)");
    const empty = bench();
    expect((await empty.call(empty.catalog(), "list_party_sheets", {})).text).toBe("No character sheets in this room yet.");
  });

  test("update_character_attribute writes through the pack and reports its corrections", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    const catalog = room.catalog();
    const updated = await room.call(catalog, "update_character_attribute", { attribute: "力量", value: 65 });
    expect(updated.text).toBe("Updated Ada's 力量: 50 → 65");
    const clamped = await room.call(catalog, "update_character_attribute", { attribute: "STR", value: 400 });
    expect(clamped.status).toBe("ok");
    expect(clamped.text).toContain("The rule pack corrected the sheet:\n- attributes.STR: attribute_above_max → 90");
    const hp = await room.call(catalog, "update_character_attribute", { attribute: "HP", value: 3 });
    expect(hp.text).toBe("Updated Ada's HP: 12 → 3");
    const nobody = await room.call(catalog, "update_character_attribute", { attribute: "STR", value: 3 }, { context: room.context({ who: NOBODY }) });
    expect(nobody.code).toBe("no_character");
  });

  test("update_character_status replaces the status effects", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    const catalog = room.catalog();
    const done = await room.call(catalog, "update_character_status", { status_effects: '["Poisoned", "Afraid", "Poisoned"]' });
    expect(done.text).toBe("Character status updated: Poisoned, Afraid");
    expect(stored(room, CHARACTER_TYPE, "ada")?.status).toEqual(["Poisoned", "Afraid"]);
    expect((await room.call(catalog, "update_character_status", { status_effects: "Poisoned" })).code).toBe("invalid_status");
    expect((await room.call(catalog, "update_character_status", { status_effects: JSON.stringify(["x".repeat(81)]) })).code).toBe("bad_status");
  });
});

describe("kp_note", () => {
  test("scene categories write the table's scene card", async () => {
    const room = bench();
    const catalog = room.catalog();
    const set = await room.call(catalog, "kp_note", { action: "set", category: "current_scene", content: "The mill" });
    expect(set.text).toContain("Players now see this");
    await room.call(catalog, "kp_note", { action: "add", category: "current_focus", content: "Searching the loft" });
    expect(stored(room, SCENE_TYPE, SCENE_ID)).toMatchObject({ name: "The mill", focus: "Searching the loft" });
    expect((await room.call(catalog, "kp_note", { action: "get", category: "current_scene" })).text).toBe("current_scene = The mill");
    await room.call(catalog, "kp_note", { action: "delete", category: "current_scene" });
    expect((await room.call(catalog, "kp_note", { action: "delete", category: "current_scene" })).code).toBe("unknown_category");
  });

  test("other categories are the Keeper's notebook, stamped with the game clock", async () => {
    const room = bench();
    const catalog = room.catalog();
    await room.call(catalog, "game_clock", { action: "set", value: "1926-03-15 14:00" });
    await room.call(catalog, "kp_note", { action: "add", category: "npc_status", content: "Martha is lying" });
    await room.call(catalog, "kp_note", { action: "add", category: "npc_status", content: "Bob fled" });
    await room.call(catalog, "kp_note", { action: "update", category: "npc_status", content: "Bob fled north" });
    const listed = await room.call(catalog, "kp_note", { action: "list", category: "npc_status" });
    expect(listed.text).toContain("1. [1926-03-15 14:00] Martha is lying");
    expect(listed.text).toContain("2. [1926-03-15 14:00] Bob fled north");
    await room.call(catalog, "kp_note", { action: "set", category: "plan", content: "The cult strikes at dawn" });
    expect((await room.call(catalog, "kp_note", { action: "get", category: "plan" })).text).toBe("plan = The cult strikes at dawn");
    expect(stored(room, KEEPER_NOTES_TYPE, KEEPER_NOTES_ID)).not.toBeNull();
    expect((await room.call(catalog, "kp_note", { action: "update", category: "nothing" })).code).toBe("unknown_category");
    expect((await room.call(catalog, "kp_note", { action: "frobnicate", category: "plan" })).code).toBe("unknown_action");
    expect((await room.call(catalog, "kp_note", { action: "add", category: "plan", content: "" })).code).toBe("bad_note");
  });

  test("npc_intents reads the actors' intents and cannot be written", async () => {
    const room = bench();
    const catalog = room.catalog();
    await room.call(catalog, "create_npc", { name: "Martha" });
    room.put(NPC_INTENTS_TYPE, NPC_INTENTS_ID, intentLogData({ intents: [{ npc: "martha", intent: "slip out the back", at: null }] }));
    const listed = await room.call(catalog, "kp_note", { action: "list", category: "npc_intents" });
    expect(listed.text).toContain("Martha intends: slip out the back");
    expect((await room.call(catalog, "kp_note", { action: "add", category: "npc_intents", content: "x" })).code).toBe("read_only_category");
  });
});

describe("game_clock", () => {
  test("sets, advances, schedules and lists", async () => {
    const room = bench();
    const catalog = room.catalog();
    expect((await room.call(catalog, "game_clock", {})).text).toContain("Current game time: not set");
    expect((await room.call(catalog, "game_clock", { action: "advance", value: "+1 hour" })).code).toBe("unset");
    await room.call(catalog, "game_clock", { action: "set", value: "1926-03-15 14:00" });
    const advanced = await room.call(catalog, "game_clock", { action: "advance", value: "+2 hours" });
    expect(advanced.text).toBe("Game time advanced by +2 hours; now: 1926-03-15 16:00");
    expect(advanced.bookkeeping.clockAdvances).toEqual([{ from: "1926-03-15 14:00", to: "1926-03-15 16:00", minutes: 120, moved: true }]);
    await room.call(catalog, "game_clock", { action: "add_event", value: "The train leaves" });
    expect((await room.call(catalog, "game_clock", { action: "list_events" })).text).toContain("1926-03-15 16:00: The train leaves");
    expect(stored(room, GAME_CLOCK_TYPE, GAME_CLOCK_ID)).toMatchObject({ now: "1926-03-15 16:00" });
    expect((await room.call(catalog, "game_clock", { action: "advance", value: "soonish" })).code).toBe("bad_delta");
  });

  test("a clock face the engine cannot move is kept, and the advance still recorded", async () => {
    const room = bench();
    const catalog = room.catalog();
    await room.call(catalog, "game_clock", { action: "set", value: "澹洲三百年六月初二 午时" });
    const advanced = await room.call(catalog, "game_clock", { action: "advance", value: "+2 hours" });
    expect(advanced.status).toBe("ok");
    expect(advanced.text).toContain("is not a format the engine can move");
    expect(advanced.bookkeeping.clockAdvances[0]?.moved).toBe(false);
  });
});
