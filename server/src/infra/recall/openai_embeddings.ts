// A real embeddings endpoint: OpenAI itself and every vendor that serves the same
// `/embeddings` wire. The request and response shapes are those of the SDK's own typings
// (node_modules/openai/resources/embeddings.d.ts, openai 7.65.0).
import OpenAI from "openai";

import { fromOpenAIError } from "../llm/errors.ts";
import type { EmbedOptions, Embeddings } from "./embeddings.ts";
import { RecallError, requirePositiveInteger } from "./errors.ts";

export interface OpenAIEmbeddingsSettings {
  /** The endpoint's base URL; OpenAI's own when absent. Never read from the environment. */
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly model: string;
  /** Asked of the endpoint (`dimensions`, honoured by `text-embedding-3` and later) and checked on every answer. */
  readonly dimensions: number;
  /** Texts per request; a longer list is sent as several requests, in order. Default 64. */
  readonly batchSize?: number;
  readonly timeoutMs?: number;
  /** The SDK's injection point; tests hand it canned responses. */
  readonly fetch?: typeof fetch;
}

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
// OpenAI's cap is 2048 inputs per request (node_modules/openai/resources/embeddings.d.ts);
// other vendors set their own, so the default stays far below it and a setting overrides it.
export const DEFAULT_EMBED_BATCH_SIZE = 64;

// The SDK refuses to construct without a credential, and a self-hosted endpoint may need
// none. This placeholder is what such an endpoint receives instead of nothing.
const NO_KEY = "no-key";

export class OpenAIEmbeddings implements Embeddings {
  readonly dimensions: number;
  readonly #client: OpenAI;
  readonly #model: string;
  readonly #batchSize: number;

  constructor(settings: OpenAIEmbeddingsSettings) {
    this.dimensions = requirePositiveInteger("dimensions", settings.dimensions);
    this.#batchSize = requirePositiveInteger("batchSize", settings.batchSize ?? DEFAULT_EMBED_BATCH_SIZE);
    this.#model = settings.model;
    // Every value the SDK would otherwise read from the environment is given explicitly:
    // Bun loads `.env`, and an ambient OPENAI_API_KEY or OPENAI_BASE_URL must never steer
    // a request to, or credential at, a different endpoint. Retries are the caller's, so
    // the SDK's are off.
    this.#client = new OpenAI({
      apiKey: settings.apiKey || NO_KEY,
      baseURL: settings.baseUrl || DEFAULT_OPENAI_BASE_URL,
      organization: null,
      project: null,
      adminAPIKey: null,
      webhookSecret: null,
      maxRetries: 0,
      ...(settings.timeoutMs === undefined ? {} : { timeout: settings.timeoutMs }),
      ...(settings.fetch ? { fetch: settings.fetch } : {}),
    });
  }

  async embed(texts: readonly string[], options: EmbedOptions = {}): Promise<Float64Array[]> {
    const { signal } = options;
    const vectors: Float64Array[] = [];
    for (let start = 0; start < texts.length; start += this.#batchSize) {
      if (signal?.aborted) throw new RecallError("aborted", { cause: signal.reason });
      const batch = texts.slice(start, start + this.#batchSize);
      let answer: unknown;
      try {
        answer = await this.#client.embeddings.create(
          // `encoding_format` is stated because the SDK otherwise asks for base64 behind the
          // caller's back (node_modules/openai/lib/embeddings.js), which many compatible
          // vendors do not serve; plain floats are understood everywhere.
          { model: this.#model, input: batch, dimensions: this.dimensions, encoding_format: "float" },
          signal ? { signal } : {},
        );
      } catch (error) {
        throw fromProviderError(error, signal);
      }
      vectors.push(...readVectors(answer, batch.length, this.dimensions));
    }
    return vectors;
  }
}

function fromProviderError(error: unknown, signal: AbortSignal | undefined): RecallError {
  if (error instanceof RecallError) return error;
  const failure = fromOpenAIError(error, signal);
  if (failure.code === "aborted") return new RecallError("aborted", { cause: failure });
  return new RecallError("provider", {
    ...(failure.status === undefined ? {} : { status: failure.status }),
    retryable: failure.retryable,
    ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
    cause: failure,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The vectors of an answer, in the order of the request. Vendors are not trusted to
 * match the typings: the item count, each item's `index`, and every vector's length and
 * numbers are checked before anything is returned, so a bad answer never reaches the index.
 */
function readVectors(answer: unknown, expected: number, dimensions: number): Float64Array[] {
  const data = isRecord(answer) ? answer.data : undefined;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new RecallError("bad_response", { detail: { expected, actual: Array.isArray(data) ? data.length : -1 } });
  }
  const vectors: (Float64Array | undefined)[] = new Array<Float64Array | undefined>(expected).fill(undefined);
  for (const item of data as unknown[]) {
    const index = isRecord(item) ? item.index : undefined;
    const embedding = isRecord(item) ? item.embedding : undefined;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= expected || vectors[index] !== undefined) {
      throw new RecallError("bad_response", { detail: { expected, index: typeof index === "number" ? index : -1 } });
    }
    if (!Array.isArray(embedding)) throw new RecallError("bad_response", { detail: { index } });
    if (embedding.length !== dimensions) {
      throw new RecallError("dimension_mismatch", { detail: { expected: dimensions, actual: embedding.length, index } });
    }
    const vector = new Float64Array(dimensions);
    for (let i = 0; i < dimensions; i++) {
      const component: unknown = embedding[i];
      if (typeof component !== "number") throw new RecallError("bad_response", { detail: { index, component: i } });
      if (!Number.isFinite(component)) throw new RecallError("non_finite", { detail: { index, component: i } });
      vector[i] = component;
    }
    vectors[index] = vector;
  }
  return vectors.map((vector) => {
    if (vector === undefined) throw new RecallError("bad_response", { detail: { expected } });
    return vector;
  });
}
