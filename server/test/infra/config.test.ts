import { expect, test } from "bun:test";

import { ConfigError, loadSettings } from "../../src/infra/config.ts";

function problems(env: Record<string, string>): string[] {
  try {
    loadSettings(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems.map((entry) => `${entry.variable}:${entry.problem}`);
    throw error;
  }
  return [];
}

test("nothing set: defaults, and no model", () => {
  expect(loadSettings({})).toEqual({ locale: "en", modules: { callTimeoutMs: 5000 } });
});

test("a known provider needs only a key and a model", () => {
  expect(loadSettings({ TRPG_LLM__PROVIDER: "DeepSeek", TRPG_LLM__API_KEY: " k ", TRPG_LLM__CHAT_MODEL: "m" }).llm).toEqual({
    apiKey: "k",
    model: "m",
    preset: "deepseek",
  });
});

test("an unknown provider name with an explicit base URL is a label, not an error", () => {
  const settings = loadSettings({
    TRPG_LLM__PROVIDER: "xai",
    TRPG_LLM__BASE_URL: "https://example.test/grok/v1",
    TRPG_LLM__API_KEY: "k",
    TRPG_LLM__CHAT_MODEL: "grok",
    TRPG_LLM__CONTEXT_WINDOW: "500000",
    TRPG_LOCALE: "zh",
  });
  expect(settings).toEqual({
    locale: "zh",
    modules: { callTimeoutMs: 5000 },
    llm: { apiKey: "k", model: "grok", baseUrl: "https://example.test/grok/v1", contextWindow: 500000 },
  });
});

test("every problem is reported at once", () => {
  expect(
    problems({
      TRPG_LLM__PROVIDER: "nowhere",
      TRPG_LLM__REASONING_EFFORT: "extreme",
      TRPG_LLM__CONTEXT_WINDOW: "200k",
      TRPG_MODULES__CALL_TIMEOUT_MS: "0",
    }),
  ).toEqual([
    "TRPG_LLM__REASONING_EFFORT:invalid",
    "TRPG_LLM__CONTEXT_WINDOW:invalid",
    "TRPG_LLM__BASE_URL:missing",
    "TRPG_LLM__API_KEY:missing",
    "TRPG_LLM__CHAT_MODEL:missing",
    "TRPG_MODULES__CALL_TIMEOUT_MS:invalid",
  ]);
});

test("numbers are plain positive integers, nothing looser", () => {
  for (const value of ["30s", "1e3", "-5", "1.5", " ", "0x10", "９"]) {
    const found = problems({ TRPG_MODULES__CALL_TIMEOUT_MS: value });
    expect([value, found]).toEqual([value, value.trim() === "" ? [] : ["TRPG_MODULES__CALL_TIMEOUT_MS:invalid"]]);
  }
  expect(loadSettings({ TRPG_MODULES__CALL_TIMEOUT_MS: "250" }).modules.callTimeoutMs).toBe(250);
});

test("a provider name that is a property of every object is not a preset", () => {
  expect(problems({ TRPG_LLM__PROVIDER: "constructor", TRPG_LLM__API_KEY: "k", TRPG_LLM__CHAT_MODEL: "m" })).toEqual([
    "TRPG_LLM__BASE_URL:missing",
  ]);
});

test("a base URL that is not a URL is refused", () => {
  expect(problems({ TRPG_LLM__BASE_URL: "not a url", TRPG_LLM__API_KEY: "k", TRPG_LLM__CHAT_MODEL: "m" })).toEqual([
    "TRPG_LLM__BASE_URL:invalid",
  ]);
});
