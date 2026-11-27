import { describe, expect, test } from "bun:test";

import type { VoiceNpcRequest } from "../../../src/agent/tools/index.ts";
import { NPC_INTENTS_ID, NPC_INTENTS_TYPE } from "../../../src/core/notes/index.ts";
import { NPC_TYPE } from "../../../src/core/npcs/index.ts";
import { bench, stored } from "./bench.ts";

describe("NPC records", () => {
  test("create_npc seeds the whole record; re-creating a name leaves it untouched", async () => {
    const room = bench();
    const catalog = room.catalog();
    const made = await room.call(catalog, "create_npc", {
      name: "Martha Kane",
      persona: "A widow who runs the inn",
      description: "Grey-haired innkeeper",
      secret_agenda: "Hides her son",
      knowledge: "the mill burned, her son is alive\nthe priest lies",
      location: "The inn",
    });
    expect(made.text).toBe('Created NPC "Martha Kane" (id: martha-kane).');
    expect(stored(room, NPC_TYPE, "martha-kane")).toMatchObject({
      persona: "A widow who runs the inn",
      publicDescription: "Grey-haired innkeeper",
      secretAgenda: "Hides her son",
      knowledge: ["the mill burned", "her son is alive", "the priest lies"],
      disposition: "neutral",
      location: "The inn",
      locationKnown: true,
      major: true,
    });
    const again = await room.call(catalog, "create_npc", { name: "martha kane", persona: "someone else" });
    expect(again.text).toContain("already exists");
    expect(stored(room, NPC_TYPE, "martha-kane")?.persona).toBe("A widow who runs the inn");
  });

  test("names slugging alike get distinct ids; CJK names keep theirs", async () => {
    const room = bench();
    const catalog = room.catalog();
    await room.call(catalog, "sketch_npc", { name: "Bob!", one_line: "a dock worker" });
    expect((await room.call(catalog, "sketch_npc", { name: "Bob?", one_line: "another" })).text).toContain("(id: bob-2)");
    expect((await room.call(catalog, "sketch_npc", { name: "老周", one_line: "掌柜" })).text).toContain("(id: 老周)");
  });

  test("a player character's name is never an NPC, and caps are refusals", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    const catalog = room.catalog();
    expect((await room.call(catalog, "create_npc", { name: "ada" })).code).toBe("name_is_player");
    expect((await room.call(catalog, "create_npc", { name: "Long", persona: "x".repeat(2001) })).code).toBe("bad_persona");
    expect((await room.call(catalog, "sketch_npc", { name: "!!!", one_line: "nobody" })).code).toBe("bad_name");
  });

  test("learn, move and disposition change the record; an unknown NPC is refused", async () => {
    const room = bench();
    const catalog = room.catalog();
    await room.call(catalog, "create_npc", { name: "Martha" });
    expect((await room.call(catalog, "npc_learns", { npc: "martha", fact: "The key is under the mat" })).text).toBe("Martha learned: The key is under the mat");
    expect((await room.call(catalog, "move_npc", { npc: "Mart", location: "The cellar" })).text).toBe("Martha moved to: The cellar");
    expect((await room.call(catalog, "set_npc_disposition", { npc: "martha", disposition: "friendly but wary" })).text).toBe("Martha's disposition is now: friendly but wary");
    expect(stored(room, NPC_TYPE, "martha")).toMatchObject({ knowledge: ["The key is under the mat"], location: "The cellar", disposition: "friendly but wary" });
    expect((await room.call(catalog, "npc_learns", { npc: "Nobody", fact: "x" })).code).toBe("npc_not_found");
    expect((await room.call(catalog, "set_npc_disposition", { npc: "Martha", disposition: "x".repeat(401) })).code).toBe("bad_disposition");
  });

  test("get_npc and list_npcs show the secrets, flagged Keeper-only", async () => {
    const room = bench();
    const catalog = room.catalog();
    await room.call(catalog, "create_npc", { name: "Martha", secret_agenda: "SECRET-MARKER", knowledge: "KNOWLEDGE-MARKER" });
    const one = await room.call(catalog, "get_npc", { npc: "Martha" });
    expect(one.keeperOnly).toBe(true);
    expect(one.text).toStartWith("[KEEPER-ONLY");
    expect(one.text).toContain("SECRET-MARKER");
    expect(one.text).toContain("KNOWLEDGE-MARKER");
    const all = await room.call(catalog, "list_npcs", {});
    expect(all.text).toContain("- Martha [martha]");
    expect((await room.call(catalog, "get_npc", { npc: "Nobody" })).code).toBe("npc_not_found");
  });
});

describe("speak_as_npc", () => {
  test("hands the actor this NPC's own document; the line is an event, the intent Keeper-only", async () => {
    const room = bench();
    const seen: VoiceNpcRequest[] = [];
    const catalog = room.catalog({
      deps: {
        voiceNpc: async (request) => {
          seen.push(request);
          return { ok: true, line: "Welcome, travellers.", intent: "Send her son away tonight", mood: "nervous" };
        },
      },
    });
    await room.call(catalog, "create_npc", { name: "Martha", secret_agenda: "Hides her son" });
    await room.call(catalog, "create_npc", { name: "Bob", secret_agenda: "OTHER-SECRET" });
    const spoken = await room.call(catalog, "speak_as_npc", { npc: "Martha", situation: "Strangers walk in", effort: "HIGH", tone: "wary" });
    expect(spoken.status).toBe("ok");
    expect(spoken.text).toBe(
      'Martha (nervous): "Welcome, travellers."\n(Their private intent was filed to your npc_intents notes: kp_note(\'list\', \'npc_intents\').)\n' +
        "(The table has already read this as Martha's own message. Do not repeat its words in your narration.)",
    );
    expect(spoken.events).toEqual([{ kind: "narrative", data: { speaker: "npc", name: "Martha", text: "Welcome, travellers.", format: "plain" } }]);
    expect(JSON.stringify(spoken.events)).not.toContain("son away");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ npc: "martha", situation: "Strangers walk in", tone: "wary", effort: "high", allowedActions: "", target: "" });
    expect(seen[0]?.document.id).toBe("martha");
    expect(JSON.stringify(seen[0])).not.toContain("OTHER-SECRET");
    expect(stored(room, NPC_INTENTS_TYPE, NPC_INTENTS_ID)).toMatchObject({ intents: [{ npc: "martha", intent: "Send her son away tonight" }] });
  });

  test("a failed actor, an unknown NPC or a missing lane is never spoken", async () => {
    const room = bench();
    const failing = room.catalog({ deps: { voiceNpc: async () => ({ ok: false, code: "model_failed" }) } });
    await room.call(failing, "create_npc", { name: "Martha" });
    const failed = await room.call(failing, "speak_as_npc", { npc: "Martha", situation: "x" });
    expect([failed.status, failed.code, failed.events]).toEqual(["failed", "model_failed", []]);
    expect((await room.call(failing, "speak_as_npc", { npc: "Nobody", situation: "x" })).code).toBe("npc_not_found");
    expect((await room.call(room.catalog(), "speak_as_npc", { npc: "Martha", situation: "x" })).code).toBe("npc_actor_unavailable");
    const thrown = room.catalog({
      deps: {
        voiceNpc: async () => {
          throw new Error("socket hang up");
        },
      },
    });
    const crashed = await room.call(thrown, "speak_as_npc", { npc: "Martha", situation: "x" });
    expect([crashed.status, crashed.events]).toEqual(["failed", []]);
  });
});
