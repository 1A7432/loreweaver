import { expect, test } from "bun:test";

import { contextWindowFor, createLLM, LLMConfigError, resolveEndpoint, ScriptedLLM, toolCall } from "../../../src/infra/llm/index.ts";

test("an explicit base URL needs no preset and speaks the OpenAI-compatible wire by default", () => {
  expect(resolveEndpoint({ baseUrl: "http://10.0.0.5:8000/v1" })).toEqual({ wire: "openai-compatible", baseUrl: "http://10.0.0.5:8000/v1" });
  expect(resolveEndpoint({ baseUrl: "https://proxy.test", wire: "anthropic" })).toEqual({ wire: "anthropic", baseUrl: "https://proxy.test" });
  // A base URL wins over the preset's, keeping the preset's wire.
  expect(resolveEndpoint({ preset: "anthropic", baseUrl: "https://gateway.test" })).toEqual({ wire: "anthropic", baseUrl: "https://gateway.test" });
});

test("presets and bare wires resolve; contradictions and gaps are refused with a stable reason", () => {
  expect(resolveEndpoint({ preset: "openrouter" })).toEqual({ wire: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" });
  expect(resolveEndpoint({ wire: "anthropic" })).toEqual({ wire: "anthropic", baseUrl: "https://api.anthropic.com" });
  const problem = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return error instanceof LLMConfigError ? error.problem : "other";
    }
    return "none";
  };
  expect(problem(() => resolveEndpoint({ preset: "nope" }))).toBe("unknown_preset");
  expect(problem(() => resolveEndpoint({ preset: "deepseek", wire: "anthropic" }))).toBe("wire_mismatch");
  expect(problem(() => resolveEndpoint({}))).toBe("no_endpoint");
});

test("context windows: the override wins, known ids match exactly, unknown models stay unknown", () => {
  expect(contextWindowFor("claude-opus-5-5")).toBe(1_000_000);
  expect(contextWindowFor("claude-haiku-4-5")).toBe(200_000);
  expect(contextWindowFor("claude-opus-4-5")).toBe(200_000);
  expect(contextWindowFor("claude-opus-4-6")).toBe(1_000_000);
  expect(contextWindowFor("claude-opus-4")).toBeUndefined();
  expect(contextWindowFor("my-local-model")).toBeUndefined();
  expect(contextWindowFor("my-local-model", 32_768)).toBe(32_768);
  expect(contextWindowFor("claude-opus-5-5", 200_000)).toBe(200_000);
  expect(createLLM({ baseUrl: "http://local.test/v1", apiKey: "", model: "llama", contextWindow: 8192 }).contextWindow).toBe(8192);
});

test("the scripted double records calls and options, streams in slices, and scripts tool calls, usage and stop reasons", async () => {
  const call = toolCall("roll", { expr: "1d20" }, "c1");
  const llm = new ScriptedLLM([{ toolCalls: [call], usage: { inputTokens: 9, outputTokens: 3 } }, { content: "Ninety", stopReason: "output_cap" }]);
  const first = await llm.chat([{ role: "user", content: "x" }], { toolChoice: "required" });
  expect(first).toEqual({ content: "", toolCalls: [call], stopReason: "tool_calls", usage: { inputTokens: 9, outputTokens: 3 } });
  const deltas: string[] = [];
  const second = await llm.chat([{ role: "user", content: "y" }], { onTextDelta: (text) => deltas.push(text) });
  expect(deltas).toEqual(["Nin", "ety"]);
  expect(second.stopReason).toBe("output_cap");
  expect(llm.requests[0]?.options.toolChoice).toBe("required");
  expect(llm.calls.map((messages) => messages[0]?.content)).toEqual(["x", "y"]);
  await expect(llm.chat([])).rejects.toThrow();
});
