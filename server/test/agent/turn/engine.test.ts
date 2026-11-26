import { describe, expect, test } from "bun:test";

import { PENDING_FACTS, NARRATE_NOW, type PendingFact } from "../../../src/agent/effects.ts";
import { WHISPERS_KEY } from "../../../src/agent/lanes/scribe.ts";
import { CONTEXT_READING, FACTS_TURN_LINE, OPENING_NOTE, PLAYER_ACTIONS, recordPlayerAction } from "../../../src/agent/turn/index.ts";
import { turnText } from "../../../src/agent/turn/catalog.ts";
import { worldCardData, worldCardId, WORLD_CARD_TYPE } from "../../../src/core/card/index.ts";
import { documentCatalog } from "../../../src/core/documents/raw.ts";
import { createNpc, npcData, NPC_TYPE } from "../../../src/core/npcs/index.ts";
import { LLMError, toolCall } from "../../../src/infra/llm/index.ts";
import { WorkerTimeout } from "../../../src/infra/room_worker.ts";
import { addLore, putTree } from "../room_fixture.ts";
import { fact, fakeLoreWorker, fakeWorker, Harness, promptText, ROOM } from "./harness.ts";

function addNpc(h: Harness, id: string, name: string, secret: string): void {
  const made = createNpc({ name, persona: `${name} is a dockhand.`, secretAgenda: secret });
  if (!made.ok) throw new Error(made.code);
  h.put(NPC_TYPE, id, npcData(made.data));
}

function narratives(events: readonly { kind: string; data: Record<string, unknown> }[], speaker: string): string[] {
  return events.filter((event) => event.kind === "narrative" && event.data.speaker === speaker).map((event) => String(event.data.text));
}

describe("a plain turn", () => {
  test("streams a draft, publishes the reply under the turn with the draft's id, returns usage", async () => {
    const h = new Harness();
    h.keeper.script([{ content: "The door creaks open onto a dark stair.", usage: { inputTokens: 1200, outputTokens: 40 } }]);
    const ran = await h.turn("I open the door.");
    expect(ran.result.status).toBe("replied");
    expect(ran.result.reply).toBe("The door creaks open onto a dark stair.");
    const reply = ran.events.at(-1);
    expect(reply).toMatchObject({ kind: "narrative", turn: ran.writer.turn, data: { speaker: "kp", format: "markdown" } });
    expect(reply?.id).toBe(ran.result.replyId as string);
    const drafts = ran.signals.filter((signal) => signal.kind === "draft");
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((draft) => draft.data.id === ran.result.replyId)).toBe(true);
    expect(drafts.map((draft) => draft.data.text).join("")).toBe("The door creaks open onto a dark stair.");
    expect(ran.result.usage).toMatchObject({ inputTokens: 1200, outputTokens: 40 });
    expect(ran.result.usageEstimated).toBe(false);
    expect(h.store.stateGet(ROOM, CONTEXT_READING)).toMatchObject({ turn: ran.writer.turn, tokens: 1200, estimated: false });
    expect(ran.signals[0]).toMatchObject({ kind: "turn", data: { status: "busy", actor: "Ada" } });
    // The prompt: a cached head, the state message, the player's tagged line.
    const sent = h.keeper.requests[0];
    expect(sent?.messages[0]).toMatchObject({ role: "system", cacheBreakpoint: true });
    expect(sent?.messages.at(-1)?.content).toContain("I open the door.");
    expect(sent?.options.toolChoice).toBe("auto");
  });

  test("a provider that reports no usage gets an estimate, marked as one", async () => {
    const h = new Harness();
    h.keeper.script(["Fine."]);
    const ran = await h.turn("Hello.");
    expect(ran.result.usageEstimated).toBe(true);
    expect(ran.result.usage.inputTokens).toBeGreaterThan(0);
    expect(h.store.stateGet(ROOM, CONTEXT_READING)?.estimated).toBe(true);
  });
});

