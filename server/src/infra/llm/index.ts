// The model lanes: the interface the server programs against, the two wires, the retry
// layer, error classification and per-call accounting. `createLLM` turns plain settings
// (filled from the environment elsewhere — nothing here reads it) into a ready client.
import { AnthropicLLM } from "./anthropic.ts";
import { OpenAICompatibleLLM } from "./openai.ts";
import { contextWindowFor, PRESETS } from "./presets.ts";
import { type RetryPolicy, RetryingLLM, type Sleep } from "./retry.ts";
import type { ChatMessage, ChatOptions, ChatResult, LLMClient, ReasoningEffort, Wire } from "./types.ts";

export * from "./types.ts";
export { type CallRecord, type CallSink, currentLane, installCallSink, type LaneFields, type LaneScope, withLane } from "./accounting.ts";
export { AnthropicLLM, type AnthropicLaneSettings, DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS } from "./anthropic.ts";
export { fromAnthropicError, fromOpenAIError, LLMError, type LLMErrorCode } from "./errors.ts";
export { OpenAICompatibleLLM, type OpenAILaneSettings } from "./openai.ts";
export { contextWindowFor, type Preset, PRESETS } from "./presets.ts";
export { DEFAULT_RETRY_POLICY, realSleep, type RetryOptions, type RetryPolicy, RetryingLLM, retryDelayMs, type Sleep } from "./retry.ts";
export { type Responder, type ScriptedReply, type ScriptedRequest, type ScriptedTurn, ScriptedLLM, toolCall } from "./scripted.ts";

export interface LLMSettings {
  /** A name from `PRESETS`; supplies the wire and base URL. */
  readonly preset?: string;
  /** Which wire to speak. Defaults to the preset's, else OpenAI-compatible. */
  readonly wire?: Wire;
  /** Wins over the preset's. */
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly maxOutputTokens?: number;
  /** Overrides the verified table; required for a model the table does not know. */
  readonly contextWindow?: number;
  readonly timeoutMs?: number;
  /** False: the OpenAI-compatible wire never sends `prompt_cache_key` (see `openai.ts`). Default: sent. */
  readonly promptCacheKey?: boolean;
  readonly retry?: Partial<RetryPolicy>;
}

/** The test seams: the SDKs' fetch, the retry layer's sleep, jitter and clock. */
export interface LLMRuntime {
  readonly fetch?: typeof fetch;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  readonly now?: () => number;
}

export type LLMConfigProblem = "unknown_preset" | "no_endpoint" | "wire_mismatch";

export class LLMConfigError extends Error {
  readonly problem: LLMConfigProblem;

  constructor(problem: LLMConfigProblem) {
    super(`llm settings: ${problem}`);
    this.name = "LLMConfigError";
    this.problem = problem;
  }
}

export interface Endpoint {
  readonly wire: Wire;
  readonly baseUrl: string;
}

/** Where the settings point. An explicit base URL never needs a preset. */
export function resolveEndpoint(settings: Pick<LLMSettings, "preset" | "wire" | "baseUrl">): Endpoint {
  let preset;
  if (settings.preset !== undefined) {
    preset = PRESETS[settings.preset];
    if (!preset) throw new LLMConfigError("unknown_preset");
  }
  if (settings.baseUrl) return { wire: settings.wire ?? preset?.wire ?? "openai-compatible", baseUrl: settings.baseUrl };
  if (preset) {
    if (settings.wire !== undefined && settings.wire !== preset.wire) throw new LLMConfigError("wire_mismatch");
    return preset;
  }
  // A wire alone means that wire's own vendor, at its SDK's default address.
  if (settings.wire === "anthropic") return PRESETS.anthropic ?? missing();
  if (settings.wire === "openai-compatible") return PRESETS.openai ?? missing();
  throw new LLMConfigError("no_endpoint");
}

function missing(): never {
  throw new LLMConfigError("no_endpoint");
}

/** A configured client: the lane behind one retry layer, plus what it was built for. */
export class ConfiguredLLM implements LLMClient {
  readonly wire: Wire;
  readonly baseUrl: string;
  readonly model: string;
  /** `undefined` when neither the settings nor the verified table know it. */
  readonly contextWindow: number | undefined;
  readonly #client: LLMClient;

  constructor(settings: LLMSettings, runtime: LLMRuntime = {}) {
    const endpoint = resolveEndpoint(settings);
    this.wire = endpoint.wire;
    this.baseUrl = endpoint.baseUrl;
    this.model = settings.model;
    this.contextWindow = contextWindowFor(settings.model, settings.contextWindow);
    const lane = {
      baseUrl: endpoint.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort }),
      ...(settings.maxOutputTokens === undefined ? {} : { maxOutputTokens: settings.maxOutputTokens }),
      ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }),
      ...(settings.promptCacheKey === undefined ? {} : { promptCacheKey: settings.promptCacheKey }),
      ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
    };
    const inner = endpoint.wire === "anthropic" ? new AnthropicLLM(lane) : new OpenAICompatibleLLM(lane);
    this.#client = new RetryingLLM(inner, {
      wire: endpoint.wire,
      model: settings.model,
      ...(settings.retry ? { policy: settings.retry } : {}),
      ...(runtime.sleep ? { sleep: runtime.sleep } : {}),
      ...(runtime.random ? { random: runtime.random } : {}),
      ...(runtime.now ? { now: runtime.now } : {}),
    });
  }

  chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<ChatResult> {
    return this.#client.chat(messages, options);
  }
}

export function createLLM(settings: LLMSettings, runtime: LLMRuntime = {}): ConfiguredLLM {
  return new ConfiguredLLM(settings, runtime);
}
