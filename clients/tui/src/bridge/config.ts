import { readFile } from "node:fs/promises"
import { expandHome } from "../localPaths"

export type GroupMode = "all" | "mention"

export interface BridgeGroupConfig {
  group_id: string
  room_keeper_key?: string
  admins: string[]
  mode: GroupMode
}

export interface OneBotForwardConfig {
  mode: "forward"
  ws_url: string
  access_token?: string
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
  access_token?: string
  /** Seconds. Converted to milliseconds for the transport. */
  request_timeout: number
  /** Seconds. Converted to milliseconds for the transport (forward reconnect). */
  reconnect_delay: number
}

export type OneBotConfig = OneBotForwardConfig | OneBotReverseConfig

export interface BridgeConfig {
  ticket?: string
  keeper_key?: string
  /** When set, overrides `welcome.locale`. Absent → follow the observer's welcome. */
  locale?: "en" | "zh"
  onebot: OneBotConfig
  groups: BridgeGroupConfig[]
  busy_notice: boolean
  idle_close_minutes: number
  state_dir: string
}

export type BridgeConfigErrorCode =
  | "invalid_json"
  | "invalid_ws_url"
  | "reverse_token_required"
  | "duplicate_group"
  | "missing_groups"
  | "invalid_group"
  | "invalid_onebot"
  | "invalid_listen_port"
  | "invalid_mode"
  | "invalid_locale"
  | "invalid_idle_close"
  | "invalid_reverse_path"
  | "missing_keeper_key"
  | "missing_room_keeper_key"
  | "invalid_timeout"

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

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h === "0:0:0:0:0:0:0:1"
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

function parseGroup(raw: unknown): BridgeGroupConfig {
  if (!isObject(raw)) throw new BridgeConfigError("invalid_group", "each group must be an object")
  const group_id = asString(raw.group_id)?.trim()
  if (!group_id) throw new BridgeConfigError("invalid_group", "each group needs a group_id")
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
  const access_token = asString(raw.access_token)?.trim() || undefined
  return { mode: "forward", ws_url, access_token, ...parseOneBotTimeouts(raw) }
}

function parseReverse(raw: Record<string, unknown>): OneBotReverseConfig {
  const listen_host = (asString(raw.listen_host) ?? "127.0.0.1").trim()
  const listen_port = asNumber(raw.listen_port)
  if (listen_port === undefined || !Number.isInteger(listen_port) || listen_port < 1 || listen_port > 65535) {
    throw new BridgeConfigError("invalid_listen_port", "onebot.listen_port must be an integer 1..65535")
  }
  const access_token = asString(raw.access_token)?.trim() || undefined
  if (!isLoopbackHost(listen_host) && !access_token) {
    throw new BridgeConfigError("reverse_token_required", "a non-loopback reverse listener requires access_token")
  }
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

export function parseBridgeConfig(raw: unknown): BridgeConfig {
  if (!isObject(raw)) throw new BridgeConfigError("invalid_json", "config must be a JSON object")
  const onebot = parseOneBot(raw.onebot)
  if (!Array.isArray(raw.groups) || raw.groups.length === 0) {
    throw new BridgeConfigError("missing_groups", "config.groups must list at least one group")
  }
  const groups = raw.groups.map(parseGroup)
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
  const state_dir = expandHome(asString(raw.state_dir)?.trim() || "~/.loreweaver/bridge")
  return {
    ticket,
    keeper_key,
    locale,
    onebot,
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
