// The OpenAI Responses API lane (`POST /v1/responses`): OpenAI itself and xAI's Grok models.
// It exists for one reason the Chat Completions lane cannot meet: a reasoning model's
// thinking has to travel with the conversation, and only this wire has a field for it.
//   - xAI: "Use the Responses API … The Chat Completions API is deprecated, and it has no
//     field for the model's encrypted reasoning"; "Send the encrypted reasoning back
//     unchanged. For reasoning models, leaving it out is the most common cause of cache
//     misses." https://docs.x.ai/developers/model-capabilities/text/best-practices
//     (updated 2026-11-23, read 2026-11-27).
//   - OpenAI: "any reasoning items returned in model responses with tool calls must also be
//     passed back with tool call outputs." https://developers.openai.com/api/docs/guides/
//     function-calling (read 2026-11-27).
//
// STATELESS. Nothing of a conversation is kept on the vendor's side: `store: false`, never
// `previous_response_id`, and every request carries the whole conversation as input items.
// Both vendors document exactly this route — xAI: "Manage the history yourself with
// `store: false`. Request the reasoning with `include: ["reasoning.encrypted_content"]`
// and append every output item to the next request's `input`" (best-practices, above);
// "send include: ["reasoning.encrypted_content"] on every request"
// (https://docs.x.ai/developers/advanced-api-usage/troubleshooting-reasoning, read
// 2026-11-27). OpenAI: the `include` value "enables reasoning items to be used in
// multi-turn conversations when using the Responses API statelessly (like when the `store`
// parameter is set to `false` …)" (node_modules/openai/resources/responses/responses.d.ts,
// `ResponseCreateParamsBase.include`, openai 7.65.0, read 2026-11-27); its reasoning guide
// calls the value legacy but still accepted (https://developers.openai.com/api/docs/guides/
// reasoning, read 2026-11-27). xAI's grok-4.6 and grok-4.5 return the ciphertext ONLY when
// asked (troubleshooting page), so `include` is always sent.
//
// Every call streams, like the other lanes; usage arrives on the terminal
// `response.completed` / `response.incomplete` event without being asked for.
import OpenAI from "openai";
import type {
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseInputItem,
  ResponseStreamEvent,
  ResponseUsage,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from "openai/resources/responses/responses";

import { currentLane } from "./accounting.ts";
import { abortedError, fromResponsesError, responsesStreamFailure } from "./errors.ts";
import { type OpenAILaneSettings, promptCacheKey } from "./openai.ts";
import {
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type LLMClient,
  parseToolInput,
  type StopReason,
  type ToolCall,
  type ToolChoice,
  type ToolDefinition,
  toolInputText,
  type Usage,
} from "./types.ts";

/**
 * The same knobs as the Chat Completions lane. `maxOutputTokens` is sent as
 * `max_output_tokens`, which the two vendors COUNT DIFFERENTLY: OpenAI's includes reasoning
 * tokens ("including visible output tokens and reasoning tokens" — responses.d.ts), xAI's
 * "caps only the visible answer; reasoning and function call tokens do not count toward it"
 * (best-practices, above). The same number therefore buys more on xAI.
 */
export type ResponsesLaneSettings = OpenAILaneSettings;

// The SDK refuses to construct without a credential; a self-hosted endpoint may need none.
const NO_KEY = "no-key";

const ENCRYPTED_REASONING = "reasoning.encrypted_content" as const;

export class OpenAIResponsesLLM implements LLMClient {
  readonly #client: OpenAI;
  readonly #settings: ResponsesLaneSettings;

  constructor(settings: ResponsesLaneSettings) {
    this.#settings = settings;
    // As in openai.ts: every ambient value the SDK would read from the environment is given
    // explicitly (Bun loads `.env`; an OPENAI_API_KEY must never reach a third-party base
    // URL), and the SDK's retries are off because retry.ts owns them.
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
      const stream = await this.#client.responses.create(this.#body(messages, options), signal ? { signal } : {});
      const reply = new ReplyAssembler(options.onTextDelta);
      for await (const event of stream) reply.add(event);
      // MEASURED (openai 7.65.0, test "aborting mid-stream …"): as on the Chat Completions
      // stream, aborting ends this loop quietly instead of throwing — the SDK's SSE reader
      // swallows a transport abort (core/streaming.js, `isTransportAbortError`) — so an
      // aborted reply would otherwise look complete.
      if (signal?.aborted) throw abortedError("openai-responses", signal.reason);
      return reply.result();
    } catch (error) {
      throw fromResponsesError(error, signal);
    }
  }

  #body(messages: readonly ChatMessage[], options: ChatOptions): ResponseCreateParamsStreaming {
    const body: ResponseCreateParamsStreaming = {
      model: options.model ?? this.#settings.model,
      input: messages.flatMap(toInputItems),
      stream: true,
      store: false,
      include: [ENCRYPTED_REASONING],
    };
    const tools = options.tools ?? [];
    if (tools.length > 0) {
      body.tools = tools.map(toWireTool);
      if (options.toolChoice !== undefined) body.tool_choice = toWireToolChoice(options.toolChoice);
    }
    // `reasoning.effort`: OpenAI "Not all reasoning models support every value"
    // (node_modules/openai/resources/shared.d.ts, `Reasoning.effort`); xAI "The supported
    // values and the default depend on the model" (best-practices, above), and a
    // non-reasoning Grok model refuses the parameter outright. So it is sent only when the
    // operator configured it — never a default of ours.
    const effort = options.reasoningEffort ?? this.#settings.reasoningEffort;
    if (effort !== undefined) body.reasoning = { effort };
    const cap = options.maxOutputTokens ?? this.#settings.maxOutputTokens;
    if (cap !== undefined) body.max_output_tokens = cap;
    // The same routing key, digest and off switch as the Chat Completions lane (openai.ts
    // `promptCacheKey`). On this endpoint too: OpenAI `ResponseCreateParamsBase
    // .prompt_cache_key` (responses.d.ts); xAI "routes requests with the same key to the
    // same server" with a `responses.create` example
    // (https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits,
    // updated 2026-11-23, read 2026-11-27).
    const cacheKey = this.#settings.promptCacheKey === false ? undefined : promptCacheKey(currentLane());
    if (cacheKey !== undefined) body.prompt_cache_key = cacheKey;
    return body;
  }
}

