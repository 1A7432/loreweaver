import { expect, test } from "bun:test";

import { type ChatMessage, LLMError, OpenAIResponsesLLM, type ToolDefinition, withLane } from "../../../src/infra/llm/index.ts";
import { type CannedResponse, data, event, FakeHttp } from "./fake_http.ts";

const BASE = "https://llm.example.test/v1";

function lane(http: FakeHttp, extra: { reasoningEffort?: "high"; maxOutputTokens?: number } = {}): OpenAIResponsesLLM {
  return new OpenAIResponsesLLM({ baseUrl: BASE, apiKey: "test-key", model: "m-default", fetch: http.fetch, ...extra });
}

const TOOL: ToolDefinition = { name: "roll", description: "Roll dice.", parameters: { type: "object", properties: { expr: { type: "string" } } } };

let sequence = 0;

/** One named SSE event, as both vendors stream this wire. */
function ev(type: string, payload: Record<string, unknown> = {}): string {
  return event(type, { type, sequence_number: sequence++, ...payload });
}

function response(status: string, output: unknown[] = [], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "resp_1", object: "response", created_at: 1, model: "m", status, output, error: null, incomplete_details: null, ...extra };
}

function completed(output: unknown[] = [], extra: Record<string, unknown> = {}): string {
  return ev("response.completed", { response: response("completed", output, extra) });
}

function incomplete(reason: string | null, output: unknown[] = []): string {
  return ev("response.incomplete", { response: response("incomplete", output, { incomplete_details: reason === null ? null : { reason } }) });
}

function message(text: string, id = "msg_1"): Record<string, unknown> {
  return { type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [], logprobs: [] }] };
}

function textReply(text: string): CannedResponse {
  return { events: [ev("response.output_text.delta", { output_index: 0, content_index: 0, item_id: "msg_1", delta: text, logprobs: [] }), completed([message(text)])] };
}

const USAGE = { input_tokens: 120, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 150 };

test("the request: streamed, stateless, encrypted reasoning asked for, every message kind as input items in order, no marker of ours", async () => {
  const http = new FakeHttp([textReply("ok")]);
  const messages: ChatMessage[] = [
    { role: "system", content: "You are the Keeper.", cacheBreakpoint: true },
    { role: "user", content: "I roll.", cacheBreakpoint: true },
    { role: "assistant", content: "Rolling.", toolCalls: [{ id: "t1", name: "roll", input: { valid: true, value: { expr: "1d6" } } }] },
    { role: "tool", toolCallId: "t1", content: "4", isError: true },
    { role: "assistant", content: "", toolCalls: [{ id: "t2", name: "roll", input: { valid: false, raw: "{oops" } }] },
    { role: "tool", toolCallId: "t2", content: "bad arguments" },
    { role: "system", content: "State: night." },
    { role: "user", content: "Again." },
  ];
  await lane(http, { reasoningEffort: "high", maxOutputTokens: 900 }).chat(messages, { tools: [TOOL], toolChoice: "required", model: "m-override" });
  const sent = http.sent[0];
  expect(sent?.url).toBe(`${BASE}/responses`);
  expect(sent?.headers.get("authorization")).toBe("Bearer test-key");
  expect(sent?.body).toEqual({
    model: "m-override",
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "high" },
    max_output_tokens: 900,
    tools: [{ type: "function", name: "roll", description: "Roll dice.", parameters: TOOL.parameters, strict: false }],
    tool_choice: "required",
    input: [
      { role: "system", content: "You are the Keeper." },
      { role: "user", content: "I roll." },
      { role: "assistant", content: "Rolling." },
      { type: "function_call", call_id: "t1", name: "roll", arguments: '{"expr":"1d6"}' },
      { type: "function_call_output", call_id: "t1", output: "4" },
      { type: "function_call", call_id: "t2", name: "roll", arguments: "{oops" },
      { type: "function_call_output", call_id: "t2", output: "bad arguments" },
      { role: "system", content: "State: night." },
      { role: "user", content: "Again." },
    ],
  });
  expect(sent?.rawBody).not.toContain("cacheBreakpoint");
  expect(sent?.rawBody).not.toContain("isError");
  expect(sent?.body).not.toHaveProperty("previous_response_id");
  expect(sent?.body).not.toHaveProperty("instructions");
});

