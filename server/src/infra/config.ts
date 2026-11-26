// Settings, read once from the environment (`TRPG_*`, `__` between levels, so the
// variables an operator already has in `.env` keep working). This is the only place that
// reads environment variables; everything else is handed a typed object. Reading is a
// pure function of the variables it is given, and it reports every problem at once —
// an operator fixing a config file should not discover the mistakes one start at a time.
import { PRESETS, type LLMSettings, type ReasoningEffort, type Wire } from "./llm/index.ts";

/** A model lane's own endpoint, resolved: complete settings a client can be built from. */
export type LaneSettings = LLMSettings;

export interface Settings {
  /** The language of rooms on this server until a room sets its own. */
  readonly locale: string;
  /** Where the database, the key file and stored media live. */
  readonly dataDir: string;
  /** Absent when no model is configured; the server still starts and says so. */
  readonly llm?: LLMSettings;
  /**
   * The lanes that may talk to a model of their own. Absent means "the Keeper's client".
   * A lane that names only a model (or an effort) keeps the Keeper's endpoint and key;
   * one that names a provider or a base URL is a separate endpoint and brings its own key.
   */
  readonly lanes: {
    readonly npc?: LaneSettings;
    readonly scribe?: LaneSettings;
    readonly director?: LaneSettings;
    /** The chronicle fold. */
    readonly memory?: LaneSettings;
  };
  readonly turn: {
    /** Tool rounds the Keeper may take in one turn before it must answer. */
    readonly maxRounds: number;
  };
  readonly scribe: { readonly enabled: boolean };
  readonly director: {
    readonly enabled: boolean;
    /** False: the Director may show a pack's pictures but never generates one. */
    readonly images: boolean;
    /** Pictures one story may generate. */
    readonly maxImages: number;
    /** Likely-next subjects one beat may ask to prepare. */
    readonly pregenPerBeat: number;
  };
  /** Fractions of the context window; `core/chronicle` checks their order. */
  readonly chronicle: {
    readonly enabled: boolean;
    readonly trigger: number;
    readonly floor: number;
    readonly emergency: number;
    readonly lagTurns: number;
    readonly summaryMaxChars: number;
  };
  /** Absent: no pictures are generated. */
  readonly imagegen?: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly model: string;
    readonly size: string;
    readonly dialect: "openai" | "xai";
  };
  /** Absent: recall by meaning is off and lore activates by keyword only. */
  readonly embeddings?: {
    readonly baseUrl?: string;
    readonly apiKey: string;
    readonly model: string;
    readonly dimensions: number;
  };
  /** The word filter on text bound for the table; off when both are absent. */
  readonly review: {
    readonly wordlist?: string;
    readonly wordlistPath?: string;
  };
  readonly store: {
    /** How many turns back an undo may reach. */
    readonly undoDepth: number;
  };
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
const WIRES: readonly Wire[] = ["openai-compatible", "anthropic", "openai-responses"];
const DIALECTS = ["openai", "xai"] as const;

