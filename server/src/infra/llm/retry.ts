// The one retry layer. Both SDK clients are built with their own retries off, so a
// logical call costs at most `maxAttempts` HTTP attempts — the 2.x server's retries
// composed with the SDKs' into up to nine. A rate-limited turn should get slower, never
// dead; a permanent error (auth, bad request, context overflow) or an abort is surfaced
// at once, because asking again only delays the operator learning about it.
import { recordCall } from "./accounting.ts";
import { abortedError, LLMError } from "./errors.ts";
import type { ChatMessage, ChatOptions, ChatResult, LLMClient, Wire } from "./types.ts";

export interface RetryPolicy {
  /** Total attempts, the first included. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /**
   * A provider's own wait hint is believed up to this much. A longer hint ends the
   * retries instead: waiting less than the provider asked wastes the attempt, and waiting
   * longer breaks the bound on how long a call can hold its room.
   */
  readonly maxHintDelayMs: number;
}

// Three attempts ride out the per-minute buckets vendors use while a dead endpoint still
// reports within a table's patience.
export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 2_000, maxDelayMs: 20_000, maxHintDelayMs: 60_000 };

/** Waits `ms`, or rejects with the signal's reason when it aborts first. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export interface RetryOptions {
  readonly policy?: Partial<RetryPolicy>;
  readonly sleep?: Sleep;
  /** A number in [0, 1); full jitter draws the wait from it. */
  readonly random?: () => number;
  readonly now?: () => number;
  /** For the accounting record: which wire and model this client calls by default. */
  readonly wire?: Wire;
  readonly model?: string;
}

/**
 * The wait before retrying after attempt `attempt` (counted from 1). Full jitter — a
 * uniform draw over the whole window — because every client of a shared key retries on
 * the same bucket boundary, and a room firing several calls a turn collides with itself.
 * `undefined` means do not retry: the provider asked for longer than the policy allows.
 */
export function retryDelayMs(policy: RetryPolicy, attempt: number, hintMs: number | undefined, random: () => number): number | undefined {
  const window = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(window * random());
  if (hintMs === undefined) return jittered;
  if (hintMs > policy.maxHintDelayMs) return undefined;
  return Math.max(jittered, Math.ceil(hintMs));
}

export class RetryingLLM implements LLMClient {
  readonly #inner: LLMClient;
  readonly #policy: RetryPolicy;
  readonly #sleep: Sleep;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #wire: Wire | undefined;
  readonly #model: string | undefined;

  constructor(inner: LLMClient, options: RetryOptions = {}) {
    this.#inner = inner;
    const policy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
    this.#policy = { ...policy, maxAttempts: Math.max(1, Math.floor(policy.maxAttempts)) };
    this.#sleep = options.sleep ?? realSleep;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? (() => performance.now());
    this.#wire = options.wire;
    this.#model = options.model;
  }

  async chat(messages: readonly ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const started = this.#now();
    const model = options.model ?? this.#model;
    const account = { ...(this.#wire ? { wire: this.#wire } : {}), ...(model ? { model } : {}) };
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.#inner.chat(messages, options);
        recordCall({
          ...account,
          durationMs: this.#now() - started,
          attempts: attempt,
          stopReason: result.stopReason,
          ...(result.usage ? { usage: result.usage } : {}),
        });
        return result;
      } catch (thrown) {
        const delay = this.#retryDelay(thrown, attempt, options.signal);
        if (delay === undefined) {
          recordCall({ ...account, durationMs: this.#now() - started, attempts: attempt, error: errorSummary(thrown) });
          throw thrown;
        }
        const failure = thrown as LLMError;
        options.onRetry?.({ attempt, delayMs: delay, code: failure.code });
        try {
          await this.#sleep(delay, options.signal);
        } catch (reason) {
          const aborted = abortedError(failure.wire, reason);
          recordCall({ ...account, durationMs: this.#now() - started, attempts: attempt, error: errorSummary(aborted) });
          throw aborted;
        }
      }
    }
  }

  #retryDelay(thrown: unknown, attempt: number, signal: AbortSignal | undefined): number | undefined {
    // Anything that is not one of ours (a programming error, a test double's throw) is
    // not a provider saying "not now", so it is never retried.
    if (!(thrown instanceof LLMError) || !thrown.retryable || signal?.aborted) return undefined;
    if (attempt >= this.#policy.maxAttempts) return undefined;
    return retryDelayMs(this.#policy, attempt, thrown.retryAfterMs, this.#random);
  }
}

function errorSummary(thrown: unknown): { code: LLMError["code"] | "thrown"; status?: number } {
  if (!(thrown instanceof LLMError)) return { code: "thrown" };
  return thrown.status === undefined ? { code: thrown.code } : { code: thrown.code, status: thrown.status };
}
