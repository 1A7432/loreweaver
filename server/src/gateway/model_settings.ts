// The model lanes and image generation as they are NOW: the operator's settings (`TRPG_*`,
// read once by `infra/config.ts`) with a room admin's run-time overrides on top, and the
// clients built from the result. Server-wide, as in 2.6: one admin's switch is every
// room's.
//
// - What is stored (`infra/server_settings.ts`): per lane an override that is a complete
//   endpoint — provider, model, base URL, key, wire and the tuning `config.ts` lets the
//   variables set (effort, context window, output tokens, timeout, the prompt cache key) —
//   the image override (an endpoint, or "off"), and two credential books, provider → key and
//   base URL, so switching back to a provider does not ask for its key again (2.6's
//   `CredentialBook`). The effective setting of a lane is its override if it has one, else
//   the variables', else (a lane other than the Keeper's) the Keeper's client itself.
// - Taking effect: every change rebuilds the clients and swaps in a new SNAPSHOT (a version
//   and the five lanes' clients, plus the Keeper model's context window). A snapshot is never
//   changed once made. The room takes one when it makes the context for a piece of work and
//   keeps it for that work's whole life (`gateway/room.ts` `#contextFor`), so a turn in
//   flight — its tool rounds, its NPC calls, its fold, the Scribe pass scheduled with its
//   context — finishes on the clients it started with, and the next turn starts on the new
//   ones. Nothing here waits for a turn and no turn waits for this.
// - Image generation is looked up at each picture (the Keeper's `generate_image` asks
//   `image()` when it runs), not pinned per turn: one picture is one request.
//
// Inputs are content from people and providers: provider names and ids are checked against
// a plain pattern, model ids for length and printable characters, base URLs parsed as
// http(s) URLs, the credential book capped. A refusal is a code (and its parameters) for
// the command layer to word.
import type { AdminModelLane, AdminModelView, SettingSource } from "loreweaver-protocol/v3";

import type { LaneModels } from "../agent/context.ts";
import type { Settings } from "../infra/config.ts";
import { createImageGen, type ImageDialect, type ImageGenerator, type ImageGenSettings } from "../infra/imagegen/index.ts";
import { contextWindowFor, createLLM, LLMConfigError, type LLMClient, LLMError, type LLMSettings, PRESETS, type ReasoningEffort, resolveEndpoint, type Wire } from "../infra/llm/index.ts";
import { acceptableModelId, listProviderModels, type ModelListOutcome } from "../infra/llm/models_list.ts";
import { maskSecret, type ServerSettings } from "../infra/server_settings.ts";

export const MODEL_LANES = ["keeper", "npc", "scribe", "director", "memory"] as const;
export type ModelLane = (typeof MODEL_LANES)[number];

export const WIRES: readonly Wire[] = ["openai-compatible", "anthropic", "openai-responses"];
export const EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * The window assumed for a Keeper model this server has no figure for. Deliberately small: a
 * window guessed too large never folds and ends in the provider refusing the prompt; one
 * guessed too small only folds early. The operator states the real one with
 * `TRPG_LLM__CONTEXT_WINDOW`, an admin with `model set … context=N`.
 */
export const FALLBACK_CONTEXT_WINDOW = 32_000;

/** A provider name: a preset id, or an admin's label for an endpoint. Lower case, plain. */
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
export const MAX_PROVIDER_CHARS = 64;
export const MAX_BASE_URL_CHARS = 2000;
export const MAX_SECRET_CHARS = 1000;
/** Saved credentials per book. */
export const MAX_SAVED_CREDENTIALS = 64;
/** Same pattern as `TRPG_IMAGEGEN__SIZE`. */
const IMAGE_SIZE = /^(auto|[1-9]\d{1,4}x[1-9]\d{1,4})$/u;
const DEFAULT_IMAGE_SIZE = "1024x1024";
/** Image providers this server knows by name; any other needs a base URL and speaks OpenAI's request shape. */
export const IMAGE_PROVIDERS: readonly ImageDialect[] = ["openai", "xai"];
/** Where a lane with an operator endpoint but no preset is filed in the credential book. */
const UNNAMED_PROVIDER = "custom";

