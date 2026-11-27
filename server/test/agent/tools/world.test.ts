import { describe, expect, test } from "bun:test";

import type { CommandInfo, CommandOutcome } from "../../../src/agent/modules.ts";
import { type RunCommandRequest, queryLore } from "../../../src/agent/tools/index.ts";
import { CHRONICLE_RECORD_TYPE, PLOT_THREAD_TYPE, plotThreadId } from "../../../src/core/chronicle/index.ts";
import {
  EMPTY_OVERLAY,
  LORE_ENTRY_TYPE,
  LORE_OVERLAY_ID,
  LORE_OVERLAY_TYPE,
  loreEntryDocument,
  mergeSetupItems,
  newLoreEntry,
  overlayData,
  readOverlay,
  switchLore,
  type LoreEntryInput,
} from "../../../src/core/lore/index.ts";
import { RELATIONSHIPS_ID, RELATIONSHIPS_TYPE } from "../../../src/core/relationships/index.ts";
import {
  buildSpec,
  defineVariable,
  EMPTY_MODULE_VARIABLES,
  fromPlain,
  moduleVariablesPayload,
  MODULE_VARIABLES_ID,
  MODULE_VARIABLES_TYPE,
  type VarMap,
  variableTreeData,
  VARIABLE_TREE_ID,
  VARIABLE_TREE_TYPE,
} from "../../../src/core/variables/index.ts";
import { bench, stored } from "./bench.ts";

describe("chronicle tools", () => {
  test("record_chronicle stamps the engine's turn and numbers records", async () => {
    const room = bench();
    const catalog = room.catalog();
    const context = room.context();
    const first = await room.call(catalog, "record_chronicle", { text: "The mill burned.", keeper_notes: "The priest lit it.", pcs: "Ada, Bao,", scene: "Mill" }, { context });
    expect(first.text).toBe(`Chronicle entry c000001 recorded (turn ${context.turn}).`);
    expect(stored(room, CHRONICLE_RECORD_TYPE, "c000001")).toMatchObject({ turn: context.turn, characters: ["Ada", "Bao"], keeper: "The priest lit it.", folded: false });
    expect((await room.call(catalog, "record_chronicle", { text: "Bob fled." }, { context })).text).toContain("c000002");
    expect((await room.call(catalog, "record_chronicle", { text: "  " }, { context })).status).toBe("refused");
  });

  test("update_thread opens, keeps notes when omitted, resolves; a bad status is refused", async () => {
    const room = bench();
    const catalog = room.catalog();
    expect((await room.call(catalog, "update_thread", { label: "The missing son", notes: "He is in the crypt" })).text).toBe('Thread "The missing son" is now open.');
    await room.call(catalog, "update_thread", { label: "the missing son ", status: "Resolved" });
    expect(stored(room, PLOT_THREAD_TYPE, plotThreadId("The missing son"))).toEqual({ label: "The missing son", status: "resolved", notes: "He is in the crypt" });
    expect((await room.call(catalog, "update_thread", { label: "x", status: "closed" })).code).toBe("bad_status");
  });
});

function addLore(room: ReturnType<typeof bench>, id: string, input: LoreEntryInput): void {
  const made = newLoreEntry(input, 0);
  if (!made.ok) throw new Error(made.code);
  const document = loreEntryDocument(made.data);
  room.put(LORE_ENTRY_TYPE, id, document.data, document.meta);
}

describe("query_lore", () => {
  test("finds entries by keyword at Keeper grade, flags the result, and merges semantic hits", async () => {
    const room = bench();
    addLore(room, "e1", { title: "The Mill", content: "The mill burned in 1925.", keys: ["mill"], category: "location" });
    addLore(room, "e2", { title: "The Cult", content: "CULT-SECRET-MARKER", keys: ["cult"], secret: true });
    addLore(room, "e3", { title: "Premise", content: "Always on.", constant: true });
    addLore(room, "e4", { title: "Chance", content: "Rarely injected.", keys: ["mill"], probability: 1 });
    addLore(room, "e5", { title: "Gated", content: "Only when afraid.", keys: ["mill"], condition: "fear > 5" });
    const catalog = room.catalog({ deps: { recallLore: async (_room, query) => (query.includes("worship") ? ["e2", "e1", "nope"] : []) } });
    const found = await room.call(catalog, "query_lore", { query: "what about the mill?" });
    expect(found.keeperOnly).toBe(true);
    expect(found.text).toContain("- [location] The Mill: The mill burned in 1925.");
    // A browse ignores chance and conditions, and does not select always-on entries.
    expect(found.text).toContain("Rarely injected.");
    expect(found.text).toContain("Only when afraid.");
    expect(found.text).not.toContain("Always on.");
    const semantic = await room.call(catalog, "query_lore", { query: "who do they worship" });
    expect(semantic.text).toContain("The Cult (secret): CULT-SECRET-MARKER");
    expect((await room.call(catalog, "query_lore", { query: "nothing here" })).text).toBe('No lore matches "nothing here".');
  });

  test("an entry the admin switched off never comes back", () => {
    const room = bench();
    addLore(room, "e1", { title: "The Mill", content: "Burned.", keys: ["mill"] });
    const off = switchLore(EMPTY_OVERLAY, "The Mill", false);
    if (!off.ok) throw new Error(off.code);
    room.put(LORE_OVERLAY_TYPE, LORE_OVERLAY_ID, overlayData(off.data));
    expect(queryLore(room.context(), "mill", ["e1"])).toEqual([]);
  });
});

