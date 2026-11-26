import { expect, test } from "bun:test";

import { type ChatMessage, LLMError, OpenAICompatibleLLM, type ToolDefinition } from "../../../src/infra/llm/index.ts";
import { data, FakeHttp } from "./fake_http.ts";

const BASE = "https://llm.example.test/v1";

function lane(http: FakeHttp, extra: { reasoningEffort?: "high"; maxOutputTokens?: number } = {}): OpenAICompatibleLLM {
  return new OpenAICompatibleLLM({ baseUrl: BASE, apiKey: "test-key", model: "m-default", fetch: http.fetch, ...extra });
}

function chunk(delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}): string {
  return data({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
}

function usageChunk(usage: Record<string, unknown>): string {
  return data({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage });
}

const TOOL: ToolDefinition = { name: "roll", description: "Roll dice.", parameters: { type: "object", properties: { expr: { type: "string" } } } };

test("the request: always streamed, usage always asked for, our message fields translated and the cache marker gone", async () => {
  const http = new FakeHttp([{ events: [chunk({ content: "ok" }, "stop"), data("[DONE]")] }]);
  const messages: ChatMessage[] = [
    { role: "system", content: "You are the Keeper.", cacheBreakpoint: true },
    { role: "user", content: "I roll.", cacheBreakpoint: true },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "roll", input: { valid: true, value: { expr: "1d6" } } }] },
    { role: "tool", toolCallId: "t1", content: "4", isError: false },
  ];
  await lane(http, { reasoningEffort: "high" }).chat(messages, { tools: [TOOL], toolChoice: "required", model: "m-override" });
  const sent = http.sent[0];
  expect(sent?.url).toBe(`${BASE}/chat/completions`);
  expect(sent?.headers.get("authorization")).toBe("Bearer test-key");
  expect(sent?.body).toEqual({
    model: "m-override",
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: "high",
    tools: [{ type: "function", function: { name: "roll", description: "Roll dice.", parameters: TOOL.parameters } }],
    tool_choice: "required",
    messages: [
      { role: "system", content: "You are the Keeper." },
      { role: "user", content: "I roll." },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "roll", arguments: '{"expr":"1d6"}' } }] },
      { role: "tool", tool_call_id: "t1", content: "4" },
    ],
  });
  expect(sent?.rawBody).not.toContain("cacheBreakpoint");
});

test("a named tool choice, the output cap, and no tool choice at all when no tools are offered", async () => {
  const http = new FakeHttp([{ events: [chunk({ content: "a" }, "stop")] }, { events: [chunk({ content: "b" }, "stop")] }]);
  const llm = lane(http, { maxOutputTokens: 900 });
  await llm.chat([{ role: "user", content: "x" }], { tools: [TOOL], toolChoice: { name: "roll" } });
  expect(http.sent[0]?.body.tool_choice).toEqual({ type: "function", function: { name: "roll" } });
  expect(http.sent[0]?.body.max_completion_tokens).toBe(900);
  await llm.chat([{ role: "user", content: "x" }], { toolChoice: "none" });
  expect(http.sent[1]?.body).not.toHaveProperty("tool_choice");
  expect(http.sent[1]?.body).not.toHaveProperty("tools");
  expect(http.sent[1]?.body).not.toHaveProperty("reasoning_effort");
});

test("text streams through the callback while the whole reply and its usage come back", async () => {
  const http = new FakeHttp([
    {
      events: [
        chunk({ role: "assistant", content: "The door " }),
        chunk({ content: "creaks." }, "stop"),
        usageChunk({
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 100 },
          completion_tokens_details: { reasoning_tokens: 12 },
        }),
        data("[DONE]"),
      ],
    },
  ]);
  const deltas: string[] = [];
  const result = await lane(http).chat([{ role: "user", content: "open it" }], { onTextDelta: (text) => deltas.push(text) });
  expect(deltas).toEqual(["The door ", "creaks."]);
  expect(result.content).toBe("The door creaks.");
  expect(result.stopReason).toBe("finished");
  expect(result.rawStopReason).toBe("stop");
  expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30, cachedInputTokens: 100, reasoningTokens: 12 });
  expect(result.toolCalls).toEqual([]);
});

test("a stream that reports no usage leaves usage absent rather than guessing it", async () => {
  const http = new FakeHttp([{ events: [chunk({ content: "hi" }, "stop"), data("[DONE]")] }]);
  const result = await lane(http).chat([{ role: "user", content: "x" }]);
  expect(result.usage).toBeUndefined();
});

