// Every failure a lane raises becomes an LLMError with a code from one small closed set.
// Callers branch on `code`; `status` and `providerMessage` exist for the operator's log.
// No text in here is part of the contract.
//
// The classification is deliberately strict: a code other than `unknown` is assigned only
// from what the installed SDK types or the vendor's own documentation state (defensive
// pattern 3). Sources, read 2026-11-26:
// - Anthropic status/type table, `x-should-retry`, `retry-after`, `error.details.error_code`:
//   https://platform.claude.com/docs/en/api/errors ; codes typed in
//   node_modules/@anthropic-ai/sdk/resources/shared.d.ts.
// - Anthropic context overflow: "If the input alone already exceeds the model's context
//   window, the API returns a 400 `invalid_request_error` ("prompt is too long") on every
//   model." https://platform.claude.com/docs/en/build-with-claude/context-windows
// - OpenAI status table (401/403/429/500/503, Retry-After):
//   https://developers.openai.com/api/docs/guides/error-codes
//
// Context overflow on the OpenAI-compatible wire (looked up 2026-11-26). No two vendors
// report it the same way, and most do not list it on their error page at all, so the
// evidence is what the endpoints actually return: every one answers HTTP 400, and the
// only signal that holds across them is the wording of the message.
// - OpenAI chat completions: `code: "context_length_exceeded"`, `param: "messages"`,
//   "This model's maximum context length is N tokens. However, …"; the newer wording is
//   "Your input exceeds the context window of this model". Its error-code guide lists
//   neither; captured bodies: https://community.openai.com/t/681792
// - xAI: NO such code. "This model's maximum prompt length is N but the request
//   contains M tokens." Its debugging page lists only a generic 400; the wording is from
//   live provider tests (https://github.com/badlogic/pi-mono/issues/129) and a
//   verification against grok-4.5 dated 2026-07-28 quoting the same sentence.
// - DeepSeek: the OpenAI sentence, but `code: "invalid_request_error"` — the code alone
//   would miss it (captured body: https://community.n8n.io/t/85711).
// - OpenRouter: documented. `error.metadata.error_type: "context_length_exceeded"`, and
//   "This endpoint's maximum context length is N tokens"
//   (https://openrouter.ai/docs/api_reference/errors-and-debugging).
// - Groq: "Please reduce the length of the messages or completion" (pi-mono, as above).
// The old server matched the code and the OpenAI sentence only, so it never recognised
// an overflow from xAI. A wording not listed here stays `bad_request`: add it with its
// source when it is seen.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import type { Wire } from "./types.ts";

export type LLMErrorCode = "auth" | "rate_limited" | "context_overflow" | "bad_request" | "transient" | "aborted" | "unknown";

