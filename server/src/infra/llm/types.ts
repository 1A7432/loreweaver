// The model interface every lane implements. It is the server's own vocabulary: each lane
// translates it to one vendor's wire and back, so nothing above infra/ sees an SDK type.

/**
 * The wires this server speaks: Chat Completions (`openai-compatible`), the Anthropic
 * Messages API, and the OpenAI Responses API (`openai-responses`, for OpenAI and xAI).
 */
export type Wire = "openai-compatible" | "anthropic" | "openai-responses";

/**
 * Thinking depth. The levels both installed SDKs type for their effort parameter
 * (`openai` `ReasoningEffort`, `@anthropic-ai/sdk` `OutputConfig.effort`); the ones only
 * one side has (`none`, `minimal`) are left out so a setting means the same on either lane.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** A JSON Schema object describing the arguments. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** `required`: the model must call some tool; `{ name }`: it must call that one. */
export type ToolChoice = "auto" | "required" | "none" | { readonly name: string };

/**
 * A tool call's arguments. Models occasionally emit arguments that are not a JSON object
 * (cut off by the output cap, or simply malformed); those arrive as `valid: false` with
 * the raw text, so the caller can tell the model rather than run the tool with nothing.
 */
export type ToolInput =
  | { readonly valid: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly valid: false; readonly raw: string };

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: ToolInput;
}

/**
 * What a provider needs echoed back verbatim with an assistant turn during a tool loop,
 * tagged with the wire that produced it so the other lane ignores it. Anthropic: the
 * response's content blocks (signed thinking blocks must return unmodified). The
 * OpenAI-compatible wire: DeepSeek's `reasoning_content`, which its thinking-mode guide
 * requires back on every later request that carries tools. The Responses API: every output
 * item of the response, in order — the encrypted reasoning items with the message and
 * function calls they belong to — opaque, to go back exactly as received.
 */
export type ProviderState =
  | { readonly wire: "anthropic"; readonly blocks: readonly unknown[] }
  | { readonly wire: "openai-compatible"; readonly reasoningContent: string }
  | { readonly wire: "openai-responses"; readonly items: readonly unknown[] };

/**
 * Marks the END of a cacheable prefix: everything up to and including this message.
 * Wire-only — the Anthropic lane turns it into `cache_control`, the two OpenAI lanes
 * (prefix caching is automatic there) drop it; it is never sent as content.
 */
interface Cacheable {
  readonly cacheBreakpoint?: true;
}

export interface SystemMessage extends Cacheable {
  readonly role: "system";
  readonly content: string;
}

export interface UserMessage extends Cacheable {
  readonly role: "user";
  readonly content: string;
}

export interface AssistantMessage extends Cacheable {
  readonly role: "assistant";
  /** May be empty when the turn only called tools. */
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly providerState?: ProviderState;
}

export interface ToolResultMessage extends Cacheable {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly content: string;
  /** Anthropic carries this as `is_error`; the OpenAI wire has no such field. */
  readonly isError?: boolean;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

/**
 * Token accounting as the provider reported it. Fields the provider did not report are
 * absent, never zero-filled or derived.
 */
export interface Usage {
  /** Every prompt token, cached or not — what counts toward the context window. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The part of `inputTokens` read from the prompt cache. */
  readonly cachedInputTokens?: number;
  /** The part of `inputTokens` written to the prompt cache. */
  readonly cacheWriteTokens?: number;
  /** The part of `outputTokens` spent on reasoning. */
  readonly reasoningTokens?: number;
}

/**
 * Why generation ended, normalised. Each lane maps only the reasons its vendor documents;
 * everything else is `unknown` (defensive pattern 6: "truncated" is not one condition).
 * - `finished`: a natural stop.
 * - `tool_calls`: the model wants tools run.
 * - `output_cap`: the configured output limit was reached.
 * - `context_window`: generation ran into the model's context window.
 * - `refused`: a refusal or content filter ended it.
 */
export type StopReason = "finished" | "tool_calls" | "output_cap" | "context_window" | "refused" | "unknown";

export interface ChatResult {
  /** All text the model produced, concatenated; empty when it only called tools. */
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly stopReason: StopReason;
  /** The vendor's own value, for the operator's log; absent when none arrived. */
  readonly rawStopReason?: string;
  readonly usage?: Usage;
  /** Echo this on the assistant message when the conversation continues. */
  readonly providerState?: ProviderState;
}

export interface RetryNotice {
  /** The attempt that just failed, counted from 1. */
  readonly attempt: number;
  readonly delayMs: number;
  readonly code: string;
}

export interface ChatOptions {
  readonly tools?: readonly ToolDefinition[];
  /** Ignored when no tools are offered: strict endpoints reject a choice without tools. */
  readonly toolChoice?: ToolChoice;
  /** Overrides the configured model for this call. */
  readonly model?: string;
  /** Overrides the configured effort for this call. */
  readonly reasoningEffort?: ReasoningEffort;
  /** Overrides the configured output cap for this call. */
  readonly maxOutputTokens?: number;
  /** Each piece of text as it arrives; the pieces concatenate to `content`. */
  readonly onTextDelta?: (text: string) => void;
  /**
   * Before each retry. Text already streamed by the failed attempt cannot be un-sent;
   * this is where a streaming caller resets its draft.
   */
  readonly onRetry?: (notice: RetryNotice) => void;
  readonly signal?: AbortSignal;
}

export interface LLMClient {
  chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
}

/** Parses a tool call's argument text. Empty text is a call with no arguments. */
export function parseToolInput(raw: string): ToolInput {
  if (raw.trim() === "") return { valid: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { valid: true, value: parsed as Record<string, unknown> };
    }
  } catch {
    // Falls through: malformed text is reported as such, not dropped.
  }
  return { valid: false, raw };
}

/** The argument text to send back for a call this server received. */
export function toolInputText(input: ToolInput): string {
  return input.valid ? JSON.stringify(input.value) : input.raw;
}