test("tool-call fragments are assembled per index, and arguments that are not JSON are surfaced", async () => {
  const http = new FakeHttp([
    {
      events: [
        chunk({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "roll", arguments: '{"ex' } }] }),
        chunk({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "look", arguments: "{oops" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'pr":"2d6"}' } }] }),
        chunk({ tool_calls: [{ index: 2, id: "c", type: "function", function: { name: "wait", arguments: "" } }] }),
        chunk({}, "tool_calls"),
        data("[DONE]"),
      ],
    },
  ]);
  const result = await lane(http).chat([{ role: "user", content: "x" }], { tools: [TOOL] });
  expect(result.stopReason).toBe("tool_calls");
  expect(result.toolCalls).toEqual([
    { id: "a", name: "roll", input: { valid: true, value: { expr: "2d6" } } },
    { id: "b", name: "look", input: { valid: false, raw: "{oops" } },
    { id: "c", name: "wait", input: { valid: true, value: {} } },
  ]);
});

test("stop reasons: only the documented finish reasons are mapped", async () => {
  const cases: [string, string][] = [
    ["length", "output_cap"],
    ["content_filter", "refused"],
    ["insufficient_system_resource", "unknown"],
  ];
  for (const [finish, expected] of cases) {
    const http = new FakeHttp([{ events: [chunk({ content: "x" }, finish), data("[DONE]")] }]);
    const result = await lane(http).chat([{ role: "user", content: "x" }]);
    expect(result.stopReason).toBe(expected as never);
    expect(result.rawStopReason).toBe(finish);
  }
  const silent = new FakeHttp([{ events: [chunk({ content: "x" }), data("[DONE]")] }]);
  const cut = await lane(silent).chat([{ role: "user", content: "x" }]);
  expect(cut.stopReason).toBe("unknown");
  expect(cut).not.toHaveProperty("rawStopReason");
});

test("DeepSeek's shape: usage on the last content chunk, and reasoning_content kept and echoed back", async () => {
  const http = new FakeHttp([
    {
      events: [
        chunk({ reasoning_content: "Think " }),
        chunk({ reasoning_content: "hard." }),
        chunk({ tool_calls: [{ index: 0, id: "t", type: "function", function: { name: "roll", arguments: "{}" } }] }),
        chunk({}, "tool_calls", { usage: { prompt_tokens: 50, completion_tokens: 9, total_tokens: 59, prompt_tokens_details: { cached_tokens: 0 } } }),
        data("[DONE]"),
      ],
    },
    { events: [chunk({ content: "done" }, "stop"), data("[DONE]")] },
  ]);
  const llm = lane(http);
  const first = await llm.chat([{ role: "user", content: "x" }], { tools: [TOOL] });
  expect(first.usage).toEqual({ inputTokens: 50, outputTokens: 9, cachedInputTokens: 0 });
  expect(first.providerState).toEqual({ wire: "openai-compatible", reasoningContent: "Think hard." });
  await llm.chat(
    [
      { role: "user", content: "x" },
      { role: "assistant", content: first.content, toolCalls: first.toolCalls, ...(first.providerState ? { providerState: first.providerState } : {}) },
      { role: "tool", toolCallId: "t", content: "5" },
    ],
    { tools: [TOOL] },
  );
  const echoed = (http.sent[1]?.body.messages as Record<string, unknown>[])[1];
  expect(echoed?.reasoning_content).toBe("Think hard.");
});

test("an Anthropic provider state is never sent on this wire", async () => {
  const http = new FakeHttp([{ events: [chunk({ content: "x" }, "stop")] }]);
  await lane(http).chat([
    { role: "user", content: "x" },
    { role: "assistant", content: "hi", providerState: { wire: "anthropic", blocks: [{ type: "text", text: "hi" }] } },
    { role: "user", content: "y" },
  ]);
  expect((http.sent[0]?.body.messages as Record<string, unknown>[])[1]).toEqual({ role: "assistant", content: "hi" });
});

async function failure(response: ConstructorParameters<typeof FakeHttp>[0][number]): Promise<LLMError> {
  const http = new FakeHttp([response]);
  const error = await lane(http)
    .chat([{ role: "user", content: "x" }])
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(LLMError);
  return error as LLMError;
}

