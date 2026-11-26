import { describe, expect, test } from "bun:test";

import {
  accumulateUsage,
  closeTurnUsage,
  EMPTY_TURN_USAGE,
  estimatePromptTokens,
  fillEstimatedPromptTokens,
  replayedHistoryCosts,
  type TurnUsage,
  usageReading,
} from "../../../src/agent/turn/usage.ts";
import { replayExchange } from "../../../src/agent/prompt/assemble.ts";
import { estimateTokens } from "../../../src/core/chronicle/index.ts";
import type { ChatMessage, ToolDefinition, Usage } from "../../../src/infra/llm/types.ts";

function sum(...rounds: (Usage | undefined)[]): TurnUsage {
  return rounds.reduce<TurnUsage>((total, round) => accumulateUsage(total, round), EMPTY_TURN_USAGE);
}

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "You are the Keeper of a 1920s investigation." },
  { role: "user", content: "[Ada]\nhi" },
];
const TOOLS: ToolDefinition[] = [{ name: "lookup_time", description: "Look up the current in-game time.", parameters: { type: "object", properties: {} } }];

describe("accumulateUsage", () => {
  test("output sums across rounds; the prompt side is the last round's", () => {
    const total = sum(
      { inputTokens: 100, outputTokens: 10, cachedInputTokens: 20, cacheWriteTokens: 5 },
      { inputTokens: 140, outputTokens: 25, cachedInputTokens: 100 },
    );
    expect(total).toEqual({ inputTokens: 140, outputTokens: 35, cachedInputTokens: 100, estimated: false });
  });

  test("a round that reported nothing leaves the total as it was", () => {
    const once = sum({ inputTokens: 90, outputTokens: 7, cachedInputTokens: 30 });
    expect(accumulateUsage(once, undefined)).toBe(once);
    expect(sum(undefined, undefined)).toBe(EMPTY_TURN_USAGE);
  });

  test("reasoning tokens sum when any round reports them", () => {
    expect(sum({ inputTokens: 10, outputTokens: 5, reasoningTokens: 3 }, { inputTokens: 12, outputTokens: 6 }, { inputTokens: 14, outputTokens: 7, reasoningTokens: 4 })).toEqual({
      inputTokens: 14,
      outputTokens: 18,
      reasoningTokens: 7,
      estimated: false,
    });
  });

  test("main rounds and the finalizer merge", () => {
    expect(sum({ inputTokens: 45, outputTokens: 5 }, { inputTokens: 50, outputTokens: 5 }, { inputTokens: 80, outputTokens: 9 })).toEqual({
      inputTokens: 80,
      outputTokens: 19,
      estimated: false,
    });
  });

  test("main rounds are kept when the finalizer failed", () => {
    expect(sum({ inputTokens: 51, outputTokens: 5 }, { inputTokens: 52, outputTokens: 5 })).toEqual({ inputTokens: 52, outputTokens: 10, estimated: false });
  });
});

describe("the estimate", () => {
  test("a turn the provider never metered falls back to an estimate, marked as one", () => {
    const filled = fillEstimatedPromptTokens(EMPTY_TURN_USAGE, MESSAGES, TOOLS);
    expect(filled.estimated).toBe(true);
    expect(filled.inputTokens).toBeGreaterThan(0);
    // Nothing is invented about the half the engine cannot see.
    expect(filled.outputTokens).toBe(0);
    expect(filled.cachedInputTokens).toBeUndefined();
  });

  test("an unmetered turn keeps the output it did report", () => {
    const filled = fillEstimatedPromptTokens({ inputTokens: 0, outputTokens: 12, estimated: false }, MESSAGES, []);
    expect(filled).toEqual({ inputTokens: estimatePromptTokens(MESSAGES, []), outputTokens: 12, estimated: true });
  });

  test("a measured turn is never relabelled", () => {
    const measured = sum({ inputTokens: 140, outputTokens: 10 });
    expect(fillEstimatedPromptTokens(measured, MESSAGES, TOOLS)).toBe(measured);
  });

  test("the estimate prices the tool catalogue as well as the messages", () => {
    expect(estimatePromptTokens(MESSAGES, TOOLS)).toBeGreaterThan(estimatePromptTokens(MESSAGES, []));
    expect(estimatePromptTokens(MESSAGES, [])).toBe(MESSAGES.reduce((total, message) => total + estimateTokens(message.content), 0));
    expect(estimatePromptTokens(MESSAGES, TOOLS) - estimatePromptTokens(MESSAGES, [])).toBe(estimateTokens(JSON.stringify(TOOLS)));
  });
});

describe("the meter", () => {
  test("a measured turn reads as measured", () => {
    const { usage, reading } = closeTurnUsage(sum({ inputTokens: 60_000, outputTokens: 900 }), MESSAGES, TOOLS, 100_000);
    expect(usage.estimated).toBe(false);
    expect(reading).toEqual({ tokens: 60_000, window: 100_000, estimated: false });
  });

  test("an unmetered turn reads as an estimate, never as an empty meter", () => {
    const { usage, reading } = closeTurnUsage(EMPTY_TURN_USAGE, MESSAGES, TOOLS, 100_000);
    expect(reading.estimated).toBe(true);
    expect(reading.tokens).toBe(usage.inputTokens);
    expect(reading.tokens).toBeGreaterThan(0);
    expect(usageReading(usage, 100_000)).toEqual(reading);
  });

  test("replayed history is priced as the prompt carries it: speaker-tagged line and reply, at the exchange's turn", () => {
    const history = [
      { turn: 1, speaker: "Ada", playerText: "I open the door.", keeperReply: "It creaks." },
      { turn: 2, speaker: "", playerText: "我看向窗外。", keeperReply: "雨下得正紧。" },
    ];
    const costs = replayedHistoryCosts("en", history);
    expect(costs.map((cost) => cost.turn)).toEqual([1, 1, 2, 2]);
    const [user] = replayExchange("en", history[0] as (typeof history)[0]);
    expect(costs[0]?.tokens).toBe(estimateTokens(user.content));
    expect(costs[0]?.tokens).toBeGreaterThan(estimateTokens("I open the door."));
    expect(costs[3]?.tokens).toBe(estimateTokens("雨下得正紧。"));
  });
});
