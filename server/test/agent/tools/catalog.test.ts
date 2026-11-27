import { describe, expect, test } from "bun:test";

import {
  type ArgsOf,
  concurrencyGroups,
  FIXED_TOOLS,
  GATED_TOOLS,
  MAX_TOOL_RESULT_CHARS,
  mergeBookkeeping,
  normalizeToolInput,
  param,
  parametersSchema,
  subsystemTools,
  type TurnCatalog,
  TurnLedger,
} from "../../../src/agent/tools/index.ts";
import type { CommandInfo } from "../../../src/agent/modules.ts";
import { documentCatalog } from "../../../src/core/documents/raw.ts";
import { KEEPER_NOTES_ID, KEEPER_NOTES_TYPE } from "../../../src/core/notes/index.ts";
import { ROOM, bench, stored } from "./bench.ts";

/** The first-release list (§12 1.3), the gated four excepted. */
const ALWAYS_ON = [
  "roll_dice",
  "skill_check",
  "hp_manager",
  "initiative_tracker",
  "get_character_sheet",
  "list_party_sheets",
  "update_character_attribute",
  "update_character_status",
  "kp_note",
  "game_clock",
  "create_npc",
  "sketch_npc",
  "speak_as_npc",
  "get_npc",
  "list_npcs",
  "move_npc",
  "npc_learns",
  "set_npc_disposition",
  "record_chronicle",
  "update_thread",
  "query_lore",
  "set_variable",
  "adjust_variable",
  "set_stat",
  "adjust_stat",
  "get_stat",
];
const GATED = ["adjust_relationship", "set_relationship", "get_relationships", "generate_image"];
const MODULE = ["run_command", "lookup_command"];

const COMMAND: CommandInfo = { name: "rest", title: "Rest", description: "Take a rest.", params: { type: "object" }, forms: [], role: "player", keeper: true, danger: false, checksAvailability: false };

function names(catalog: TurnCatalog): string[] {
  return catalog.tools.map((tool) => tool.name);
}

describe("the tool declarations", () => {
  test("the fixed set is the first-release list", () => {
    expect(FIXED_TOOLS.map((tool) => tool.name).sort()).toEqual([...ALWAYS_ON, ...GATED, ...MODULE].sort());
    expect([...GATED_TOOLS].sort()).toEqual([...GATED].sort());
  });

  test("every schema closes its properties and describes every parameter; required follows presence", () => {
    const all = [...FIXED_TOOLS, ...subsystemTools(bench().pack("coc7")), ...subsystemTools(bench().pack("dnd5e"))];
    for (const tool of all) {
      const schema = parametersSchema(tool.params);
      expect(schema.additionalProperties).toBe(false);
      expect(tool.description.trim()).not.toBe("");
      for (const [name, property] of Object.entries(schema.properties)) {
        expect(property.description.trim(), `${tool.name}.${name}`).not.toBe("");
        expect(schema.required.includes(name)).toBe(tool.params[name]?.presence === "required");
      }
    }
  });

  test("the handler's argument type follows the declaration", () => {
    const params = { a: param.string("a"), b: param.integer("b").optional(), c: param.boolean("c").or(true) };
    // Compile-time: these assignments fail to type-check if the derivation drifts.
    const value: ArgsOf<typeof params> = { a: "x", b: undefined, c: false };
    const b: number | undefined = value.b;
    const c: boolean = value.c;
    expect([value.a, b, c]).toEqual(["x", undefined, false]);
    expect(parametersSchema(params)).toEqual({
      type: "object",
      properties: { a: { type: "string", description: "a" }, b: { type: "integer", description: "b" }, c: { type: "boolean", description: "c" } },
      required: ["a"],
      additionalProperties: false,
    });
  });

  test("the always-on schemas fit the old budget (21,000 characters)", () => {
    const room = bench();
    const catalog = room.catalog({ pack: null });
    const size = catalog.definitions().reduce((sum, definition) => sum + JSON.stringify(definition).length, 0);
    // Recorded: the 26 always-on tools, no subsystems, no module commands.
    expect(catalog.tools.length).toBe(26);
    console.log(`always-on tool schemas: ${size} characters`);
    expect(size).toBeLessThan(21_000);
    const coc = room.catalog().definitions().reduce((sum, definition) => sum + JSON.stringify(definition).length, 0);
    console.log(`with coc7 subsystems: ${coc} characters`);
  });
});

