import { expect, test } from "bun:test";

import { ConfigError, loadSettings } from "../../src/infra/config.ts";

const DEFAULTS = {
  locale: "en",
  dataDir: "./data",
  lanes: {},
  turn: { maxRounds: 12 },
  scribe: { enabled: true },
  director: { enabled: true, images: true, maxImages: 24, pregenPerBeat: 2 },
  chronicle: { enabled: true, trigger: 0.6, floor: 0.4, emergency: 0.85, lagTurns: 4, summaryMaxChars: 4000 },
  review: {},
  store: { undoDepth: 4 },
  modules: { callTimeoutMs: 5000 },
};

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
  expect(loadSettings({})).toEqual(DEFAULTS);
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
    ...DEFAULTS,
    locale: "zh",
    llm: { apiKey: "k", model: "grok", baseUrl: "https://example.test/grok/v1", contextWindow: 500000 },
  });
  expect(loadSettings({ TRPG_LLM__BASE_URL: "https://example.test/grok/v1", TRPG_LLM__WIRE: "openai-responses", TRPG_LLM__API_KEY: "k", TRPG_LLM__CHAT_MODEL: "grok" }).llm?.wire).toBe("openai-responses");
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

const MAIN = { TRPG_LLM__PROVIDER: "deepseek", TRPG_LLM__API_KEY: "k", TRPG_LLM__CHAT_MODEL: "big" };

test("a lane that names only a model keeps the Keeper's endpoint and key", () => {
  const settings = loadSettings({ ...MAIN, TRPG_SCRIBE__CHAT_MODEL: "small", TRPG_SCRIBE__REASONING_EFFORT: "low" });
  expect(settings.lanes).toEqual({
    scribe: { apiKey: "k", model: "small", preset: "deepseek", reasoningEffort: "low" },
  });
});

test("a lane that names a provider is a separate endpoint and inherits nothing", () => {
  const settings = loadSettings({
    ...MAIN,
    TRPG_LLM__REASONING_EFFORT: "high",
    TRPG_NPC__PROVIDER: "openrouter",
    TRPG_NPC__API_KEY: "other",
    TRPG_NPC__CHAT_MODEL: "voice",
  });
  expect(settings.lanes.npc).toEqual({ apiKey: "other", model: "voice", preset: "openrouter" });
  expect(problems({ ...MAIN, TRPG_MEMORY__PROVIDER: "openrouter" })).toEqual([
    "TRPG_MEMORY__API_KEY:missing",
    "TRPG_MEMORY__CHAT_MODEL:missing",
  ]);
});

test("a lane override with nothing to override is a problem, and so is a stray key", () => {
  expect(problems({ TRPG_DIRECTOR__CHAT_MODEL: "small" })).toEqual(["TRPG_LLM__CHAT_MODEL:missing"]);
  expect(problems({ ...MAIN, TRPG_DIRECTOR__API_KEY: "other" })).toEqual(["TRPG_DIRECTOR__BASE_URL:missing"]);
});

test("switches, counts and fractions are read strictly", () => {
  const settings = loadSettings({
    TRPG_SCRIBE__ENABLED: "false",
    TRPG_DIRECTOR__IMAGES: "0",
    TRPG_DIRECTOR__MAX_IMAGES: "0",
    TRPG_CHRONICLE__FOLD_TRIGGER: "0.5",
    TRPG_CHRONICLE__FOLD_FLOOR: "0.3",
    TRPG_STORE__UNDO_DEPTH: "8",
    TRPG_TURN__MAX_ROUNDS: "6",
  });
  expect(settings.scribe.enabled).toBe(false);
  expect(settings.director).toEqual({ enabled: true, images: false, maxImages: 0, pregenPerBeat: 2 });
  expect(settings.chronicle.trigger).toBe(0.5);
  expect(settings.store.undoDepth).toBe(8);
  expect(settings.turn.maxRounds).toBe(6);
  expect(
    problems({ TRPG_SCRIBE__ENABLED: "yes", TRPG_CHRONICLE__FOLD_EMERGENCY: "85%", TRPG_DIRECTOR__MAX_IMAGES: "-1" }),
  ).toEqual(["TRPG_SCRIBE__ENABLED:invalid", "TRPG_DIRECTOR__MAX_IMAGES:invalid", "TRPG_CHRONICLE__FOLD_EMERGENCY:invalid"]);
});

test("the fold fractions must be in order", () => {
  expect(problems({ TRPG_CHRONICLE__FOLD_FLOOR: "0.7" })).toEqual(["TRPG_CHRONICLE__FOLD_TRIGGER:invalid"]);
  expect(problems({ TRPG_CHRONICLE__FOLD_TRIGGER: "0.9" })).toEqual(["TRPG_CHRONICLE__FOLD_TRIGGER:invalid"]);
});

test("pictures need an endpoint, a key and a model; there is no default model", () => {
  expect(loadSettings({}).imagegen).toBeUndefined();
  expect(problems({ TRPG_IMAGEGEN__API_KEY: "k" })).toEqual(["TRPG_IMAGEGEN__BASE_URL:missing", "TRPG_IMAGEGEN__MODEL:missing"]);
  expect(
    loadSettings({
      TRPG_IMAGEGEN__BASE_URL: "https://images.test/v1",
      TRPG_IMAGEGEN__API_KEY: "k",
      TRPG_IMAGEGEN__MODEL: "m",
      TRPG_IMAGEGEN__DIALECT: "xai",
    }).imagegen,
  ).toEqual({ baseUrl: "https://images.test/v1", apiKey: "k", model: "m", size: "1024x1024", dialect: "xai" });
  expect(problems({ TRPG_IMAGEGEN__SIZE: "big" })).toEqual(["TRPG_IMAGEGEN__SIZE:invalid"]);
});

test("embeddings need a key, a model and the vector size", () => {
  expect(problems({ TRPG_EMBEDDINGS__MODEL: "e" })).toEqual([
    "TRPG_EMBEDDINGS__API_KEY:missing",
    "TRPG_EMBEDDINGS__DIMENSIONS:missing",
  ]);
  expect(
    loadSettings({ TRPG_EMBEDDINGS__API_KEY: "k", TRPG_EMBEDDINGS__MODEL: "e", TRPG_EMBEDDINGS__DIMENSIONS: "1024" }).embeddings,
  ).toEqual({ apiKey: "k", model: "e", dimensions: 1024 });
});