const STORED = {
  lanes: "models.lanes",
  credentials: "models.credentials",
  image: "imagegen.override",
  imageCredentials: "imagegen.credentials",
} as const;

interface LaneOverride {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly wire?: Wire;
  readonly reasoningEffort?: ReasoningEffort;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly promptCacheKey?: boolean;
}

interface Credential {
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

interface ImageEndpoint {
  readonly provider: string;
  readonly model: string;
  readonly size: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
}

type ImageOverride = { readonly off: true } | (ImageEndpoint & { readonly off?: undefined });

/** What `model set` takes. */
export interface LaneInput {
  readonly provider: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly key?: string;
  readonly wire?: Wire;
  readonly effort?: ReasoningEffort;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly promptCacheKey?: boolean;
}

/** What `imagegen set` takes. */
export interface ImageInput {
  readonly provider: string;
  readonly model?: string;
  readonly size?: string;
  readonly key?: string;
  readonly baseUrl?: string;
}

export type SettingsRefusal = { readonly ok: false; readonly code: string; readonly params?: Readonly<Record<string, string | number>> };
export type SettingsOutcome<T> = ({ readonly ok: true } & T) | SettingsRefusal;

/** One immutable state of the lanes: what a piece of work keeps from start to end. */
export interface ModelSnapshot {
  /** Grows with every change. */
  readonly version: number;
  readonly models: LaneModels;
  /** The Keeper model's context window, or `FALLBACK_CONTEXT_WINDOW` when unknown. */
  readonly contextWindow: number;
  readonly contextWindowKnown: boolean;
  /** Whether the Keeper's lane has any model configured. */
  readonly configured: boolean;
}

/** A built client and the context window its model has, where known. */
export interface BuiltClient {
  readonly client: LLMClient;
  readonly contextWindow?: number | undefined;
}

/** How clients are made (tests hand scripted ones per provider) and the provider listing's network. */
export interface ModelBuilders {
  readonly llm?: (settings: LLMSettings) => BuiltClient;
  readonly image?: (settings: ImageGenSettings) => ImageGenerator;
  readonly fetch?: typeof fetch;
  readonly listTimeoutMs?: number;
}

/** The part of `Settings` this reads: the operator's model and image settings. */
export type ModelEnvironment = Pick<Settings, "lanes"> & { readonly llm?: Settings["llm"]; readonly imagegen?: Settings["imagegen"] };

/** A lane with no model configured: every call fails as a provider that refuses the key. */
export class UnconfiguredLLM implements LLMClient {
  chat(): Promise<never> {
    return Promise.reject(new LLMError({ code: "auth", retryable: false }));
  }
}

interface Effective {
  readonly settings: LLMSettings | null;
  readonly provider: string | null;
  readonly source: SettingSource;
  /** False: a lane that uses the Keeper's client. */
  readonly own: boolean;
}

interface ImageEffective {
  readonly settings: ImageGenSettings | null;
  readonly provider: string | null;
  readonly source: SettingSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPreset(provider: string): boolean {
  return Object.hasOwn(PRESETS, provider);
}

/**
 * A base URL people typed: http(s), parseable, capped, and with no user or password in it —
 * a URL is shown whole in `admin/model`, so it must not be a way to carry a secret unmasked.
 */
export function acceptableBaseUrl(value: string): boolean {
  if (value.length > MAX_BASE_URL_CHARS || !URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.username !== "" || url.password !== "") return false;
  return url.protocol === "https:" || url.protocol === "http:";
}

export function acceptableProvider(value: string): boolean {
  return PROVIDER.test(value);
}

function acceptableSecret(value: string): boolean {
  return value !== "" && value.length <= MAX_SECRET_CHARS && !/[\s\p{Cc}]/u.test(value);
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** A stored lane override, checked as strictly as one typed: anything unusable is dropped. */
function readLaneOverride(value: unknown): LaneOverride | null {
  if (!isRecord(value)) return null;
  const { provider, model, baseUrl, apiKey, wire, reasoningEffort, promptCacheKey } = value;
  if (typeof provider !== "string" || !acceptableProvider(provider) || !acceptableModelId(model)) return null;
  if (baseUrl !== undefined && (typeof baseUrl !== "string" || !acceptableBaseUrl(baseUrl))) return null;
  if (!isPreset(provider) && baseUrl === undefined) return null;
  const out: { -readonly [K in keyof LaneOverride]: LaneOverride[K] } = { provider, model };
  if (typeof baseUrl === "string") out.baseUrl = baseUrl;
  if (typeof apiKey === "string" && acceptableSecret(apiKey)) out.apiKey = apiKey;
  if (WIRES.includes(wire as Wire)) out.wire = wire as Wire;
  if (EFFORTS.includes(reasoningEffort as ReasoningEffort)) out.reasoningEffort = reasoningEffort as ReasoningEffort;
  const contextWindow = positive(value.contextWindow);
  const maxOutputTokens = positive(value.maxOutputTokens);
  const timeoutMs = positive(value.timeoutMs);
  if (contextWindow !== undefined) out.contextWindow = contextWindow;
  if (maxOutputTokens !== undefined) out.maxOutputTokens = maxOutputTokens;
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  if (typeof promptCacheKey === "boolean") out.promptCacheKey = promptCacheKey;
  return out;
}

function readCredential(value: unknown): Credential | null {
  if (!isRecord(value)) return null;
  const out: { apiKey?: string; baseUrl?: string } = {};
  if (typeof value.apiKey === "string" && acceptableSecret(value.apiKey)) out.apiKey = value.apiKey;
  if (typeof value.baseUrl === "string" && acceptableBaseUrl(value.baseUrl)) out.baseUrl = value.baseUrl;
  return out.apiKey === undefined && out.baseUrl === undefined ? null : out;
}

function readImageOverride(value: unknown): ImageOverride | null {
  if (!isRecord(value)) return null;
  if (value.off === true) return { off: true };
  const { provider, model, size, baseUrl, apiKey } = value;
  if (typeof provider !== "string" || !acceptableProvider(provider) || !acceptableModelId(model)) return null;
  if (typeof size !== "string" || !IMAGE_SIZE.test(size) || typeof baseUrl !== "string" || !acceptableBaseUrl(baseUrl)) return null;
  const out: { -readonly [K in keyof ImageEndpoint]: ImageEndpoint[K] } = { provider, model, size, baseUrl };
  if (typeof apiKey === "string" && acceptableSecret(apiKey)) out.apiKey = apiKey;
  return out;
}

/** Ordered `[name, value]` pairs from storage (names are content: never an object's keys). */
function readPairs<T>(value: unknown, read: (item: unknown) => T | null, nameOk: (name: string) => boolean): Map<string, T> {
  const out = new Map<string, T>();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !nameOk(item[0])) continue;
    const parsed = read(item[1]);
    if (parsed !== null && !out.has(item[0])) out.set(item[0], parsed);
  }
  return out;
}

function laneSettings(override: LaneOverride): LLMSettings {
  return {
    apiKey: override.apiKey ?? "",
    model: override.model,
    ...(isPreset(override.provider) ? { preset: override.provider } : {}),
    ...(override.baseUrl === undefined ? {} : { baseUrl: override.baseUrl }),
    ...(override.wire === undefined ? {} : { wire: override.wire }),
    ...(override.reasoningEffort === undefined ? {} : { reasoningEffort: override.reasoningEffort }),
    ...(override.contextWindow === undefined ? {} : { contextWindow: override.contextWindow }),
    ...(override.maxOutputTokens === undefined ? {} : { maxOutputTokens: override.maxOutputTokens }),
    ...(override.timeoutMs === undefined ? {} : { timeoutMs: override.timeoutMs }),
    ...(override.promptCacheKey === undefined ? {} : { promptCacheKey: override.promptCacheKey }),
  };
}

/** The override that reproduces `settings` under `provider` (for `model key` on a lane without one). */
function overrideFrom(settings: LLMSettings, provider: string): LaneOverride {
  return {
    provider,
    model: settings.model,
    ...(settings.apiKey === "" ? {} : { apiKey: settings.apiKey }),
    ...(settings.baseUrl === undefined ? {} : { baseUrl: settings.baseUrl }),
    ...(settings.wire === undefined ? {} : { wire: settings.wire }),
    ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort }),
    ...(settings.contextWindow === undefined ? {} : { contextWindow: settings.contextWindow }),
    ...(settings.maxOutputTokens === undefined ? {} : { maxOutputTokens: settings.maxOutputTokens }),
    ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }),
    ...(settings.promptCacheKey === undefined ? {} : { promptCacheKey: settings.promptCacheKey }),
  };
}

