// Named endpoints and known context windows. Every entry here was checked on 2026-11-26
// against the vendor's own documentation or the installed SDK, and cites where
// (defensive pattern 3: a vendor constant is re-verified, never propagated). Anything
// not here still works: an explicit base URL plus a model name needs no preset, and the
// context window is a setting. Re-verify an entry before changing it.
import type { Wire } from "./types.ts";

export interface Preset {
  readonly wire: Wire;
  readonly baseUrl: string;
}

export const PRESETS: Readonly<Record<string, Preset>> = {
  // The SDK's own default (node_modules/openai/client.js).
  openai: { wire: "openai-compatible", baseUrl: "https://api.openai.com/v1" },
  // The SDK's own default (node_modules/@anthropic-ai/sdk/client.js).
  anthropic: { wire: "anthropic", baseUrl: "https://api.anthropic.com" },
  // "OpenAI format: https://api.deepseek.com" — https://api-docs.deepseek.com/quick_start/pricing
  deepseek: { wire: "openai-compatible", baseUrl: "https://api.deepseek.com" },
  // https://openrouter.ai/docs/quickstart
  openrouter: { wire: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" },
  // https://platform.kimi.ai/docs/guide/start-using-kimi-api
  moonshot: { wire: "openai-compatible", baseUrl: "https://api.moonshot.ai/v1" },
};

// Exact model ids, no substring matching: sibling ids with different windows share
// prefixes (claude-opus-4-5 is 200K, claude-opus-4-6 is 1M), so a prefix rule would make
// line order decide correctness. Vendors write "1M" and "200k"; the decimal reading is
// used, the lower of the two possible ones, because a window guessed high lets a prompt
// grow past the real limit while one guessed low only folds early.
const ONE_M = 1_000_000;
const CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  // https://platform.claude.com/docs/en/build-with-claude/context-windows ("These models
  // have a 1M-token context window … Other Claude models have a 200k-token context
  // window") and the "All models" table at https://platform.claude.com/docs/en/models/overview.
  // Ids as typed in node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts `Model`.
  ...[
    "claude-fable-5-2",
    "claude-mythos-5-2",
    "claude-fable-5-1",
    "claude-mythos-5-1",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-mythos-preview",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-5-5",
  ].map((id) => [id, ONE_M] as const),
  ...[
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
  ].map((id) => [id, 200_000] as const),
  // "The context length is 1M tokens" — https://api-docs.deepseek.com/quick_start/pricing
  ["deepseek-v4-pro", ONE_M],
  ["deepseek-flash", ONE_M],
  // "supports a 1M-token context window" — https://platform.kimi.ai/docs/guide/start-using-kimi-api
  ["kimi-k3.1-pro", ONE_M],
  // https://docs.x.ai/docs/models (no xAI preset: its chat-completions base was not verified).
  ["grok-4.7", 500_000],
  ["grok-4.6", 500_000],
  ["grok-4.5", 500_000],
  ["grok-4.3", ONE_M],
  ["grok-4.20-0309-reasoning", ONE_M],
  ["grok-4.20-0309-non-reasoning", ONE_M],
]);

/**
 * The context window for `model`: the operator's override when given, else the verified
 * table, else `undefined` — an unknown model is unknown, and the caller decides what that
 * means rather than this module inventing a number.
 */
export function contextWindowFor(model: string, override?: number): number | undefined {
  if (override !== undefined && override > 0) return override;
  return CONTEXT_WINDOWS.get(model.trim().toLowerCase());
}
