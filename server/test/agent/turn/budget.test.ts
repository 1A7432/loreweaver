// The per-turn model-call budget (AGENTS.md "Per-turn model-call budget", §12 3.6): at most
// 3 fold batches + `maxRounds` tool rounds + 5 check rounds (or 1 finalizer) + 1 overflow
// re-send = 21 with the default 12 rounds. These tests drive a turn into every term at once
// and count the calls the Keeper's and the fold's lanes received.
import { expect, test } from "bun:test";

import { CONTEXT_READING } from "../../../src/agent/turn/index.ts";
import { MAX_ROUNDS_PER_TURN } from "../../../src/agent/turn/checks.ts";
import { replayedHistoryCosts } from "../../../src/agent/turn/usage.ts";
import { CHRONICLE_RECORD_TYPE, chronicleRecordData, chronicleRecordId, FOLD_MAX_BATCHES_PER_TURN } from "../../../src/core/chronicle/index.ts";
import { LLMError, toolCall } from "../../../src/infra/llm/index.ts";
import { Harness } from "./harness.ts";

const WINDOW = 100_000;
const PROSE = "The fog hangs low over the harbor and the lamps burn a sickly yellow along the quay. ".repeat(4);
const TURNS = 40;

/**
 * A campaign whose meter asks the routine fold for exactly two batches (18 records), so
 * the recovery fold after an overflow has the third batch of the budget left to spend.
 */
function campaign(): Harness {
  const h = new Harness({ contextWindow: WINDOW });
  const exchanges = [];
  for (let turn = 1; turn <= TURNS; turn++) {
    const line = `Line ${turn}. ${PROSE}`;
    const reply = `Reply ${turn}. ${PROSE}`;
    h.exchange(line, reply);
    exchanges.push({ turn, speaker: "Ada", playerText: line, keeperReply: reply });
  }
  for (let turn = 1; turn <= TURNS - 4; turn++) {
    const id = chronicleRecordId(turn);
    if (!id.ok) throw new Error(id.code);
    h.put(CHRONICLE_RECORD_TYPE, id.data, chronicleRecordData({ turn, text: `Record ${turn}.`, characters: [], scene: "", keeper: "", folded: false }));
  }
  const deficit = replayedHistoryCosts("en", exchanges)
    .filter((cost) => cost.turn <= 18)
    .reduce((sum, cost) => sum + cost.tokens, 0);
  h.seedWriter().statePut(CONTEXT_READING, { turn: TURNS, tokens: Math.trunc(0.4 * WINDOW) + deficit, window: WINDOW, estimated: false });
  h.memory.script(() => "SUMMARY");
  return h;
}

function overflow(): LLMError {
  return new LLMError({ code: "context_overflow", retryable: false });
}

test("a model that always asks for a tool is stopped at folds + max rounds + the re-send + the finalizer", async () => {
  const h = campaign();
  let calls = 0;
  h.keeper.script((_messages, options) => {
    calls++;
    if (calls === 1) return { error: overflow() };
    if ((options.tools?.length ?? 0) === 0) return "Closing.";
    return { toolCalls: [toolCall("list_npcs", {})] };
  });
  const ran = await h.turn("Go on.");
  expect(ran.result.status).toBe("replied");
  expect(ran.result.reply).toBe("Closing.");
  const maxRounds = h.settings.maxRounds;
  expect(h.memory.requests.length).toBe(FOLD_MAX_BATCHES_PER_TURN);
  // One refused call, `maxRounds` tool rounds, one finalizer.
  expect(h.keeper.requests.length).toBe(1 + maxRounds + 1);
  expect(h.memory.requests.length + h.keeper.requests.length).toBe(FOLD_MAX_BATCHES_PER_TURN + maxRounds + 1 + 1);
});

test("the worst case reaches exactly 21 with the default 12 rounds", async () => {
  const h = campaign();
  const maxRounds = h.settings.maxRounds;
  expect(maxRounds).toBe(12);
  let calls = 0;
  // A bad reply every check row holds on: narration lost (1), dice forged (2), a stale heading (2).
  const bad = "🌉 Pier 5 | 10:15 pm\nYou roll 1d100 = 47.";
  h.keeper.script(() => {
    calls++;
    if (calls === 1) return { error: overflow() };
    if (calls <= maxRounds) return { content: `${PROSE}${PROSE}`, toolCalls: [toolCall("list_npcs", {})] };
    return bad;
  });
  const ran = await h.turn("Go on.");
  expect(ran.result.status).toBe("replied");
  expect(h.memory.requests.length).toBe(FOLD_MAX_BATCHES_PER_TURN);
  // The loop: the refused call, 11 tool rounds and the reply (12 rounds + the re-send); then the checks.
  expect(h.keeper.requests.length).toBe(1 + maxRounds + MAX_ROUNDS_PER_TURN);
  expect(h.memory.requests.length + h.keeper.requests.length).toBe(21);
});
