// The one error type of the recall layer (embeddings and the vector index). Callers branch
// on `code`; `detail` carries only numbers (sizes, positions), never request text, so the
// message is safe to log. No text in here is part of the contract.

export type RecallErrorCode =
  /** A dimension count, batch size or similar setting that is not a positive integer. */
  | "invalid_settings"
  /** A vector whose length is not the configured dimension count. */
  | "dimension_mismatch"
  /** A vector with a NaN or infinite component, or one whose length overflows. */
  | "non_finite"
  /** A payload that is not a plain JSON object. */
  | "invalid_payload"
  /** A search limit that is not a non-negative integer. */
  | "invalid_limit"
  /** An embeddings answer that does not have the documented shape. */
  | "bad_response"
  /** A stored row that does not fit this index: another dimension count, or unreadable. */
  | "store_mismatch"
  /** The embeddings endpoint failed (HTTP status, network, timeout). */
  | "provider"
  | "aborted";

export interface RecallErrorInit {
  readonly detail?: Readonly<Record<string, number>>;
  readonly status?: number;
  /** Whether asking the endpoint again could succeed. */
  readonly retryable?: boolean;
  /** How long the endpoint asked us to wait, when it said. */
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class RecallError extends Error {
  readonly code: RecallErrorCode;
  readonly detail: Readonly<Record<string, number>>;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(code: RecallErrorCode, init: RecallErrorInit = {}) {
    const detail = init.detail ?? {};
    const parts = [`recall ${code}`];
    if (init.status !== undefined) parts.push(`status=${init.status}`);
    for (const [key, value] of Object.entries(detail)) parts.push(`${key}=${value}`);
    super(parts.join(" "), init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "RecallError";
    this.code = code;
    this.detail = detail;
    this.status = init.status;
    this.retryable = init.retryable ?? false;
    this.retryAfterMs = init.retryAfterMs;
  }
}

/** A positive safe integer, or the `invalid_settings` error naming which setting it was. */
export function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RecallError("invalid_settings", { detail: { [name]: value } });
  return value;
}