describe("tool rounds", () => {
  test("dice before the reply; a keeper-only result never reaches the ports; two NPCs overlap but publish in call order", async () => {
    const h = new Harness();
    addNpc(h, "mara", "Mara", "SECRET_MARA_SMUGGLES");
    addNpc(h, "tobin", "Tobin", "SECRET_TOBIN_INFORMS");
    const started: string[] = [];
    const finished: string[] = [];
    h.npc.script(async (messages) => {
      const who = promptText(messages).includes("Mara") ? "Mara" : "Tobin";
      started.push(who);
      // Mara answers last: publication must still follow call order.
      await new Promise((resolve) => setTimeout(resolve, who === "Mara" ? 30 : 5));
      finished.push(who);
      return `{"dialogue": "${who} speaks.", "action_intent": "", "mood": "calm"}`;
    });
    h.keeper.script([
      {
        toolCalls: [
          toolCall("roll_dice", { expression: "1d100" }),
          toolCall("get_npc", { npc: "Mara" }),
          toolCall("speak_as_npc", { npc: "Mara", situation: "Asked about the boat." }),
          toolCall("speak_as_npc", { npc: "Tobin", situation: "Asked about the boat." }),
        ],
      },
      "The two dockhands trade a look.",
    ]);
    const ran = await h.turn("I ask about the boat.");
    expect(ran.result.status).toBe("replied");
    const kinds = ran.events.map((event) => `${event.kind}:${String(event.data.speaker ?? "")}`);
    expect(kinds).toEqual(["dice:", "narrative:npc", "narrative:npc", "narrative:kp"]);
    expect(narratives(ran.events, "npc")).toEqual(["Mara speaks.", "Tobin speaks."]);
    // Both actors were asked before either answered.
    expect(started).toEqual(["Mara", "Tobin"]);
    expect(finished).toEqual(["Tobin", "Mara"]);
    // The secret reached the model (keeper-only result) and nothing the table receives.
    expect(promptText(h.keeper.requests[1]?.messages ?? [])).toContain("SECRET_MARA_SMUGGLES");
    expect(h.wire()).not.toContain("SECRET_MARA_SMUGGLES");
    expect(h.wire()).not.toContain("SECRET_TOBIN_INFORMS");
    expect(ran.result.toolsCalled).toEqual(["roll_dice", "get_npc", "speak_as_npc", "speak_as_npc"]);
    // Tools and tool choice are the same object every round; one moving mark on the newest tool result.
    expect(h.keeper.requests[1]?.options.tools).toBe(h.keeper.requests[0]?.options.tools);
    const second = h.keeper.requests[1]?.messages ?? [];
    const marked = second.filter((message) => message.role === "tool" && message.cacheBreakpoint === true);
    expect(marked.length).toBe(1);
    expect(second.at(-1)).toMatchObject({ role: "tool", cacheBreakpoint: true });
  });

  test("a module veto: the call does not run and the model reads the module's reason", async () => {
    const h = new Harness();
    const worker = fakeWorker({
      id: "warden",
      events: { toolUse: true },
      toolUse: (event) => {
        const calls = event.calls as { id: string; name: string }[];
        return { effects: calls.filter((call) => call.name === "roll_dice").map((call) => ({ module: "warden", kind: "deny", callId: call.id, reason: "No dice in the chapel." })) };
      },
    });
    h.keeper.script([{ toolCalls: [toolCall("roll_dice", { expression: "1d100" })] }, "You stay your hand."]);
    const ran = await h.turn("I roll for it.", { worker });
    expect(ran.events.some((event) => event.kind === "dice")).toBe(false);
    const toolMessage = h.keeper.requests[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toBe("No dice in the chapel.");
    expect(ran.result.status).toBe("replied");
  });

  test("run_command: the module's effects are applied and published before the reply", async () => {
    const h = new Harness();
    putTree(h.services, h.seedWriter(), { dock: { hp: 10 } });
    const worker = fakeWorker({
      id: "dock",
      commands: [{ name: "hit", title: "Hit", description: "Lose some hp.", params: { type: "object" }, text: [], role: "player" }],
      command: () => ({
        outcome: { status: "ok", result: { text: "hp 9" } },
        effects: [fact("dock", "Ada is hit", "table"), { module: "dock", kind: "setVar", path: "dock.hp", value: 9 }],
      }),
    });
    h.keeper.script([{ toolCalls: [toolCall("run_command", { id: "dock/hit", args: { amount: 1 } })] }, "You reel."]);
    const ran = await h.turn("I take the hit.", { worker });
    expect(narratives(ran.events, "system")).toEqual(["Ada is hit"]);
    expect(ran.events.map((event) => String(event.data.speaker))).toEqual(["system", "kp"]);
    expect(ran.result.contentWrites.has("dock.hp")).toBe(true);
    expect(promptText(h.keeper.requests[1]?.messages ?? [])).toContain("dock/hit: hp 9");
    // The command catalogue rides the cached head.
    expect(h.keeper.requests[0]?.messages[0]?.content).toContain("dock/hit");
  });
});

describe("module exchanges around the reply", () => {
  test("turn-start facts go out before the reply; reply-phase facts after; a narrate-now mark is recorded", async () => {
    const h = new Harness();
    let phaseReply = "";
    const worker = fakeWorker({
      id: "bell",
      events: { turnStart: true, replyPhase: true },
      turnStart: () => ({ effects: [fact("bell", "The bell tolls.", "table"), fact("bell", "KEEPER_NOTE the bell is cursed", "keeper"), { module: "bell", kind: "inject", text: "INJECTED_BELL" }] }),
      replyPhase: (event) => {
        phaseReply = String(event.reply);
        return { effects: [fact("bell", "The echo fades.", "table"), fact("bell", "NEXT_TURN_FACT", "keeper", true)] };
      },
    });
    h.keeper.script(["The tolling follows you up the hill."]);
    const ran = await h.turn("I listen.", { worker });
    expect(ran.events.map((event) => String(event.data.text))).toEqual(["The bell tolls.", "The tolling follows you up the hill.", "The echo fades."]);
    const prompt = promptText(h.keeper.requests[0]?.messages ?? []);
    expect(prompt).toContain("INJECTED_BELL");
    expect(prompt).toContain("KEEPER_NOTE the bell is cursed");
    expect(phaseReply).toBe("The tolling follows you up the hill.");
    expect(ran.result.narrateNowRequested).toBe(true);
    expect(h.store.stateGet(ROOM, NARRATE_NOW)).toMatchObject({ requested: true, opened: false });
    // The fact the prompt consumed is gone; the reply phase's new one waits for the next turn.
    const pending = h.store.stateGet(ROOM, PENDING_FACTS) ?? [];
    expect(pending.map((item) => item.text)).toEqual(["NEXT_TURN_FACT"]);
  });

  test("a facts turn: no player line, the pending facts are narrated, its own marks wait", async () => {
    const h = new Harness();
    const waiting: PendingFact = { module: "bell", turn: 0, to: "keeper", importance: "high", text: "FACT_TO_NARRATE the tower falls", data: null };
    h.services.store.transaction(() => h.seedWriter().statePut(PENDING_FACTS, [waiting]));
    const worker = fakeWorker({ id: "bell", events: { replyPhase: true }, replyPhase: () => ({ effects: [fact("bell", "LATER", "keeper", true)] }) });
    h.keeper.script(["Stone thunders down the hillside."]);
    const ran = await h.turn("", { work: "facts_turn", worker });
    expect(ran.result.status).toBe("replied");
    const sent = h.keeper.requests[0]?.messages ?? [];
    expect(sent.at(-1)?.content).toBe(FACTS_TURN_LINE);
    expect(promptText(sent)).toContain("FACT_TO_NARRATE the tower falls");
    expect(narratives(ran.events, "player")).toEqual([]);
    expect(ran.result.narrateNowRequested).toBe(false);
    expect((h.store.stateGet(ROOM, PENDING_FACTS) ?? []).map((item) => item.text)).toEqual(["LATER"]);
    // The next turn replays it with the same line, byte-stable.
    h.keeper.script(["Dust settles."]);
    await h.turn("I look around.");
    const replay = h.keeper.requests[1]?.messages ?? [];
    expect(replay.some((message) => message.role === "user" && message.content === FACTS_TURN_LINE)).toBe(true);
    expect(replay.some((message) => message.role === "assistant" && message.content === "Stone thunders down the hillside.")).toBe(true);
  });
});

describe("lore", () => {
  test("activated lore reaches the prompt", async () => {
    const h = new Harness();
    addLore(h.services, h.seedWriter(), "beacon", { title: "Beacon", content: "LORE_BEACON the beacon is lit", constant: true });
    const lore = fakeLoreWorker((request) => ({
      injected: [{ id: "beacon", text: "LORE_BEACON the beacon is lit", via: "match" }],
      activatedTitles: ["Beacon"],
      timers: { turn: (request.timers as { turn: number }).turn + 1, entries: [] },
      writes: [],
      failures: [],
    }));
    h.keeper.script(["The beacon burns."]);
    const ran = await h.turn("I climb to the lamp.", { loreWorker: lore });
    expect(promptText(h.keeper.requests[0]?.messages ?? [])).toContain("LORE_BEACON");
    expect(ran.result.problems).toEqual([]);
  });

  test("a failed lore exchange degrades the turn, never fails it", async () => {
    const h = new Harness();
    addLore(h.services, h.seedWriter(), "beacon", { title: "Beacon", content: "LORE_BEACON", constant: true });
    const lore = {
      assembleLore: async () => {
        throw new WorkerTimeout("assembleLore", 10);
      },
    } as never;
    h.keeper.script(["You climb."]);
    const ran = await h.turn("I climb.", { loreWorker: lore });
    expect(ran.result.status).toBe("replied");
    expect(ran.result.problems).toContain("lore_timeout");
    expect(promptText(h.keeper.requests[0]?.messages ?? [])).not.toContain("LORE_BEACON");
  });
});

describe("failures", () => {
  test("a provider failure loses nothing consumed: whispers, facts and player actions wait for the next turn", async () => {
    const h = new Harness();
    const writer = h.seedWriter();
    writer.statePut(WHISPERS_KEY, [{ kind: "note", text: "WHISPER_ONE watch the clock" }, { kind: "unrolled_check", skill: "Spot Hidden", quote: "you notice the hatch" }]);
    writer.statePut(PENDING_FACTS, [{ module: "bell", turn: 0, to: "keeper", importance: "normal", text: "PENDING_ONE", data: null }]);
    expect(recordPlayerAction({ services: h.services, room: ROOM, writer }, { actor: "Ada", action: "bell/ring", text: "ACTION_ONE rang" })).toEqual({ ok: true });
    h.keeper.script([{ error: new LLMError({ code: "auth", retryable: false }) }]);
    const failed = await h.turn("I wait.");
    expect(failed.result).toMatchObject({ status: "failed", code: "provider_auth", reply: null });
    expect(failed.events.some((event) => event.data.speaker === "kp")).toBe(false);
    expect(failed.signals.find((signal) => signal.kind === "notice")?.data).toMatchObject({ code: "provider_auth", text: turnText("en", "loop.provider_auth") });
    expect(h.store.stateGet(ROOM, WHISPERS_KEY)?.length).toBe(2);
    expect(h.store.stateGet(ROOM, PENDING_FACTS)?.length).toBe(1);
    expect(h.store.stateGet(ROOM, PLAYER_ACTIONS)?.length).toBe(1);

    h.keeper.script(["The clock ticks on."]);
    const next = await h.turn("I wait again.");
    expect(next.result.status).toBe("replied");
    const prompt = promptText(h.keeper.requests[1]?.messages ?? []);
    expect(prompt).toContain("WHISPER_ONE watch the clock");
    expect(prompt).toContain(turnText("en", "scribe.whisper.unrolled_check", { skill: "Spot Hidden", quote: "you notice the hatch" }));
    expect(prompt).toContain("PENDING_ONE");
    expect(prompt).toContain("ACTION_ONE rang");
    expect(h.store.stateGet(ROOM, WHISPERS_KEY)).toBeNull();
    expect(h.store.stateGet(ROOM, PENDING_FACTS)).toBeNull();
    expect(h.store.stateGet(ROOM, PLAYER_ACTIONS)).toBeNull();
    // The failed turn's line has no reply, so it is not replayed.
    expect(prompt).not.toContain("I wait.\n");
  });

  test("a whisper the Scribe adds while the turn runs survives the commit", async () => {
    const h = new Harness();
    h.seedWriter().statePut(WHISPERS_KEY, [{ kind: "note", text: "OLD" }]);
    let late = false;
    h.keeper.script(() => {
      // A late Scribe pass of an earlier turn queues a whisper mid-turn.
      h.store.writer(ROOM).statePut(WHISPERS_KEY, [{ kind: "note", text: "OLD" }, { kind: "note", text: "NEW" }]);
      late = true;
      return "Fine.";
    });
    await h.turn("Go on.");
    expect(late).toBe(true);
    expect(h.store.stateGet(ROOM, WHISPERS_KEY)).toEqual([{ kind: "note", text: "NEW" }]);
  });

  test("the room rewound while the model call is pending: stale, nothing written after", async () => {
    const h = new Harness();
    h.exchange("Earlier.", "Earlier reply.");
    let headAfterUndo = 0;
    h.keeper.script(() => {
      h.store.undoTo(ROOM, h.store.room(ROOM).turn - 1);
      headAfterUndo = h.store.eventsAfter(ROOM, 0, 1000).length;
      return "Too late.";
    });
    const ran = await h.turn("Now.");
    expect(ran.result.status).toBe("stale");
    expect(ran.events).toEqual([]);
    expect(ran.signals.some((signal) => signal.kind === "notice")).toBe(false);
    expect(h.store.eventsAfter(ROOM, 0, 1000).length).toBe(headAfterUndo);
    expect(h.store.stateGet(ROOM, CONTEXT_READING)).toBeNull();
  });

  test("the room reset while the model call is pending: stale", async () => {
    const h = new Harness();
    h.keeper.script(() => {
      h.store.reset(ROOM, "story", documentCatalog(h.services.types));
      return "Too late.";
    });
    const ran = await h.turn("Now.");
    expect(ran.result.status).toBe("stale");
    expect(h.store.eventsAfter(ROOM, 0, 1000)).toEqual([]);
  });

  test("abort: the caller's signal ends the turn with nothing published", async () => {
    const h = new Harness();
    const controller = new AbortController();
    h.keeper.script(() => {
      controller.abort();
      return "Never shown.";
    });
    const ran = await h.turn("Hurry.", { signal: controller.signal });
    expect(ran.result.status).toBe("aborted");
    expect(ran.events).toEqual([]);
  });

  test("a blocked reply is not published: failed with a stable code and a notice, the draft withdrawn", async () => {
    const h = new Harness();
    h.keeper.script(["Something the room does not allow."]);
    const ran = await h.turn("Say it.", { reviewNarrative: (text) => ({ text, allowed: false }) });
    expect(ran.result).toMatchObject({ status: "failed", code: "reply_blocked", reply: null });
    expect(ran.events).toEqual([]);
    expect(ran.signals.find((signal) => signal.kind === "notice")?.data).toMatchObject({ code: "reply_blocked" });
    expect(ran.signals.some((signal) => signal.kind === "draft" && signal.data.discard === true)).toBe(true);
  });
});

describe("the reply's commit block", () => {
  test("<UpdateVariable> is applied and stripped; textual tool calls are stripped", async () => {
    const h = new Harness();
    putTree(h.services, h.seedWriter(), { hp: 10 });
    h.keeper.script([
      "You bleed.\n<UpdateVariable>\n_.set('hp', 10, 7);//hurt\n</UpdateVariable>\n<tool_call><name>mcp__x</name></tool_call>",
    ]);
    const ran = await h.turn("Ouch.");
    expect(ran.result.reply).toBe("You bleed.");
    const tree = h.services.documents.get(ROOM, "variable_tree", "tree");
    expect(JSON.stringify(tree?.data)).toContain("7");
  });
});

describe("prefix stability", () => {
  test("two consecutive turns share a byte-identical head and history", async () => {
    const h = new Harness();
    h.exchange("Earlier line.", "Earlier reply.");
    h.keeper.script(["First reply."]);
    await h.turn("First line.");
    h.keeper.script(["Second reply."]);
    await h.turn("Second line.");
    const first = h.keeper.requests[0]?.messages ?? [];
    const second = h.keeper.requests[1]?.messages ?? [];
    expect(JSON.stringify(second[0])).toBe(JSON.stringify(first[0]));
    // First: [head, earlier user, earlier assistant◆, state, line]. Second: [head, earlier…, first user, first assistant◆, state, line].
    const firstHistory = first.slice(1, first.length - 2).map((message) => message.content);
    const secondHistory = second.slice(1, second.length - 2).map((message) => message.content);
    expect(secondHistory.slice(0, firstHistory.length)).toEqual(firstHistory);
    expect(secondHistory.slice(firstHistory.length)).toEqual([first.at(-1)?.content ?? "", "First reply."]);
  });
});

describe("the opening", () => {
  test("the first Keeper turn of a world-card room gets the authored opening; later turns do not", async () => {
    const h = new Harness();
    h.put(
      WORLD_CARD_TYPE,
      worldCardId("Harbor"),
      worldCardData({
        name: "Harbor",
        description: "",
        personality: "",
        scenario: "",
        examples: "",
        creatorNotes: "",
        head: "",
        postHistory: "",
        opening: "OPENING_TEXT Fog rolls over the harbor of {{char}}.",
        alternates: [],
        provenance: { hash: "a".repeat(64), importedAt: 1, importedBy: null, format: "sillytavern" },
      }),
    );
    h.keeper.script(["Fog rolls in."]);
    await h.turn("We arrive.");
    const first = promptText(h.keeper.requests[0]?.messages ?? []);
    expect(first).toContain(OPENING_NOTE);
    expect(first).toContain("OPENING_TEXT Fog rolls over the harbor of Harbor.");
    h.keeper.script(["Gulls cry."]);
    await h.turn("We walk on.");
    expect(promptText(h.keeper.requests[1]?.messages ?? [])).not.toContain(OPENING_NOTE);
  });
});
