export class OneBotError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = "OneBotError"
    this.code = code
  }
}

export class OneBotAPIError extends Error {
  readonly retcode: number
  readonly wording: string
  constructor(retcode: number, wording = "") {
    super(`onebot.api.${retcode}${wording ? `.${wording}` : ""}`)
    this.name = "OneBotAPIError"
    this.retcode = retcode
    this.wording = wording
  }
}

export class OneBotAttachmentNotFound extends Error {
  constructor(id: string) {
    super(id)
    this.name = "OneBotAttachmentNotFound"
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

export function protocolId(value: unknown): number | string {
  const text = String(value ?? "")
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10)
  return text
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

export function validWsUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase()
  return (
    (scheme === "ws" || scheme === "wss") &&
    Boolean(parsed.hostname) &&
    parsed.hash === "" &&
    ![...parsed.hostname].some((ch) => ch.trim() === "")
  )
}

export function isLoopbackHost(value: string): boolean {
  const host = stripIpv6Brackets(value.trim().toLowerCase().replace(/\.+$/, ""))
  if (host === "localhost") return true
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true
  const ipv4 = parseIPv4(host)
  if (ipv4 !== null) return (ipv4 >>> 24) === 127
  return false
}

export function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
}

export function parseIPv4(host: string): number | null {
  const parts = host.split(".")
  if (parts.length !== 4) return null
  let n = 0
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    const v = Number(part)
    if (v > 255) return null
    n = (n << 8) + v
  }
  return n >>> 0
}

export function normalizePath(value: string, fallback: string): string {
  const path = value || fallback
  return path.startsWith("/") ? path : `/${path}`
}

export function sendErrorCode(err: unknown): string {
  if (err instanceof OneBotAPIError) return `onebot.api.${err.retcode}`
  if (err instanceof Error && (err.name === "TimeoutError" || err.message === "onebot.api.timeout")) {
    return "onebot.api.timeout"
  }
  if (err instanceof Error && /onebot\.websocket\.(not_connected|disconnected)/.test(err.message)) {
    return "onebot.websocket.disconnected"
  }
  return "onebot.send.failed"
}

export function errorName(err: unknown): string {
  if (err instanceof Error && err.name) return err.name
  return typeof err === "object" && err !== null ? (err as { constructor?: { name?: string } }).constructor?.name ?? "Error" : "Error"
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function withTimeout<T>(promise: Promise<T>, ms: number, code = "onebot.api.timeout"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(code)
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
