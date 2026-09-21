import { readFile } from "node:fs/promises"
import { expandHome } from "../localPaths"

export type GroupMode = "all" | "mention"
export type BridgePlatform = "onebot" | "qqbot"

export interface BridgeGroupConfig {
  group_id: string
  room_keeper_key?: string
  admins: string[]
  mode: GroupMode
}

export interface OneBotForwardConfig {
  mode: "forward"
  ws_url: string
  access_token: string
  /** Seconds. Converted to milliseconds for the transport. */
  request_timeout: number
  /** Seconds. Converted to milliseconds for the transport. */
  reconnect_delay: number
}

export interface OneBotReverseConfig {
  mode: "reverse"
  listen_host: string
  listen_port: number
  path?: string
  access_token: string
  /** Seconds. Converted to milliseconds for the transport. */
  request_timeout: number
  /** Seconds. Converted to milliseconds for the transport (forward reconnect). */
  reconnect_delay: number
}

export type OneBotConfig = OneBotForwardConfig | OneBotReverseConfig

export interface QQBotBridgeConfig {
  app_id: string
  client_secret: string
  transport: "websocket"
  receive_all: boolean
  max_chunk_chars: number
  url_whitelist: string[]
  media_public_base_url: string | null
  bot_qpm: number
  /** Seconds. Converted to milliseconds for the deliverer send race only. */
  send_timeout: number
  /** Seconds. Converted to milliseconds for the transport ready-gate and REST. Default 10. */
  request_timeout: number
}

export interface BridgeConfig {
  ticket?: string
  keeper_key?: string
  /** When set, overrides `welcome.locale`. Absent → follow the observer's welcome. */
  locale?: "en" | "zh"
  /** Absent JSON `platform` parses as `"onebot"` so every M24 config keeps working. */
  platform: BridgePlatform
  /** Required when `platform` is `"onebot"`; omitted on the official-bot path. */
  onebot?: OneBotConfig
  /** Required when `platform` is `"qqbot"`; omitted on the OneBot path. */
  qqbot?: QQBotBridgeConfig
  groups: BridgeGroupConfig[]
  busy_notice: boolean
  idle_close_minutes: number
  state_dir: string
}

export type BridgeConfigErrorCode =
  | "invalid_json"
  | "invalid_ws_url"
  | "token_required"
  | "duplicate_group"
  | "missing_groups"
  | "invalid_group"
  | "invalid_onebot"
  | "invalid_qqbot"
  | "invalid_platform"
  | "platform_mismatch"
  | "secret_required"
  | "invalid_listen_port"
  | "invalid_mode"
  | "invalid_locale"
  | "invalid_idle_close"
  | "invalid_reverse_path"
  | "missing_keeper_key"
  | "missing_room_keeper_key"
  | "invalid_timeout"
  | "duplicate_keeper_key"

export class BridgeConfigError extends Error {
  constructor(
    public readonly code: BridgeConfigErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "BridgeConfigError"
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** ws/wss only; a host is required; fragments are rejected (old OneBot adapter rule). */
export function isWsUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return false
  if (!url.hostname) return false
  if (url.hash) return false
  return true
}

function parseAdmins(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new BridgeConfigError("invalid_group", "group admins must be an array of QQ ids")
  const admins: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const id = asString(item)?.trim()
    if (!id) throw new BridgeConfigError("invalid_group", "group admin ids must be numbers or strings")
    if (seen.has(id)) continue
    seen.add(id)
    admins.push(id)
  }
  return admins
}

function parseGroup(raw: unknown, platform: BridgePlatform): BridgeGroupConfig {
  if (!isObject(raw)) throw new BridgeConfigError("invalid_group", "each group must be an object")
  const group_id =
    platform === "qqbot" ? asString(raw.group_openid)?.trim() : asString(raw.group_id)?.trim()
  if (!group_id) {
    throw new BridgeConfigError(
      "invalid_group",
      platform === "qqbot" ? "each group needs a group_openid" : "each group needs a group_id",
    )
  }
  const modeRaw = raw.mode === undefined ? "mention" : asString(raw.mode)
  if (modeRaw !== "all" && modeRaw !== "mention") {
    throw new BridgeConfigError("invalid_mode", "group mode must be all or mention")
  }
  const room_keeper_key = asString(raw.room_keeper_key)?.trim() || undefined
  return {
    group_id,
    room_keeper_key,
    admins: parseAdmins(raw.admins),
    mode: modeRaw,
  }
}

