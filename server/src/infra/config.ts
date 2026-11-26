// Settings, read once from the environment (`TRPG_*`, `__` between levels, so the
// variables an operator already has in `.env` keep working). This is the only place that
// reads environment variables; everything else is handed a typed object. Reading is a
// pure function of the variables it is given, and it reports every problem at once —
// an operator fixing a config file should not discover the mistakes one start at a time.
import { PRESETS, type LLMSettings, type ReasoningEffort, type Wire } from "./llm/index.ts";

export interface Settings {
  /** The language of rooms on this server until a room sets its own. */
  readonly locale: string;
  /** Absent when no model is configured; the server still starts and says so. */
  readonly llm?: LLMSettings;
  readonly modules: {
    /** How long one call into a room's worker may take before the worker is ended. */
    readonly callTimeoutMs: number;
  };
}

export interface ConfigProblem {
  readonly variable: string;
  /** `invalid`: present but not usable. `missing`: required by another variable. */
  readonly problem: "invalid" | "missing";
}

export class ConfigError extends Error {
  readonly problems: readonly ConfigProblem[];

  constructor(problems: readonly ConfigProblem[]) {
    super(`settings: ${problems.map((entry) => `${entry.variable} ${entry.problem}`).join(", ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export type Environment = Readonly<Record<string, string | undefined>>;

const EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const WIRES: readonly Wire[] = ["openai-compatible", "anthropic"];
const DEFAULT_CALL_TIMEOUT_MS = 5000;

export function loadSettings(env: Environment): Settings {
  const problems: ConfigProblem[] = [];

  /** A variable's value, trimmed; an empty one counts as unset. */
  const text = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  /** A positive whole number, written in plain decimal digits. */
  const positiveInt = (name: string): number | undefined => {
    const value = text(name);
    if (value === undefined) return undefined;
    // Strict on purpose: `Number("")` is 0 and `parseInt("30s")` is 30.
    if (/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
    problems.push({ variable: name, problem: "invalid" });
    return undefined;
  };
  const oneOf = <T extends string>(name: string, allowed: readonly T[]): T | undefined => {
    const value = text(name);
    if (value === undefined) return undefined;
    const match = allowed.find((option) => option === value.toLowerCase());
    if (match === undefined) problems.push({ variable: name, problem: "invalid" });
    return match;
  };

  const provider = text("TRPG_LLM__PROVIDER")?.toLowerCase();
  const baseUrl = text("TRPG_LLM__BASE_URL");
  const apiKey = text("TRPG_LLM__API_KEY");
  const model = text("TRPG_LLM__CHAT_MODEL");
  const wire = oneOf("TRPG_LLM__WIRE", WIRES);
  const reasoningEffort = oneOf("TRPG_LLM__REASONING_EFFORT", EFFORTS);
  const contextWindow = positiveInt("TRPG_LLM__CONTEXT_WINDOW");
  const maxOutputTokens = positiveInt("TRPG_LLM__MAX_OUTPUT_TOKENS");
  const timeoutMs = positiveInt("TRPG_LLM__TIMEOUT_MS");

  if (baseUrl !== undefined && !URL.canParse(baseUrl)) {
    problems.push({ variable: "TRPG_LLM__BASE_URL", problem: "invalid" });
  }
  // A provider name is a preset only when this server knows it. With an explicit base
  // URL any other name is just the operator's label for their endpoint.
  const preset = provider !== undefined && Object.hasOwn(PRESETS, provider) ? provider : undefined;
  if (provider !== undefined && preset === undefined && baseUrl === undefined) {
    problems.push({ variable: "TRPG_LLM__BASE_URL", problem: "missing" });
  }

  let llm: LLMSettings | undefined;
  const wanted = provider !== undefined || baseUrl !== undefined || apiKey !== undefined || model !== undefined;
  if (wanted) {
    if (apiKey === undefined) problems.push({ variable: "TRPG_LLM__API_KEY", problem: "missing" });
    if (model === undefined) problems.push({ variable: "TRPG_LLM__CHAT_MODEL", problem: "missing" });
    if (preset === undefined && baseUrl === undefined && provider === undefined) {
      problems.push({ variable: "TRPG_LLM__BASE_URL", problem: "missing" });
    }
    if (apiKey !== undefined && model !== undefined) {
      llm = {
        apiKey,
        model,
        ...(preset !== undefined ? { preset } : {}),
        ...(wire !== undefined ? { wire } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
  }

  const callTimeoutMs = positiveInt("TRPG_MODULES__CALL_TIMEOUT_MS") ?? DEFAULT_CALL_TIMEOUT_MS;
  const locale = text("TRPG_LOCALE") ?? "en";

  if (problems.length > 0) throw new ConfigError(problems);
  return { locale, modules: { callTimeoutMs }, ...(llm !== undefined ? { llm } : {}) };
}