describe("the turn catalogue", () => {
  test("gated tools appear only when a skill unlocks them", () => {
    const room = bench();
    expect(names(room.catalog())).not.toContain("adjust_relationship");
    const unlocked = names(room.catalog({ unlocked: new Set(["adjust_relationship", "get_relationships"]) }));
    expect(unlocked).toContain("adjust_relationship");
    expect(unlocked).toContain("get_relationships");
    expect(unlocked).not.toContain("set_relationship");
  });

  test("the clock tool is withheld while a module owns the clock, and refused by name", async () => {
    const room = bench();
    const catalog = room.catalog({ keeperOwnsClock: false });
    expect(names(catalog)).not.toContain("game_clock");
    const outcome = await room.call(catalog, "game_clock", { action: "show" });
    expect(outcome.status).toBe("refused");
    expect(outcome.code).toBe("clock_owned_by_module");
  });

  test("the room pack's subsystems become tools", () => {
    const room = bench();
    expect(names(room.catalog({ pack: room.pack("coc7") }))).toEqual(expect.arrayContaining(["sanity_check", "skill_growth", "spend_luck", "opposed_check", "random_madness"]));
    expect(names(room.catalog({ pack: room.pack("dnd5e") }))).toContain("opposed_check");
    expect(names(room.catalog({ pack: room.pack("wod") })).length).toBe(26);
  });

  test("the module tools come with module commands", () => {
    const room = bench();
    expect(names(room.catalog())).not.toContain("run_command");
    expect(names(room.catalog({ commands: [{ module: "m", info: COMMAND }] }))).toEqual(expect.arrayContaining(MODULE));
  });

  test("the schemas sent and the tools dispatched are the same set", () => {
    const room = bench();
    const catalog = room.catalog({ unlocked: new Set(["generate_image"]) });
    expect(catalog.definitions().map((definition) => definition.name)).toEqual(names(catalog));
  });

  test("an uncatalogued call is refused, not thrown", async () => {
    const room = bench();
    const catalog = room.catalog();
    const unknown = await room.call(catalog, "summon_cthulhu", {});
    expect([unknown.status, unknown.code, unknown.text]).toEqual(["refused", "unknown_tool", "Unknown tool: summon_cthulhu"]);
    const locked = await room.call(catalog, "set_relationship", { subject: "a", target: "b", track: "affection", value: 1 });
    expect([locked.status, locked.code]).toEqual(["refused", "not_available"]);
  });

  test("bad arguments come back as a refusal naming the tool", async () => {
    const room = bench();
    const outcome = await room.call(room.catalog(), "kp_note", { action: "set", category: "x", value: "oops" });
    expect(outcome.status).toBe("refused");
    expect(outcome.text).toBe("Invalid arguments for tool kp_note: unknown argument 'value'; accepted parameters: action, category, content");
    const invalid = await room.catalog().dispatch(room.context(), { name: "roll_dice", input: { valid: false, raw: "{" } }, new TurnLedger());
    expect(invalid.code).toBe("bad_arguments");
  });

  test("a Keeper-only tool's outcome is flagged", async () => {
    const room = bench();
    const catalog = room.catalog();
    await room.call(catalog, "create_npc", { name: "Martha", secret_agenda: "SECRET-MARKER" });
    const read = await room.call(catalog, "get_npc", { npc: "Martha" });
    expect(read.keeperOnly).toBe(true);
    expect(read.text).toContain("SECRET-MARKER");
    expect((await room.call(catalog, "list_npcs", {})).keeperOnly).toBe(true);
    expect((await room.call(catalog, "roll_dice", { expression: "1d6" })).keeperOnly).toBe(false);
  });

  test("a result over the cap is cut, and the cut is announced", async () => {
    const room = bench();
    const catalog = room.catalog();
    for (let index = 0; index < 20; index++) await room.call(catalog, "kp_note", { action: "add", category: "log", content: "x".repeat(900) });
    const listed = await room.call(catalog, "kp_note", { action: "list", category: "log" });
    expect(listed.truncated).toBe(true);
    expect(Array.from(listed.text.split("\n\n[…truncated")[0] as string).length).toBe(MAX_TOOL_RESULT_CHARS);
    expect(listed.text).toContain(`only the first ${MAX_TOOL_RESULT_CHARS} characters`);
    const short = await room.call(catalog, "kp_note", { action: "get", category: "log" });
    expect(short.truncated).toBe(true);
  });

  test("a stale writer after undo or reset is refused, never a crash", async () => {
    const room = bench();
    const first = room.writer();
    room.addCharacter("ada", "Ada");
    const second = room.writer();
    const catalog = room.catalog();
    room.store.undoTo(ROOM, first.turn);
    const stale = room.context({ writer: second });
    const write = await room.call(catalog, "kp_note", { action: "add", category: "log", content: "late" }, { context: stale });
    expect([write.status, write.code]).toEqual(["refused", "stale_room"]);
    const read = await room.call(catalog, "get_character_sheet", {}, { context: stale });
    expect(read.code).toBe("stale_room");
    expect(stored(room, KEEPER_NOTES_TYPE, KEEPER_NOTES_ID)).toBeNull();

    // A suspending tool whose room is rewound while it waits: refused at its commit.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const live = room.writer();
    await room.call(room.catalog(), "create_npc", { name: "Martha" }, { context: room.context({ writer: live }) });
    const voicing = room.catalog({
      deps: {
        voiceNpc: async () => {
          await gate;
          return { ok: true, line: "Hello.", intent: "flee", mood: "calm" };
        },
      },
    });
    const pending = room.call(voicing, "speak_as_npc", { npc: "Martha", situation: "x" }, { context: room.context({ writer: live }) });
    room.store.reset(ROOM, "story", documentCatalog(room.services.types));
    release();
    const outcome = await pending;
    expect([outcome.status, outcome.code]).toEqual(["refused", "stale_room"]);
  });

  test("a repeated initiative next within one turn is suppressed", async () => {
    const room = bench();
    const catalog = room.catalog();
    const ledger = new TurnLedger();
    await room.call(catalog, "initiative_tracker", { action: "add", name: "Ghoul", initiative: 40 }, { ledger });
    await room.call(catalog, "initiative_tracker", { action: "add", name: "Bob", initiative: 60 }, { ledger });
    const first = await room.call(catalog, "initiative_tracker", { action: "next" }, { ledger });
    expect(first.status).toBe("ok");
    const second = await room.call(catalog, "initiative_tracker", { action: "next" }, { ledger });
    expect(second.status).toBe("suppressed");
    expect(second.text).toContain("duplicate next suppressed");
    // A new turn may advance again.
    expect((await room.call(catalog, "initiative_tracker", { action: "next" }, { ledger: new TurnLedger() })).status).toBe("ok");
  });

  test("provider sentinels on skill_check are dropped before decoding", () => {
    const cleaned = normalizeToolInput("skill_check", { valid: true, value: { skill_name: "侦查", actor: " ", npc_target: 0 } });
    expect(cleaned).toEqual({ valid: true, value: { skill_name: "侦查" } });
    const kept = normalizeToolInput("skill_check", { valid: true, value: { skill_name: "x", actor: "Ghoul", npc_target: 0 } });
    expect(kept).toEqual({ valid: true, value: { skill_name: "x", actor: "Ghoul", npc_target: 0 } });
    expect(normalizeToolInput("roll_dice", { valid: true, value: { actor: "" } })).toEqual({ valid: true, value: { actor: "" } });
  });

  test("bookkeeping is gathered in call order", async () => {
    const room = bench();
    const catalog = room.catalog();
    const outcomes = [
      await room.call(catalog, "roll_dice", { expression: "1d6" }),
      await room.call(catalog, "game_clock", { action: "set", value: "1926-03-15 14:00" }),
      await room.call(catalog, "game_clock", { action: "advance", value: "+2 hours" }),
    ];
    const merged = mergeBookkeeping(outcomes);
    expect(merged.diceTools).toEqual(["roll_dice"]);
    expect(merged.clockAdvances.length).toBe(1);
  });
});

