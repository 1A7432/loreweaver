import { promises as dns } from "node:dns"
import http from "node:http"
import https from "node:https"
import type { IncomingMessage } from "node:http"
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_REDIRECTS,
} from "./constants"
import {
  OneBotAttachmentNotFound,
  OneBotError,
  asInteger,
  parseIPv4,
  stripIpv6Brackets,
} from "./shared"

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export type ResolveAddresses = (host: string, port: number) => Promise<string[]>

export interface HttpResponse {
  status: number
  headers: { get(name: string): string | null }
  raiseForStatus(): void
  body: AsyncIterable<Uint8Array>
}

export type AddressEntry = { address: string; family: 4 | 6 }

/** Node/Bun `net.connect` lookup: array form `cb(null, [{address, family}])`. */
export type PinnedLookup = (
  hostname: string,
  options: unknown,
  callback?: (err: Error | null, addresses: AddressEntry[]) => void,
) => void

export interface HttpGetInit {
  redirect: "manual"
  signal?: AbortSignal
  /** Addresses `assertPublicHttpUrl` already validated; the request lookup may only return these. */
  addresses?: string[]
  /** Test seam: override the pinned lookup. Production always uses `pinnedLookup(addresses)`. */
  lookup?: PinnedLookup
}

export type HttpGet = (url: string, init: HttpGetInit) => Promise<HttpResponse>

export interface PinnedRequestOptions {
  protocol: string
  hostname: string
  servername: string
  port: number
  path: string
  method: "GET"
  lookup: PinnedLookup
  signal?: AbortSignal
}

export interface FetchDeps {
  resolveAddresses?: ResolveAddresses
  httpGet?: HttpGet
}

export interface FetchAttachmentOptions extends FetchDeps {
  maxBytes?: number
  timeoutMs?: number
  id?: string
  size?: number
  signal?: AbortSignal
}

export async function defaultResolveAddresses(host: string, port: number): Promise<string[]> {
  const results = await dns.lookup(host, { all: true, port, verbatim: true })
  return results.map((item) => item.address)
}

export function pinnedLookup(addresses: string[]): PinnedLookup {
  const entries: AddressEntry[] = addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }))
  return (_hostname, options, callback) => {
    const cb = typeof options === "function" ? options : callback
    if (typeof cb !== "function") return
    try {
      assertPublicAddresses(addresses)
    } catch (err) {
      cb(err instanceof Error ? err : new Error(String(err)), [])
      return
    }
    cb(null, entries)
  }
}

/**
 * Options for `http`/`https`.request. Host header and TLS SNI stay the original
 * hostname; `lookup` returns only the already-validated addresses so the TCP
 * connect cannot rebind.
 */
export function buildHttpRequestOptions(
  url: URL,
  addresses: string[],
  signal?: AbortSignal,
  lookup: PinnedLookup = pinnedLookup(addresses),
): PinnedRequestOptions {
  const hostname = stripIpv6Brackets(url.hostname)
  const scheme = url.protocol.replace(/:$/, "").toLowerCase()
  return {
    protocol: url.protocol,
    hostname,
    servername: hostname,
    port: url.port ? Number(url.port) : scheme === "https" ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    lookup,
    ...(signal ? { signal } : {}),
  }
}

export async function defaultHttpGet(url: string, init: HttpGetInit): Promise<HttpResponse> {
  void init.redirect
  const parsed = new URL(url)
  const addresses = init.addresses ?? []
  const lookup = init.lookup ?? pinnedLookup(addresses)
  const opts = buildHttpRequestOptions(parsed, addresses, init.signal, lookup)
  const lib = parsed.protocol === "https:" ? https : http
  return new Promise<HttpResponse>((resolve, reject) => {
    const req = lib.request(opts as http.RequestOptions, (res) => {
      resolve(wrapIncomingMessage(res))
    })
    const fail = (err: Error) => {
      req.destroy()
      reject(err)
    }
    req.on("error", reject)
    if (init.signal) {
      const onAbort = () => {
        const err = new Error("The operation was aborted.")
        err.name = "AbortError"
        fail(err)
      }
      if (init.signal.aborted) onAbort()
      else {
        init.signal.addEventListener("abort", onAbort, { once: true })
        req.on("close", () => init.signal?.removeEventListener("abort", onAbort))
      }
    }
    req.end()
  })
}

function wrapIncomingMessage(res: IncomingMessage): HttpResponse {
  return {
    status: res.statusCode ?? 0,
    headers: {
      get(name: string) {
        const value = res.headers[name.toLowerCase()]
        if (value === undefined) return null
        return Array.isArray(value) ? (value[0] ?? null) : value
      },
    },
    raiseForStatus() {
      if ((res.statusCode ?? 0) >= 400) throw new Error(`http.${res.statusCode}`)
    },
    body: iterateIncoming(res),
  }
}