/**
 * One message as input items, built field by field so nothing of ours (the cache marker,
 * `isError`) reaches the wire; caching here is automatic and prefix-based, so
 * `cacheBreakpoint` has nothing to become.
 *
 * System text stays a `role: "system"` input message IN PLACE rather than moving to
 * `instructions`: both caches match "your input from the start" (xAI best-practices,
 * "Put static content first"), xAI's own stateless examples send the system prompt as the
 * first input message, OpenAI's `EasyInputMessage.role` admits `system` (responses.d.ts),
 * and `instructions` holds a single string — a later system message (the Keeper's trailing
 * state) would have nowhere to go and the order of the prefix would change.
 *
 * An assistant message this wire produced goes back as its output items exactly as
 * received, in their original order (reasoning, text, function calls) — xAI: "keep every
 * item of each response's `output` array exactly as it arrived … Real items carry more
 * fields than shown here. Send all of them back." (troubleshooting page); "edits,
 * reorders, or filters output items" is how code drops reasoning (best-practices). OpenAI's
 * reasoning guide likewise: "preserve every output item". The same objects are passed on,
 * never rebuilt. Any other assistant message — a foreign wire's, or one replayed from a
 * record — is rebuilt from its text and calls, and a foreign state is not sent.
 */
function toInputItems(message: ChatMessage): ResponseInputItem[] {
  switch (message.role) {
    case "system":
      return [{ role: "system", content: message.content }];
    case "user":
      return [{ role: "user", content: message.content }];
    case "tool":
      // No error flag on this wire; the content says what went wrong.
      return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
    case "assistant": {
      if (message.providerState?.wire === "openai-responses") return message.providerState.items as ResponseInputItem[];
      const items: ResponseInputItem[] = message.content === "" ? [] : [{ role: "assistant", content: message.content }];
      for (const call of message.toolCalls ?? []) {
        items.push({ type: "function_call", call_id: call.id, name: call.name, arguments: toolInputText(call.input) });
      }
      return items;
    }
  }
}

