// The OpenAI-compatible chat-completions lane: OpenAI itself and every vendor that speaks
// its wire (DeepSeek, OpenRouter, Moonshot, a self-hosted endpoint, …). Every call streams:
// one code path whether or not the caller wants deltas, and usage is always requested,
// because a stream reports usage only when asked (`stream_options.include_usage`;
// defensive pattern 4) and the context meter depends on it.
import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";
import type { CompletionUsage } from "openai/resources/completions";

import { abortedError, fromOpenAIError } from "./errors.ts";
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
  toolInputText,
  type Usage,
} from "./types.ts";

export interface OpenAILaneSettings {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort;
  /** Sent as `max_completion_tokens` only when set; vendors differ on the default. */
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  /** The SDK's injection point; tests hand it canned responses. */
  readonly fetch?: typeof fetch;
}

// The SDK refuses to construct without a credential, and a self-hosted endpoint may need
// none. This placeholder is what such an endpoint receives instead of nothing.
const NO_KEY = "no-key";

export class OpenAICompatibleLLM implements LLMClient {
  readonly #client: OpenAI;
  readonly #settings: OpenAILaneSettings;

  constructor(settings: OpenAILaneSettings) {
    this.#settings = settings;
    // Every value the SDK would otherwise read from the environment is given explicitly:
    // Bun loads `.env`, and an ambient OPENAI_API_KEY must never be sent to a third-party
    // base URL. Retries are ours (retry.ts), so the SDK's are off.
    this.#client = new OpenAI({
      apiKey: settings.apiKey || NO_KEY,
      baseURL: settings.baseUrl,
      organization: null,
      project: null,
      adminAPIKey: null,
      webhookSecret: null,
      maxRetries: 0,
      ...(settings.timeoutMs === undefined ? {} : { timeout: settings.timeoutMs }),
      ...(settings.fetch ? { fetch: settings.fetch } : {}),
    });
  }

  async chat(messages: readonly ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const { signal } = options;
    try {
      const stream = await this.#client.chat.completions.create(this.#body(messages, options), signal ? { signal } : {});
      const reply = new ReplyAssembler(options.onTextDelta);
      for await (const chunk of stream) reply.add(chunk);
      // MEASURED (openai 7.65.0): aborting mid-stream ends this loop quietly rather than
      // throwing, so without this check an aborted reply would look complete.
      if (signal?.aborted) throw abortedError("openai-compatible", signal.reason);
      return reply.result();
    } catch (error) {
      throw fromOpenAIError(error, signal);
    }
  }

  #body(messages: readonly ChatMessage[], options: ChatOptions): ChatCompletionCreateParamsStreaming {
    const body: ChatCompletionCreateParamsStreaming = {
      model: options.model ?? this.#settings.model,
      messages: messages.map(toWireMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    const tools = options.tools ?? [];
    if (tools.length > 0) {
      body.tools = tools.map(toWireTool);
      if (options.toolChoice !== undefined) body.tool_choice = toWireToolChoice(options.toolChoice);
    }
    const effort = options.reasoningEffort ?? this.#settings.reasoningEffort;
    if (effort !== undefined) body.reasoning_effort = effort;
    const cap = options.maxOutputTokens ?? this.#settings.maxOutputTokens;
    if (cap !== undefined) body.max_completion_tokens = cap;
    return body;
  }
}

// Built field by field, so the cache marker and anything else of ours cannot leak onto
// the wire; a vendor rejects unknown message properties.
function toWireMessage(message: ChatMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    case "assistant": {
      const calls = message.toolCalls ?? [];
      const wire: Record<string, unknown> = { role: "assistant", content: message.content === "" && calls.length > 0 ? null : message.content };
      if (calls.length > 0) {
        wire.tool_calls = calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: toolInputText(call.input) } }));
      }
      // DeepSeek's thinking mode: "for requests carrying `tools`, `reasoning_content` must
      // be fully passed back to the API in all subsequent requests", or the API returns a
      // 400 (https://api-docs.deepseek.com/guides/thinking_mode, read 2026-11-26). Sent
      // only when that vendor produced it, so other endpoints never see the field.
      if (message.providerState?.wire === "openai-compatible") wire.reasoning_content = message.providerState.reasoningContent;
      return wire as unknown as ChatCompletionMessageParam;
    }
  }
}