function defaultLLM(settings: LLMSettings): BuiltClient {
  const client = createLLM(settings);
  return { client, contextWindow: client.contextWindow };
}

/** A base URL as an admin view shows it: a user or password the operator wrote into it is starred. */
function shownUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  if (parsed.username === "" && parsed.password === "") return url;
  parsed.username = "***";
  parsed.password = "";
  return parsed.toString();
}

function masked(secret: string | undefined): { set: boolean; masked: string | null } {
  return secret === undefined || secret === "" ? { set: false, masked: null } : { set: true, masked: maskSecret(secret) };
}

export class ModelSettings {
  readonly #env: ModelEnvironment;
  readonly #store: ServerSettings;
  readonly #builders: ModelBuilders;
  readonly #listeners: (() => void)[] = [];
  #lanes: Map<string, LaneOverride>;
  #book: Map<string, Credential>;
  #image: ImageOverride | null;
  #imageBook: Map<string, Credential>;
  #snapshot: ModelSnapshot;
  #imageClient: ImageGenerator | null = null;
  #version = 0;
  /** Stored overrides that could not be used at the last build, by lane (for the operator's notes). */
  #unusable: string[] = [];

  constructor(env: ModelEnvironment, store: ServerSettings, builders: ModelBuilders = {}) {
    this.#env = env;
    this.#store = store;
    this.#builders = builders;
    this.#lanes = readPairs(store.get(STORED.lanes), readLaneOverride, (name) => (MODEL_LANES as readonly string[]).includes(name));
    this.#book = readPairs(store.get(STORED.credentials), readCredential, acceptableProvider);
    this.#image = readImageOverride(store.get(STORED.image));
    this.#imageBook = readPairs(store.get(STORED.imageCredentials), readCredential, acceptableProvider);
    this.#snapshot = this.#build();
    this.#imageClient = this.#buildImage();
  }

