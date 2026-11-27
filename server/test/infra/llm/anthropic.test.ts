import { expect, test } from "bun:test";

import { AnthropicLLM, type ChatMessage, DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS, LLMError, type ToolDefinition } from "../../../src/infra/llm/index.ts";
import { type CannedResponse, event, FakeHttp } from "./fake_http.ts";

const BASE = "https://claude.example.test";

function lane(http: FakeHttp, extra: { reasoningEffort?: "low" | "xhigh"; maxOutputTokens?: number } = {}): AnthropicLLM {
  return new AnthropicLLM({ baseUrl: BASE, apiKey: "test-key", model: "claude-opus-5-5", fetch: http.fetch, ...extra });
}

function start(usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 1 }): string {
  return event("message_start", {
    type: "message_start",
    message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage },
  });
}

function blockStart(index: number, block: Record<string, unknown>): string {
  return event("content_block_start", { type: "content_block_start", index, content_block: block });
}

function delta(index: number, payload: Record<string, unknown>): string {
  return event("content_block_delta", { type: "content_block_delta", index, delta: payload });
}

function blockStop(index: number): string {
  return event("content_block_stop", { type: "content_block_stop", index });
}

function finish(stopReason: string, usage: Record<string, unknown> = { output_tokens: 5 }): string[] {
  return [
    event("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage }),
    event("message_stop", { type: "message_stop" }),
  ];
}

function textReply(text: string, stopReason = "end_turn"): CannedResponse {
  return { events: [start(), blockStart(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text }), blockStop(0), ...finish(stopReason)] };
}

const TOOL: ToolDefinition = { name: "roll", description: "Roll dice.", parameters: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] } };

test("the request: leading system messages as blocks, cache marks as cache_control, tool results merged, nothing of ours on the wire", async () => {
  const http = new FakeHttp([textReply("ok")]);
  const messages: ChatMessage[] = [
    { role: "system", content: "Stable rules.", cacheBreakpoint: true },
    { role: "system", content: "" },
    { role: "user", content: "I roll twice." },
    {
      role: "assistant",
      content: "Rolling.",
      toolCalls: [
        { id: "t1", name: "roll", input: { valid: true, value: { expr: "1d6" } } },
        { id: "t2", name: "roll", input: { valid: false, raw: "{bad" } },
      ],
    },
    { role: "tool", toolCallId: "t1", content: "4" },
    { role: "tool", toolCallId: "t2", content: "unreadable arguments", isError: true, cacheBreakpoint: true },
    { role: "system", content: "Turn 3, night." },
    { role: "user", content: "And?", cacheBreakpoint: true },
  ];
  await lane(http).chat(messages, { tools: [TOOL], toolChoice: "auto" });
  const sent = http.sent[0];
  expect(sent?.url).toBe(`${BASE}/v1/messages`);
  // MEASURED: @anthropic-ai/sdk 1.14.0 sends the API key as a bearer token, not `x-api-key`.
  expect(sent?.headers.get("authorization")).toBe("Bearer test-key");
  expect(sent?.headers.get("anthropic-version")).toBe("2026-10-21");
  expect(sent?.body).toEqual({
    model: "claude-opus-5-5",
    max_tokens: DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS,
    stream: true,
    system: [{ type: "text", text: "Stable rules.", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "roll", description: "Roll dice.", input_schema: TOOL.parameters }],
    tool_choice: { type: "auto" },
    messages: [
      { role: "user", content: [{ type: "text", text: "I roll twice." }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Rolling." },
          { type: "tool_use", id: "t1", name: "roll", input: { expr: "1d6" } },
          { type: "tool_use", id: "t2", name: "roll", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "4" },
          { type: "tool_result", tool_use_id: "t2", content: "unreadable arguments", is_error: true, cache_control: { type: "ephemeral" } },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Turn 3, night." }] },
      { role: "user", content: [{ type: "text", text: "And?", cache_control: { type: "ephemeral" } }] },
    ],
  });
  expect(sent?.rawBody).not.toContain("cacheBreakpoint");
  expect(sent?.body).not.toHaveProperty("temperature");
  expect(sent?.body).not.toHaveProperty("thinking");
});

test("effort turns on adaptive thinking; tool choices map to the wire's names; per-call overrides win", async () => {
  const http = new FakeHttp([textReply("a"), textReply("b"), textReply("c")]);
  const llm = lane(http, { reasoningEffort: "low", maxOutputTokens: 8000 });
  await llm.chat([{ role: "user", content: "x" }], { tools: [TOOL], toolChoice: "required" });
  expect(http.sent[0]?.body).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "low" }, max_tokens: 8000, tool_choice: { type: "any" } });
  await llm.chat([{ role: "user", content: "x" }], { tools: [TOOL], toolChoice: { name: "roll" }, reasoningEffort: "xhigh", maxOutputTokens: 100, model: "claude-sonnet-5-5" });
  expect(http.sent[1]?.body).toMatchObject({ output_config: { effort: "xhigh" }, max_tokens: 100, model: "claude-sonnet-5-5", tool_choice: { type: "tool", name: "roll" } });
  await llm.chat([{ role: "user", content: "x" }], { toolChoice: "none" });
  expect(http.sent[2]?.body).not.toHaveProperty("tool_choice");
});

