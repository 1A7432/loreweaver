// The Anthropic Messages API lane. Every call streams: one code path whether or not the
// caller wants deltas, and the SDK refuses large non-streaming requests anyway. Facts
// relied on, verified 2026-11-26 against node_modules/@anthropic-ai/sdk (1.14.0) typings
// and https://platform.claude.com/docs (context-windows, errors, models/overview):
// - `stop_reason` values and their meanings: messages.d.ts, `Message.stop_reason`.
// - `thinking: {type: "adaptive"}` + `output_config.effort` (low…max): messages.d.ts,
//   `ThinkingConfigAdaptive`, `OutputConfig`. Sampling parameters are not sent at all —
//   the SDK pins API version 2026-10-21 (client.js), on which they are a 400.
// - `cache_control: {type: "ephemeral"}` on content blocks: `CacheControlEphemeral`.
// - `max_tokens` is required; the smallest output cap of any listed model is 32K
//   (Claude Opus 4 / 4.1, models overview), so the default below fits every model.
import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageDeltaUsage,
  MessageParam,
  RawMessageStreamEvent,
  StopReason as AnthropicStopReason,
  TextBlockParam,
  Tool,
  ToolChoice as AnthropicToolChoice,
  Usage as AnthropicUsage,
} from "@anthropic-ai/sdk/resources/messages";

import { abortedError, fromAnthropicError } from "./errors.ts";
import {
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type LLMClient,
  parseToolInput,
  type ReasoningEffort,
  type StopReason,
  type ToolCall,
  type ToolChoice,
  type ToolDefinition,
  type Usage,
} from "./types.ts";

export const DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS = 32_000;

export interface AnthropicLaneSettings {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

const EPHEMERAL = { type: "ephemeral" } as const;

export class AnthropicLLM implements LLMClient {
  readonly #client: Anthropic;
  readonly #settings: AnthropicLaneSettings;

  constructor(settings: AnthropicLaneSettings) {
    this.#settings = settings;
    // A credential passed in code stops the SDK reading ANTHROPIC_API_KEY,
    // ANTHROPIC_AUTH_TOKEN or a login profile (client.js constructor); Bun loads `.env`,
    // so nothing ambient may decide what this client sends. Retries are ours.
    this.#client = new Anthropic({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
      maxRetries: 0,
      ...(settings.timeoutMs === undefined ? {} : { timeout: settings.timeoutMs }),
      ...(settings.fetch ? { fetch: settings.fetch } : {}),
    });
  }

  async chat(messages: readonly ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const { signal } = options;
    try {
      const stream = await this.#client.messages.create(this.#body(messages, options), signal ? { signal } : {});
      const reply = new ReplyAssembler(options.onTextDelta);
      for await (const event of stream) reply.add(event);
      // MEASURED (@anthropic-ai/sdk 1.14.0): aborting mid-stream ends this loop quietly,
      // as the openai SDK does, so the abort has to be raised here.
      if (signal?.aborted) throw abortedError("anthropic", signal.reason);
      return reply.result();
    } catch (error) {
      throw fromAnthropicError(error, signal);
    }
  }

  #body(messages: readonly ChatMessage[], options: ChatOptions): MessageCreateParamsStreaming {
    const { system, turns } = toWireMessages(messages);
    const body: MessageCreateParamsStreaming = {
      model: options.model ?? this.#settings.model,
      max_tokens: options.maxOutputTokens ?? this.#settings.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS,
      messages: turns,
      stream: true,
    };
    if (system.length > 0) body.system = system;
    const tools = options.tools ?? [];
    if (tools.length > 0) {
      body.tools = tools.map(toWireTool);
      if (options.toolChoice !== undefined) body.tool_choice = toWireToolChoice(options.toolChoice);
    }
    // Adaptive thinking is the only thinking mode current models accept, and on the ones
    // that think without being asked it is equivalent to leaving the field out; models
    // that do not think by default need it said. With no effort configured, neither field
    // is sent and each model runs at its own default.
    const effort = options.reasoningEffort ?? this.#settings.reasoningEffort;
    if (effort !== undefined) {
      body.thinking = { type: "adaptive" };
      body.output_config = { effort };
    }
    return body;
  }
}

