// The round loop's edges: the fold before assembly, an overflow and its one re-send, the
// end-of-turn checks through the real runner, and the max-rounds finalizer and fallback.
import { afterEach, describe, expect, test } from "bun:test";

import { CONTEXT_READING } from "../../../src/agent/turn/index.ts";
import { turnText } from "../../../src/agent/turn/catalog.ts";
import {
  CAMPAIGN_SUMMARY_ID,
  CAMPAIGN_SUMMARY_TYPE,
  CHRONICLE_RECORD_TYPE,
  chronicleRecordData,
  chronicleRecordId,
  readCampaignSummary,
  readChronicleRecord,
} from "../../../src/core/chronicle/index.ts";
import { LLMError, toolCall } from "../../../src/infra/llm/index.ts";
import { RoomWorker } from "../../../src/infra/room_worker.ts";
import { spawnWorker } from "../../../src/infra/runtime/worker.ts";
import { fixtureModule, WORKER_ENTRY } from "../../helpers.ts";
import { putTree } from "../room_fixture.ts";
import { Harness, promptText, ROOM } from "./harness.ts";

const PROSE = "The fog hangs low over the harbor and the lamps burn a sickly yellow along the quay. ".repeat(4);

function seedCampaign(h: Harness, turns: number, recordsThrough: number): void {
  for (let turn = 1; turn <= turns; turn++) h.exchange(`Line ${turn}. ${PROSE}`, `Reply ${turn}. ${PROSE}`);
  for (let turn = 1; turn <= recordsThrough; turn++) {
    const id = chronicleRecordId(turn);
    if (!id.ok) throw new Error(id.code);
    h.put(CHRONICLE_RECORD_TYPE, id.data, chronicleRecordData({ turn, text: `Record of turn ${turn}.`, characters: [], scene: "", keeper: "", folded: false }));
  }
}

function overflow(): LLMError {
  return new LLMError({ code: "context_overflow", retryable: false });
}

describe("the fold", () => {
  test("the routine fold runs before assembly and trims the replayed history", async () => {
    const h = new Harness({ contextWindow: 10_000 });
    seedCampaign(h, 20, 16);
    h.seedWriter().statePut(CONTEXT_READING, { turn: 20, tokens: 9_000, window: 10_000, estimated: false });
    h.memory.script(() => "SUMMARY_TEXT the story so far.");
    h.keeper.script(["The harbor waits."]);
    const ran = await h.turn("I look out to sea.");
    expect(ran.result.status).toBe("replied");
    // 16 foldable records: two batches, two fold calls.
    expect(h.memory.requests.length).toBe(2);
    const summary = readCampaignSummary(h.services.documents.get(ROOM, CAMPAIGN_SUMMARY_TYPE, CAMPAIGN_SUMMARY_ID)?.data ?? {});
    expect(summary?.throughTurn).toBe(16);
    const record = readChronicleRecord(h.services.documents.get(ROOM, CHRONICLE_RECORD_TYPE, "c000001")?.data ?? {});
    expect(record?.folded).toBe(true);
    const sent = h.keeper.requests[0]?.messages ?? [];
    expect(sent[0]?.content).toContain("SUMMARY_TEXT");
    const prompt = promptText(sent);
    expect(prompt).not.toContain("Line 16.");
    expect(prompt).toContain("Line 17.");
    expect(prompt).toContain("Reply 20.");
  });

  test("an overflow folds once and re-sends once", async () => {
    const h = new Harness();
    seedCampaign(h, 10, 6);
    h.memory.script(() => "SUMMARY_AFTER_OVERFLOW");
    h.keeper.script([{ error: overflow() }, "Recovered."]);
    const ran = await h.turn("Continue.");
    expect(ran.result.status).toBe("replied");
    expect(ran.result.reply).toBe("Recovered.");
    expect(h.keeper.requests.length).toBe(2);
    expect(h.memory.requests.length).toBe(1);
    const before = h.keeper.requests[0]?.messages ?? [];
    const after = h.keeper.requests[1]?.messages ?? [];
    expect(after.length).toBeLessThan(before.length);
    expect(after[0]?.content).toContain("SUMMARY_AFTER_OVERFLOW");
  });

  test("a second overflow fails the turn", async () => {
    const h = new Harness();
    seedCampaign(h, 10, 6);
    h.memory.script(() => "SUMMARY");
    h.keeper.script([{ error: overflow() }, { error: overflow() }]);
    const ran = await h.turn("Continue.");
    expect(ran.result.status).toBe("failed");
    expect(h.keeper.requests.length).toBe(2);
    expect(ran.events.some((event) => event.data.speaker === "kp")).toBe(false);
    expect(ran.signals.some((signal) => signal.kind === "notice")).toBe(true);
  });

  test("an overflow with nothing to fold does not re-send", async () => {
    const h = new Harness();
    h.keeper.script([{ error: overflow() }]);
    const ran = await h.turn("Continue.");
    expect(ran.result.status).toBe("failed");
    expect(h.keeper.requests.length).toBe(1);
    // The meter remembers what the provider said.
    expect(h.store.stateGet(ROOM, CONTEXT_READING)).toMatchObject({ tokens: 200_000, estimated: true });
  });
});

