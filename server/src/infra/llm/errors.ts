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
// Deliberately NOT classified as `context_overflow`: the OpenAI-compatible wire. OpenAI's
// error-code guide does not list a context-length error for chat completions; the
// `context_length_exceeded` code is documented only for the Agents API (as a turn error
// without an HTTP status), and the "maximum context length is N tokens" message only for
// the embeddings endpoint. The check is per endpoint, so that lane's overflow arrives as
// `bad_request` until a vendor documents it.
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

export function fromOpenAIError(error: unknown, signal?: AbortSignal): LLMError {
  if (error instanceof LLMError) return error;
  if (isAbort(error, signal)) return abortedError("openai-compatible", error);
  if (error instanceof OpenAI.APIConnectionError) {
    return new LLMError({ code: "transient", wire: "openai-compatible", retryable: true, providerMessage: error.message, cause: error });
  }
  if (!(error instanceof OpenAI.APIError)) {
    return new LLMError({ code: "unknown", wire: "openai-compatible", retryable: false, providerMessage: messageOf(error), cause: error });
  }
  const base = { wire: "openai-compatible" as const, providerMessage: error.message, cause: error, retryAfterMs: retryAfterMs(error.headers) };
  // A mid-stream error payload carries no status, and this wire documents no shape for it.
  if (error.status === undefined) return new LLMError({ ...base, code: "unknown", retryable: false });
  let { code, retryable } = byStatus(error.status);
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
