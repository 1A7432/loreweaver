export class QQBotApiError extends Error {
  readonly code: string
  readonly traceId?: string
  readonly httpStatus?: number
  readonly platformCode?: number

  constructor(
    code: string,
    message = code,
    opts: { traceId?: string; httpStatus?: number; platformCode?: number } = {},
  ) {
    super(message)
    this.name = "QQBotApiError"
    this.code = code
    if (opts.traceId !== undefined) this.traceId = opts.traceId
    if (opts.httpStatus !== undefined) this.httpStatus = opts.httpStatus
    if (opts.platformCode !== undefined) this.platformCode = opts.platformCode
  }
}

export function stringId(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value)
}

export function asInteger(value: unknown, defaultValue: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === "string" && value.trim() !== "" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10)
  }
  return defaultValue
}

export function jsonObject(raw: unknown): Record<string, unknown> | undefined {
  let value: unknown = raw
  if (value instanceof ArrayBuffer) {
    try {
      value = new TextDecoder().decode(value)
    } catch {
      return undefined
    }
  }
  if (value instanceof Uint8Array) {
    try {
      value = new TextDecoder().decode(value)
    } catch {
      return undefined
    }
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

export function finiteTimeout(
  value: number | undefined,
  defaultValue: number,
  opts: { allowZero: boolean },
): number | null {
  if (value === undefined) return defaultValue
  if (!Number.isFinite(value)) return null
  return (opts.allowZero ? value >= 0 : value > 0) ? value : null
}

export function errorName(err: unknown): string {
  if (err instanceof Error && err.name) return err.name
  return typeof err === "object" && err !== null
    ? ((err as { constructor?: { name?: string } }).constructor?.name ?? "Error")
    : "Error"
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function withTimeout<T>(promise: Promise<T>, ms: number, code = "qqbot.gateway.timeout"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new QQBotApiError(code, code)
      err.name = "TimeoutError"
      reject(err)
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

export function tokenRefreshDelayMs(expiresInSec: number, marginSec: number): number {
  if (!Number.isFinite(expiresInSec) || expiresInSec <= 0) return 0
  return Math.max(0, (expiresInSec - marginSec) * 1000)
}

export function nextBackoffMs(attempt: number, steps: readonly number[], cap: number): number {
  if (attempt <= 0) return steps[0] ?? cap
  const index = Math.min(attempt - 1, steps.length - 1)
  const value = steps[index] ?? cap
  return Math.min(value, cap)
}

export function joinUrl(base: string, path: string): string {
  const prefix = base.replace(/\/+$/, "")
  const suffix = path.startsWith("/") ? path : `/${path}`
  return `${prefix}${suffix}`
}

export function headerTraceId(headers: { get(name: string): string | null }): string | undefined {
  for (const name of ["x-tps-trace-id", "X-Tps-trace-Id", "x-trace-id", "X-Trace-Id"]) {
    const value = headers.get(name)
    if (value) return value
  }
  return undefined
}

export function parseRetryAfterMs(
  headers: { get(name: string): string | null },
  body: Record<string, unknown> | undefined,
): number | undefined {
  const header = headers.get("retry-after") ?? headers.get("Retry-After")
  if (header !== null && header !== undefined && header !== "") {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  }
  if (body && body.retry_after !== undefined) {
    const value = asInteger(body.retry_after, -1)
    if (value >= 0) return value > 10_000 ? value : value * 1000
  }
  return undefined
}

/** True when `text` contains the secret as a contiguous substring. Empty secret never matches. */
export function containsSecret(text: string, secret: string): boolean {
  return secret.length > 0 && text.includes(secret)
}

export interface QQBotClock {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const realClock: QQBotClock = {
  now: () => Date.now(),
  sleep,
}
