// The model interface every provider implements, and the scripted stand-in tests use.

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
}

export interface ChatResult {
  readonly content: string;
  /** Absent when the provider reported none — never guessed. */
  readonly usage?: Usage;
}

export interface ChatOptions {
  /** Called with each piece of text as it arrives; the pieces concatenate to `content`. */
  readonly onTextDelta?: (text: string) => void;
  readonly signal?: AbortSignal;
}

export interface LLMClient {
  chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<ChatResult>;
}

export type Responder = (messages: readonly ChatMessage[]) => ChatResult | string;

/**
 * A model that says what a test tells it to. Give it a script (one reply per call, in
 * order; running past the end throws) or a responder. Every call is recorded. A reply is
 * delivered in two slices when the caller asked for deltas, so accumulation is exercised.
 */
export class ScriptedLLM implements LLMClient {
  readonly calls: (readonly ChatMessage[])[] = [];
  readonly #script: (ChatResult | string)[] | undefined;
  readonly #responder: Responder | undefined;

  constructor(source: readonly (ChatResult | string)[] | Responder) {
    if (typeof source === "function") this.#responder = source;
    else this.#script = [...source];
  }

  async chat(messages: readonly ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    this.calls.push(messages);
    options.signal?.throwIfAborted();
    let next: ChatResult | string | undefined;
    if (this.#responder) next = this.#responder(messages);
    else next = this.#script?.shift();
    if (next === undefined) throw new Error("scripted model: no reply left for this call");
    const result = typeof next === "string" ? { content: next } : next;
    if (options.onTextDelta && result.content.length > 0) {
      const characters = [...result.content];
      const middle = Math.max(1, Math.floor(characters.length / 2));
      options.onTextDelta(characters.slice(0, middle).join(""));
      const rest = characters.slice(middle).join("");
      if (rest.length > 0) options.onTextDelta(rest);
    }
    return result;
  }
}