test("a named tool choice; no tools, tool choice, effort or cap when none are set", async () => {
  const http = new FakeHttp([textReply("a"), textReply("b")]);
  const llm = lane(http);
  await llm.chat([{ role: "user", content: "x" }], { tools: [TOOL], toolChoice: { name: "roll" } });
  expect(http.sent[0]?.body.tool_choice).toEqual({ type: "function", name: "roll" });
  await llm.chat([{ role: "user", content: "x" }], { toolChoice: "none" });
  for (const key of ["tool_choice", "tools", "reasoning", "max_output_tokens", "prompt_cache_key"]) expect(http.sent[1]?.body).not.toHaveProperty(key);
});

// The item shapes are xAI's own example (troubleshooting-reasoning) plus a field this server
// does not know, which must survive the trip.
const REASONING = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "Hfq+g7jQ...4QfQnY==", status: "completed", vendor_extra: { kept: [1, "two"] } };
const CALL = { type: "function_call", id: "fc_1", call_id: "call-5faadddf-0", name: "roll", arguments: '{"expr":"2d6"}', status: "completed" };

test("reasoning items go back byte for byte, in their original place, across a two-request tool loop", async () => {
  const http = new FakeHttp([
    {
      events: [
        ev("response.created", { response: response("in_progress") }),
        ev("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "Hfq+" } }),
        ev("response.output_item.done", { output_index: 0, item: REASONING }),
        ev("response.output_item.added", { output_index: 1, item: { ...CALL, arguments: "", status: "in_progress" } }),
        ev("response.function_call_arguments.delta", { output_index: 1, item_id: "fc_1", delta: '{"expr"' }),
        ev("response.function_call_arguments.delta", { output_index: 1, item_id: "fc_1", delta: ':"2d6"}' }),
        ev("response.function_call_arguments.done", { output_index: 1, item_id: "fc_1", arguments: '{"expr":"2d6"}' }),
        ev("response.output_item.done", { output_index: 1, item: CALL }),
        completed([REASONING, CALL], { usage: USAGE }),
      ],
    },
    textReply("Seven."),
  ]);
  const llm = lane(http);
  const first = await llm.chat([{ role: "user", content: "Roll for me." }], { tools: [TOOL] });
  expect(first.stopReason).toBe("tool_calls");
  expect(first.toolCalls).toEqual([{ id: "call-5faadddf-0", name: "roll", input: { valid: true, value: { expr: "2d6" } } }]);
  expect(first.providerState).toEqual({ wire: "openai-responses", items: [REASONING, CALL] });

  await llm.chat(
    [
      { role: "user", content: "Roll for me." },
      { role: "assistant", content: first.content, toolCalls: first.toolCalls, ...(first.providerState ? { providerState: first.providerState } : {}) },
      { role: "tool", toolCallId: "call-5faadddf-0", content: "7" },
    ],
    { tools: [TOOL] },
  );
  const input = http.sent[1]?.body.input as unknown[];
  expect(input).toEqual([{ role: "user", content: "Roll for me." }, REASONING, CALL, { type: "function_call_output", call_id: "call-5faadddf-0", output: "7" }]);
  // Byte for byte: the exact serialisation of each item as it arrived, reasoning before its call.
  const raw = http.sent[1]?.rawBody ?? "";
  expect(raw).toContain(`${JSON.stringify(REASONING)},${JSON.stringify(CALL)}`);
});

test("without items on the terminal event, the streamed `done` items are what goes back", async () => {
  const http = new FakeHttp([{ events: [ev("response.output_item.done", { output_index: 0, item: REASONING }), ev("response.output_item.done", { output_index: 1, item: message("Hi.") }), completed([])] }]);
  const result = await lane(http).chat([{ role: "user", content: "x" }]);
  expect(result.providerState).toEqual({ wire: "openai-responses", items: [REASONING, message("Hi.")] });
  expect(result.content).toBe("Hi.");
  expect(result.stopReason).toBe("finished");
});

test("another wire's provider state is never sent on this one", async () => {
  const http = new FakeHttp([textReply("x")]);
  await lane(http).chat([
    { role: "user", content: "x" },
    { role: "assistant", content: "hi", providerState: { wire: "anthropic", blocks: [{ type: "thinking", thinking: "secret", signature: "sig" }] } },
    { role: "assistant", content: "", toolCalls: [{ id: "t", name: "roll", input: { valid: true, value: {} } }], providerState: { wire: "openai-compatible", reasoningContent: "deep" } },
    { role: "tool", toolCallId: "t", content: "1" },
  ]);
  expect((http.sent[0]?.body.input as unknown[]).slice(1)).toEqual([
    { role: "assistant", content: "hi" },
    { type: "function_call", call_id: "t", name: "roll", arguments: "{}" },
    { type: "function_call_output", call_id: "t", output: "1" },
  ]);
  expect(http.sent[0]?.rawBody).not.toContain("secret");
  expect(http.sent[0]?.rawBody).not.toContain("deep");
});

test("text streams through the callback while the whole reply and its usage come back", async () => {
  const delta = (text: string): string => ev("response.output_text.delta", { output_index: 1, content_index: 0, item_id: "msg_1", delta: text, logprobs: [] });
  const http = new FakeHttp([{ events: [delta("The door "), delta("creaks."), completed([REASONING, message("The door creaks.")], { usage: USAGE }), data("[DONE]")] }]);
  const deltas: string[] = [];
  const result = await lane(http).chat([{ role: "user", content: "open it" }], { onTextDelta: (text) => deltas.push(text) });
  expect(deltas).toEqual(["The door ", "creaks."]);
  expect(result.content).toBe("The door creaks.");
  expect(result.stopReason).toBe("finished");
  expect(result.rawStopReason).toBe("completed");
  expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30, cachedInputTokens: 100, cacheWriteTokens: 0, reasoningTokens: 12 });
  expect(result.toolCalls).toEqual([]);
});

