import { afterEach, expect, test } from "bun:test";

import {
  type CallRecord,
  type ChatResult,
  createLLM,
  DEFAULT_RETRY_POLICY,
  installCallSink,
  type LLMClient,
  LLMError,
  type LLMErrorCode,
  RetryingLLM,
  retryDelayMs,
  type RetryNotice,
  ScriptedLLM,
  withLane,
} from "../../../src/infra/llm/index.ts";
import { data, FakeHttp } from "./fake_http.ts";

const OK: ChatResult = { content: "fine", toolCalls: [], stopReason: "finished", usage: { inputTokens: 5, outputTokens: 2 } };

function fail(code: LLMErrorCode, retryable: boolean, extra: { retryAfterMs?: number; status?: number } = {}): LLMError {
  return new LLMError({ code, retryable, wire: "openai-compatible", ...extra });
}

/** A lane that fails with the given errors in order, then succeeds. */
class Flaky implements LLMClient {
  attempts = 0;
  readonly #failures: unknown[];

  constructor(failures: unknown[]) {
    this.#failures = [...failures];
  }

  async chat(): Promise<ChatResult> {
    this.attempts++;
    const next = this.#failures.shift();
    if (next !== undefined) throw next;
    return OK;
  }
}

function harness(failures: unknown[], policy = {}) {
  const inner = new Flaky(failures);
  const sleeps: number[] = [];
  let clock = 0;
  const llm = new RetryingLLM(inner, {
    policy,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 0.5,
    now: () => clock,
    wire: "openai-compatible",
    model: "m",
  });
  return { inner, sleeps, llm };
}

let uninstall: (() => void) | undefined;
afterEach(() => uninstall?.());

function capture(): CallRecord[] {
  const records: CallRecord[] = [];
  uninstall = installCallSink((record) => records.push(record));
  return records;
}

test("transient failures and rate limits are retried with jittered exponential backoff", async () => {
  const { inner, sleeps, llm } = harness([fail("transient", true), fail("rate_limited", true)]);
  const notices: RetryNotice[] = [];
  const result = await llm.chat([{ role: "user", content: "x" }], { onRetry: (notice) => notices.push(notice) });
  expect(result).toEqual(OK);
  expect(inner.attempts).toBe(3);
  // Windows of 2s then 4s, each drawn at the midpoint.
  expect(sleeps).toEqual([1000, 2000]);
  expect(notices).toEqual([
    { attempt: 1, delayMs: 1000, code: "transient" },
    { attempt: 2, delayMs: 2000, code: "rate_limited" },
  ]);
});

test("the attempts are bounded: the last failure surfaces unchanged", async () => {
  const last = fail("transient", true, { status: 503 });
  const { inner, llm } = harness([fail("transient", true), fail("transient", true), last]);
  await expect(llm.chat([{ role: "user", content: "x" }])).rejects.toBe(last);
  expect(inner.attempts).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
});

test("auth, bad requests, context overflows, aborts, unretryable errors and foreign throws are never retried", async () => {
  const errors: unknown[] = [
    fail("auth", false),
    fail("bad_request", false),
    fail("context_overflow", false),
    fail("aborted", false),
    fail("rate_limited", false),
    new Error("a bug"),
  ];
  for (const error of errors) {
    const { inner, sleeps, llm } = harness([error]);
    await expect(llm.chat([{ role: "user", content: "x" }])).rejects.toBe(error);
    expect(inner.attempts).toBe(1);
    expect(sleeps).toEqual([]);
  }
});

test("a provider's wait hint is honoured up to the cap; a longer one ends the retries", async () => {
  const hinted = harness([fail("rate_limited", true, { retryAfterMs: 8000 })]);
  await hinted.llm.chat([{ role: "user", content: "x" }]);
  expect(hinted.sleeps).toEqual([8000]);

  const tooLong = fail("rate_limited", true, { retryAfterMs: 120_000 });
  const refused = harness([tooLong]);
  await expect(refused.llm.chat([{ role: "user", content: "x" }])).rejects.toBe(tooLong);
  expect(refused.sleeps).toEqual([]);

  // A hint shorter than the backoff draw does not shorten the wait.
  expect(retryDelayMs(DEFAULT_RETRY_POLICY, 2, 100, () => 0.5)).toBe(2000);
  // The window stops growing at the cap.
  expect(retryDelayMs(DEFAULT_RETRY_POLICY, 10, undefined, () => 0.999)).toBe(19_980);
});