test("errors are classified by status, carrying the status and the provider's own message", async () => {
  const auth = await failure({ status: 401, json: { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } } });
  expect([auth.code, auth.status, auth.retryable, auth.wire]).toEqual(["auth", 401, false, "openai-compatible"]);
  expect(auth.providerMessage).toContain("Incorrect API key provided");

  const limited = await failure({ status: 429, headers: { "retry-after": "7" }, json: { error: { message: "Rate limit reached for requests" } } });
  expect([limited.code, limited.retryable, limited.retryAfterMs]).toEqual(["rate_limited", true, 7000]);

  const overloaded = await failure({ status: 503, headers: { "retry-after-ms": "1500" }, json: { error: { message: "The requested model is temporarily overloaded." } } });
  expect([overloaded.code, overloaded.retryable, overloaded.retryAfterMs]).toEqual(["transient", true, 1500]);

  const bad = await failure({ status: 400, json: { error: { message: "Invalid value for tool_choice" } } });
  expect([bad.code, bad.retryable]).toEqual(["bad_request", false]);

  const told = await failure({ status: 500, headers: { "x-should-retry": "false" }, json: { error: { message: "no" } } });
  expect([told.code, told.retryable]).toEqual(["transient", false]);

  const network = await failure({ networkError: new TypeError("fetch failed") });
  expect([network.code, network.retryable]).toEqual(["transient", true]);
});

test("a context overflow is recognised in each vendor's own wording, and is never retried", async () => {
  const bodies: [string, Record<string, unknown>][] = [
    ["OpenAI", { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 134521 tokens. Please reduce the length of the messages.", type: "invalid_request_error", param: "messages", code: "context_length_exceeded" }],
    ["OpenAI, code only", { message: "Request rejected.", code: "context_length_exceeded" }],
    ["OpenAI, newer wording", { message: "Your input exceeds the context window of this model. Please adjust your input and try again." }],
    ["xAI", { message: "This model's maximum prompt length is 500000 but the request contains 700207 tokens." }],
    ["DeepSeek", { message: "This model's maximum context length is 65536 tokens. However, you requested 73149 tokens (73149 in the messages, 0 in the completion).", type: "invalid_request_error", param: null, code: "invalid_request_error" }],
    ["OpenRouter", { message: "This endpoint's maximum context length is 200,000 tokens. However, you requested about 250,000 tokens", code: 400, metadata: { error_type: "context_length_exceeded" } }],
    ["OpenRouter, type only", { message: "Provider returned error", code: 400, metadata: { error_type: "context_length_exceeded" } }],
    ["Groq", { message: "Please reduce the length of the messages or completion." }],
  ];
  for (const [vendor, error] of bodies) {
    const overflow = await failure({ status: 400, json: { error } });
    expect([vendor, overflow.code, overflow.retryable, overflow.status]).toEqual([vendor, "context_overflow", false, 400]);
  }
});

test("an ordinary bad request, or overflow wording on another status, is not an overflow", async () => {
  const plain = await failure({ status: 400, json: { error: { message: "Invalid value for max_tokens: must be at most 8192", code: "invalid_request_error" } } });
  expect(plain.code).toBe("bad_request");
  const capped = await failure({ status: 400, json: { error: { message: "max_tokens is too large: 200000. This model supports at most 32768 completion tokens." } } });
  expect(capped.code).toBe("bad_request");
  const limited = await failure({ status: 429, json: { error: { message: "Rate limit: maximum context length is 128000 tokens per minute" } } });
  expect(limited.code).toBe("rate_limited");
});

test("aborting mid-stream throws instead of returning the partial reply as if complete", async () => {
  const controller = new AbortController();
  const http = new FakeHttp([{ events: [chunk({ content: "The do" })], hang: true, afterEvents: () => controller.abort() }]);
  const deltas: string[] = [];
  const error = await lane(http)
    .chat([{ role: "user", content: "x" }], { signal: controller.signal, onTextDelta: (text) => deltas.push(text) })
    .catch((caught: unknown) => caught);
  expect(deltas).toEqual(["The do"]);
  expect(error).toBeInstanceOf(LLMError);
  expect((error as LLMError).code).toBe("aborted");
});

test("a call aborted before it starts never reaches the network", async () => {
  const http = new FakeHttp([{ events: [chunk({ content: "x" }, "stop")] }]);
  const error = await lane(http)
    .chat([{ role: "user", content: "x" }], { signal: AbortSignal.abort() })
    .catch((caught: unknown) => caught);
  expect((error as LLMError).code).toBe("aborted");
  expect(http.sent).toHaveLength(0);
});