test("usage: xAI's shape without cache writes, no details at all, and none reported", async () => {
  const xai = { input_tokens: 129, input_tokens_details: { cached_tokens: 128 }, output_tokens: 477, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 606, num_sources_used: 0, cost_in_usd_ticks: 28896000 };
  const bare = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
  const http = new FakeHttp([{ events: [completed([message("a")], { usage: xai })] }, { events: [completed([message("b")], { usage: bare })] }, { events: [completed([message("c")])] }]);
  const llm = lane(http);
  expect((await llm.chat([{ role: "user", content: "x" }])).usage).toEqual({ inputTokens: 129, outputTokens: 477, cachedInputTokens: 128, reasoningTokens: 0 });
  expect((await llm.chat([{ role: "user", content: "x" }])).usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  expect((await llm.chat([{ role: "user", content: "x" }])).usage).toBeUndefined();
});

test("function-call arguments are assembled per item from fragments: two calls, one whose arguments are not JSON", async () => {
  const added = (index: number, id: string, name: string): string =>
    ev("response.output_item.added", { output_index: index, item: { type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: "", status: "in_progress" } });
  const delta = (index: number, text: string): string => ev("response.function_call_arguments.delta", { output_index: index, item_id: "x", delta: text });
  const http = new FakeHttp([
    {
      events: [added(0, "a", "roll"), added(1, "b", "look"), delta(0, '{"ex'), delta(1, "{oops"), delta(0, 'pr":"2d6"}'), added(2, "c", "wait"), completed([])],
    },
  ]);
  const result = await lane(http).chat([{ role: "user", content: "x" }], { tools: [TOOL] });
  expect(result.stopReason).toBe("tool_calls");
  expect(result.toolCalls).toEqual([
    { id: "a", name: "roll", input: { valid: true, value: { expr: "2d6" } } },
    { id: "b", name: "look", input: { valid: false, raw: "{oops" } },
    { id: "c", name: "wait", input: { valid: true, value: {} } },
  ]);
  const items = (result.providerState as { readonly items: readonly Record<string, unknown>[] }).items;
  expect(items.map((item) => item.arguments)).toEqual(['{"expr":"2d6"}', "{oops", ""]);
});

test("stop reasons: only documented statuses and incomplete reasons are mapped", async () => {
  const refusal = { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "No." }] };
  const cases: [string, string, string | undefined][] = [
    [incomplete("max_output_tokens", [message("cut")]), "output_cap", "max_output_tokens"],
    [incomplete("max_prompt_tokens"), "context_window", "max_prompt_tokens"],
    [incomplete("content_filter"), "refused", "content_filter"],
    [incomplete("max_time_limit"), "unknown", "max_time_limit"],
    [incomplete("max_messages"), "unknown", "max_messages"],
    [incomplete("steered"), "unknown", "steered"],
    [incomplete(null), "unknown", "incomplete"],
    [completed([refusal]), "refused", "completed"],
    [ev("response.completed", { response: response("cancelled", [message("x")]) }), "unknown", "cancelled"],
  ];
  for (const [terminal, expected, raw] of cases) {
    const result = await lane(new FakeHttp([{ events: [terminal] }])).chat([{ role: "user", content: "x" }]);
    expect([raw, result.stopReason]).toEqual([raw, expected as never]);
    expect(result.rawStopReason).toBe(raw as string);
  }
  // A cap that cut a call short still reports the cap, with the call surfaced.
  const capped = await lane(new FakeHttp([{ events: [incomplete("max_output_tokens", [{ ...CALL, arguments: '{"ex' }])] }])).chat([{ role: "user", content: "x" }]);
  expect(capped.stopReason).toBe("output_cap");
  expect(capped.toolCalls[0]?.input).toEqual({ valid: false, raw: '{"ex' });
  // A stream that ends without a terminal event is not a finished reply.
  const silent = await lane(new FakeHttp([{ events: [ev("response.output_text.delta", { output_index: 0, content_index: 0, item_id: "m", delta: "x", logprobs: [] })] }])).chat([{ role: "user", content: "x" }]);
  expect(silent.stopReason).toBe("unknown");
  expect(silent).not.toHaveProperty("rawStopReason");
});