  /** The lanes now. Keep the object for the work at hand; take a new one for the next. */
  snapshot(): ModelSnapshot {
    return this.#snapshot;
  }

  /**
   * Lane clients that always answer with the CURRENT snapshot's: for whatever holds a
   * `Services` outside a room's pinned contexts.
   */
  liveModels(): LaneModels {
    const now = (): LaneModels => this.#snapshot.models;
    return {
      get keeper() {
        return now().keeper;
      },
      get npc() {
        return now().npc;
      },
      get scribe() {
        return now().scribe;
      },
      get director() {
        return now().director;
      },
      get memory() {
        return now().memory;
      },
    };
  }

  /** The image client now; null when pictures are off or not configured. */
  image(): ImageGenerator | null {
    return this.#imageClient;
  }

  /** Lanes whose stored override could not be used at the last build. */
  get unusableOverrides(): readonly string[] {
    return this.#unusable;
  }

  /** Told after every change (the hub refreshes every open room's views). */
  onChange(listener: () => void): void {
    this.#listeners.push(listener);
  }

  // --- the model lanes ------------------------------------------------------------------

  /** `model set`: `lane` now talks to `input.provider`. */
  set(lane: ModelLane, input: LaneInput): SettingsOutcome<{ readonly lane: AdminModelLane; readonly keySaved: boolean }> {
    const provider = input.provider.toLowerCase();
    const checked = this.#checkEndpointInput(provider, input.baseUrl, input.key);
    if (checked !== null) return checked;
    if (input.model !== undefined && !acceptableModelId(input.model)) return { ok: false, code: "bad_model_id" };
    const current = this.#effective(lane);
    const same = current.settings !== null && current.provider === provider;
    const saved = same ? undefined : this.#credentialFor(provider);
    const apiKey = input.key ?? (same ? current.settings?.apiKey : saved?.apiKey);
    const baseUrl = input.baseUrl ?? (same ? current.settings?.baseUrl : saved?.baseUrl);
    if (!isPreset(provider) && baseUrl === undefined) return { ok: false, code: "unknown_provider", params: { provider } };
    const model = input.model ?? (same ? current.settings?.model : undefined);
    if (model === undefined) return { ok: false, code: "model_required" };
    // The tuning goes with the model: kept when only the key or the endpoint changes.
    const keep = same && model === current.settings?.model ? current.settings : null;
    const override: LaneOverride = {
      provider,
      model,
      ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...pick("wire", input.wire ?? (same ? current.settings?.wire : undefined)),
      ...pick("reasoningEffort", input.effort ?? keep?.reasoningEffort),
      ...pick("contextWindow", input.contextWindow ?? keep?.contextWindow),
      ...pick("maxOutputTokens", input.maxOutputTokens ?? keep?.maxOutputTokens),
      ...pick("timeoutMs", input.timeoutMs ?? keep?.timeoutMs),
      ...pick("promptCacheKey", input.promptCacheKey ?? keep?.promptCacheKey),
    };
    const built = this.#tryBuild(laneSettings(override));
    if (built !== null) return built;
    let keySaved = false;
    if (input.key !== undefined || input.baseUrl !== undefined) {
      const remembered = this.#remember(this.#book, provider, { apiKey: override.apiKey, baseUrl });
      if (remembered !== null) return remembered;
      keySaved = input.key !== undefined;
    }
    this.#lanes.set(lane, override);
    this.#commit();
    return { ok: true, lane: this.#describeLane(lane), keySaved };
  }

  /** `model key`: the key of the provider `lane` uses now, saved for that provider too. */
  setKey(lane: ModelLane, key: string): SettingsOutcome<{ readonly lane: AdminModelLane; readonly provider: string }> {
    if (!acceptableSecret(key)) return { ok: false, code: "bad_key" };
    const current = this.#effective(lane);
    if (current.settings === null) return { ok: false, code: "model_not_configured" };
    const provider = current.provider ?? UNNAMED_PROVIDER;
    const override = { ...overrideFrom(current.settings, provider), apiKey: key };
    const built = this.#tryBuild(laneSettings(override));
    if (built !== null) return built;
    const remembered = this.#remember(this.#book, provider, { apiKey: key, baseUrl: current.settings.baseUrl });
    if (remembered !== null) return remembered;
    this.#lanes.set(lane, override);
    this.#commit();
    return { ok: true, lane: this.#describeLane(lane), provider };
  }

  /** `model reset`: drop the override of `lane`, or of every lane. The credential book stays. */
  reset(lane?: ModelLane): { readonly ok: true; readonly lanes: readonly ModelLane[] } {
    const dropped = MODEL_LANES.filter((each) => (lane === undefined || each === lane) && this.#lanes.has(each));
    for (const each of dropped) this.#lanes.delete(each);
    if (dropped.length > 0) this.#commit();
    return { ok: true, lanes: dropped };
  }

  /**
   * `model list`: ask a provider which models it offers — `provider`'s endpoint (from the
   * credential book or the operator's settings), else the one `lane` uses now. Network.
   */
  async listModels(target: { readonly lane?: ModelLane; readonly provider?: string }): Promise<(ModelListOutcome & { readonly ok: true; readonly provider: string | null }) | SettingsRefusal> {
    let settings: LLMSettings;
    let provider: string | null;
    if (target.provider !== undefined) {
      provider = target.provider.toLowerCase();
      if (!acceptableProvider(provider)) return { ok: false, code: "bad_provider" };
      const current = this.#effective(target.lane ?? "keeper");
      const credential = current.provider === provider && current.settings !== null ? { apiKey: current.settings.apiKey, baseUrl: current.settings.baseUrl } : this.#credentialFor(provider);
      if (!isPreset(provider) && credential?.baseUrl === undefined) return { ok: false, code: "unknown_provider", params: { provider } };
      settings = {
        apiKey: credential?.apiKey ?? "",
        model: "list",
        ...(isPreset(provider) ? { preset: provider } : {}),
        ...(credential?.baseUrl === undefined ? {} : { baseUrl: credential.baseUrl }),
      };
    } else {
      const current = this.#effective(target.lane ?? "keeper");
      if (current.settings === null) return { ok: false, code: "model_not_configured" };
      settings = current.settings;
      provider = current.provider;
    }
    const outcome = await listProviderModels(settings, {
      ...(this.#builders.fetch === undefined ? {} : { fetch: this.#builders.fetch }),
      ...(this.#builders.listTimeoutMs === undefined ? {} : { timeoutMs: this.#builders.listTimeoutMs }),
    });
    if (!outcome.ok) return { ok: false, code: outcome.code === "timeout" ? "model_list_timeout" : outcome.code === "too_large" ? "model_list_too_large" : "model_list_failed", params: { code: outcome.code } };
    return { ...outcome, provider };
  }

  // --- image generation -----------------------------------------------------------------

  /** `imagegen set`. */
  imageSet(input: ImageInput): SettingsOutcome<{ readonly imagegen: AdminModelView["imagegen"]; readonly keySaved: boolean }> {
    const provider = input.provider.toLowerCase();
    const checked = this.#checkEndpointInput(provider, input.baseUrl, input.key);
    if (checked !== null) return checked;
    if (input.model !== undefined && !acceptableModelId(input.model)) return { ok: false, code: "bad_model_id" };
    if (input.size !== undefined && !IMAGE_SIZE.test(input.size)) return { ok: false, code: "bad_image_size" };
    const current = this.#imageEffective();
    const same = current.settings !== null && current.provider === provider;
    const saved = same ? undefined : this.#imageCredentialFor(provider);
    const apiKey = input.key ?? (same ? current.settings?.apiKey : saved?.apiKey);
    // OpenAI's own address is its SDK's default (`infra/llm/presets.ts`); no other image
    // vendor's base URL is verified here, so any other provider names one.
    const baseUrl = input.baseUrl ?? (same ? current.settings?.baseUrl : saved?.baseUrl) ?? (provider === "openai" ? PRESETS.openai?.baseUrl : undefined);
    if (baseUrl === undefined) return { ok: false, code: "image_base_url_required", params: { provider } };
    const model = input.model ?? (same ? current.settings?.model : undefined);
    if (model === undefined) return { ok: false, code: "model_required" };
    const size = input.size ?? (same ? current.settings?.size : undefined) ?? this.#env.imagegen?.size ?? DEFAULT_IMAGE_SIZE;
    const endpoint: ImageEndpoint = { provider, model, size, baseUrl, ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }) };
    try {
      this.#makeImage(imageSettings(endpoint));
    } catch {
      return { ok: false, code: "image_config_invalid" };
    }
    let keySaved = false;
    if (input.key !== undefined || input.baseUrl !== undefined) {
      const remembered = this.#remember(this.#imageBook, provider, { apiKey: endpoint.apiKey, baseUrl: input.baseUrl ?? (same ? current.settings?.baseUrl : saved?.baseUrl) });
      if (remembered !== null) return remembered;
      keySaved = input.key !== undefined;
    }
    this.#image = endpoint;
    this.#commit();
    return { ok: true, imagegen: this.#describeImage(), keySaved };
  }

  /** `imagegen off`: no pictures until an admin sets a provider again. */
  imageOff(): { readonly ok: true; readonly changed: boolean } {
    const changed = this.#image?.off !== true;
    this.#image = { off: true };
    this.#commit();
    return { ok: true, changed };
  }

  // --- what an admin sees ---------------------------------------------------------------

  /** The `admin/model` view: masked keys only. */
  describe(): AdminModelView {
    const providers: AdminModelView["providers"] = Object.entries(PRESETS).map(([id, preset]) => ({ id, preset: true, wire: preset.wire, baseUrl: preset.baseUrl, credential: this.#credentialFor(id)?.apiKey !== undefined }));
    for (const [id, credential] of this.#book) {
      if (!isPreset(id)) providers.push({ id, preset: false, wire: null, baseUrl: shownUrl(credential.baseUrl), credential: credential.apiKey !== undefined });
    }
    const imageProviders: AdminModelView["imageProviders"] = IMAGE_PROVIDERS.map((id) => ({ id, credential: this.#imageCredentialFor(id)?.apiKey !== undefined }));
    for (const [id, credential] of this.#imageBook) {
      if (!(IMAGE_PROVIDERS as readonly string[]).includes(id)) imageProviders.push({ id, credential: credential.apiKey !== undefined });
    }
    return { lanes: MODEL_LANES.map((lane) => this.#describeLane(lane)), providers, imagegen: this.#describeImage(), imageProviders };
  }

  /** One lane as `admin/model` shows it. */
  describeLane(lane: ModelLane): AdminModelLane {
    return this.#describeLane(lane);
  }

  #describeLane(lane: ModelLane): AdminModelLane {
    const effective = this.#effective(lane);
    const settings = effective.settings;
    let endpoint: { wire: Wire; baseUrl: string } | null = null;
    if (settings !== null) {
      try {
        endpoint = resolveEndpoint(settings);
      } catch {
        endpoint = null;
      }
    }
    return {
      lane,
      source: effective.source,
      sameAsKeeper: !effective.own,
      provider: effective.provider,
      model: settings?.model ?? null,
      baseUrl: shownUrl(endpoint?.baseUrl ?? settings?.baseUrl),
      wire: endpoint?.wire ?? settings?.wire ?? null,
      effort: settings?.reasoningEffort ?? null,
      contextWindow: settings === null ? null : (contextWindowFor(settings.model, settings.contextWindow) ?? null),
      key: masked(settings?.apiKey),
    };
  }

  #describeImage(): AdminModelView["imagegen"] {
    const effective = this.#imageEffective();
    const settings = effective.settings;
    return {
      source: effective.source,
      enabled: settings !== null,
      provider: effective.provider,
      model: settings?.model ?? null,
      size: settings?.size ?? null,
      baseUrl: shownUrl(settings?.baseUrl),
      key: masked(settings?.apiKey),
    };
  }

  // --- resolution -----------------------------------------------------------------------

  #effective(lane: ModelLane): Effective {
    const override = this.#lanes.get(lane);
    if (override !== undefined) return { settings: laneSettings(override), provider: override.provider, source: "override", own: true };
    const env = lane === "keeper" ? this.#env.llm : this.#env.lanes[lane];
    if (env !== undefined) return { settings: env, provider: env.preset ?? null, source: "environment", own: true };
    if (lane === "keeper") return { settings: null, provider: null, source: "default", own: true };
    return { ...this.#effective("keeper"), source: "default", own: false };
  }

  #imageEffective(): ImageEffective {
    const override = this.#image;
    if (override?.off === true) return { settings: null, provider: null, source: "override" };
    if (override !== null) return { settings: imageSettings(override), provider: override.provider, source: "override" };
    const env = this.#env.imagegen;
    if (env !== undefined) return { settings: env, provider: env.dialect, source: "environment" };
    return { settings: null, provider: null, source: "default" };
  }

  /** The saved credential for `provider`: the book's, else the operator's settings where they name it. */
  #credentialFor(provider: string): Credential | undefined {
    const saved = this.#book.get(provider);
    if (saved !== undefined) return saved;
    for (const env of [this.#env.llm, ...Object.values(this.#env.lanes)]) {
      if (env?.preset === provider) return { apiKey: env.apiKey, ...(env.baseUrl === undefined ? {} : { baseUrl: env.baseUrl }) };
    }
    return undefined;
  }

  #imageCredentialFor(provider: string): Credential | undefined {
    const saved = this.#imageBook.get(provider);
    if (saved !== undefined) return saved;
    const env = this.#env.imagegen;
    if (env !== undefined && env.dialect === provider) return { apiKey: env.apiKey, baseUrl: env.baseUrl };
    return undefined;
  }

  #checkEndpointInput(provider: string, baseUrl: string | undefined, key: string | undefined): SettingsRefusal | null {
    if (!acceptableProvider(provider)) return { ok: false, code: "bad_provider" };
    if (baseUrl !== undefined && !acceptableBaseUrl(baseUrl)) return { ok: false, code: "bad_base_url" };
    if (key !== undefined && !acceptableSecret(key)) return { ok: false, code: "bad_key" };
    return null;
  }

  #remember(book: Map<string, Credential>, provider: string, credential: { readonly apiKey?: string | undefined; readonly baseUrl?: string | undefined }): SettingsRefusal | null {
    if (!book.has(provider) && book.size >= MAX_SAVED_CREDENTIALS) return { ok: false, code: "too_many_credentials", params: { limit: MAX_SAVED_CREDENTIALS } };
    const entry: { apiKey?: string; baseUrl?: string } = {};
    if (credential.apiKey !== undefined && credential.apiKey !== "") entry.apiKey = credential.apiKey;
    if (credential.baseUrl !== undefined) entry.baseUrl = credential.baseUrl;
    if (entry.apiKey === undefined && entry.baseUrl === undefined) return null;
    book.set(provider, entry);
    return null;
  }

  // --- building -------------------------------------------------------------------------

  #make(settings: LLMSettings): BuiltClient {
    return (this.#builders.llm ?? defaultLLM)(settings);
  }

  #makeImage(settings: ImageGenSettings): ImageGenerator {
    return (this.#builders.image ?? ((each) => createImageGen(each)))(settings);
  }

  /** A refusal when no client can be built from `settings`; null when one can. */
  #tryBuild(settings: LLMSettings): SettingsRefusal | null {
    try {
      resolveEndpoint(settings);
    } catch (error) {
      if (error instanceof LLMConfigError) return { ok: false, code: error.problem === "wire_mismatch" ? "model_wire_mismatch" : "model_config_invalid" };
      throw error;
    }
    try {
      this.#make(settings);
    } catch {
      return { ok: false, code: "model_config_invalid" };
    }
    return null;
  }

  #build(): ModelSnapshot {
    const unusable: string[] = [];
    // A stored override that no longer builds (a preset withdrawn since) gives way to the
    // operator's settings for that lane; the operator's own settings were checked at start-up.
    const own = (lane: ModelLane): BuiltClient | null => {
      const override = this.#lanes.get(lane);
      if (override !== undefined) {
        try {
          return this.#make(laneSettings(override));
        } catch {
          unusable.push(lane);
          this.#lanes.delete(lane);
        }
      }
      const env = lane === "keeper" ? this.#env.llm : this.#env.lanes[lane];
      return env === undefined ? null : this.#make(env);
    };
    const keeper = own("keeper");
    const keeperClient = keeper?.client ?? new UnconfiguredLLM();
    const lane = (name: Exclude<ModelLane, "keeper">): LLMClient => own(name)?.client ?? keeperClient;
    const models: LaneModels = { keeper: keeperClient, npc: lane("npc"), scribe: lane("scribe"), director: lane("director"), memory: lane("memory") };
    this.#unusable = unusable;
    const known = keeper?.contextWindow;
    this.#version += 1;
    return Object.freeze({ version: this.#version, models: Object.freeze(models), contextWindow: known ?? FALLBACK_CONTEXT_WINDOW, contextWindowKnown: known !== undefined, configured: keeper !== null });
  }

  #buildImage(): ImageGenerator | null {
    const effective = this.#imageEffective();
    if (effective.settings === null) return null;
    try {
      return this.#makeImage(effective.settings);
    } catch {
      return null;
    }
  }

  /** Persist everything, rebuild, tell the listeners. */
  #commit(): void {
    const pairs = <T>(map: Map<string, T>): [string, T][] => [...map];
    this.#store.put(STORED.lanes, pairs(this.#lanes));
    this.#store.put(STORED.credentials, pairs(this.#book));
    if (this.#image === null) this.#store.delete(STORED.image);
    else this.#store.put(STORED.image, this.#image);
    this.#store.put(STORED.imageCredentials, pairs(this.#imageBook));
    this.#snapshot = this.#build();
    this.#imageClient = this.#buildImage();
    for (const listener of this.#listeners) listener();
  }
}

function imageSettings(endpoint: ImageEndpoint): ImageGenSettings {
  return { baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey ?? "", model: endpoint.model, size: endpoint.size, dialect: endpoint.provider === "xai" ? "xai" : "openai" };
}

/** `{name: value}` when the value is set, `{}` otherwise (for optional fields under exactOptionalPropertyTypes). */
function pick<K extends string, V>(name: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [name]: value }) as { [P in K]?: V };
}