function toWireTool(tool: ToolDefinition): ChatCompletionTool {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: { ...tool.parameters } } };
}

function toWireToolChoice(choice: ToolChoice): ChatCompletionToolChoiceOption {
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

// `finish_reason` as node_modules/openai/resources/chat/completions/completions.d.ts
// documents it: `stop` (natural stop or stop sequence), `length` ("the maximum number of
// tokens specified in the request was reached" — the configured cap, not the window),
// `tool_calls`, `content_filter`. `function_call` is the deprecated pre-tools form this
// server never requests; it and any vendor extension map to `unknown`.
const STOP_REASONS: Readonly<Record<string, StopReason>> = {
  stop: "finished",
  length: "output_cap",
  tool_calls: "tool_calls",
  content_filter: "refused",
};

interface ToolSlot {
  id: string;
  name: string;
  arguments: string;
}

class ReplyAssembler {
  readonly #onTextDelta: ((text: string) => void) | undefined;
  readonly #text: string[] = [];
  readonly #reasoning: string[] = [];
  readonly #slots = new Map<number, ToolSlot>();
  #finish: string | undefined;
  #usage: Usage | undefined;

  constructor(onTextDelta: ((text: string) => void) | undefined) {
    this.#onTextDelta = onTextDelta;
  }

  add(chunk: ChatCompletionChunk): void {
    // Read before looking at choices: OpenAI's usage chunk has an empty `choices`, while
    // DeepSeek puts usage on its last content chunk. Every other chunk carries `null`.
    if (chunk.usage) this.#usage = parseUsage(chunk.usage);
    const choice = chunk.choices[0];
    if (!choice) return;
    const delta = choice.delta as ChatCompletionChunk.Choice.Delta & { reasoning_content?: string | null };
    if (delta.content) {
      this.#text.push(delta.content);
      this.#onTextDelta?.(delta.content);
    }
    if (delta.reasoning_content) this.#reasoning.push(delta.reasoning_content);
    for (const call of delta.tool_calls ?? []) {
      let slot = this.#slots.get(call.index);
      if (!slot) {
        slot = { id: "", name: "", arguments: "" };
        this.#slots.set(call.index, slot);
      }
      if (call.id) slot.id = call.id;
      if (call.function?.name) slot.name = call.function.name;
      if (call.function?.arguments) slot.arguments += call.function.arguments;
    }
    if (choice.finish_reason) this.#finish = choice.finish_reason;
  }

  result(): ChatResult {
    const toolCalls: ToolCall[] = [...this.#slots.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, slot]) => ({ id: slot.id, name: slot.name, input: parseToolInput(slot.arguments) }));
    const reasoning = this.#reasoning.join("");
    return {
      content: this.#text.join(""),
      toolCalls,
      stopReason: (this.#finish !== undefined ? STOP_REASONS[this.#finish] : undefined) ?? "unknown",
      ...(this.#finish !== undefined ? { rawStopReason: this.#finish } : {}),
      ...(this.#usage ? { usage: this.#usage } : {}),
      ...(reasoning ? { providerState: { wire: "openai-compatible" as const, reasoningContent: reasoning } } : {}),
    };
  }
}

/** `CompletionUsage` (node_modules/openai/resources/completions.d.ts); absent stays absent. */
export function parseUsage(usage: CompletionUsage): Usage | undefined {
  if (typeof usage.prompt_tokens !== "number" || typeof usage.completion_tokens !== "number") return undefined;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  const written = usage.prompt_tokens_details?.cache_write_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    ...(typeof cached === "number" ? { cachedInputTokens: cached } : {}),
    ...(typeof written === "number" ? { cacheWriteTokens: written } : {}),
    ...(typeof reasoning === "number" ? { reasoningTokens: reasoning } : {}),
  };
}