/** JSON keeps seconds (old OneBot adapter); the transport takes milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 10
export const DEFAULT_RECONNECT_DELAY_SECONDS = 1
export const DEFAULT_QQBOT_SEND_TIMEOUT_SECONDS = 5
export const DEFAULT_QQBOT_REQUEST_TIMEOUT_SECONDS = 10
export const DEFAULT_QQBOT_BOT_QPM = 30
export const DEFAULT_QQBOT_MAX_CHUNK_CHARS = 2800

export function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000)
}

function parseOneBotTimeouts(raw: Record<string, unknown>): { request_timeout: number; reconnect_delay: number } {
  const request_timeout = raw.request_timeout === undefined ? DEFAULT_REQUEST_TIMEOUT_SECONDS : asNumber(raw.request_timeout)
  if (request_timeout === undefined || !(request_timeout > 0) || !Number.isFinite(request_timeout)) {
    throw new BridgeConfigError("invalid_timeout", "onebot.request_timeout must be > 0 seconds")
  }
  const reconnect_delay = raw.reconnect_delay === undefined ? DEFAULT_RECONNECT_DELAY_SECONDS : asNumber(raw.reconnect_delay)
  if (reconnect_delay === undefined || reconnect_delay < 0 || !Number.isFinite(reconnect_delay)) {
    throw new BridgeConfigError("invalid_timeout", "onebot.reconnect_delay must be >= 0 seconds")
  }
  return { request_timeout, reconnect_delay }
}

function parseForward(raw: Record<string, unknown>): OneBotForwardConfig {
  const ws_url = asString(raw.ws_url)?.trim()
  if (!ws_url || !isWsUrl(ws_url)) {
    throw new BridgeConfigError("invalid_ws_url", "onebot.ws_url must be a ws:// or wss:// URL")
  }
  const access_token = requireToken(raw)
  return { mode: "forward", ws_url, access_token, ...parseOneBotTimeouts(raw) }
}

/**
 * Both modes require a token. NapCat instances left with an empty token are what got
 * QQ accounts mass-banned in 2026, and a loopback listener is one port-forward away from
 * the internet; the bridge refuses to be the weak side of that pairing.
 */
function requireToken(raw: Record<string, unknown>): string {
  const access_token = asString(raw.access_token)?.trim() || undefined
  if (!access_token) {
    throw new BridgeConfigError(
      "token_required",
      "onebot.access_token is required in both modes; set the same token in the OneBot implementation",
    )
  }
  return access_token
}

function parseReverse(raw: Record<string, unknown>): OneBotReverseConfig {
  const listen_host = (asString(raw.listen_host) ?? "127.0.0.1").trim()
  const listen_port = asNumber(raw.listen_port)
  if (listen_port === undefined || !Number.isInteger(listen_port) || listen_port < 1 || listen_port > 65535) {
    throw new BridgeConfigError("invalid_listen_port", "onebot.listen_port must be an integer 1..65535")
  }
  const access_token = requireToken(raw)
  const path = asString(raw.path)?.trim() || undefined
  if (path && !path.startsWith("/")) {
    throw new BridgeConfigError("invalid_reverse_path", "onebot.path must start with /")
  }
  return { mode: "reverse", listen_host, listen_port, path, access_token, ...parseOneBotTimeouts(raw) }
}

function parseOneBot(raw: unknown): OneBotConfig {
  if (!isObject(raw)) throw new BridgeConfigError("invalid_onebot", "onebot config is required")
  const mode = asString(raw.mode)?.trim()
  if (mode === "forward") return parseForward(raw)
  if (mode === "reverse") return parseReverse(raw)
  throw new BridgeConfigError("invalid_onebot", "onebot.mode must be forward or reverse")
}

function parseUrlWhitelist(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new BridgeConfigError("invalid_qqbot", "qqbot.url_whitelist must be an array of hostnames")
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const host = asString(item)?.trim()
    if (!host) throw new BridgeConfigError("invalid_qqbot", "qqbot.url_whitelist entries must be strings")
    if (seen.has(host)) continue
    seen.add(host)
    out.push(host)
  }
  return out
}