/**
 * The leading system messages become the top-level `system` blocks. A system message
 * later in the conversation becomes user text: mid-conversation `role: "system"` is
 * accepted only by some models and is a 400 on the rest. Consecutive tool results share
 * one user turn — the documented shape for parallel tool calls.
 */
export function toWireMessages(messages: readonly ChatMessage[]): { system: TextBlockParam[]; turns: MessageParam[] } {
  const system: TextBlockParam[] = [];
  const turns: MessageParam[] = [];
  let leading = true;
  for (const message of messages) {
    if (message.role === "system" && leading) {
      // An empty text block is rejected, and there is nothing in it to cache.
      if (message.content !== "") system.push(textBlock(message.content, message.cacheBreakpoint));
      continue;
    }
    leading = false;
    switch (message.role) {
      case "system":
      case "user":
        turns.push({ role: "user", content: message.content === "" ? "" : [textBlock(message.content, message.cacheBreakpoint)] });
        break;
      case "tool": {
        const block: ContentBlockParam = {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
          ...(message.isError ? { is_error: true } : {}),
          ...(message.cacheBreakpoint ? { cache_control: EPHEMERAL } : {}),
        };
        const previous = turns.at(-1);
        if (previous?.role === "user" && Array.isArray(previous.content) && previous.content.every((part) => part.type === "tool_result")) {
          previous.content.push(block);
        } else {
          turns.push({ role: "user", content: [block] });
        }
        break;
      }
      case "assistant": {
        let blocks: ContentBlockParam[];
        if (message.providerState?.wire === "anthropic") {
          // Signed thinking blocks must return exactly as they came.
          blocks = message.providerState.blocks.map((block) => ({ ...(block as ContentBlockParam) }));
        } else {
          blocks = message.content === "" ? [] : [{ type: "text", text: message.content }];
          for (const call of message.toolCalls ?? []) {
            // The wire needs an object; a call whose arguments never parsed goes back
            // empty, and its tool result is where the caller says what went wrong.
            blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input.valid ? call.input.value : {} });
          }
        }
        if (message.cacheBreakpoint) markLastCacheable(blocks);
        turns.push({ role: "assistant", content: blocks.length > 0 ? blocks : "" });
        break;
      }
    }
  }
  return { system, turns };
}

function textBlock(text: string, breakpoint: true | undefined): TextBlockParam {
  return breakpoint ? { type: "text", text, cache_control: EPHEMERAL } : { type: "text", text };
}

// Thinking blocks cannot carry `cache_control`; the breakpoint goes on the last block that can.
function markLastCacheable(blocks: ContentBlockParam[]): void {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (!block || block.type === "thinking" || block.type === "redacted_thinking") continue;
    blocks[index] = { ...block, cache_control: EPHEMERAL } as ContentBlockParam;
    return;
  }
}

function toWireTool(tool: ToolDefinition): Tool {
  return { name: tool.name, description: tool.description, input_schema: { type: "object", ...tool.parameters } };
}

// `required` is Anthropic's `any`. Claude Opus 5.5, Sonnet 5.5 and Fable 5.1/5.2 answer a
// forced choice (`any` or a named tool) with a 400 (errors page); that arrives as
// `bad_request` rather than being silently rewritten here.
function toWireToolChoice(choice: ToolChoice): AnthropicToolChoice {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
}

const STOP_REASONS: Readonly<Record<AnthropicStopReason, StopReason>> = {
  end_turn: "finished",
  stop_sequence: "finished",
  tool_use: "tool_calls",
  // "we exceeded the requested `max_tokens` or the model's maximum" — an output cap either way.
  max_tokens: "output_cap",
  model_context_window_exceeded: "context_window",
  refusal: "refused",
  // A paused server-tool turn; this server declares no server tools.
  pause_turn: "unknown",
};

type Block = Record<string, unknown> & { type: string };

class ReplyAssembler {
  readonly #onTextDelta: ((text: string) => void) | undefined;
  readonly #blocks = new Map<number, Block>();
  readonly #toolJson = new Map<number, string>();
  #startUsage: AnthropicUsage | undefined;
  #deltaUsage: MessageDeltaUsage | undefined;
  #stop: string | undefined;

