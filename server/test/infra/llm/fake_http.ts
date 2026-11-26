// A canned HTTP endpoint for the SDKs' `fetch` injection point: it records what each
// request sent and answers from a queue. Bodies honour the request's abort signal the way
// a real fetch body does, so mid-stream aborts behave as they would on the network.

export interface SentRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
  readonly rawBody: string;
}

export interface CannedResponse {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  /** SSE event strings for a 200, or a JSON body for an error. */
  readonly events?: readonly string[];
  readonly json?: unknown;
  /** Keep the stream open after the events, until the request aborts. */
  readonly hang?: boolean;
  /** Called once the events are written; for aborting mid-stream. */
  readonly afterEvents?: () => void;
  /** Throw from fetch itself — a network failure. */
  readonly networkError?: Error;
}

export class FakeHttp {
  readonly sent: SentRequest[] = [];
  readonly #queue: CannedResponse[];

  constructor(responses: readonly CannedResponse[]) {
    this.#queue = [...responses];
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const rawBody = typeof init?.body === "string" ? init.body : "";
    this.sent.push({ url, headers: new Headers(init?.headers), body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {}, rawBody });
    const next = this.#queue.shift();
    if (!next) throw new Error("fake http: no response queued");
    if (next.networkError) throw next.networkError;
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    if (next.json !== undefined || (next.status ?? 200) !== 200) {
      return new Response(JSON.stringify(next.json ?? {}), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json", ...next.headers },
      });
    }
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of next.events ?? []) controller.enqueue(encoder.encode(event));
        signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
        if (!next.hang) controller.close();
        if (next.afterEvents) setTimeout(next.afterEvents, 5);
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", ...next.headers } });
  }) as typeof fetch;
}

/** One `data:` SSE event (the OpenAI wire), or `data: [DONE]`. */
export function data(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

/** One named SSE event (the Anthropic wire). */
export function event(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}