function parsePublicBaseUrl(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const raw = asString(value)?.trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BridgeConfigError("invalid_qqbot", "qqbot.media_public_base_url must be an http(s) URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BridgeConfigError("invalid_qqbot", "qqbot.media_public_base_url must be an http(s) URL")
  }
  return raw
}

function parseQQBot(raw: unknown): QQBotBridgeConfig {
  if (!isObject(raw)) throw new BridgeConfigError("invalid_qqbot", "qqbot config is required")
  const app_id = asString(raw.app_id)?.trim()
  if (!app_id) throw new BridgeConfigError("invalid_qqbot", "qqbot.app_id is required")
  const client_secret = asString(raw.client_secret)?.trim()
  if (!client_secret) {
    throw new BridgeConfigError("secret_required", "qqbot.client_secret is required")
  }
  const transportRaw = raw.transport === undefined ? "websocket" : asString(raw.transport)?.trim()
  if (transportRaw !== "websocket") {
    throw new BridgeConfigError("invalid_qqbot", "qqbot.transport must be websocket")
  }
  const max_chunk_chars =
    raw.max_chunk_chars === undefined ? DEFAULT_QQBOT_MAX_CHUNK_CHARS : asNumber(raw.max_chunk_chars)
  if (max_chunk_chars === undefined || !(max_chunk_chars > 0) || !Number.isFinite(max_chunk_chars)) {
    throw new BridgeConfigError("invalid_qqbot", "qqbot.max_chunk_chars must be > 0")
  }
  const bot_qpm = raw.bot_qpm === undefined ? DEFAULT_QQBOT_BOT_QPM : asNumber(raw.bot_qpm)
  if (bot_qpm === undefined || !(bot_qpm > 0) || !Number.isFinite(bot_qpm)) {
    throw new BridgeConfigError("invalid_qqbot", "qqbot.bot_qpm must be > 0")
  }
  const send_timeout =
    raw.send_timeout === undefined ? DEFAULT_QQBOT_SEND_TIMEOUT_SECONDS : asNumber(raw.send_timeout)
  if (send_timeout === undefined || !(send_timeout > 0) || !Number.isFinite(send_timeout)) {
    throw new BridgeConfigError("invalid_timeout", "qqbot.send_timeout must be > 0 seconds")
  }
  const request_timeout =
    raw.request_timeout === undefined ? DEFAULT_QQBOT_REQUEST_TIMEOUT_SECONDS : asNumber(raw.request_timeout)
  if (request_timeout === undefined || !(request_timeout > 0) || !Number.isFinite(request_timeout)) {
    throw new BridgeConfigError("invalid_timeout", "qqbot.request_timeout must be > 0 seconds")
  }
  return {
    app_id,
    client_secret,
    transport: "websocket",
    receive_all: asBoolean(raw.receive_all, false),
    max_chunk_chars,
    url_whitelist: parseUrlWhitelist(raw.url_whitelist),
    media_public_base_url: parsePublicBaseUrl(raw.media_public_base_url),
    bot_qpm,
    send_timeout,
    request_timeout,
  }
}

function parsePlatform(raw: Record<string, unknown>): BridgePlatform {
  if (raw.platform === undefined) return "onebot"
  const platform = asString(raw.platform)?.trim()
  if (platform === "onebot" || platform === "qqbot") return platform
  throw new BridgeConfigError("invalid_platform", "platform must be onebot or qqbot")
}

