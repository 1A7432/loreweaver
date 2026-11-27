// The model lanes at run time: the operator's settings with an admin's overrides on top,
// persisted server-wide, a credential book per provider, snapshots that never change once
// made, and asking a provider for its models through an injected fetch (no network).
import { describe, expect, test } from "bun:test";

import { type BuiltClient, ModelSettings, type ModelEnvironment } from "../../src/gateway/model_settings.ts";
import type { ImageGenSettings } from "../../src/infra/imagegen/index.ts";
import { type LLMSettings, ScriptedLLM } from "../../src/infra/llm/index.ts";
import { MAX_LISTED_MODELS } from "../../src/infra/llm/models_list.ts";
import { openDatabase } from "../../src/infra/runtime/sqlite.ts";
import { maskSecret, ServerSettings } from "../../src/infra/server_settings.ts";

const ENV_KEY = "sk-env-openai-0123456789";
const DEEPSEEK_KEY = "sk-deepseek-abcdefghijklmnop";
const ENV: ModelEnvironment = { llm: { preset: "openai", apiKey: ENV_KEY, model: "gpt-5.5" }, lanes: {} };

/** A scripted client per build, remembering the settings it was built from. */
function builders(built: LLMSettings[] = [], images: ImageGenSettings[] = []) {
  return {
    llm: (settings: LLMSettings): BuiltClient => {
      built.push(settings);
      return { client: new ScriptedLLM([]), contextWindow: settings.model === "deepseek-v4-pro" ? 1_000_000 : undefined };
    },
    image: (settings: ImageGenSettings) => {
      images.push(settings);
      return { generate: () => Promise.reject(new Error("no pictures")) };
    },
  };
}

function settingsOn(store = new ServerSettings(openDatabase(":memory:")), env: ModelEnvironment = ENV, extra: Partial<ReturnType<typeof builders>> & { fetch?: typeof fetch; listTimeoutMs?: number } = {}): { models: ModelSettings; store: ServerSettings; built: LLMSettings[] } {
  const built: LLMSettings[] = [];
  return { models: new ModelSettings(env, store, { ...builders(built), ...extra }), store, built };
}