export interface LLMErrorInit {
  readonly code: LLMErrorCode;
  readonly wire?: Wire;
  readonly status?: number;
  /** The provider's own explanation, verbatim; may quote request details, so log only. */
  readonly providerMessage?: string;
  /** Whether asking again could succeed. */
  readonly retryable: boolean;
  /** How long the provider asked us to wait, when it said. */
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class LLMError extends Error {
  readonly code: LLMErrorCode;
  readonly wire: Wire | undefined;
  readonly status: number | undefined;
  readonly providerMessage: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(init: LLMErrorInit) {
    const status = init.status === undefined ? "" : ` ${init.status}`;
    const detail = init.providerMessage ? `: ${init.providerMessage}` : "";
    super(`llm ${init.code}${status}${detail}`, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "LLMError";
    this.code = init.code;
    this.wire = init.wire;
    this.status = init.status;
    this.providerMessage = init.providerMessage;
    this.retryable = init.retryable;
    this.retryAfterMs = init.retryAfterMs;
  }
}

export function abortedError(wire: Wire | undefined, cause: unknown): LLMError {
  return new LLMError({ code: "aborted", wire, retryable: false, cause });
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (error instanceof OpenAI.APIUserAbortError || error instanceof Anthropic.APIUserAbortError) return true;
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Milliseconds the provider asked us to wait. Both SDKs honour `retry-after-ms` before
 * `retry-after` (seconds, or an HTTP date) in their own retry code
 * (node_modules/openai/client.js, node_modules/@anthropic-ai/sdk/client.js,
 * `retryRequest`); ours reads the same headers in the same order.
 */
export function retryAfterMs(headers: Headers | undefined, now: () => number = Date.now): number | undefined {
  if (!headers) return undefined;
  const millis = headers.get("retry-after-ms");
  if (millis !== null) {
    const value = Number.parseFloat(millis);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const after = headers.get("retry-after");
  if (after === null) return undefined;
  const seconds = Number.parseFloat(after);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const date = Date.parse(after);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now());
}

/** The class every vendor shares for an HTTP status; overflow is decided per lane. */
function byStatus(status: number): { code: LLMErrorCode; retryable: boolean } {
  if (status === 401 || status === 402 || status === 403) return { code: "auth", retryable: false };
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status === 408 || status === 409 || status >= 500) return { code: "transient", retryable: true };
  if (status >= 400) return { code: "bad_request", retryable: false };
  return { code: "unknown", retryable: false };
}

// Anthropic's 429s that keep failing until a person acts: the tier and contract spend
// caps (typed as RateLimitError subclasses in shared.d.ts; the errors page says a
// spend-cap 429 "keeps failing until access resumes").
const ANTHROPIC_PERMANENT_429 = new Set(["enforced_spend_limit_reached", "contract_spend_limit_reached"]);
const ANTHROPIC_OVERFLOW = /prompt is too long/i;

export function fromAnthropicError(error: unknown, signal?: AbortSignal): LLMError {
  if (error instanceof LLMError) return error;
  if (isAbort(error, signal)) return abortedError("anthropic", error);
  if (error instanceof Anthropic.APIConnectionError) {
    return new LLMError({ code: "transient", wire: "anthropic", retryable: true, providerMessage: error.message, cause: error });
  }
  if (!(error instanceof Anthropic.APIError)) {
    return new LLMError({ code: "unknown", wire: "anthropic", retryable: false, providerMessage: messageOf(error), cause: error });
  }
  const providerMessage = error.apiMessage ?? error.message;
  const base = { wire: "anthropic" as const, providerMessage, cause: error, retryAfterMs: retryAfterMs(error.headers) };
  if (error.status === undefined) {
    // An `error` event in the middle of a stream (node_modules/@anthropic-ai/sdk/core/streaming.js):
    // no HTTP status, only the body's `error.type`.
    if (error.type === "rate_limit_error") return new LLMError({ ...base, code: "rate_limited", retryable: true });
    if (error.type === "overloaded_error" || error.type === "api_error" || error.type === "timeout_error") {
      return new LLMError({ ...base, code: "transient", retryable: true });
    }
    return new LLMError({ ...base, code: "unknown", retryable: false });
  }
  let { code, retryable } = byStatus(error.status);
  if (error.status === 400 && error.type === "invalid_request_error" && ANTHROPIC_OVERFLOW.test(providerMessage)) {
    code = "context_overflow";
  }
  if (code === "rate_limited" && error.errorCode !== null && ANTHROPIC_PERMANENT_429.has(error.errorCode)) retryable = false;
  // "If the response has an `x-should-retry` header (`true` or `false`), the SDK follows it."
  const shouldRetry = error.headers?.get("x-should-retry");
  if (shouldRetry === "false") retryable = false;
  else if (shouldRetry === "true") retryable = true;
  return new LLMError({ ...base, code, status: error.status, retryable });
}

/** Each wording, with the vendor it was captured from (sources in the header). */
const OPENAI_WIRE_OVERFLOW: readonly RegExp[] = [
  /maximum context length is [\d,]+ tokens/i, // OpenAI, DeepSeek, OpenRouter
  /exceeds the context window/i, // OpenAI, newer wording
  /maximum prompt length is [\d,]+/i, // xAI
  /reduce the length of the messages/i, // Groq
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a 400 from an OpenAI-compatible endpoint says the prompt does not fit the window. */
function openAIWireOverflow(error: InstanceType<typeof OpenAI.APIError>): boolean {
  if (error.code === "context_length_exceeded") return true;
  const body: unknown = error.error;
  const metadata = isRecord(body) ? body.metadata : undefined;
  if (isRecord(metadata) && metadata.error_type === "context_length_exceeded") return true;
  return OPENAI_WIRE_OVERFLOW.some((pattern) => pattern.test(error.message));
}

export function fromOpenAIError(error: unknown, signal?: AbortSignal): LLMError {
  return fromOpenAIWireError(error, signal, "openai-compatible");
}

/**
 * The Responses API lane (responses.ts): the same SDK and HTTP statuses as Chat Completions,
 * and the same overflow wordings — measured on this endpoint, both HTTP 400: OpenAI
 * "Your input exceeds the context window of this model." with `code:
 * "context_length_exceeded"`, xAI (whose Grok models answer only on /v1/responses there)
 * "This model's maximum prompt length is 500000 but the request contains 700207 tokens."
 * (https://github.com/sschatter/pi-jetbrains-junie-bridge/blob/main/JUNIE_INSIGHTS.md,
 * "Context Overflow Errors", verified 2026-07-28; read 2026-11-27). Unlike Chat
 * Completions this wire DOES document a failure inside the stream; see
 * `responsesStreamFailure`.
 */
export function fromResponsesError(error: unknown, signal?: AbortSignal): LLMError {
  if (error instanceof LLMError) return error;
  // An SSE event named `error` is raised by the SDK as an APIError without a status
  // (node_modules/openai/core/streaming.js), carrying the event's `code` and `message`.
  // A connection failure is an APIError without a status too, and is not that.
  if (error instanceof OpenAI.APIError && error.status === undefined && !(error instanceof OpenAI.APIConnectionError) && !isAbort(error, signal)) {
    return responsesStreamFailure(typeof error.code === "string" ? error.code : undefined, error.message, error);
  }
  return fromOpenAIWireError(error, signal, "openai-responses");
}

/**
 * A Responses API failure that arrives as a stream event rather than an HTTP status: a
 * `response.failed` event (its `response.error`) or an `error` event. The codes are
 * `ResponseError.code` in node_modules/openai/resources/responses/responses.d.ts (openai
 * 7.65.0, read 2026-11-27): `server_error` and `rate_limit_exceeded` are the vendor saying
 * "not now"; the rest describe the request (a policy block, a bad image, an invalid prompt)
 * and are not retried. An overflow is recognised by the HTTP code OpenAI uses for it or by
 * a known wording — but only when the code does not already say something else, so a
 * rate-limit message quoting a token budget stays a rate limit.
 */
export function responsesStreamFailure(code: string | null | undefined, message: string, cause?: unknown): LLMError {
  const base = { wire: "openai-responses" as const, providerMessage: message, ...(cause === undefined ? {} : { cause }) };
  if (code === "server_error") return new LLMError({ ...base, code: "transient", retryable: true });
  if (code === "rate_limit_exceeded") return new LLMError({ ...base, code: "rate_limited", retryable: true });
  const saysOtherwise = typeof code === "string" && STREAM_CODES_WITH_MEANING.has(code);
  if (code === "context_length_exceeded" || (!saysOtherwise && OPENAI_WIRE_OVERFLOW.some((pattern) => pattern.test(message)))) {
    return new LLMError({ ...base, code: "context_overflow", retryable: false });
  }
  return new LLMError({ ...base, code: "unknown", retryable: false });
}

// The documented `ResponseError.code` values; one of these already says what went wrong.
const STREAM_CODES_WITH_MEANING = new Set([
  "server_error",
  "rate_limit_exceeded",
  "invalid_prompt",
  "data_residency_mismatch",
  "bio_policy",
  "misalignment_policy_violation",
  "vector_store_timeout",
  "invalid_image",
  "invalid_image_format",
  "invalid_base64_image",
  "invalid_image_url",
  "image_too_large",
  "image_too_small",
  "image_parse_error",
  "image_content_policy_violation",
  "invalid_image_mode",
  "image_file_too_large",
  "unsupported_image_media_type",
  "empty_image_file",
  "failed_to_download_image",
  "image_file_not_found",
]);

function fromOpenAIWireError(error: unknown, signal: AbortSignal | undefined, wire: "openai-compatible" | "openai-responses"): LLMError {
  if (error instanceof LLMError) return error;
  if (isAbort(error, signal)) return abortedError(wire, error);
  if (error instanceof OpenAI.APIConnectionError) {
    return new LLMError({ code: "transient", wire, retryable: true, providerMessage: error.message, cause: error });
  }
  if (!(error instanceof OpenAI.APIError)) {
    return new LLMError({ code: "unknown", wire, retryable: false, providerMessage: messageOf(error), cause: error });
  }
  const base = { wire, providerMessage: error.message, cause: error, retryAfterMs: retryAfterMs(error.headers) };
  // A mid-stream error payload carries no status, and Chat Completions documents no shape for it.
  if (error.status === undefined) return new LLMError({ ...base, code: "unknown", retryable: false });
  let { code, retryable } = byStatus(error.status);
  if (error.status === 400 && openAIWireOverflow(error)) code = "context_overflow";
  // The SDK obeys this header in its own retry decision (node_modules/openai/client.js, `shouldRetry`).
  const shouldRetry = error.headers?.get("x-should-retry");
  if (shouldRetry === "false") retryable = false;
  else if (shouldRetry === "true") retryable = true;
  if (code === "unknown") retryable = false;
  return new LLMError({ ...base, code, status: error.status, retryable });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