export function parseBridgeConfig(raw: unknown): BridgeConfig {
  if (!isObject(raw)) throw new BridgeConfigError("invalid_json", "config must be a JSON object")
  const platform = parsePlatform(raw)
  const hasOneBot = raw.onebot !== undefined
  const hasQQBot = raw.qqbot !== undefined
  if (hasOneBot && hasQQBot) {
    throw new BridgeConfigError("platform_mismatch", "onebot and qqbot blocks are mutually exclusive")
  }
  if (platform === "onebot" && hasQQBot) {
    throw new BridgeConfigError("platform_mismatch", "platform onebot cannot include a qqbot block")
  }
  if (platform === "qqbot" && hasOneBot) {
    throw new BridgeConfigError("platform_mismatch", "platform qqbot cannot include an onebot block")
  }
  const onebot = platform === "onebot" ? parseOneBot(raw.onebot) : undefined
  const qqbot = platform === "qqbot" ? parseQQBot(raw.qqbot) : undefined
  if (!Array.isArray(raw.groups) || raw.groups.length === 0) {
    throw new BridgeConfigError("missing_groups", "config.groups must list at least one group")
  }
  const groups = raw.groups.map((group) => parseGroup(group, platform))
  const seen = new Set<string>()
  for (const group of groups) {
    if (seen.has(group.group_id)) {
      throw new BridgeConfigError("duplicate_group", `duplicate group_id ${group.group_id}`)
    }
    seen.add(group.group_id)
  }
  let locale: "en" | "zh" | undefined
  if (raw.locale !== undefined) {
    const localeRaw = asString(raw.locale)?.trim()
    if (localeRaw !== "en" && localeRaw !== "zh") {
      throw new BridgeConfigError("invalid_locale", "locale must be en or zh")
    }
    locale = localeRaw
  }
  const idle = asNumber(raw.idle_close_minutes)
  const idle_close_minutes = idle === undefined ? 30 : idle
  if (!Number.isFinite(idle_close_minutes) || idle_close_minutes < 0) {
    throw new BridgeConfigError("invalid_idle_close", "idle_close_minutes must be >= 0")
  }
  const ticket = asString(raw.ticket)?.trim() || undefined
  const keeper_key = asString(raw.keeper_key)?.trim() || undefined
  if (ticket && !keeper_key && groups.every((group) => !group.room_keeper_key)) {
    throw new BridgeConfigError("missing_keeper_key", "a ticket requires keeper_key or per-group room_keeper_key")
  }
  if (groups.length > 1 && groups.some((group) => !group.room_keeper_key)) {
    throw new BridgeConfigError("missing_room_keeper_key", "each group needs its own room_keeper_key when more than one group is listed")
  }
  const claimedKeys = new Map<string, string>()
  for (const group of groups) {
    const key = group.room_keeper_key || keeper_key
    if (!key) continue
    const previous = claimedKeys.get(key)
    if (previous !== undefined) {
      throw new BridgeConfigError(
        "duplicate_keeper_key",
        `room_keeper_key is already used by group ${previous}`,
      )
    }
    claimedKeys.set(key, group.group_id)
  }
  const state_dir = expandHome(asString(raw.state_dir)?.trim() || "~/.loreweaver/bridge")
  return {
    ticket,
    keeper_key,
    locale,
    platform,
    ...(onebot ? { onebot } : {}),
    ...(qqbot ? { qqbot } : {}),
    groups,
    busy_notice: asBoolean(raw.busy_notice, true),
    idle_close_minutes,
    state_dir,
  }
}

export async function loadBridgeConfig(path: string): Promise<BridgeConfig> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    throw new BridgeConfigError("invalid_json", `could not read config: ${(error as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BridgeConfigError("invalid_json", "config is not valid JSON")
  }
  return parseBridgeConfig(parsed)
}

/** Default keeper key for a group: the group's own key, else the process-level one. */
export function roomKeeperKey(config: BridgeConfig, group: BridgeGroupConfig): string | undefined {
  return group.room_keeper_key || config.keeper_key
}

export function onebotTimeoutsMs(onebot: OneBotConfig): { requestTimeoutMs: number; reconnectDelayMs: number } {
  return {
    requestTimeoutMs: secondsToMs(onebot.request_timeout),
    reconnectDelayMs: secondsToMs(onebot.reconnect_delay),
  }
}

export function requireOneBot(config: BridgeConfig): OneBotConfig {
  if (config.platform !== "onebot" || !config.onebot) {
    throw new BridgeConfigError("platform_mismatch", "onebot config is required when platform is onebot")
  }
  return config.onebot
}

export function requireQQBot(config: BridgeConfig): QQBotBridgeConfig {
  if (config.platform !== "qqbot" || !config.qqbot) {
    throw new BridgeConfigError("platform_mismatch", "qqbot config is required when platform is qqbot")
  }
  return config.qqbot
}

/** Transport ready-gate / REST timeout. `send_timeout` is the deliverer's send race only. */
export function qqbotTransportOptions(qqbot: QQBotBridgeConfig): { requestTimeoutMs: number } {
  return { requestTimeoutMs: secondsToMs(qqbot.request_timeout) }
}
