// The synchronous steps between the model's final text and publication, and the two ways
// a turn ends without an ordinary reply (ported from `agent/loop.py`):
//
// - `stripTextToolCalls`: a model occasionally writes a TOOL CALL as text instead of using
//   the tool channel (a foreign harness's `<Deep><use><name>mcp__…` block, observed live
//   with keeper-side notes in its arguments). A wrapper that contains tool-call markers is
//   machinery, never narration, and is removed WHOLE, content unseen.
// - the max-rounds finalizer: the round budget is spent with no plain reply, so one last
//   call with tools disabled narrates the committed PUBLIC results; when that fails too,
//   `maxRoundsFallback` says so deterministically and lists those results.
// - `failureNotice`: a provider call failed; the table is told with a `notice` signal.
//
// "Public" is structural: a Keeper-only result (a secret) never enters the finalizer's
// prompt or the fallback, and neither does a call that did nothing (vetoed by a module or
// refused by its tool) — only what the table could already see.
import type { SignalPayloads } from "loreweaver-protocol/v3";

import { stripCacheBreakpoints } from "../prompt/assemble.ts";
import { LLMError } from "../../infra/llm/errors.ts";
import type { ChatMessage, ChatOptions } from "../../infra/llm/types.ts";
import { turnText } from "./catalog.ts";
import { correctionBaseMessages } from "./checks.ts";

// ---------------------------------------------------------------------------
// Textual tool calls
// ---------------------------------------------------------------------------

// Python's `\b` after a tag name: no letter, digit or `_` of any script follows.
const TEXT_TOOL_CALL_WRAPPER_RE = /<(Deep|use|tool_call|tool_use|function_call|function_calls|invoke)(?![\p{L}\p{N}_])[^>]*>[\s\S]*?<\/\1\s*>/giu;
const TEXT_TOOL_CALL_MARKER_RE = /<\s*(?:name|tool_name|args|arguments|parameter)(?![\p{L}\p{N}_])|mcp__/iu;

/** `reply` without the tool-call-shaped blocks a model wrote as text; unchanged when there are none. */
export function stripTextToolCalls(reply: string): string {
  const cleaned = reply.replace(TEXT_TOOL_CALL_WRAPPER_RE, (block) => (TEXT_TOOL_CALL_MARKER_RE.test(block) ? "" : block));
  if (cleaned === reply) return reply;
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// The max-rounds finalizer and its fallback
// ---------------------------------------------------------------------------

/** One call of the turn, as the finalizer and the fallback see it. */
export interface CommittedCall {
  readonly name: string;
  /** The text the model got back. */
  readonly result: string;
  /** The result carries Keeper-only material. */
  readonly keeperOnly: boolean;
  /** Vetoed by a module, or refused / failed by the tool: nothing was committed. */
  readonly suppressed: boolean;
}

/** The public committed results, one line each, or the "none" line. */
export function publicCommittedResults(calls: readonly CommittedCall[], locale: string): string {
  const lines = calls
    .filter((call) => !call.keeperOnly && !call.suppressed)
    .map((call) => turnText(locale, "loop.max_rounds_result", { name: call.name, result: call.result.trim() }));
  return lines.length > 0 ? lines.join("\n") : turnText(locale, "loop.max_rounds_no_public_results");
}

/** The deterministic reply when the finalizer failed too: a pause, then the public results. */
export function maxRoundsFallback(calls: readonly CommittedCall[], locale: string): string {
  return [turnText(locale, "loop.max_rounds"), `${turnText(locale, "loop.max_rounds_committed")}\n${publicCommittedResults(calls, locale)}`].join("\n\n");
}

/**
 * The finalizer's conversation: the turn's messages without its tool rounds and without
 * cache marks (tools are disabled for this call, which on Anthropic invalidates every cache
 * layer beneath them, so a mark would buy a write nothing reads), then the instruction
 * carrying the public results.
 */
export function finalizerMessages(messages: readonly ChatMessage[], calls: readonly CommittedCall[], locale: string): ChatMessage[] {
  return [
    ...stripCacheBreakpoints(correctionBaseMessages(messages)),
    { role: "user", content: turnText(locale, "loop.max_rounds_finalize", { results: publicCommittedResults(calls, locale) }) },
  ];
}

/** The finalizer's call options: no tools. Streamed through the gate like a final round. */
export const FINALIZER_OPTIONS: Pick<ChatOptions, "tools" | "toolChoice"> = Object.freeze({ tools: Object.freeze([]), toolChoice: "none" });

/** The finalizer's reply, trimmed; null when it wrote nothing (the fallback then applies). */
export function finalizerReply(content: string): string | null {
  const text = content.trim();
  return text === "" ? null : text;
}

// ---------------------------------------------------------------------------
// A failed provider call
// ---------------------------------------------------------------------------

/** The stable code of a failed turn's notice; each names its `turn.json` text. */
export type TurnFailureCode = "provider_auth" | "provider_quota" | "provider_transient" | "provider_content" | "unavailable";

/**
 * Which diagnosis a provider failure gets. Only a classified `LLMError` earns a specific
 * one; anything else is "momentarily unavailable".
 * - `auth`: the credentials were refused.
 * - `rate_limited` and not retryable: a spend or plan limit, not a burst — the quota text.
 *   A retryable one the retry layer gave up on is transient.
 * - `transient`: the provider stayed unavailable through the retries.
 * - `bad_request`: the provider could not process this input.
 */
export function failureCode(error: unknown): TurnFailureCode {
  if (!(error instanceof LLMError)) return "unavailable";
  switch (error.code) {
    case "auth":
      return "provider_auth";
    case "rate_limited":
      return error.retryable ? "provider_transient" : "provider_quota";
    case "transient":
      return "provider_transient";
    case "bad_request":
      return "provider_content";
    default:
      return "unavailable";
  }
}

/** The `notice` that tells the table a turn failed; `code` is stable, `text` in the room's language. */
export function failureNotice(error: unknown, locale: string): SignalPayloads["notice"] {
  const code = failureCode(error);
  return { level: "warn", code, text: turnText(locale, `loop.${code}`) };
}