/** One assembly of lore templates may take 3 s (`worker/templates`); a call must outlast it. */
const DEFAULT_CALL_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ROUNDS = 12;
const DEFAULT_MAX_IMAGES = 24;
const DEFAULT_PREGEN_PER_BEAT = 2;
const DEFAULT_UNDO_DEPTH = 4;
const DEFAULT_IMAGE_SIZE = "1024x1024";
const DEFAULT_CHRONICLE = { trigger: 0.6, floor: 0.4, emergency: 0.85, lagTurns: 4, summaryMaxChars: 4000 } as const;
const LANES = ["npc", "scribe", "director", "memory"] as const;

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
  /** Zero or a positive whole number. */
  const count = (name: string): number | undefined => {
    if (text(name) === "0") return 0;
    return positiveInt(name);
  };
  /** A fraction from 0 to 1 in plain decimal notation. */
  const fraction = (name: string): number | undefined => {
    const value = text(name);
    if (value === undefined) return undefined;
    if (/^(0(\.\d+)?|1(\.0+)?)$/.test(value)) return Number(value);
    problems.push({ variable: name, problem: "invalid" });
    return undefined;
  };
  const flag = (name: string): boolean | undefined => {
    const value = text(name)?.toLowerCase();
    if (value === undefined) return undefined;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
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
  const url = (name: string): string | undefined => {
    const value = text(name);
    if (value !== undefined && !URL.canParse(value)) {
      problems.push({ variable: name, problem: "invalid" });
      return undefined;
    }
    return value;
  };

  /**
   * One model endpoint under `TRPG_<PREFIX>__`. With `base`, the variables are overrides
   * of it: naming a provider or a base URL makes a separate endpoint; naming only a model
   * or an effort keeps the base's endpoint and key.
   */
  const endpoint = (prefix: string, base?: LLMSettings | undefined, hasBase = false): LLMSettings | undefined => {
    const name = (field: string): string => `TRPG_${prefix}__${field}`;
    const provider = text(name("PROVIDER"))?.toLowerCase();
    const baseUrl = text(name("BASE_URL"));
    const apiKey = text(name("API_KEY"));
    const model = text(name("CHAT_MODEL"));
    const wire = oneOf(name("WIRE"), WIRES);
    const reasoningEffort = oneOf(name("REASONING_EFFORT"), EFFORTS);
    const contextWindow = positiveInt(name("CONTEXT_WINDOW"));
    const maxOutputTokens = positiveInt(name("MAX_OUTPUT_TOKENS"));
    const timeoutMs = positiveInt(name("TIMEOUT_MS"));
    const promptCacheKey = flag(name("PROMPT_CACHE_KEY"));

    if (baseUrl !== undefined && !URL.canParse(baseUrl)) {
      problems.push({ variable: name("BASE_URL"), problem: "invalid" });
    }
    // A provider name is a preset only when this server knows it. With an explicit base
    // URL any other name is just the operator's label for their endpoint.
    const preset = provider !== undefined && Object.hasOwn(PRESETS, provider) ? provider : undefined;
    if (provider !== undefined && preset === undefined && baseUrl === undefined) {
      problems.push({ variable: name("BASE_URL"), problem: "missing" });
    }
    const tuning = {
      ...(wire !== undefined ? { wire } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
    };

    const separate = provider !== undefined || baseUrl !== undefined;
    if (hasBase && !separate) {
      // Overrides of the base endpoint: a key alone is not an override of anything.
      if (apiKey !== undefined) problems.push({ variable: name("BASE_URL"), problem: "missing" });
      if (model === undefined && Object.keys(tuning).length === 0) return undefined;
      if (base === undefined) {
        problems.push({ variable: "TRPG_LLM__CHAT_MODEL", problem: "missing" });
        return undefined;
      }
      return { ...base, ...(model !== undefined ? { model } : {}), ...tuning };
    }

    const wanted = separate || apiKey !== undefined || model !== undefined;
    if (!wanted) return undefined;
    if (apiKey === undefined) problems.push({ variable: name("API_KEY"), problem: "missing" });
    if (model === undefined) problems.push({ variable: name("CHAT_MODEL"), problem: "missing" });
    if (preset === undefined && baseUrl === undefined && provider === undefined) {
      problems.push({ variable: name("BASE_URL"), problem: "missing" });
    }
    if (apiKey === undefined || model === undefined) return undefined;
    return {
      apiKey,
      model,
      ...(preset !== undefined ? { preset } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...tuning,
    };
  };

  const llm = endpoint("LLM");
  const lanes: { -readonly [K in (typeof LANES)[number]]?: LaneSettings } = {};
  for (const lane of LANES) {
    const settings = endpoint(lane.toUpperCase(), llm, true);
    if (settings !== undefined) lanes[lane] = settings;
  }

  const maxRounds = positiveInt("TRPG_TURN__MAX_ROUNDS") ?? DEFAULT_MAX_ROUNDS;
  const scribe = { enabled: flag("TRPG_SCRIBE__ENABLED") ?? true };
  const director = {
    enabled: flag("TRPG_DIRECTOR__ENABLED") ?? true,
    images: flag("TRPG_DIRECTOR__IMAGES") ?? true,
    maxImages: count("TRPG_DIRECTOR__MAX_IMAGES") ?? DEFAULT_MAX_IMAGES,
    pregenPerBeat: count("TRPG_DIRECTOR__PREGEN_PER_BEAT") ?? DEFAULT_PREGEN_PER_BEAT,
  };
  const chronicle = {
    enabled: flag("TRPG_CHRONICLE__ENABLED") ?? true,
    trigger: fraction("TRPG_CHRONICLE__FOLD_TRIGGER") ?? DEFAULT_CHRONICLE.trigger,
    floor: fraction("TRPG_CHRONICLE__FOLD_FLOOR") ?? DEFAULT_CHRONICLE.floor,
    emergency: fraction("TRPG_CHRONICLE__FOLD_EMERGENCY") ?? DEFAULT_CHRONICLE.emergency,
    lagTurns: positiveInt("TRPG_CHRONICLE__LAG_TURNS") ?? DEFAULT_CHRONICLE.lagTurns,
    summaryMaxChars: positiveInt("TRPG_CHRONICLE__SUMMARY_MAX_CHARS") ?? DEFAULT_CHRONICLE.summaryMaxChars,
  };
  if (!(chronicle.floor < chronicle.trigger && chronicle.trigger <= chronicle.emergency)) {
    problems.push({ variable: "TRPG_CHRONICLE__FOLD_TRIGGER", problem: "invalid" });
  }

  // Pictures: no default model. The one the old server defaulted to has been shut down,
  // and a default that goes stale fails at the first picture instead of at start-up.
  let imagegen: Settings["imagegen"];
  {
    const baseUrl = url("TRPG_IMAGEGEN__BASE_URL");
    const apiKey = text("TRPG_IMAGEGEN__API_KEY");
    const model = text("TRPG_IMAGEGEN__MODEL");
    const size = text("TRPG_IMAGEGEN__SIZE") ?? DEFAULT_IMAGE_SIZE;
    const dialect = oneOf("TRPG_IMAGEGEN__DIALECT", DIALECTS) ?? "openai";
    if (!/^(auto|[1-9]\d{1,4}x[1-9]\d{1,4})$/.test(size)) {
      problems.push({ variable: "TRPG_IMAGEGEN__SIZE", problem: "invalid" });
    }
    if (baseUrl !== undefined || apiKey !== undefined || model !== undefined) {
      if (baseUrl === undefined && text("TRPG_IMAGEGEN__BASE_URL") === undefined) {
        problems.push({ variable: "TRPG_IMAGEGEN__BASE_URL", problem: "missing" });
      }
      if (apiKey === undefined) problems.push({ variable: "TRPG_IMAGEGEN__API_KEY", problem: "missing" });
      if (model === undefined) problems.push({ variable: "TRPG_IMAGEGEN__MODEL", problem: "missing" });
      if (baseUrl !== undefined && apiKey !== undefined && model !== undefined) {
        imagegen = { baseUrl, apiKey, model, size, dialect };
      }
    }
  }

  // Recall by meaning: the model and its vector size are both the operator's to state.
  let embeddings: Settings["embeddings"];
  {
    const baseUrl = url("TRPG_EMBEDDINGS__BASE_URL");
    const apiKey = text("TRPG_EMBEDDINGS__API_KEY");
    const model = text("TRPG_EMBEDDINGS__MODEL");
    const dimensions = positiveInt("TRPG_EMBEDDINGS__DIMENSIONS");
    if (baseUrl !== undefined || apiKey !== undefined || model !== undefined || dimensions !== undefined) {
      if (apiKey === undefined) problems.push({ variable: "TRPG_EMBEDDINGS__API_KEY", problem: "missing" });
      if (model === undefined) problems.push({ variable: "TRPG_EMBEDDINGS__MODEL", problem: "missing" });
      if (dimensions === undefined && text("TRPG_EMBEDDINGS__DIMENSIONS") === undefined) {
        problems.push({ variable: "TRPG_EMBEDDINGS__DIMENSIONS", problem: "missing" });
      }
      if (apiKey !== undefined && model !== undefined && dimensions !== undefined) {
        embeddings = { apiKey, model, dimensions, ...(baseUrl !== undefined ? { baseUrl } : {}) };
      }
    }
  }

  const wordlist = text("TRPG_CENSOR__WORDLIST");
  const wordlistPath = text("TRPG_CENSOR__WORDLIST_PATH");
  const undoDepth = positiveInt("TRPG_STORE__UNDO_DEPTH") ?? DEFAULT_UNDO_DEPTH;
  const callTimeoutMs = positiveInt("TRPG_MODULES__CALL_TIMEOUT_MS") ?? DEFAULT_CALL_TIMEOUT_MS;
  const locale = text("TRPG_LOCALE") ?? "en";
  const dataDir = text("TRPG_DATA_DIR") ?? "./data";

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    locale,
    dataDir,
    ...(llm !== undefined ? { llm } : {}),
    lanes,
    turn: { maxRounds },
    scribe,
    director,
    chronicle,
    ...(imagegen !== undefined ? { imagegen } : {}),
    ...(embeddings !== undefined ? { embeddings } : {}),
    review: {
      ...(wordlist !== undefined ? { wordlist } : {}),
      ...(wordlistPath !== undefined ? { wordlistPath } : {}),
    },
    store: { undoDepth },
    modules: { callTimeoutMs },
  };
}