// `strict: false` keeps the Chat Completions lane's semantics. OpenAI: "Responses requests
// will attempt to normalize your schema into strict mode when possible … To keep non-strict
// behavior in Responses, you can explicitly set `strict: false`" (function-calling guide,
// above). xAI: `strict` is "Not supported. Only maintained for compatibility reasons."
// (https://docs.x.ai/openapi.json, `FunctionDefinition`, read 2026-11-27). The SDK types the
// field as required.
function toWireTool(tool: ToolDefinition): FunctionTool {
  return { type: "function", name: tool.name, description: tool.description, parameters: { ...tool.parameters }, strict: false };
}

// Both vendors: the strings `none` / `auto` / `required`, or `{type: "function", name}`
// (responses.d.ts `ToolChoiceOptions`, `ToolChoiceFunction`; xAI openapi.json
// `ModelToolChoice`, read 2026-11-27).
function toWireToolChoice(choice: ToolChoice): ToolChoiceOptions | ToolChoiceFunction {
  if (typeof choice === "string") return choice;
  return { type: "function", name: choice.name };
}

/**
 * `incomplete_details.reason`, mapped only where a vendor defines it:
 * - `max_output_tokens` (both): OpenAI's reasoning guide says it fires when "the generated
 *   tokens reach the context window limit or the `max_output_tokens` value you've set" —
 *   one code for both, so it cannot be told apart and is read as the cap it is named for
 *   (defensive pattern 6).
 * - `max_prompt_tokens` (xAI only; openapi.json `IncompleteDetails`): "The model's context
 *   window was exhausted mid-generation (xAI extension)" — xAI's own client,
 *   https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-sampler/src/
 *   stream/responses.rs (read 2026-11-27).
 * - `content_filter` (both): a moderation cut.
 * Not mapped: xAI's `max_time_limit` (a server time limit — neither cap nor window) and
 * OpenAI's `max_messages` and `steered` (responses.d.ts `Response.IncompleteDetails`).
 */
const INCOMPLETE_REASONS: Readonly<Record<string, StopReason>> = {
  max_output_tokens: "output_cap",
  max_prompt_tokens: "context_window",
  content_filter: "refused",
};

type Item = Record<string, unknown> & { readonly type?: unknown };

interface Final {
  readonly status: string | undefined;
  readonly incompleteReason: string | undefined;
  readonly output: readonly Item[];
  readonly usage: Usage | undefined;
}

class ReplyAssembler {
  readonly #onTextDelta: ((text: string) => void) | undefined;
  readonly #text: string[] = [];
  /** Output items by `output_index`, as they stream; a `done` item replaces its draft. */
  readonly #items = new Map<number, Item>();
  /** Function-call arguments by `output_index`, assembled from the deltas. */
  readonly #arguments = new Map<number, string>();
  #final: Final | undefined;

  constructor(onTextDelta: ((text: string) => void) | undefined) {
    this.#onTextDelta = onTextDelta;
  }