describe("module variables", () => {
  function declare(room: ReturnType<typeof bench>): void {
    const spec = buildSpec({ id: "town_fear", kind: "number", minimum: 0, maximum: 10, labels: { en: "Town Fear" } });
    if (!spec.ok) throw new Error(spec.problem);
    room.put(MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID, moduleVariablesPayload(defineVariable(EMPTY_MODULE_VARIABLES, spec.spec).state));
  }

  test("set and adjust validate, clamp, store and record the write", async () => {
    const room = bench();
    declare(room);
    const setup = mergeSetupItems(EMPTY_OVERLAY, [{ path: "town_fear", options: ["3", "7"], labels: [], done: false }]);
    if (!setup.ok) throw new Error(setup.code);
    room.put(LORE_OVERLAY_TYPE, LORE_OVERLAY_ID, overlayData(setup.data));
    const catalog = room.catalog();
    const set = await room.call(catalog, "set_variable", { var_id: "Town Fear", value: "7" });
    expect(set.text).toBe("Town Fear [town_fear]: 0 → 7.");
    expect(set.bookkeeping.variableWrites).toEqual([{ path: "town_fear", op: "set" }]);
    const adjusted = await room.call(catalog, "adjust_variable", { var_id: "town_fear", delta: 9 });
    expect(adjusted.text).toBe("Town Fear [town_fear]: 7 → 10 (change: 9).");
    expect(adjusted.bookkeeping.variableWrites).toEqual([{ path: "town_fear", op: "add" }]);
    expect(JSON.stringify(stored(room, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID))).toContain('"value":10');
    // The pending "set before play" choice on this variable is now made.
    expect(readOverlay(stored(room, LORE_OVERLAY_TYPE, LORE_OVERLAY_ID) ?? {}).setup[0]?.done).toBe(true);
  });

  test("refuses an unknown variable, a bad value, and a room with none", async () => {
    const room = bench();
    expect((await room.call(room.catalog(), "set_variable", { var_id: "x", value: "1" })).code).toBe("no_variables");
    declare(room);
    expect((await room.call(room.catalog(), "set_variable", { var_id: "suspicion", value: "1" })).code).toBe("unknown_variable");
    const bad = await room.call(room.catalog(), "set_variable", { var_id: "town_fear", value: "lots" });
    expect([bad.status, bad.code, bad.bookkeeping.variableWrites]).toEqual(["refused", "not_a_number", []]);
  });
});

describe("the imported variable tree", () => {
  function seed(room: ReturnType<typeof bench>): void {
    const tree = fromPlain({ 理: { 好感度: 10, 情绪状态: { pleasure: 0.1 }, 地点: ["教堂", "location"] } }) as VarMap;
    room.put(VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, variableTreeData(tree, []));
  }

  test("set_stat, adjust_stat and get_stat go through the update protocol", async () => {
    const room = bench();
    seed(room);
    const catalog = room.catalog();
    expect((await room.call(catalog, "set_stat", { path: "理.情绪状态.pleasure", value: "0.4" })).text).toBe("理.情绪状态.pleasure: 0.1 → 0.4.");
    expect((await room.call(catalog, "set_stat", { path: "理.地点", value: "酒馆" })).text).toBe("理.地点: 教堂 → 酒馆.");
    const added = await room.call(catalog, "adjust_stat", { path: "理.好感度", delta: 2.5 });
    expect(added.text).toBe("理.好感度: 10 → 12.5 (change: 2.5).");
    expect(added.bookkeeping.variableWrites).toEqual([{ path: "理.好感度", op: "add" }]);
    // A new leaf under an existing parent, as the reference tool allowed.
    expect((await room.call(catalog, "set_stat", { path: "理.情绪状态.arousal", value: "0.2" })).status).toBe("ok");
    expect((await room.call(catalog, "get_stat", { path: "理.情绪状态.arousal" })).text).toBe("理.情绪状态.arousal = 0.2");
    const all = await room.call(catalog, "get_stat", {});
    expect(all.text).toContain("- 理.好感度 = 12.5");
  });

  test("refuses a missing parent, a non-number target, and a room without a tree", async () => {
    const room = bench();
    expect((await room.call(room.catalog(), "get_stat", {})).code).toBe("no_variable_tree");
    seed(room);
    expect((await room.call(room.catalog(), "set_stat", { path: "无.此.路径", value: "1" })).status).toBe("refused");
    expect((await room.call(room.catalog(), "adjust_stat", { path: "理.地点", delta: 1 })).code).toBe("unsupported_target");
    expect((await room.call(room.catalog(), "get_stat", { path: "理.nothing" })).text).toBe('No variable at path "理.nothing".');
  });
});