async function failure(response: CannedResponse): Promise<LLMError> {
  const error = await lane(new FakeHttp([response]))
    .chat([{ role: "user", content: "x" }])
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(LLMError);
  return error as LLMError;
}

test("errors are classified by status, carrying the status, the wire and the provider's own message", async () => {
  const auth = await failure({ status: 401, json: { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } } });
  expect([auth.code, auth.status, auth.retryable, auth.wire]).toEqual(["auth", 401, false, "openai-responses"]);
  expect(auth.providerMessage).toContain("Incorrect API key provided");
  const limited = await failure({ status: 429, headers: { "retry-after": "7" }, json: { error: { message: "Rate limit reached" } } });
  expect([limited.code, limited.retryable, limited.retryAfterMs]).toEqual(["rate_limited", true, 7000]);
  const overloaded = await failure({ status: 503, json: { error: { message: "overloaded" } } });
  expect([overloaded.code, overloaded.retryable]).toEqual(["transient", true]);
  const bad = await failure({ status: 400, json: { error: { message: "This model does not support reasoning_effort value none" } } });
  expect([bad.code, bad.retryable]).toEqual(["bad_request", false]);
  const told = await failure({ status: 500, headers: { "x-should-retry": "false" }, json: { error: { message: "no" } } });
  expect([told.code, told.retryable]).toEqual(["transient", false]);
  const network = await failure({ networkError: new TypeError("fetch failed") });
  expect([network.code, network.retryable, network.wire]).toEqual(["transient", true, "openai-responses"]);
});

test("a failure inside the stream: `response.failed`, a named `error` event and a bare one", async () => {
  const failed = (code: string, message: string): CannedResponse => ({
    events: [ev("response.output_text.delta", { output_index: 0, content_index: 0, item_id: "m", delta: "par", logprobs: [] }), ev("response.failed", { response: response("failed", [], { error: { code, message } }) })],
  });
  const server = await failure(failed("server_error", "The model failed."));
  expect([server.code, server.retryable, server.status, server.wire]).toEqual(["transient", true, undefined, "openai-responses"]);
  const limited = await failure(failed("rate_limit_exceeded", "Slow down."));
  expect([limited.code, limited.retryable]).toEqual(["rate_limited", true]);
  const prompt = await failure(failed("invalid_prompt", "Prompt rejected."));
  expect([prompt.code, prompt.retryable]).toEqual(["unknown", false]);
  // The SDK raises an SSE event named `error` itself; a payload that only says so in its type is ours to raise.
  const named = await failure({ events: [event("error", { type: "error", code: "server_error", message: "boom", param: null, sequence_number: 1 })] });
  expect([named.code, named.retryable, named.providerMessage]).toEqual(["transient", true, "boom"]);
  const bare = await failure({ events: [data({ type: "error", code: "rate_limit_exceeded", message: "later", param: null, sequence_number: 1 })] });
  expect([bare.code, bare.retryable]).toEqual(["rate_limited", true]);
  // No code, or a proxy's own: the stream was cut short, and is asked for again. A named fault in the request is not.
  const cut = await failure({ events: [event("error", { type: "error", code: null, message: "unexpected EOF", param: null, sequence_number: 1 })] });
  expect([cut.code, cut.retryable, cut.providerMessage]).toEqual(["transient", true, "unexpected EOF"]);
  const proxied = await failure(failed("upstream_error", "upstream stream closed before any chunk carried finish_reason"));
  expect([proxied.code, proxied.retryable]).toEqual(["transient", true]);
  const key = await failure(failed("invalid_api_key", "Incorrect API key"));
  expect([key.code, key.retryable]).toEqual(["unknown", false]);
});