  // Event names and shapes: responses.d.ts `ResponseStreamEvent` (openai 7.65.0).
  add(event: ResponseStreamEvent): void {
    switch (event.type) {
      case "response.output_item.added": {
        const item = event.item as unknown as Item;
        this.#items.set(event.output_index, item);
        if (item.type === "function_call") this.#arguments.set(event.output_index, typeof item.arguments === "string" ? item.arguments : "");
        break;
      }
      case "response.output_text.delta":
        this.#text.push(event.delta);
        this.#onTextDelta?.(event.delta);
        break;
      case "response.function_call_arguments.delta":
        this.#arguments.set(event.output_index, `${this.#arguments.get(event.output_index) ?? ""}${event.delta}`);
        break;
      case "response.function_call_arguments.done":
        this.#arguments.set(event.output_index, event.arguments);
        break;
      case "response.output_item.done": {
        // "use the completed reasoning item and its `encrypted_content` from the
        // `response.output_item.done` event … The `encrypted_content` in
        // `response.output_item.added` may be incomplete." (responses.d.ts, `ResponseReasoningItem`)
        const item = event.item as unknown as Item;
        this.#items.set(event.output_index, item);
        if (item.type === "function_call" && typeof item.arguments === "string") this.#arguments.set(event.output_index, item.arguments);
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        // xAI: "When you stream, take the items from the final `response.completed` or
        // `response.incomplete` event" (troubleshooting page).
        const response = event.response;
        const output = Array.isArray(response.output) ? (response.output as unknown as Item[]) : [];
        this.#final = {
          status: typeof response.status === "string" ? response.status : undefined,
          incompleteReason: typeof response.incomplete_details?.reason === "string" ? response.incomplete_details.reason : undefined,
          output,
          usage: response.usage ? parseResponsesUsage(response.usage) : undefined,
        };
        break;
      }
      case "response.failed": {
        const failure = event.response.error;
        throw responsesStreamFailure(failure?.code, failure?.message ?? "response.failed", event);
      }
      case "error":
        // Reached only when the SDK did not already raise it (it throws on an SSE event
        // NAMED `error` — core/streaming.js — but yields a bare `{type: "error"}` payload).
        throw responsesStreamFailure(event.code, event.message, event);
      default:
        break;
    }
  }

  result(): ChatResult {
    const items = this.#outputItems();
    const toolCalls: ToolCall[] = [];
    const text: string[] = [];
    let refused = false;
    for (const item of items) {
      if (item.type === "function_call") {
        toolCalls.push({ id: String(item.call_id ?? ""), name: String(item.name ?? ""), input: parseToolInput(typeof item.arguments === "string" ? item.arguments : "") });
      } else if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content as Item[]) {
          if (part.type === "output_text" && typeof part.text === "string") text.push(part.text);
          if (part.type === "refusal") refused = true;
        }
      }
    }
    const { stopReason, raw } = this.#stop(toolCalls.length > 0, refused);
    const usage = this.#final?.usage;
    return {
      // The streamed pieces are what the caller already showed; they must concatenate to
      // `content`. Only a reply that streamed no text falls back to the items' text.
      content: this.#text.length > 0 ? this.#text.join("") : text.join(""),
      toolCalls,
      stopReason,
      ...(raw !== undefined ? { rawStopReason: raw } : {}),
      ...(usage ? { usage } : {}),
      ...(items.length > 0 ? { providerState: { wire: "openai-responses" as const, items } } : {}),
    };
  }

  /** The terminal event's output when it carried one, else the items as they streamed. */
  #outputItems(): Item[] {
    if (this.#final && this.#final.output.length > 0) return [...this.#final.output];
    return [...this.#items.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, item]) => {
        const assembled = this.#arguments.get(index);
        // A call whose `done` never came: its draft gets the assembled arguments.
        return item.type === "function_call" && assembled !== undefined && item.arguments !== assembled ? { ...item, arguments: assembled } : item;
      });
  }

  // `status`: responses.d.ts `ResponseStatus`; xAI documents `completed`, `in_progress`,
  // `incomplete` (openapi.json `ModelResponse.status`). A refusal is a documented content
  // part (`ResponseOutputRefusal`). Anything else, or no terminal event at all, is `unknown`.
  #stop(hasCalls: boolean, refused: boolean): { stopReason: StopReason; raw: string | undefined } {
    const final = this.#final;
    if (final === undefined) return { stopReason: "unknown", raw: undefined };
    if (final.status === "completed") return { stopReason: hasCalls ? "tool_calls" : refused ? "refused" : "finished", raw: "completed" };
    if (final.status === "incomplete") {
      const reason = final.incompleteReason;
      return { stopReason: (reason !== undefined ? INCOMPLETE_REASONS[reason] : undefined) ?? "unknown", raw: reason ?? "incomplete" };
    }
    return { stopReason: "unknown", raw: final.status };
  }
}

/**
 * `ResponseUsage` (responses.d.ts): `input_tokens` with `input_tokens_details.cached_tokens`
 * ("A detailed breakdown of the input tokens" — the cached part is INSIDE the input count)
 * and `cache_write_tokens`, `output_tokens` with `output_tokens_details.reasoning_tokens`.
 * xAI reports the same names (openapi.json `ModelUsage`, `InputTokensDetails`,
 * `OutputTokensDetails`), without `cache_write_tokens`. Absent stays absent.
 */
export function parseResponsesUsage(usage: ResponseUsage): Usage | undefined {
  if (typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") return undefined;
  const cached = usage.input_tokens_details?.cached_tokens;
  const written = usage.input_tokens_details?.cache_write_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(typeof cached === "number" ? { cachedInputTokens: cached } : {}),
    ...(typeof written === "number" ? { cacheWriteTokens: written } : {}),
    ...(typeof reasoning === "number" ? { reasoningTokens: reasoning } : {}),
  };
}