test("text streams through the callback; tool input fragments, thinking and its signature are assembled; usage merges", async () => {
  const http = new FakeHttp([
    {
      events: [
        start({ input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 80 }),
        blockStart(0, { type: "thinking", thinking: "", signature: "" }),
        delta(0, { type: "thinking_delta", thinking: "Consider " }),
        delta(0, { type: "thinking_delta", thinking: "dice." }),
        delta(0, { type: "signature_delta", signature: "sig-abc" }),
        blockStop(0),
        blockStart(1, { type: "text", text: "" }),
        delta(1, { type: "text_delta", text: "Let me " }),
        delta(1, { type: "text_delta", text: "roll." }),
        blockStop(1),
        blockStart(2, { type: "tool_use", id: "toolu_1", name: "roll", input: {} }),
        delta(2, { type: "input_json_delta", partial_json: '{"expr":' }),
        delta(2, { type: "input_json_delta", partial_json: '"3d6"}' }),
        blockStop(2),
        blockStart(3, { type: "tool_use", id: "toolu_2", name: "roll", input: {} }),
        delta(3, { type: "input_json_delta", partial_json: '{"expr": "2' }),
        blockStop(3),
        ...finish("tool_use", { input_tokens: 20, output_tokens: 64, cache_read_input_tokens: 900, cache_creation_input_tokens: 80, output_tokens_details: { thinking_tokens: 40 } }),
      ],
    },
  ]);
  const deltas: string[] = [];
  const result = await lane(http).chat([{ role: "user", content: "x" }], { tools: [TOOL], onTextDelta: (text) => deltas.push(text) });
  expect(deltas).toEqual(["Let me ", "roll."]);
  expect(result.content).toBe("Let me roll.");
  expect(result.stopReason).toBe("tool_calls");
  expect(result.toolCalls).toEqual([
    { id: "toolu_1", name: "roll", input: { valid: true, value: { expr: "3d6" } } },
    { id: "toolu_2", name: "roll", input: { valid: false, raw: '{"expr": "2' } },
  ]);
  expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 64, cachedInputTokens: 900, cacheWriteTokens: 80, reasoningTokens: 40 });
  expect(result.providerState).toEqual({
    wire: "anthropic",
    blocks: [
      { type: "thinking", thinking: "Consider dice.", signature: "sig-abc" },
      { type: "text", text: "Let me roll." },
      { type: "tool_use", id: "toolu_1", name: "roll", input: { expr: "3d6" } },
      { type: "tool_use", id: "toolu_2", name: "roll", input: {} },
    ],
  });
});

test("a provider state is replayed verbatim, with a cache mark on the last block that can carry one", async () => {
  const http = new FakeHttp([textReply("ok")]);
  const blocks = [
    { type: "text", text: "Rolling." },
    { type: "tool_use", id: "toolu_1", name: "roll", input: { expr: "3d6" } },
    { type: "thinking", thinking: "", signature: "sig" },
  ];
  await lane(http).chat([
    { role: "user", content: "x" },
    { role: "assistant", content: "ignored", providerState: { wire: "anthropic", blocks }, cacheBreakpoint: true },
    { role: "tool", toolCallId: "toolu_1", content: "11" },
  ]);
  const replayed = (http.sent[0]?.body.messages as { content: unknown }[])[1];
  expect(replayed?.content).toEqual([blocks[0], { ...blocks[1], cache_control: { type: "ephemeral" } }, blocks[2]]);
  // The caller's state is not mutated by the mark.
  expect(blocks[1]).not.toHaveProperty("cache_control");
});

test("an OpenAI-compatible provider state is ignored on this wire", async () => {
  const http = new FakeHttp([textReply("ok")]);
  await lane(http).chat([
    { role: "user", content: "x" },
    { role: "assistant", content: "hi", providerState: { wire: "openai-compatible", reasoningContent: "secret" } },
    { role: "user", content: "y" },
  ]);
  expect(http.sent[0]?.rawBody).not.toContain("secret");
});

