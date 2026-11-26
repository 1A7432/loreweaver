// The token figures of a room's last Keeper turn: written by the room after a turn, read
// by the `usage` view. Declared here, by its writer.
import type { RoomContext } from "../../agent/context.ts";
import { jsonStateKey } from "../../infra/lifecycle/declarations.ts";
import type { Usage } from "../../infra/llm/types.ts";

export interface LastTurnUsage {
  readonly turn: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly estimated: boolean;
}

const COUNTS = ["turn", "inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens"] as const;

function isLastTurnUsage(value: unknown): value is LastTurnUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return COUNTS.every((name) => Number.isSafeInteger(record[name]) && (record[name] as number) >= 0) && typeof record.estimated === "boolean";
}

/** The last turn's usage. It describes the story played so far: a story reset clears it. */
export const LAST_TURN_USAGE = jsonStateKey<LastTurnUsage>("views.last_turn_usage", { reset: "story" }, isLastTurnUsage);

function count(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Record a finished turn's usage (the turn's summed `Usage`; `estimated` when the engine
 * sized the prompt itself) through the turn's own writer.
 */
export function recordUsage(context: RoomContext, usage: Usage & { readonly estimated?: boolean }): void {
  context.writer.statePut(LAST_TURN_USAGE, {
    turn: context.turn,
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    cachedInputTokens: count(usage.cachedInputTokens),
    cacheWriteTokens: count(usage.cacheWriteTokens),
    reasoningTokens: count(usage.reasoningTokens),
    estimated: usage.estimated === true,
  });
}