  constructor(onTextDelta: ((text: string) => void) | undefined) {
    this.#onTextDelta = onTextDelta;
  }

  add(event: RawMessageStreamEvent): void {
    switch (event.type) {
      case "message_start":
        this.#startUsage = event.message.usage;
        break;
      case "content_block_start": {
        const start = event.content_block;
        if (start.type === "text") this.#blocks.set(event.index, { type: "text", text: start.text });
        else if (start.type === "thinking") this.#blocks.set(event.index, { type: "thinking", thinking: start.thinking, signature: start.signature });
        else if (start.type === "tool_use") {
          this.#blocks.set(event.index, { type: "tool_use", id: start.id, name: start.name, input: {} });
          this.#toolJson.set(event.index, "");
        } else this.#blocks.set(event.index, { ...start });
        break;
      }
      case "content_block_delta": {
        const block = this.#blocks.get(event.index);
        if (!block) break;
        const delta = event.delta;
        if (delta.type === "text_delta") {
          block.text = `${String(block.text ?? "")}${delta.text}`;
          this.#onTextDelta?.(delta.text);
        } else if (delta.type === "input_json_delta") {
          this.#toolJson.set(event.index, `${this.#toolJson.get(event.index) ?? ""}${delta.partial_json}`);
        } else if (delta.type === "thinking_delta") {
          block.thinking = `${String(block.thinking ?? "")}${delta.thinking}`;
        } else if (delta.type === "signature_delta") {
          block.signature = delta.signature;
        }
        break;
      }
      case "content_block_stop":
        break;
      case "message_delta":
        if (event.delta.stop_reason) this.#stop = event.delta.stop_reason;
        this.#deltaUsage = event.usage;
        break;
      case "message_stop":
        break;
    }
  }

  result(): ChatResult {
    const ordered = [...this.#blocks.entries()].sort(([a], [b]) => a - b);
    const text: string[] = [];
    const toolCalls: ToolCall[] = [];
    const blocks: Block[] = [];
    for (const [index, block] of ordered) {
      if (block.type === "text") text.push(String(block.text ?? ""));
      if (block.type === "tool_use") {
        const input = parseToolInput(this.#toolJson.get(index) ?? "");
        toolCalls.push({ id: String(block.id), name: String(block.name), input });
        block.input = input.valid ? input.value : {};
      }
      blocks.push(block);
    }
    const usage = mergeUsage(this.#startUsage, this.#deltaUsage);
    const stopReason = this.#stop === undefined ? "unknown" : (STOP_REASONS[this.#stop as AnthropicStopReason] ?? "unknown");
    return {
      content: text.join(""),
      toolCalls,
      stopReason,
      ...(this.#stop !== undefined ? { rawStopReason: this.#stop } : {}),
      ...(usage ? { usage } : {}),
      ...(blocks.length > 0 ? { providerState: { wire: "anthropic" as const, blocks } } : {}),
    };
  }
}

/**
 * `message_start` carries the input side; `message_delta` carries cumulative counts in
 * which any field may be null. "Total input tokens in a request is the summation of
 * `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`"
 * (messages.d.ts, `RawMessageDeltaEvent.usage`).
 */
export function mergeUsage(start: AnthropicUsage | undefined, delta: MessageDeltaUsage | undefined): Usage | undefined {
  const input = delta?.input_tokens ?? start?.input_tokens;
  const output = delta?.output_tokens ?? start?.output_tokens;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  const read = delta?.cache_read_input_tokens ?? start?.cache_read_input_tokens ?? undefined;
  const written = delta?.cache_creation_input_tokens ?? start?.cache_creation_input_tokens ?? undefined;
  const thinking = delta?.output_tokens_details?.thinking_tokens ?? start?.output_tokens_details?.thinking_tokens;
  return {
    inputTokens: input + (read ?? 0) + (written ?? 0),
    outputTokens: output,
    ...(typeof read === "number" ? { cachedInputTokens: read } : {}),
    ...(typeof written === "number" ? { cacheWriteTokens: written } : {}),
    ...(typeof thinking === "number" ? { reasoningTokens: thinking } : {}),
  };
}