test("stop reasons: each documented value maps, the window is told apart from the output cap", async () => {
  const cases: [string, string][] = [
    ["end_turn", "finished"],
    ["stop_sequence", "finished"],
    ["max_tokens", "output_cap"],
    ["model_context_window_exceeded", "context_window"],
    ["refusal", "refused"],
    ["pause_turn", "unknown"],
    ["something_new", "unknown"],
  ];
  for (const [raw, expected] of cases) {
    const result = await lane(new FakeHttp([textReply("x", raw)])).chat([{ role: "user", content: "x" }]);
    expect([result.stopReason, result.rawStopReason]).toEqual([expected as never, raw]);
  }
});

async function failure(response: CannedResponse): Promise<LLMError> {
  const error = await lane(new FakeHttp([response]))
    .chat([{ role: "user", content: "x" }])
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(LLMError);
  return error as LLMError;
}

function body(type: string, message: string, details?: Record<string, unknown>): unknown {
  return { type: "error", error: { type, message, ...(details ? { details } : {}) }, request_id: "req_1" };
}

test("the documented context overflow is recognised; another 400 is a bad request", async () => {
  const overflow = await failure({ status: 400, json: body("invalid_request_error", "prompt is too long: 1200000 tokens > 1000000 maximum") });
  expect([overflow.code, overflow.status, overflow.retryable, overflow.wire]).toEqual(["context_overflow", 400, false, "anthropic"]);
  expect(overflow.providerMessage).toContain("prompt is too long");

  const bad = await failure({ status: 400, json: body("invalid_request_error", 'tool_choice: type "tool" and "any" are not supported for this model.') });
  expect(bad.code).toBe("bad_request");
});

test("errors are classified by status and the provider's retry instructions are honoured", async () => {
  const auth = await failure({ status: 401, json: body("authentication_error", "invalid x-api-key") });
  expect([auth.code, auth.retryable]).toEqual(["auth", false]);

  const limited = await failure({ status: 429, headers: { "retry-after": "12" }, json: body("rate_limit_error", "slow down") });
  expect([limited.code, limited.retryable, limited.retryAfterMs]).toEqual(["rate_limited", true, 12_000]);

  const capped = await failure({ status: 429, json: body("rate_limit_error", "You have reached your API usage limits", { error_code: "enforced_spend_limit_reached" }) });
  expect([capped.code, capped.retryable]).toEqual(["rate_limited", false]);

  const overloaded = await failure({ status: 529, json: body("overloaded_error", "Overloaded") });
  expect([overloaded.code, overloaded.retryable]).toEqual(["transient", true]);

  const told = await failure({ status: 500, headers: { "x-should-retry": "false" }, json: body("api_error", "Internal") });
  expect([told.code, told.retryable]).toEqual(["transient", false]);

  const tooLarge = await failure({ status: 413, json: body("request_too_large", "too large") });
  expect(tooLarge.code).toBe("bad_request");
});

test("an error event in the middle of a stream is classified by its type", async () => {
  const error = await failure({
    events: [start(), blockStart(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "Hal" }), event("error", body("overloaded_error", "Overloaded"))],
  });
  expect([error.code, error.retryable, error.status]).toEqual(["transient", true, undefined]);
  const cut = (type: string, message: string) => failure({ events: [start(), blockStart(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "Hal" }), event("error", body(type, message))] });
  // A proxy's own payload, with a type of its own: the stream was cut short, and is asked for again.
  const proxied = await cut("upstream_error", "upstream stream closed before any chunk carried finish_reason");
  expect([proxied.code, proxied.retryable, proxied.providerMessage]).toEqual(["transient", true, "upstream stream closed before any chunk carried finish_reason"]);
  const limited = await cut("rate_limit_error", "Slow down");
  expect([limited.code, limited.retryable]).toEqual(["rate_limited", true]);
  // A fault in the request is not asked again.
  for (const type of ["invalid_request_error", "authentication_error", "billing_error", "permission_error", "not_found_error"]) {
    const refused = await cut(type, "no");
    expect([type, refused.code, refused.retryable]).toEqual([type, "unknown", false]);
  }
});

test("aborting mid-stream throws instead of returning the partial reply as if complete", async () => {
  const controller = new AbortController();
  const http = new FakeHttp([
    { events: [start(), blockStart(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "Half" })], hang: true, afterEvents: () => controller.abort() },
  ]);
  const deltas: string[] = [];
  const error = await lane(http)
    .chat([{ role: "user", content: "x" }], { signal: controller.signal, onTextDelta: (text) => deltas.push(text) })
    .catch((caught: unknown) => caught);
  expect(deltas).toEqual(["Half"]);
  expect((error as LLMError).code).toBe("aborted");
});