async function* iterateIncoming(res: IncomingMessage): AsyncIterable<Uint8Array> {
  for await (const chunk of res) {
    yield chunk instanceof Uint8Array ? chunk : Buffer.from(chunk)
  }
}

export async function fetchAttachment(url: string, options: FetchAttachmentOptions = {}): Promise<Uint8Array> {
  const limit = options.maxBytes !== undefined ? Math.min(MAX_ATTACHMENT_BYTES, options.maxBytes) : MAX_ATTACHMENT_BYTES
  if ((options.size ?? 0) > limit) throw new OneBotError("onebot.attachment.too_large")

  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const resolveAddresses = options.resolveAddresses ?? defaultResolveAddresses
  const httpGet = options.httpGet ?? defaultHttpGet
  const id = options.id ?? url

  const ac = new AbortController()
  const onOuterAbort = () => ac.abort()
  options.signal?.addEventListener("abort", onOuterAbort, { once: true })
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await Promise.race([
      fetchPublicUrl(url, limit, { resolveAddresses, httpGet, signal: ac.signal }),
      abortPromise(ac.signal),
    ])
  } catch (err) {
    if (err instanceof OneBotError) throw err
    throw new OneBotAttachmentNotFound(id)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onOuterAbort)
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => {
      const err = new Error("The operation was aborted.")
      err.name = "AbortError"
      reject(err)
    }
    if (signal.aborted) fail()
    else signal.addEventListener("abort", fail, { once: true })
  })
}

async function fetchPublicUrl(
  url: string,
  limit: number,
  deps: { resolveAddresses: ResolveAddresses; httpGet: HttpGet; signal: AbortSignal },
): Promise<Uint8Array> {
  let currentUrl = url
  for (let redirectCount = 0; redirectCount <= MAX_ATTACHMENT_REDIRECTS; redirectCount += 1) {
    if (deps.signal.aborted) {
      const err = new Error("The operation was aborted.")
      err.name = "AbortError"
      throw err
    }
    const addresses = await assertPublicHttpUrl(currentUrl, deps.resolveAddresses)
    const response = await deps.httpGet(currentUrl, {
      redirect: "manual",
      signal: deps.signal,
      addresses,
    })
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("Location") ?? response.headers.get("location") ?? ""
      if (!location || redirectCount >= MAX_ATTACHMENT_REDIRECTS) {
        throw new OneBotError("onebot.attachment.redirect.invalid")
      }
      currentUrl = new URL(location, currentUrl).href
      continue
    }
    response.raiseForStatus()
    const contentLength = asInteger(response.headers.get("Content-Length") ?? response.headers.get("content-length"), 0)
    if (contentLength > limit) throw new OneBotError("onebot.attachment.too_large")
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of response.body) {
      if (deps.signal.aborted) {
        const err = new Error("The operation was aborted.")
        err.name = "AbortError"
        throw err
      }
      size += chunk.byteLength
      if (size > limit) throw new OneBotError("onebot.attachment.too_large")
      chunks.push(chunk)
    }
    return concat(chunks, size)
  }
  throw new OneBotError("onebot.attachment.redirect.invalid")
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export async function assertPublicHttpUrl(
  value: string,
  resolveAddresses: ResolveAddresses = defaultResolveAddresses,
): Promise<string[]> {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new OneBotError("onebot.attachment.unsafe_url")
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase()
  const host = stripIpv6Brackets(parsed.hostname)
  if (
    (scheme !== "http" && scheme !== "https") ||
    !host ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    /\s/.test(host)
  ) {
    throw new OneBotError("onebot.attachment.unsafe_url")
  }
  const port = parsed.port ? Number(parsed.port) : scheme === "https" ? 443 : 80
  if (parseIPv4(host) !== null) {
    if (!isPublicIp(host)) throw new OneBotError("onebot.attachment.unsafe_url")
    return [host]
  }
  if (host.includes(":")) {
    if (!isPublicIp(host)) throw new OneBotError("onebot.attachment.unsafe_url")
    return [host]
  }
  const addresses = await resolveAddresses(host, port)
  if (!addresses.length || addresses.some((address) => !isPublicIp(address))) {
    throw new OneBotError("onebot.attachment.unsafe_url")
  }
  return addresses
}

export function assertPublicAddresses(addresses: string[]): void {
  if (!addresses.length || addresses.some((address) => !isPublicIp(address))) {
    throw new OneBotError("onebot.attachment.unsafe_address")
  }
}