test("a context overflow is recognised in each vendor's wording on this endpoint, and is never retried", async () => {
  const bodies: [string, Record<string, unknown>][] = [
    ["OpenAI", { message: "Your input exceeds the context window of this model. Please adjust your input and try again.", type: "invalid_request_error", param: "input", code: "context_length_exceeded" }],
    ["OpenAI, code only", { message: "Request rejected.", code: "context_length_exceeded" }],
    ["xAI", { message: "This model's maximum prompt length is 500000 but the request contains 700207 tokens." }],
    ["xAI, gRPC prefix", { message: "gRPC error: This model's maximum prompt length is 500000 but the request contains 505171 tokens." }],
  ];
  for (const [vendor, error] of bodies) {
    const overflow = await failure({ status: 400, json: { error } });
    expect([vendor, overflow.code, overflow.retryable, overflow.status]).toEqual([vendor, "context_overflow", false, 400]);
  }
  const streamed = await failure({ events: [event("error", { type: "error", code: "context_length_exceeded", message: "Your input exceeds the context window of this model.", param: "input", sequence_number: 0 })] });
  expect([streamed.code, streamed.retryable]).toEqual(["context_overflow", false]);
});

test("an ordinary bad request, or overflow wording on another status or code, is not an overflow", async () => {
  const plain = await failure({ status: 400, json: { error: { message: "Invalid value for max_output_tokens", code: "invalid_request_error" } } });
  expect(plain.code).toBe("bad_request");
  const limited = await failure({ status: 429, json: { error: { message: "Rate limit: maximum context length is 128000 tokens per minute" } } });
  expect(limited.code).toBe("rate_limited");
  const streamedLimit = await failure({ events: [event("error", { type: "error", code: "rate_limit_exceeded", message: "maximum context length is 128000 tokens per minute", param: null, sequence_number: 0 })] });
  expect(streamedLimit.code).toBe("rate_limited");
});

test("aborting mid-stream throws instead of returning the partial reply as if complete", async () => {
  const controller = new AbortController();
  const http = new FakeHttp([{ events: [ev("response.output_text.delta", { output_index: 0, content_index: 0, item_id: "m", delta: "The do", logprobs: [] })], hang: true, afterEvents: () => controller.abort() }]);
  const deltas: string[] = [];
  const error = await lane(http)
    .chat([{ role: "user", content: "x" }], { signal: controller.signal, onTextDelta: (text) => deltas.push(text) })
    .catch((caught: unknown) => caught);
  expect(deltas).toEqual(["The do"]);
  expect(error).toBeInstanceOf(LLMError);
  expect([(error as LLMError).code, (error as LLMError).wire]).toEqual(["aborted", "openai-responses"]);
});

test("a call aborted before it starts never reaches the network", async () => {
  const http = new FakeHttp([textReply("x")]);
  const error = await lane(http)
    .chat([{ role: "user", content: "x" }], { signal: AbortSignal.abort() })
    .catch((caught: unknown) => caught);
  expect((error as LLMError).code).toBe("aborted");
  expect(http.sent).toHaveLength(0);
});

test("a call made for a room carries the same cache-routing key as the Chat Completions lane, and it switches off", async () => {
  const http = new FakeHttp([textReply("ok"), textReply("ok"), textReply("ok"), textReply("ok")]);
  const client = lane(http);
  const ask = (name: string, room?: string): Promise<unknown> => withLane(name, () => client.chat([{ role: "user", content: "hi" }]), room === undefined ? {} : { room, turn: 3 });
  await ask("keeper", "The Harbor Table");
  await ask("keeper", "The Harbor Table");
  await ask("scribe", "The Harbor Table");
  await ask("keeper");
  const keys = http.sent.map((sent) => (sent.body as { prompt_cache_key?: string }).prompt_cache_key);
  expect(keys[0]).toMatch(/^[0-9a-f]{32}$/u);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[0]);
  expect(keys[3]).toBeUndefined();
  expect(http.sent.map((sent) => sent.rawBody).join("")).not.toContain("Harbor");

  const quiet = new FakeHttp([textReply("ok")]);
  const off = new OpenAIResponsesLLM({ baseUrl: BASE, apiKey: "k", model: "m", fetch: quiet.fetch, promptCacheKey: false });
  await withLane("keeper", () => off.chat([{ role: "user", content: "hi" }]), { room: "r" });
  expect(quiet.sent[0]?.body).not.toHaveProperty("prompt_cache_key");
});