describe("grouping one round's calls", () => {
  const room = bench();
  const catalog = room.catalog();
  const call = (name: string, value: Record<string, unknown> = {}) => ({ name, input: { valid: true as const, value } });

  test("different NPCs and readers overlap; the same NPC and writers do not", () => {
    const calls = [
      call("speak_as_npc", { npc: "Martha", situation: "a" }),
      call("speak_as_npc", { npc: "Bob", situation: "b" }),
      call("query_lore", { query: "mill" }),
      call("speak_as_npc", { npc: "martha ", situation: "c" }),
      call("kp_note", { action: "add", category: "x", content: "y" }),
      call("get_npc", { npc: "Bob" }),
      call("speak_as_npc", { npc: "", situation: "d" }),
      call("nonexistent"),
    ];
    expect(concurrencyGroups(catalog, calls)).toEqual([[0, 1, 2], [3], [4], [5], [6], [7]]);
  });

  test("an empty round has no groups; a lone call is one group", () => {
    expect(concurrencyGroups(catalog, [])).toEqual([]);
    expect(concurrencyGroups(catalog, [call("roll_dice", { expression: "1d6" })])).toEqual([[0]]);
  });

  test("an unreadable call is a barrier", () => {
    const calls = [call("get_npc", { npc: "a" }), { name: "speak_as_npc", input: { valid: false as const, raw: "{" } }, call("get_npc", { npc: "b" })];
    expect(concurrencyGroups(catalog, calls)).toEqual([[0], [1], [2]]);
  });
});
