// A canned `/embeddings` endpoint for the SDK's `fetch` injection point: it records what
// each request sent and answers from a queue. A pending answer honours the request's abort
// signal the way a real fetch does.

export interface SentRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export interface Canned {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  /** The JSON body to answer with. */
  readonly json?: unknown;
  /** A raw body, for answers that are not valid to build with `JSON.stringify` (`1e999`). */
  readonly text?: string;
  /** Never answer; wait for the request to be aborted. */
  readonly hang?: boolean;
  /** Fail the way a network failure does. */
  readonly networkError?: Error;
}

export class FakeEndpoint {
  readonly sent: SentRequest[] = [];
  readonly #queue: Canned[];

  constructor(answers: readonly Canned[]) {
    this.#queue = [...answers];
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const raw = typeof init?.body === "string" ? init.body : "";
    this.sent.push({ url, headers: new Headers(init?.headers), body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
    const next = this.#queue.shift();
    if (!next) throw new Error("fake endpoint: no answer queued");
    if (next.networkError) throw next.networkError;
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    if (next.hang) {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    return new Response(next.text ?? JSON.stringify(next.json ?? {}), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json", ...next.headers },
    });
  }) as typeof fetch;
}

/** An embeddings answer for `vectors`, items numbered as given by `order` (default: 0, 1, 2, …). */
export function answer(vectors: readonly (readonly number[])[], order?: readonly number[]): Canned {
  return {
    json: {
      object: "list",
      model: "m",
      usage: { prompt_tokens: 1, total_tokens: 1 },
      data: vectors.map((embedding, i) => ({ object: "embedding", index: order?.[i] ?? i, embedding })),
    },
  };
}
