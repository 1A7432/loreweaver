// A model that says what a test tells it to. Give it a script (one reply per call, in
// order; running past the end throws) or a responder. Every call is recorded. A reply is
// delivered in two slices when the caller asked for deltas, so accumulation is exercised.
import type { ChatMessage, ChatOptions, ChatResult, LLMClient, StopReason, ToolCall, Usage } from "./types.ts";

export interface ScriptedTurn {
  readonly content?: string;
  readonly toolCalls?: readonly ToolCall[];
  /** Defaults to `tool_calls` when there are tool calls, else `finished`. */
  readonly stopReason?: StopReason;
  readonly usage?: Usage;
  /** Thrown instead of replying — an LLMError to exercise a failure path. */
  readonly error?: unknown;
}

export type ScriptedReply = string | ScriptedTurn;

export type Responder = (messages: readonly ChatMessage[], options: ChatOptions) => ScriptedReply | Promise<ScriptedReply>;

export interface ScriptedRequest {
  readonly messages: readonly ChatMessage[];
  readonly options: ChatOptions;
}

let nextCallId = 1;

/** A tool call for a script, with a fresh id unless one is given. */
export function toolCall(name: string, args: Readonly<Record<string, unknown>> = {}, id?: string): ToolCall {
  return { id: id ?? `call_${nextCallId++}`, name, input: { valid: true, value: args } };
}

export class ScriptedLLM implements LLMClient {
  /** The messages of every call, in order. */
  readonly calls: (readonly ChatMessage[])[] = [];
  /** Every call with its options. */
  readonly requests: ScriptedRequest[] = [];
  readonly #script: ScriptedReply[] | undefined;
  readonly #responder: Responder | undefined;

  constructor(source: readonly ScriptedReply[] | Responder) {
    if (typeof source === "function") this.#responder = source;
    else this.#script = [...source];
  }

  async chat(messages: readonly ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    this.calls.push(messages);
    this.requests.push({ messages, options });
    options.signal?.throwIfAborted();
    let next: ScriptedReply | undefined;
    if (this.#responder) next = await this.#responder(messages, options);
    else next = this.#script?.shift();
    if (next === undefined) throw new Error("scripted model: no reply left for this call");
    const turn: ScriptedTurn = typeof next === "string" ? { content: next } : next;
    if (turn.error !== undefined) throw turn.error;
    const content = turn.content ?? "";
    const toolCalls = turn.toolCalls ?? [];
    if (options.onTextDelta && content.length > 0) {
      const characters = [...content];
      const middle = Math.max(1, Math.floor(characters.length / 2));
      options.onTextDelta(characters.slice(0, middle).join(""));
      const rest = characters.slice(middle).join("");
      if (rest.length > 0) options.onTextDelta(rest);
    }
    return {
      content,
      toolCalls,
      stopReason: turn.stopReason ?? (toolCalls.length > 0 ? "tool_calls" : "finished"),
      ...(turn.usage ? { usage: turn.usage } : {}),
    };
  }
}