describe("relationship tracks (gated)", () => {
  test("adjust, set and read back, bounded by the track", async () => {
    const room = bench();
    const catalog = room.catalog({ unlocked: new Set(["adjust_relationship", "set_relationship", "get_relationships"]) });
    expect((await room.call(catalog, "adjust_relationship", { subject: "Martha", target: "Ada", track: "Affection", delta: 15 })).text).toBe("Martha → Ada affection: 0 → 15 (change: 15).");
    expect((await room.call(catalog, "set_relationship", { subject: "Martha", target: "Ada", track: "desire", value: 400 })).text).toBe("Martha → Ada desire set to 100.");
    await room.call(catalog, "adjust_relationship", { subject: "Bob", target: "Bao", track: "affection", delta: -5 });
    expect((await room.call(catalog, "get_relationships", { entity: "ada" })).text).toBe("Current relationships:\n- Martha → Ada: affection 15, desire 100");
    expect(stored(room, RELATIONSHIPS_TYPE, RELATIONSHIPS_ID)).not.toBeNull();
    expect((await room.call(catalog, "adjust_relationship", { subject: "A", target: "B", track: "love", delta: 1 })).code).toBe("unknown_track");
    expect((await room.call(catalog, "get_relationships", { entity: "nobody" })).text).toBe("No relationship tracks recorded yet.");
  });
});

describe("generate_image (gated)", () => {
  test("asks the injected lane and shows the stored image to the table", async () => {
    const room = bench();
    const media = { hash: "a".repeat(64), mime: "image/png", size: 10, name: "scene-mill.png", from: "server" };
    const requests: unknown[] = [];
    const catalog = room.catalog({
      unlocked: new Set(["generate_image"]),
      deps: {
        generateImage: async (request) => {
          requests.push(request);
          return { ok: true, media };
        },
      },
    });
    const sent = await room.call(catalog, "generate_image", { prompt: "A burned mill at dusk", kind: "poster", caption: "The mill" });
    expect(sent.text).toBe("Image sent: scene-mill.png (aaaaaaaaaaaa). Caption to narrate: The mill");
    expect(sent.events).toEqual([{ kind: "media", data: media }]);
    expect(requests[0]).toMatchObject({ prompt: "A burned mill at dusk", kind: "scene", caption: "The mill" });
  });

  test("a limit or a missing lane is a refusal", async () => {
    const room = bench();
    const unlocked = new Set(["generate_image"]);
    expect((await room.call(room.catalog({ unlocked }), "generate_image", { prompt: "x" })).code).toBe("not_configured");
    const limited = room.catalog({ unlocked, deps: { generateImage: async () => ({ ok: false, code: "rate_limited" }) } });
    expect((await room.call(limited, "generate_image", { prompt: "x" })).code).toBe("rate_limited");
  });
});

describe("module commands", () => {
  const rest: CommandInfo = { name: "rest", title: "Rest", description: "Take a long rest.", params: { type: "object", properties: { hours: { type: "integer" } } }, text: [], role: "player", danger: false, checksAvailability: true };
  const ok: CommandOutcome = { status: "ok", result: { text: "You rest for 8 hours.", data: null }, problems: [], facts: [], writes: [], blocks: [], rolls: [], logs: [] };

  test("lookup_command describes a command; run_command runs it through the injected worker call", async () => {
    const room = bench();
    const calls: RunCommandRequest[] = [];
    const catalog = room.catalog({
      commands: [{ module: "camp", info: rest }],
      deps: {
        runCommand: async (request) => {
          calls.push(request);
          return ok;
        },
      },
    });
    const looked = await room.call(catalog, "lookup_command", { id: "camp/rest" });
    expect(looked.text).toContain("Command camp/rest: Rest");
    expect(looked.text).toContain('"hours"');
    const ran = await room.call(catalog, "run_command", { id: "rest", args: { hours: 8 } });
    expect(ran.text).toBe("camp/rest: You rest for 8 hours.");
    expect(calls).toEqual([{ module: "camp", command: "rest", args: { hours: 8 } }]);
    expect(ran.bookkeeping.moduleCommand).toEqual({ module: "camp", command: "rest", outcome: ok });
  });

  test("an unknown command, a refusal and a failure come back as text", async () => {
    const room = bench();
    const refusing = room.catalog({ commands: [{ module: "camp", info: rest }], deps: { runCommand: async () => ({ status: "refused", reason: "unavailable", text: "Not while enemies are near.", problems: [] }) } });
    expect((await room.call(refusing, "run_command", { id: "camp/sleep" })).code).toBe("unknown_command");
    expect((await room.call(refusing, "lookup_command", { id: "nope" })).code).toBe("unknown_command");
    const refused = await room.call(refusing, "run_command", { id: "camp/rest" });
    expect([refused.status, refused.text]).toEqual(["refused", "camp/rest refused: the module says it is unavailable now: Not while enemies are near."]);
    const failing = room.catalog({ commands: [{ module: "camp", info: rest }], deps: { runCommand: async () => ({ status: "failed", problems: ["boom"] }) } });
    const failed = await room.call(failing, "run_command", { id: "camp/rest" });
    expect(failed.status).toBe("failed");
    expect(failed.text).not.toContain("boom");
  });
});