describe("the end-of-turn checks", () => {
  function lastUser(h: Harness, index: number): string {
    const messages = h.keeper.requests[index]?.messages ?? [];
    return [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  }

  test("dice_forged: a stated roll with no dice asks once", async () => {
    const h = new Harness();
    h.keeper.script(["You roll 1d100 = 47 and the lock gives.", "The lock gives way."]);
    const ran = await h.turn("I pick the lock.");
    expect(h.keeper.requests.length).toBe(2);
    expect(lastUser(h, 1)).toBe(turnText("en", "loop.check.dice_forged"));
    expect(h.keeper.requests[1]?.options.onTextDelta).toBeUndefined();
    expect(h.keeper.requests[1]?.options.tools).toBe(h.keeper.requests[0]?.options.tools);
    expect(ran.result.reply).toBe("The lock gives way.");
    // The event takes the final round's draft id, and carries the corrected text.
    expect(ran.events.at(-1)?.id).toBe(ran.result.replyId as string);
  });

  test("dice_contradicts: numbers the dice did not produce ask once", async () => {
    const h = new Harness();
    h.keeper.script([{ toolCalls: [toolCall("roll_dice", { expression: "1d100" })] }, "Your roll: 1d100 = 99.", "The roll stands."]);
    const ran = await h.turn("I roll.");
    expect(h.keeper.requests.length).toBe(3);
    expect(lastUser(h, 2)).toBe(turnText("en", "loop.check.dice_contradicts", { rolled: "42" }));
    expect(ran.result.reply).toBe("The roll stands.");
  });

  test("narration_lost: narration left in a tool round asks once", async () => {
    const h = new Harness();
    const scene = `${PROSE}${PROSE}`;
    h.keeper.script([{ content: scene, toolCalls: [toolCall("roll_dice", { expression: "1d6" })] }, "Done.", scene]);
    const ran = await h.turn("I search.");
    expect(h.keeper.requests.length).toBe(3);
    expect(lastUser(h, 2)).toContain("Runtime check: only your last message");
    expect(ran.result.reply).toBe(scene);
  });

  test("stale_scene_hud: a scene heading without the bookkeeping asks once", async () => {
    const h = new Harness();
    h.keeper.script(["🌉 Pier 5 | 10:15 pm\nThe sea wind.", "The sea wind."]);
    const ran = await h.turn("We walk to the pier.");
    expect(h.keeper.requests.length).toBe(2);
    expect(lastUser(h, 1)).toContain("🌉 Pier 5 | 10:15 pm");
    expect(ran.result.reply).toBe("The sea wind.");
  });
});

describe("max rounds", () => {
  test("rounds spent: the finalizer narrates, with no tools and no cache marks", async () => {
    const h = new Harness({ maxRounds: 2 });
    h.keeper.script((_messages, options) => ((options.tools?.length ?? 0) > 0 ? { toolCalls: [toolCall("roll_dice", { expression: "1d6" })] } : "Closing words."));
    const ran = await h.turn("Keep going.");
    expect(h.keeper.requests.length).toBe(3);
    const finalizer = h.keeper.requests[2];
    expect(finalizer?.options.tools).toEqual([]);
    expect(finalizer?.options.toolChoice).toBe("none");
    expect(finalizer?.messages.some((message) => message.cacheBreakpoint === true)).toBe(false);
    expect(ran.result.reply).toBe("Closing words.");
    expect(ran.events.filter((event) => event.kind === "dice").length).toBe(2);
  });

  test("the finalizer failing too: the deterministic fallback lists the public results", async () => {
    const h = new Harness({ maxRounds: 1 });
    let calls = 0;
    h.keeper.script(() => {
      calls++;
      if (calls === 1) return { toolCalls: [toolCall("roll_dice", { expression: "1d6" })] };
      return { error: new LLMError({ code: "transient", retryable: true }) };
    });
    const ran = await h.turn("Keep going.");
    expect(ran.result.status).toBe("replied");
    expect(ran.result.reply?.startsWith(turnText("en", "loop.max_rounds"))).toBe(true);
    expect(ran.result.reply).toContain("roll_dice");
    expect(ran.result.problems).toContain("finalizer_failed");
  });
});

describe("with a real room worker", () => {
  const workers: RoomWorker[] = [];
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  });

  test("a whole turn: turn start, tool veto, reply phase, the module's checkpoints", async () => {
    const h = new Harness();
    putTree(h.services, h.seedWriter(), { kitchen: { turn: 0, luck: 0 } });
    const saved = new Map<string, unknown>();
    const worker = new RoomWorker(() => spawnWorker(WORKER_ENTRY), [fixtureModule("kitchen")], {
      timeoutMs: 5000,
      onCheckpoint: (module, snapshot) => {
        saved.set(module, snapshot);
      },
    });
    workers.push(worker);
    h.keeper.script([{ toolCalls: [toolCall("forbidden", {}), toolCall("run_command", { id: "kitchen/hit", args: { amount: 2 } })] }, "The kitchen falls quiet."]);
    const ran = await h.turn("I step into the kitchen.", { worker });
    expect(ran.result.status).toBe("replied");
    // turnStart's table fact before the reply, the command's fact, the reply.
    const texts = ran.events.filter((event) => event.kind === "narrative").map((event) => String(event.data.text));
    expect(texts[0]).toBe(`turn ${ran.writer.turn}`);
    expect(texts.at(-1)).toBe("The kitchen falls quiet.");
    expect(texts).toContain("Ada is hit");
    const first = promptText(h.keeper.requests[0]?.messages ?? []);
    expect(first).toContain("kitchen heard 1");
    // The module denied the unknown tool by name; the command ran.
    const second = h.keeper.requests[1]?.messages ?? [];
    expect(second.filter((message) => message.role === "tool").map((message) => message.content)).toEqual(["not here", "kitchen/hit: hp 8"]);
    expect(ran.result.contentWrites.has("kitchen.turn")).toBe(true);
    expect(ran.result.contentWrites.has("kitchen.luck")).toBe(true);
    expect(saved.has("kitchen")).toBe(true);
  });

  test("run_command on a command that runs in steps is ONE tool call: one result, every step's events on the table before the reply", async () => {
    const h = new Harness();
    const worker = new RoomWorker(() => spawnWorker(WORKER_ENTRY), [fixtureModule("colony")], { timeoutMs: 5000 });
    workers.push(worker);
    h.keeper.script([{ toolCalls: [toolCall("run_command", { id: "colony/advance", args: { years: 3 } })] }, "Three winters pass."]);
    const ran = await h.turn("We wait out the years.", { worker });
    expect(ran.result.status).toBe("replied");
    const texts = ran.events.filter((event) => event.kind === "narrative").map((event) => String(event.data.text));
    expect(texts).toEqual(["year 1", "year 2", "year 3", "Three winters pass."]);
    expect(ran.events.filter((event) => event.kind === "dice")).toHaveLength(3);
    const tools = (h.keeper.requests[1]?.messages ?? []).filter((message) => message.role === "tool").map((message) => message.content);
    expect(tools).toEqual(["colony/advance: year 3\n(Ran in 3 steps.)"]);
    expect(ran.result.toolsCalled).toEqual(["run_command"]);
  });
});