export function isPublicIp(value: string): boolean {
  const host = stripIpv6Brackets(value.trim())
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped?.[1]) return isPublicIp(mapped[1])
  const ipv4 = parseIPv4(host)
  if (ipv4 !== null) return isPublicIPv4(ipv4)
  const ipv6 = parseIPv6(host)
  if (!ipv6) return false
  if (isIPv4Mapped(ipv6)) {
    const mappedV4 = (ipv6[12]! << 24) | (ipv6[13]! << 16) | (ipv6[14]! << 8) | ipv6[15]!
    return isPublicIPv4(mappedV4 >>> 0)
  }
  return isPublicIPv6(ipv6)
}

function isPublicIPv4(ip: number): boolean {
  const inRange = (prefix: number, bits: number) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (ip & mask) === (prefix & mask)
  }
  if (inRange(0x00000000, 8)) return false // 0.0.0.0/8 unspecified
  if (inRange(0x0a000000, 8)) return false // 10.0.0.0/8
  if (inRange(0x7f000000, 8)) return false // 127.0.0.0/8
  if (inRange(0xa9fe0000, 16)) return false // 169.254.0.0/16
  if (inRange(0xac100000, 12)) return false // 172.16.0.0/12
  if (inRange(0xc0a80000, 16)) return false // 192.168.0.0/16
  if (inRange(0x64400000, 10)) return false // 100.64.0.0/10 CGNAT
  if (inRange(0xc0000000, 24)) return false // 192.0.0.0/24
  if (inRange(0xc0000200, 24)) return false // 192.0.2.0/24 TEST-NET-1
  if (inRange(0xc6336400, 24)) return false // 198.51.100.0/24
  if (inRange(0xcb007100, 24)) return false // 203.0.113.0/24
  if (inRange(0xc6120000, 15)) return false // 198.18.0.0/15
  if (inRange(0xe0000000, 4)) return false // 224.0.0.0/4 multicast
  if (inRange(0xf0000000, 4)) return false // 240.0.0.0/4 reserved
  if (ip === 0xffffffff) return false // broadcast
  return true
}

function parseIPv6(host: string): Uint8Array | null {
  const lower = host.toLowerCase()
  if (lower.includes(".")) {
    const lastColon = lower.lastIndexOf(":")
    if (lastColon < 0) return null
    const v4 = parseIPv4(lower.slice(lastColon + 1))
    if (v4 === null) return null
    const head = lower.slice(0, lastColon)
    const v4Hex = `${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
    return parseIPv6(`${head}:${v4Hex}`)
  }
  const sides = lower.split("::")
  if (sides.length > 2) return null
  const left = sides[0] ? sides[0].split(":") : []
  const right = sides.length === 2 ? (sides[1] ? sides[1].split(":") : []) : []
  if (sides.length === 1 && left.length !== 8) return null
  const missing = 8 - left.length - right.length
  if (sides.length === 2 && missing < 0) return null
  if (sides.length === 1 && missing !== 0) return null
  const parts = sides.length === 2 ? [...left, ...Array(Math.max(missing, 0)).fill("0"), ...right] : left
  if (parts.length !== 8) return null
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i += 1) {
    const part = parts[i] || "0"
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null
    const n = Number.parseInt(part, 16)
    out[i * 2] = (n >> 8) & 0xff
    out[i * 2 + 1] = n & 0xff
  }
  return out
}

function isIPv4Mapped(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i += 1) if (bytes[i] !== 0) return false
  return bytes[10] === 0xff && bytes[11] === 0xff
}

function isPublicIPv6(bytes: Uint8Array): boolean {
  const allZero = bytes.every((b) => b === 0)
  if (allZero) return false
  const loopback = allZeroExceptLast(bytes) && bytes[15] === 1
  if (loopback) return false
  // fe80::/10 link-local
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return false
  // fc00::/7 unique local
  if ((bytes[0]! & 0xfe) === 0xfc) return false
  // ff00::/8 multicast
  if (bytes[0] === 0xff) return false
  // 2001::/23 Teredo / ORCHID — Python ipaddress.is_global is false here
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2]! & 0xfe) === 0) return false
  // 2001:db8::/32 documentation
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false
  // 64:ff9b::/96 NAT64 well-known prefix: unwrap and check the embedded IPv4
  if (isNat64Prefix(bytes)) {
    const embedded = (bytes[12]! << 24) | (bytes[13]! << 16) | (bytes[14]! << 8) | bytes[15]!
    return isPublicIPv4(embedded >>> 0)
  }
  return true
}

function isNat64Prefix(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0 &&
    bytes[5] === 0 &&
    bytes[6] === 0 &&
    bytes[7] === 0 &&
    bytes[8] === 0 &&
    bytes[9] === 0 &&
    bytes[10] === 0 &&
    bytes[11] === 0
  )
}

function allZeroExceptLast(bytes: Uint8Array): boolean {
  for (let i = 0; i < 15; i += 1) if (bytes[i] !== 0) return false
  return true
}
