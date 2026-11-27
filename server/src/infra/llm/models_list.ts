// Asking a provider which models it offers: the `model list` command's network half.
//
// The request is the installed SDK's own (`client.models.list()`), so the path and headers
// are the vendor's as the SDK knows them — `GET /models` with a bearer token on both OpenAI
// wires (node_modules/openai/resources/models.js), `GET /v1/models` with the Anthropic
// credential headers (node_modules/@anthropic-ai/sdk/resources/models.js, a paged list). An
// OpenAI-compatible vendor that has no such endpoint answers with an error like any other.
//
// What comes back is from outside and treated so: the whole exchange has a deadline, the
// bytes read are capped (the injected `fetch` is wrapped so a body over the cap is never
// held), the pages followed are capped, and every id is checked — a string of at most
// `MAX_MODEL_ID_CHARS` code points with no control or format characters. An id that is not
// is skipped and counted, never shown. More than `MAX_LISTED_MODELS` ids are cut there and
// the answer SAYS so (`truncated`, `total`): a long catalog is normal (OpenRouter lists
// hundreds), and refusing it would leave the admin nothing to pick from.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import { fromAnthropicError, fromOpenAIError, LLMError } from "./errors.ts";
import { type LLMSettings, resolveEndpoint } from "./index.ts";

/** The most model ids one answer carries. */
export const MAX_LISTED_MODELS = 500;
/** The longest model id kept, in code points. */
export const MAX_MODEL_ID_CHARS = 200;
/** The most bytes read from the provider for one listing, over all its pages. */
export const MAX_LIST_BYTES = 4 * 1024 * 1024;
/** Pages of a paged list followed before stopping. */
export const MAX_LIST_PAGES = 10;
export const DEFAULT_LIST_TIMEOUT_MS = 15_000;

export type ModelListFailure = "timeout" | "too_large" | "auth" | "rate_limited" | "transient" | "bad_request" | "bad_response" | "unknown";

export type ModelListOutcome =
  | {
      readonly ok: true;
      readonly models: readonly string[];
      /** Acceptable ids the provider listed, before the cut. */
      readonly total: number;
      readonly truncated: boolean;
      /** Entries dropped because their id was not acceptable. */
      readonly skipped: number;
    }
  | { readonly ok: false; readonly code: ModelListFailure };

export interface ModelListRuntime {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

// Control, format and line/paragraph separators: nothing a person should be shown as an id.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Whether `value` is an id this server shows. */
export function acceptableModelId(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) return false;
  if (value.length > MAX_MODEL_ID_CHARS * 2 || [...value].length > MAX_MODEL_ID_CHARS) return false;
  return !UNPRINTABLE.test(value);
}

class TooLarge extends Error {}

/** `base` with every response body read up to what is left of `budget` bytes. */
function cappedFetch(base: typeof fetch, budget: { left: number; over: boolean }): typeof fetch {
  const capped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const response = await base(input, init);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    if (reader !== undefined) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        budget.left -= value.byteLength;
        if (budget.left < 0) {
          budget.over = true;
          await reader.cancel().catch(() => undefined);
          throw new TooLarge("model list too large");
        }
        chunks.push(value);
      }
    }
    return new Response(chunks.length === 0 ? null : new Blob(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return capped as typeof fetch;
}

function failureOf(error: unknown, wire: "anthropic" | "openai"): ModelListFailure {
  const mapped = error instanceof LLMError ? error : wire === "anthropic" ? fromAnthropicError(error) : fromOpenAIError(error);
  switch (mapped.code) {
    case "auth":
    case "rate_limited":
    case "transient":
    case "bad_request":
      return mapped.code;
    default:
      return "unknown";
  }
}

/** The ids `settings`' endpoint lists, checked and capped; or a coded failure. Never throws. */
export async function listProviderModels(settings: LLMSettings, runtime: ModelListRuntime = {}): Promise<ModelListOutcome> {
  let endpoint;
  try {
    endpoint = resolveEndpoint(settings);
  } catch {
    return { ok: false, code: "bad_request" };
  }
  const budget = { left: MAX_LIST_BYTES, over: false };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, runtime.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS);
  const fetchFn = cappedFetch(runtime.fetch ?? fetch, budget);
  const anthropic = endpoint.wire === "anthropic";
  const raw: unknown[] = [];
  try {
    if (anthropic) {
      const client = new Anthropic({ apiKey: settings.apiKey, baseURL: endpoint.baseUrl, maxRetries: 0, fetch: fetchFn });
      let page = await client.models.list(undefined, { signal: controller.signal });
      raw.push(...(Array.isArray(page.data) ? (page.data as unknown[]) : []));
      for (let pages = 1; pages < MAX_LIST_PAGES && page.hasNextPage() && raw.length <= MAX_LISTED_MODELS * 4; pages++) {
        page = await page.getNextPage();
        raw.push(...(Array.isArray(page.data) ? (page.data as unknown[]) : []));
      }
    } else {
      // Every value the SDK would read from the environment is given (see `openai.ts`).
      const client = new OpenAI({
        apiKey: settings.apiKey || "no-key",
        baseURL: endpoint.baseUrl,
        organization: null,
        project: null,
        adminAPIKey: null,
        webhookSecret: null,
        maxRetries: 0,
        fetch: fetchFn,
      });
      const page = await client.models.list({ signal: controller.signal });
      raw.push(...(Array.isArray(page.data) ? (page.data as unknown[]) : []));
    }
  } catch (error) {
    if (budget.over) return { ok: false, code: "too_large" };
    if (timedOut) return { ok: false, code: "timeout" };
    if (error instanceof SyntaxError) return { ok: false, code: "bad_response" };
    return { ok: false, code: failureOf(error, anthropic ? "anthropic" : "openai") };
  } finally {
    clearTimeout(timer);
  }
  const seen = new Set<string>();
  let skipped = 0;
  for (const entry of raw) {
    const id = typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined;
    if (!acceptableModelId(id)) {
      skipped += 1;
      continue;
    }
    seen.add(id);
  }
  const all = [...seen];
  return { ok: true, models: all.slice(0, MAX_LISTED_MODELS), total: all.length, truncated: all.length > MAX_LISTED_MODELS, skipped };
}