describe("overrides", () => {
  test("the environment's settings, then an override: a new snapshot, the old one unchanged, the key masked", () => {
    const { models } = settingsOn();
    const before = models.snapshot();
    expect(models.describeLane("keeper")).toMatchObject({ source: "environment", provider: "openai", model: "gpt-5.5", baseUrl: "https://api.openai.com/v1", wire: "openai-compatible", key: { set: true, masked: maskSecret(ENV_KEY) } });
    expect(models.describeLane("scribe")).toMatchObject({ source: "default", sameAsKeeper: true, provider: "openai" });
    expect(before.models.scribe).toBe(before.models.keeper);

    const set = models.set("keeper", { provider: "deepseek", model: "deepseek-v4-pro", key: DEEPSEEK_KEY });
    expect(set).toMatchObject({ ok: true, keySaved: true, lane: { source: "override", provider: "deepseek", model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com", contextWindow: 1_000_000 } });
    const after = models.snapshot();
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.models.keeper).not.toBe(before.models.keeper);
    expect(after.contextWindow).toBe(1_000_000);
    expect(before.contextWindow).toBe(32_000);
    expect(Object.isFrozen(before)).toBe(true);
    // The scribe still follows the Keeper — the new one.
    expect(after.models.scribe).toBe(after.models.keeper);
    expect(JSON.stringify(models.describe())).not.toContain(DEEPSEEK_KEY);
    expect(JSON.stringify(models.describe())).not.toContain(ENV_KEY);
  });

  test("kept across a restart on the same database; reset brings back the environment's", () => {
    const store = new ServerSettings(openDatabase(":memory:"));
    const first = settingsOn(store).models;
    expect(first.set("keeper", { provider: "deepseek", model: "deepseek-v4-pro", key: DEEPSEEK_KEY }).ok).toBe(true);
    expect(first.set("scribe", { provider: "openai", model: "gpt-5.5-mini" }).ok).toBe(true);
    const again = settingsOn(store).models;
    expect(again.describeLane("keeper")).toMatchObject({ source: "override", provider: "deepseek" });
    expect(again.describeLane("scribe")).toMatchObject({ source: "override", provider: "openai", model: "gpt-5.5-mini", key: { masked: maskSecret(ENV_KEY) } });
    expect(again.reset("scribe")).toEqual({ ok: true, lanes: ["scribe"] });
    expect(again.describeLane("scribe")).toMatchObject({ source: "default", sameAsKeeper: true, provider: "deepseek" });
    expect(again.reset()).toEqual({ ok: true, lanes: ["keeper"] });
    expect(again.describeLane("keeper")).toMatchObject({ source: "environment", provider: "openai", model: "gpt-5.5" });
    expect(again.reset()).toEqual({ ok: true, lanes: [] });
    expect(settingsOn(store).models.describeLane("keeper").source).toBe("environment");
  });

  test("the credential book: switching back to a provider uses the key saved for it, and a reset keeps the book", () => {
    const { models, built } = settingsOn();
    expect(models.set("keeper", { provider: "deepseek", model: "deepseek-v4-pro", key: DEEPSEEK_KEY }).ok).toBe(true);
    // To OpenAI: the environment's OpenAI key, not DeepSeek's.
    expect(models.set("keeper", { provider: "openai", model: "gpt-5.5" }).ok).toBe(true);
    expect(built.at(-1)).toMatchObject({ preset: "openai", apiKey: ENV_KEY });
    // Back to DeepSeek without a key: the saved one.
    expect(models.set("keeper", { provider: "deepseek", model: "deepseek-v4-flash" }).ok).toBe(true);
    expect(built.at(-1)).toMatchObject({ preset: "deepseek", apiKey: DEEPSEEK_KEY, model: "deepseek-v4-flash" });
    models.reset();
    expect(models.set("npc", { provider: "deepseek", model: "deepseek-v4-pro" }).ok).toBe(true);
    expect(built.at(-1)).toMatchObject({ preset: "deepseek", apiKey: DEEPSEEK_KEY });
    expect(models.describe().providers.find((provider) => provider.id === "deepseek")).toEqual({ id: "deepseek", preset: true, wire: "openai-compatible", baseUrl: "https://api.deepseek.com", credential: true });
    expect(models.describe().providers.find((provider) => provider.id === "moonshot")?.credential).toBe(false);
  });

  test("`key` sets the key of the provider a lane uses now, and keeps its model", () => {
    const { models, built } = settingsOn();
    const keyed = models.setKey("keeper", "sk-new-openai-key-0123456789");
    expect(keyed).toMatchObject({ ok: true, provider: "openai", lane: { source: "override", model: "gpt-5.5", key: { masked: "sk-n...6789" } } });
    expect(built.at(-1)).toMatchObject({ preset: "openai", apiKey: "sk-new-openai-key-0123456789", model: "gpt-5.5" });
    const bare = settingsOn(undefined, { lanes: {} }).models;
    expect(bare.setKey("keeper", "sk-whatever-0123456789")).toEqual({ ok: false, code: "model_not_configured" });
    expect(bare.snapshot().configured).toBe(false);
  });

  test("an endpoint of the admin's own naming, and the refusals", () => {
    const { models } = settingsOn();
    expect(models.set("keeper", { provider: "mylab", model: "m1" })).toEqual({ ok: false, code: "unknown_provider", params: { provider: "mylab" } });
    expect(models.set("keeper", { provider: "mylab", model: "m1", baseUrl: "http://10.0.0.5:8000/v1" })).toMatchObject({ ok: true, lane: { provider: "mylab", baseUrl: "http://10.0.0.5:8000/v1", wire: "openai-compatible", key: { set: false } } });
    expect(models.describe().providers.find((provider) => provider.id === "mylab")).toEqual({ id: "mylab", preset: false, wire: null, baseUrl: "http://10.0.0.5:8000/v1", credential: false });
    expect(models.set("keeper", { provider: "openai" })).toEqual({ ok: false, code: "model_required" });
    expect(models.set("keeper", { provider: "openai", model: "gpt", wire: "anthropic" })).toEqual({ ok: false, code: "model_wire_mismatch" });
    expect(models.set("keeper", { provider: "Bad Name", model: "m" })).toEqual({ ok: false, code: "bad_provider" });
    expect(models.set("keeper", { provider: "x", model: "m", baseUrl: "file:///etc/passwd" })).toEqual({ ok: false, code: "bad_base_url" });
    expect(models.set("keeper", { provider: "x", model: "m", baseUrl: "https://user:sk-hidden@llm.example/v1" })).toEqual({ ok: false, code: "bad_base_url" });
    expect(models.set("keeper", { provider: "openai", model: "gpt\u0000x" })).toEqual({ ok: false, code: "bad_model_id" });
    expect(models.set("keeper", { provider: "openai", model: "gpt", key: "has space" })).toEqual({ ok: false, code: "bad_key" });
  });

  test("a user or password the operator wrote into a base URL is never shown", () => {
    const { models } = settingsOn(undefined, { llm: { apiKey: "k-0123456789abcdefgh", model: "m", baseUrl: "https://op:hunter2@llm.example/v1" }, lanes: {}, imagegen: { baseUrl: "https://op:hunter3@img.example/v1", apiKey: "k", model: "i", size: "auto", dialect: "openai" } });
    const shown = JSON.stringify(models.describe());
    expect(shown).not.toContain("hunter2");
    expect(shown).not.toContain("hunter3");
    expect(models.describeLane("keeper").baseUrl).toBe("https://***@llm.example/v1");
  });

  test("a stored override that is damaged is ignored, the environment's stands", () => {
    const store = new ServerSettings(openDatabase(":memory:"));
    store.put("models.lanes", [["keeper", { provider: "nonesuch", model: "x" }], ["constructor", { provider: "openai", model: "y" }], "junk"]);
    const { models } = settingsOn(store);
    expect(models.describeLane("keeper").source).toBe("environment");
  });

  test("a change tells the listeners", () => {
    const { models } = settingsOn();
    let told = 0;
    models.onChange(() => (told += 1));
    models.set("keeper", { provider: "deepseek", model: "deepseek-v4-pro" });
    models.reset();
    models.reset();
    expect(told).toBe(2);
  });
});

describe("image generation", () => {
  test("set, its book, and off", () => {
    const images: ImageGenSettings[] = [];
    const store = new ServerSettings(openDatabase(":memory:"));
    const models = new ModelSettings(ENV, store, builders([], images));
    expect(models.image()).toBeNull();
    expect(models.describe().imagegen).toMatchObject({ source: "default", enabled: false });
    expect(models.imageSet({ provider: "openai" })).toEqual({ ok: false, code: "model_required" });
    expect(models.imageSet({ provider: "xai", model: "grok-imagine" })).toEqual({ ok: false, code: "image_base_url_required", params: { provider: "xai" } });
    expect(models.imageSet({ provider: "openai", model: "gpt-image-2", size: "big" })).toEqual({ ok: false, code: "bad_image_size" });
    const set = models.imageSet({ provider: "openai", model: "gpt-image-2", key: "sk-image-openai-0123456789" });
    expect(set).toMatchObject({ ok: true, keySaved: true, imagegen: { source: "override", enabled: true, provider: "openai", model: "gpt-image-2", size: "1024x1024", baseUrl: "https://api.openai.com/v1", key: { set: true, masked: "sk-i...6789" } } });
    expect(models.image()).not.toBeNull();
    expect(images.at(-1)).toMatchObject({ dialect: "openai", apiKey: "sk-image-openai-0123456789" });
    expect(models.imageSet({ provider: "xai", model: "grok-imagine", baseUrl: "https://images.example/v1", key: "xai-image-key-0123456789" }).ok).toBe(true);
    expect(images.at(-1)).toMatchObject({ dialect: "xai", baseUrl: "https://images.example/v1" });
    // Back to OpenAI: its saved key.
    expect(models.imageSet({ provider: "openai", model: "gpt-image-2" }).ok).toBe(true);
    expect(images.at(-1)).toMatchObject({ apiKey: "sk-image-openai-0123456789" });
    expect(models.imageOff()).toEqual({ ok: true, changed: true });
    expect(models.image()).toBeNull();
    expect(new ModelSettings(ENV, store, builders()).describe().imagegen).toMatchObject({ source: "override", enabled: false });
    expect(JSON.stringify(models.describe())).not.toContain("sk-image-openai-0123456789");
  });
});

/** A fetch that answers every request with `body` (JSON) and `status`, recording the URLs and headers. */
function answering(body: unknown, status = 200, seen: { url: string; headers: Headers }[] = []): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    seen.push({ url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("asking a provider for its models", () => {
  test("the lane's endpoint, with its key; ids checked", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const ids = ["gpt-5.5", "gpt-5.5-mini", "bad\u0007id", "x".repeat(201), 42, "gpt-5.5"];
    const { models } = settingsOn(undefined, ENV, { fetch: answering({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }, 200, seen) });
    const listed = await models.listModels({});
    expect(listed).toEqual({ ok: true, provider: "openai", models: ["gpt-5.5", "gpt-5.5-mini"], total: 2, truncated: false, skipped: 3 });
    expect(seen[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${ENV_KEY}`);
  });

  test("an Anthropic endpoint: its own path and headers", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const { models } = settingsOn(undefined, { llm: { preset: "anthropic", apiKey: "sk-ant-0123456789abcdef", model: "claude-opus-5-5" }, lanes: {} }, { fetch: answering({ data: [{ id: "claude-opus-5-5", type: "model" }], has_more: false, first_id: null, last_id: null }, 200, seen) });
    expect(await models.listModels({})).toMatchObject({ ok: true, provider: "anthropic", models: ["claude-opus-5-5"] });
    expect(seen[0]?.url.startsWith("https://api.anthropic.com/v1/models")).toBe(true);
    // However the SDK sends the credential (it chooses the header), it is this lane's key.
    expect([seen[0]?.headers.get("x-api-key"), seen[0]?.headers.get("authorization")]).toContainEqual(expect.stringContaining("sk-ant-0123456789abcdef"));
    expect(seen[0]?.headers.get("anthropic-version")).not.toBeNull();
  });

  test("an oversized list is cut and says so", async () => {
    const data = Array.from({ length: MAX_LISTED_MODELS + 100 }, (_, index) => ({ id: `model-${index}` }));
    const { models } = settingsOn(undefined, ENV, { fetch: answering({ data }) });
    const listed = await models.listModels({});
    expect(listed).toMatchObject({ ok: true, total: MAX_LISTED_MODELS + 100, truncated: true });
    if (listed.ok) expect(listed.models).toHaveLength(MAX_LISTED_MODELS);
  });

  test("a body over the byte cap, a provider that never answers, a refused key, a non-JSON answer", async () => {
    const huge = settingsOn(undefined, ENV, { fetch: answering({ data: [{ id: "x".repeat(5 * 1024 * 1024) }] }) }).models;
    expect(await huge.listModels({})).toEqual({ ok: false, code: "model_list_too_large", params: { code: "too_large" } });

    const hanging = ((_input: unknown, init?: { signal?: AbortSignal | null }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const slow = settingsOn(undefined, ENV, { fetch: hanging, listTimeoutMs: 30 }).models;
    expect(await slow.listModels({})).toEqual({ ok: false, code: "model_list_timeout", params: { code: "timeout" } });

    const refused = settingsOn(undefined, ENV, { fetch: answering({ error: { message: "bad key" } }, 401) }).models;
    expect(await refused.listModels({})).toEqual({ ok: false, code: "model_list_failed", params: { code: "auth" } });

    const garbled = settingsOn(undefined, ENV, { fetch: answering("<html>not json</html>") }).models;
    const outcome = await garbled.listModels({});
    expect(outcome.ok).toBe(false);
  });

  test("another provider's endpoint by name, from the book; nothing configured", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const { models } = settingsOn(undefined, ENV, { fetch: answering({ data: [{ id: "deepseek-v4-pro" }] }, 200, seen) });
    models.set("npc", { provider: "deepseek", model: "deepseek-v4-pro", key: DEEPSEEK_KEY });
    expect(await models.listModels({ provider: "deepseek" })).toMatchObject({ ok: true, provider: "deepseek", models: ["deepseek-v4-pro"] });
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${DEEPSEEK_KEY}`);
    expect(await models.listModels({ provider: "mylab" })).toEqual({ ok: false, code: "unknown_provider", params: { provider: "mylab" } });
    expect(await settingsOn(undefined, { lanes: {} }).models.listModels({})).toEqual({ ok: false, code: "model_not_configured" });
  });
});
