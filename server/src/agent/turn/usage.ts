// A turn's token accounting, and the fold meter's reading of it.
//
// Rounds combine in two ways (ported from the 2.6 `_accumulate_usage`): output SUMS —
// every round produced new tokens — while the prompt side is LAST-WINS, because the
// latest round's prompt is the whole current context (history plus this turn's tool
// chatter), which is what a fullness meter describes. A round that reported nothing
// leaves the total as it was.
//
// A turn no round metered is not a turn with no usage: an endpoint that ignores the
// streaming usage option reports nothing, and an absent meter reads as "no pressure" to
// the fold — the emergency level included — so the room's history would never trim. The
// engine sizes the prompt it sent instead (`estimateTokens`, the fold's own unit, over the
// final round's messages AND the tool catalogue, a large fixed share of every Keeper
// prompt) and marks the number estimated, so it is never compared with a measured one.
import type { PastExchange } from "../prompt/snapshot.ts";
import { replayExchange } from "../prompt/assemble.ts";
import { type ContextReading, estimatedReading, estimateTokens, measuredReading, replayCosts, type TurnCost } from "../../core/chronicle/index.ts";
import type { ChatMessage, ToolDefinition, Usage } from "../../infra/llm/types.ts";

/** `Usage` summed over a turn's rounds; `estimated` says the engine sized the prompt itself. */
export interface TurnUsage extends Usage {
  readonly estimated: boolean;
}

export const EMPTY_TURN_USAGE: TurnUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, estimated: false });

/** `total` with one round's usage folded in: output sums, the prompt side is the latest round's. */
export function accumulateUsage(total: TurnUsage, round: Usage | undefined): TurnUsage {
  if (round === undefined) return total;
  const reasoning =
    total.reasoningTokens === undefined && round.reasoningTokens === undefined ? undefined : (total.reasoningTokens ?? 0) + (round.reasoningTokens ?? 0);
  return {
    inputTokens: round.inputTokens,
    outputTokens: total.outputTokens + round.outputTokens,
    ...(round.cachedInputTokens === undefined ? {} : { cachedInputTokens: round.cachedInputTokens }),
    ...(round.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: round.cacheWriteTokens }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    estimated: total.estimated,
  };
}

/** The engine's estimate of a prompt: every message's content plus the tool catalogue as JSON. */
export function estimatePromptTokens(messages: readonly ChatMessage[], tools: readonly ToolDefinition[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message.content);
  if (tools.length > 0) total += estimateTokens(JSON.stringify(tools));
  return total;
}

/**
 * `usage` with the prompt sized by the engine when no round reported one, marked
 * estimated. Unchanged the moment any round reported a prompt count. Pass the FINAL
 * round's messages (the same last-wins a measured reading has) and the catalogue sent.
 */
export function fillEstimatedPromptTokens(usage: TurnUsage, messages: readonly ChatMessage[], tools: readonly ToolDefinition[]): TurnUsage {
  if (usage.inputTokens > 0) return usage;
  return { ...usage, inputTokens: estimatePromptTokens(messages, tools), estimated: true };
}

/** The fold meter's reading of a completed turn: the usage after `fillEstimatedPromptTokens`. */
export function usageReading(usage: TurnUsage, contextWindow: number): ContextReading {
  return usage.estimated ? estimatedReading(usage.inputTokens, contextWindow) : measuredReading(usage, contextWindow);
}

/** Fill the estimate when needed, and read the meter: what the end of a turn writes. */
export function closeTurnUsage(
  usage: TurnUsage,
  messages: readonly ChatMessage[],
  tools: readonly ToolDefinition[],
  contextWindow: number,
): { readonly usage: TurnUsage; readonly reading: ContextReading } {
  const filled = fillEstimatedPromptTokens(usage, messages, tools);
  return { usage: filled, reading: usageReading(filled, contextWindow) };
}

/**
 * The replayed history priced for the fold (`FoldInput.replayed`): each exchange as the two
 * messages the prompt actually carries (`replayExchange` — the speaker-tagged player line
 * and the Keeper's reply), both at the exchange's turn.
 */
export function replayedHistoryCosts(locale: string, history: readonly PastExchange[]): TurnCost[] {
  const messages: { turn: number; content: string }[] = [];
  for (const exchange of history) {
    for (const message of replayExchange(locale, exchange)) messages.push({ turn: exchange.turn, content: message.content });
  }
  return replayCosts(messages);
}