test("an abort during the wait ends the call as aborted, without another attempt", async () => {
  const inner = new Flaky([fail("transient", true)]);
  const controller = new AbortController();
  const llm = new RetryingLLM(inner, {
    random: () => 0.5,
    sleep: async (_ms, signal) => {
      controller.abort();
      signal?.throwIfAborted();
    },
  });
  const error = await llm.chat([{ role: "user", content: "x" }], { signal: controller.signal }).catch((caught: unknown) => caught);
  expect((error as LLMError).code).toBe("aborted");
  expect(inner.attempts).toBe(1);
});

test("one record per logical call, retries included, named by the lane scope that survives awaits", async () => {
  const records = capture();
  const { llm } = harness([fail("transient", true)]);
  await withLane(
    "keeper",
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await llm.chat([{ role: "user", content: "x" }]);
      // A nested lane reports as itself, then the outer one is restored.
      await withLane("npc", () => llm.chat([{ role: "user", content: "y" }], { model: "small" }), { npc: "Ada" });
      await llm.chat([{ role: "user", content: "z" }]);
    },
    { round: 2 },
  );
  expect(records).toEqual([
    { lane: "keeper", fields: { round: 2 }, wire: "openai-compatible", model: "m", durationMs: 1000, attempts: 2, stopReason: "finished", usage: OK.usage! },
    { lane: "npc", fields: { npc: "Ada" }, wire: "openai-compatible", model: "small", durationMs: 0, attempts: 1, stopReason: "finished", usage: OK.usage! },
    { lane: "keeper", fields: { round: 2 }, wire: "openai-compatible", model: "m", durationMs: 0, attempts: 1, stopReason: "finished", usage: OK.usage! },
  ]);
});

test("a failed call is recorded with its code and status, never the provider's message", async () => {
  const records = capture();
  const { llm } = harness([new LLMError({ code: "auth", retryable: false, status: 401, providerMessage: "bad key sk-secret" })]);
  await llm.chat([{ role: "user", content: "x" }]).catch(() => undefined);
  expect(records).toEqual([{ lane: null, fields: {}, wire: "openai-compatible", model: "m", durationMs: 0, attempts: 1, error: { code: "auth", status: 401 } }]);
  expect(JSON.stringify(records)).not.toContain("sk-secret");
});

test("a sink that throws costs the call nothing", async () => {
  uninstall = installCallSink(() => {
    throw new Error("sink broke");
  });
  const { llm } = harness([]);
  await expect(llm.chat([{ role: "user", content: "x" }])).resolves.toEqual(OK);
});

test("the SDK's own retries are off: one logical call is at most maxAttempts HTTP requests", async () => {
  const overloaded = { status: 503, json: { error: { message: "overloaded" } } };
  const http = new FakeHttp([overloaded, overloaded, overloaded, overloaded]);
  const sleeps: number[] = [];
  const llm = createLLM(
    { baseUrl: "https://llm.example.test/v1", apiKey: "k", model: "m" },
    { fetch: http.fetch, sleep: async (ms) => void sleeps.push(ms), random: () => 0 },
  );
  const error = await llm.chat([{ role: "user", content: "x" }]).catch((caught: unknown) => caught);
  expect((error as LLMError).code).toBe("transient");
  expect(http.sent).toHaveLength(3);
  expect(sleeps).toEqual([0, 0]);
});

test("end to end through the factory: a retried stream returns the second attempt's reply", async () => {
  const http = new FakeHttp([
    { status: 429, headers: { "retry-after": "1" }, json: { error: { message: "slow down" } } },
    { events: [data({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }), data("[DONE]")] },
  ]);
  const sleeps: number[] = [];
  const llm = createLLM({ preset: "deepseek", apiKey: "k", model: "deepseek-v4-pro" }, { fetch: http.fetch, sleep: async (ms) => void sleeps.push(ms), random: () => 0 });
  const result = await llm.chat([{ role: "user", content: "x" }]);
  expect(result.content).toBe("hi");
  expect(sleeps).toEqual([1000]);
  expect(http.sent.map((request) => request.url)).toEqual(["https://api.deepseek.com/chat/completions", "https://api.deepseek.com/chat/completions"]);
  expect(llm.contextWindow).toBe(1_000_000);
});

test("the scripted double can play a failure for the retry layer", async () => {
  const scripted = new ScriptedLLM([{ error: fail("transient", true) }, "recovered"]);
  const llm = new RetryingLLM(scripted, { sleep: async () => undefined });
  expect((await llm.chat([{ role: "user", content: "x" }])).content).toBe("recovered");
  expect(scripted.calls).toHaveLength(2);
});
