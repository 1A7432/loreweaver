// The Keeper's sheet tools for a member seated on a module's character: no sheet exists, so
// they answer with the character's name, its resources and the module that keeps it.
import { expect, test } from "bun:test";

import type { Who } from "loreweaver/module";

import type { ModuleCharacter } from "../../../src/core/characters/index.ts";
import { seatingData, SEATING_ID, SEATING_TYPE } from "../../../src/core/characters/index.ts";
import { assembleKeeperPrompt } from "../../../src/agent/prompt/index.ts";
import { readKeeperSnapshot } from "../../../src/agent/turn/reader.ts";
import { bench } from "./bench.ts";

const SETTLER: Who = { member: { id: "m-ada", name: "Ada", role: "player" }, character: { id: "colony:ana", name: "Ana" } };
const OFFERED: readonly ModuleCharacter[] = [
  { module: "colony", id: "ana", name: "Ana", blurb: null, resources: [{ id: "hp", label: "HP", value: 4, max: 5 }, { id: "food", label: "Food", value: 2, max: null }], status: ["wounded"] },
];

function room() {
  const b = bench();
  b.addCharacter("bob", "Bob", { owner: "m-bao" });
  b.put(SEATING_TYPE, SEATING_ID, seatingData({ seats: [{ member: "m-bao", character: "bob", memberName: "Bao" }, { member: "m-ada", character: "colony:ana", memberName: "Ada" }] }));
  return { b, context: { ...b.context({ who: SETTLER }), moduleCharacters: OFFERED } };
}

test("get_character_sheet answers the name, the resources and the module that keeps the character", async () => {
  const { b, context } = room();
  const read = await b.call(b.catalog(), "get_character_sheet", {}, { context });
  expect(read.status).toBe("ok");
  expect(read.text).toBe(["Character: Ana — kept by module colony; the engine holds no sheet for it.", "Resources:", "  HP: 4/5", "  Food: 2"].join("\n"));
  // Until a render has listed it, the seat still answers, by its id.
  const unlisted = await b.call(b.catalog(), "get_character_sheet", {}, { context: { ...context, moduleCharacters: [] } });
  expect(unlisted.text).toContain("Character: colony:ana — kept by module colony");
  expect(unlisted.text).toContain("does not list this character now");
});

test("list_party_sheets lists the module's character beside the engine's", async () => {
  const { b, context } = room();
  const party = await b.call(b.catalog(), "list_party_sheets", {}, { context });
  expect(party.status).toBe("ok");
  expect(party.text).toContain("Party sheets (2):");
  expect(party.text).toContain("— Bob (coc7)");
  expect(party.text).toContain("— Character: Ana — kept by module colony");
  expect(party.text).toContain("  HP: 4/5");
});

test("a tool that would read or change the sheet says what the character is and whose, and changes nothing", async () => {
  const { b, context } = room();
  for (const [name, args] of [
    ["update_character_attribute", { attribute: "STR", value: 60 }],
    ["update_character_status", { status_effects: '["Afraid"]' }],
    ["skill_check", { skill_name: "Spot Hidden" }],
    ["initiative_tracker", { action: "add" }],
  ] as const) {
    const answer = await b.call(b.catalog(), name, args, { context });
    expect([name, answer.status, answer.code]).toEqual([name, "refused", "module_character"]);
    expect(answer.text).toContain("kept by module colony");
    expect(answer.text).toContain("HP: 4/5");
  }
});

test("the Keeper's state panel lists a member seated on a module's character: its name and the module's meters", () => {
  const { context } = room();
  const snapshot = readKeeperSnapshot(context, {
    pack: null,
    skills: [],
    moduleCommands: [],
    lore: "",
    whispers: [],
    playerActions: [],
    injections: [],
    recalled: [],
    history: [],
    speaker: "Ada",
    line: "I look around.",
    moduleClock: null,
    macros: {},
  });
  // Both seats are at the table: the engine's character, and the module's with a meter that has no maximum.
  expect(snapshot.party.map((member) => member.name)).toEqual(["Bob", "Ana"]);
  expect(snapshot.party[1]).toEqual({ name: "Ana", resources: [{ label: "HP", value: 4, max: 5 }, { label: "Food", value: 2, max: null }], status: ["wounded"] });
  const prompt = assembleKeeperPrompt(snapshot);
  expect(`${prompt.stable}\n${prompt.volatile}`).toContain("HP 4/5 | Food 2");
  expect(`${prompt.stable}\n${prompt.volatile}`).toContain("wounded");
  // A seat on a character no module lists now is not invented into the panel.
  expect(readKeeperSnapshot({ ...context, moduleCharacters: [] }, { pack: null, skills: [], moduleCommands: [], lore: "", whispers: [], playerActions: [], injections: [], recalled: [], history: [], speaker: "Ada", line: "x", moduleClock: null, macros: {} }).party.map((member) => member.name)).toEqual(["Bob"]);
});
