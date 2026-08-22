import {
  ADMIN_FORGE_KINDS,
  ADMIN_KEY_PURPOSES,
  ADMIN_ROOM_OP_ACTIONS,
  AUDIO_ACTIONS,
  AUDIO_LAYERS,
  DICE_KINDS,
  FrameType,
  MODULE_VARIABLE_KINDS,
  NARRATIVE_FORMATS,
  NARRATIVE_SPEAKERS,
  PACK_CARD_KINDS,
  PANEL_LEAF_FIELDS,
  PANEL_SLOTS,
  PLAYER_ROLES,
  SYSTEM_LEVELS,
  UI_BADGE_TONES,
  UI_BLOCK_KINDS,
  UI_PANELS,
  UI_TEXT_STYLES,
  type AdminDeleteRoomDataFrame,
  type AdminEnableSkillFrame,
  type AdminExportRoomFrame,
  type AdminForgeKind,
  type AdminGenerateFrame,
  type AdminImportRoomFrame,
  type AdminKeyPurpose,
  type AdminListModelsFrame,
  type AdminMintKeyFrame,
  type AdminResetRoomFrame,
  type AdminResetScope,
  type AdminSetImagegenFrame,
  type AdminSetModelFrame,
  type AdminUpdateKeyFrame,
  type AvatarSetFrame,
  type ClientFrame,
  type ClientInfo,
  type MediaAcceptFrame,
  type MediaFrame,
  type MediaOfferFrame,
  type PanelIntentKind,
  type PingFrame,
  type PlayerRole,
  type PongFrame,
  type ServerFrame,
  type WelcomeFrame,
} from "./types.js"
import { protocolMismatch, protocolMismatchMessage, type ProtocolMismatchHandler } from "./version.js"

export interface WebSocketLike {
  readonly readyState: number
  send(data: string | ArrayBuffer | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener?(type: "open", listener: (event: unknown) => void): void
  addEventListener?(type: "message", listener: (event: { data: unknown }) => void): void
  addEventListener?(type: "close", listener: (event: unknown) => void): void
  addEventListener?(type: "error", listener: (event: unknown) => void): void
  onopen?: ((event: unknown) => void) | null
  onmessage?: ((event: { data: unknown }) => void) | null
  onclose?: ((event: unknown) => void) | null
  onerror?: ((event: unknown) => void) | null
}

export type WebSocketFactory = (url: string) => WebSocketLike
export type MessageHandler = (frame: ServerFrame) => void
export type TypedMessageHandler<T extends ServerFrame["type"]> = (frame: Extract<ServerFrame, { type: T }>) => void

// The transport's coarse liveness, for a small UI indicator (🟢/🟡/🔴). "connecting" covers
// both the very first dial and each redial attempt; "online" is a settled, joined socket;
// "reconnecting" is the backoff window between an unexpected drop and the next redial;
// "offline" is only reached via an explicit `close()` (the reconnect loop has stopped for good).
export type ConnectionStatus = "connecting" | "online" | "reconnecting" | "offline"
export type StatusHandler = (status: ConnectionStatus) => void

export interface WsClientOptions {
  webSocketFactory?: WebSocketFactory
  clientInfo?: ClientInfo
  reconnect?: boolean
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  // Where a `welcome` announcing a different protocol MAJOR is reported. Defaults to
  // `console.warn`; pass a channel to surface it in your own UI (or to close the socket,
  // which the library deliberately does not do on its own).
  onProtocolMismatch?: ProtocolMismatchHandler
}

export interface MediaUpload {
  name: string
  mime: string
  bytes: Uint8Array
  sha256: string
}

export interface MediaPayload {
  hash: string
  mime: string
  name: string
  bytes: Uint8Array
}

const OPEN = 1
const WS_MEDIA_HEADER_BYTES = 4

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const isStr = (v: unknown): v is string => typeof v === "string"
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isBool = (v: unknown): v is boolean => typeof v === "boolean"
const isArr = Array.isArray

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
}

function optional(value: unknown, check: (v: unknown) => boolean): boolean {
  return value === undefined || check(value)
}

function everyItem(value: unknown, check: (item: unknown) => boolean): boolean {
  return isArr(value) && value.every(check)
}

function isStringList(value: unknown): value is string[] {
  return everyItem(value, isStr)
}

/** Content-addressed media blob. Downstream fetches by `hash` and reads `mime`/`size`. */
function isMediaRef(value: unknown): boolean {
  return isObject(value) && isStr(value.hash) && isStr(value.mime) && isNum(value.size) && optional(value.name, isStr)
}

function isMediaFrameFields(value: Record<string, unknown>): boolean {
  return (
    isMediaRef(value) &&
    isStr(value.id) &&
    isStr(value.name) &&
    isStr(value.from) &&
    isNum(value.ts)
  )
}

function isAudioLibraryItem(value: unknown): boolean {
  return (
    isObject(value) &&
    isMediaFrameFields(value) &&
    optional(value.title, isStr) &&
    optional(value.license, isStr) &&
    optional(value.source, isStr) &&
    optional(value.tags, isStringList)
  )
}

function isWelcomeYou(value: unknown): boolean {
  return isObject(value) && isStr(value.id) && isStr(value.name) && isOneOf(value.role, PLAYER_ROLES)
}

function isResourceState(value: unknown): boolean {
  return isObject(value) && isStr(value.id) && isStr(value.label) && isNum(value.value) && optional(value.max, isNum)
}

function isCharacterState(value: unknown): boolean {
  return (
    isObject(value) &&
    isStr(value.name) &&
    isStr(value.system) &&
    everyItem(value.resources, isResourceState) &&
    isObject(value.attributes) &&
    isStringList(value.status_effects) &&
    optional(value.avatar, isMediaRef)
  )
}

function isPartyMember(value: unknown): boolean {
  return (
    isObject(value) &&
    isStr(value.name) &&
    isBool(value.online) &&
    isBool(value.active) &&
    optional(value.initiative, isNum) &&
    optional(value.resources, (v) => everyItem(v, isResourceState)) &&
    optional(value.ai, isBool) &&
    optional(value.avatar, isMediaRef)
  )
}

function isInitiativeEntry(value: unknown): boolean {
  return isObject(value) && isStr(value.name) && isNum(value.value) && isBool(value.current)
}

function isUsageState(value: unknown): boolean {
  return (
    isObject(value) &&
    isNum(value.context_tokens) &&
    isNum(value.context_window) &&
    isNum(value.input_tokens) &&
    isNum(value.output_tokens) &&
    isNum(value.cache_hit_tokens) &&
    isNum(value.cache_miss_tokens)
  )
}

function isModuleVariable(value: unknown): boolean {
  return (
    isObject(value) &&
    isStr(value.id) &&
    isStr(value.label) &&
    isOneOf(value.kind, MODULE_VARIABLE_KINDS) &&
    (isNum(value.value) || isBool(value.value) || isStr(value.value)) &&
    optional(value.min, isNum) &&
    optional(value.max, isNum) &&
    optional(value.hidden, isBool)
  )
}

function isPregenEntry(value: unknown): boolean {
  return isObject(value) && isStr(value.name) && isStr(value.claimed_by)
}

function isRuleSystemEntry(value: unknown): boolean {
  return isObject(value) && isStr(value.id) && optional(value.make_char, isStr)
}

function isSceneState(value: unknown): boolean {
  return isObject(value) && isStr(value.name) && optional(value.focus, isStr)
}

function isClockState(value: unknown): boolean {
  return isObject(value) && isStr(value.time) && optional(value.round, isNum)
}

function isPresencePlayer(value: unknown): boolean {
  return isObject(value) && isStr(value.id) && isStr(value.name) && isBool(value.online)
}

function isAudioLayerState(value: unknown): boolean {
  return (
    isObject(value) &&
    isOneOf(value.layer, AUDIO_LAYERS) &&
    isBool(value.playing) &&
    optional(value.hash, isStr) &&
    optional(value.mime, isStr) &&
    optional(value.name, isStr) &&
    optional(value.title, isStr) &&
    optional(value.volume, isNum) &&
    optional(value.loop, isBool) &&
    optional(value.started_at, isNum)
  )
}

function isPackCardEntry(value: unknown): boolean {
  return (
    isObject(value) &&
    isStr(value.ref) &&
    isStr(value.pack) &&
    isStr(value.name) &&
    optional(value.kind, (v) => isOneOf(v, PACK_CARD_KINDS))
  )
}

function isDiceOutcome(value: unknown): boolean {
  return (
    isObject(value) &&
    isStr(value.id) &&
    isStr(value.label) &&
    isBool(value.success) &&
    isBool(value.critical) &&
    isBool(value.fumble) &&
    isNum(value.tier) &&
    optional(value.margin, isNum)
  )
}

function isUiChoiceOption(value: unknown): boolean {
  return isObject(value) && isStr(value.id) && isStr(value.label) && isStr(value.input)
}

function isKnownUiBlockKind(kind: string): kind is (typeof UI_BLOCK_KINDS)[number] {
  return (UI_BLOCK_KINDS as readonly string[]).includes(kind)
}

/** Hook `ui` blocks: object + kind; known kinds check their required fields.
 * An unknown kind is additive and passes so a newer server can ship a new
 * template without dropping the whole frame. null / primitives never pass. */
function isUiBlock(value: unknown): boolean {
  if (!isObject(value) || !isStr(value.kind)) return false
  if (!isKnownUiBlockKind(value.kind)) return true
  switch (value.kind) {
    case "meter":
      return isStr(value.label) && isNum(value.value) && isNum(value.min) && isNum(value.max)
    case "stat":
      return isStr(value.label) && (isNum(value.value) || isStr(value.value) || isBool(value.value))
    case "badge":
      return isStr(value.label) && optional(value.tone, (v) => isOneOf(v, UI_BADGE_TONES))
    case "text":
      return isStr(value.text) && optional(value.style, (v) => isOneOf(v, UI_TEXT_STYLES))
    case "divider":
      return true
    case "choices":
      return optional(value.prompt, isStr) && everyItem(value.options, isUiChoiceOption)
    case "image":
      return isStr(value.hash) && optional(value.mime, isStr) && optional(value.size, isNum)
    case "letter":
      return isStr(value.body)
    case "clipping":
      return isStr(value.headline) && isStr(value.body)
    case "map_pin":
      return isStr(value.hash) && isStr(value.label) && isNum(value.x) && isNum(value.y)
    case "title_card":
      return isStr(value.title)
  }
}

function isPanelText(value: unknown): boolean {
  return isObject(value) && optional(value.en, isStr) && optional(value.zh, isStr)
}

function isPanelVarBinding(value: unknown): boolean {
  return isObject(value) && isStr(value.$var)
}

function isPanelLeafBinding(value: unknown): boolean {
  return isObject(value) && isOneOf(value.$leaf, PANEL_LEAF_FIELDS)
}

function isPanelTextValue(value: unknown): boolean {
  return isPanelText(value) || isPanelVarBinding(value) || isPanelLeafBinding(value)
}

function isPanelBindableNumber(value: unknown): boolean {
  return isNum(value) || isPanelVarBinding(value) || isPanelLeafBinding(value)
}

function isPanelBindableScalar(value: unknown): boolean {
  return isNum(value) || isStr(value) || isBool(value) || isPanelVarBinding(value) || isPanelLeafBinding(value)
}

function isPanelChoiceOption(value: unknown): boolean {
  return isObject(value) && isStr(value.id) && isPanelTextValue(value.label) && isStr(value.input)
}

/** One `repeat` wrapper. The inner template is checked with `allowRepeat=false`
 * so a nested / thousand-deep `repeat` tree is a flat reject, not a walk.
 * Protocol and Studio both say repeat does not nest — this is that rule. */
function isPanelRepeat(value: unknown): boolean {
  return (
    isObject(value) &&
    isObject(value.repeat) &&
    isStr(value.repeat.prefix) &&
    isPanelTemplateBlock(value.repeat.block, false)
  )
}

/** Panel template blocks: object + kind (or `repeat`) + that kind's required
 * fields. Bindings (`$var` / `$leaf`) count as present. Unknown kinds pass.
 * `allowRepeat` is true only at the panel `blocks` / `fallback` root; the
 * inner of a repeat must be a kind (or unknown-kind object), never another
 * repeat. This is the only recursive validator pair, and it is bounded to
 * one level. The flag is required (no default) so it cannot be confused
 * with `Array.every`'s index argument. */
function isPanelTemplateBlock(value: unknown, allowRepeat: boolean): boolean {
  if (!isObject(value)) return false
  if (optional(value.visible_when, isStr) === false) return false
  if ("repeat" in value) return allowRepeat && isPanelRepeat(value)
  if (!isStr(value.kind)) return false
  if (!isKnownUiBlockKind(value.kind)) return true
  switch (value.kind) {
    case "meter":
      return (
        isPanelTextValue(value.label) &&
        isPanelBindableNumber(value.value) &&
        isPanelBindableNumber(value.min) &&
        isPanelBindableNumber(value.max)
      )
    case "stat":
      return isPanelTextValue(value.label) && isPanelBindableScalar(value.value)
    case "badge":
      return (
        isPanelTextValue(value.label) &&
        optional(value.tone, (v) => isOneOf(v, UI_BADGE_TONES) || isPanelVarBinding(v) || isPanelLeafBinding(v))
      )
    case "text":
      return isPanelTextValue(value.text) && optional(value.style, (v) => isOneOf(v, UI_TEXT_STYLES))
    case "divider":
      return true
    case "choices":
      return optional(value.prompt, isPanelTextValue) && everyItem(value.options, isPanelChoiceOption)
    case "image":
      return isStr(value.hash) && isStr(value.mime) && isNum(value.size)
    case "letter":
      return isPanelTextValue(value.body)
    case "clipping":
      return isPanelTextValue(value.headline) && isPanelTextValue(value.body)
    case "map_pin":
      return (
        isStr(value.hash) &&
        isStr(value.mime) &&
        isNum(value.size) &&
        isPanelTextValue(value.label) &&
        isPanelBindableNumber(value.x) &&
        isPanelBindableNumber(value.y)
      )
    case "title_card":
      return isPanelTextValue(value.title)
  }
}

function isPanelAssetRef(value: unknown): boolean {
  return isObject(value) && isStr(value.path) && isStr(value.hash) && isNum(value.size) && isStr(value.mime)
}

function isUiManifestPanel(value: unknown): boolean {
  if (!isObject(value) || !isStr(value.id) || !isPanelText(value.title)) return false
  if (!isOneOf(value.slot, PANEL_SLOTS) || (value.tier !== 1 && value.tier !== 2)) return false
  if (!optional(value.blocks, (v) => everyItem(v, (item) => isPanelTemplateBlock(item, true)))) return false
  if (
    !optional(
      value.entry,
      (v) => isObject(v) && isStr(v.hash) && isNum(v.size),
    )
  ) {
    return false
  }
  if (!optional(value.assets, (v) => everyItem(v, isPanelAssetRef))) return false
  if (value.fallback === null) return true
  return optional(value.fallback, (v) => everyItem(v, (item) => isPanelTemplateBlock(item, true)))
}

function isImageGenStatus(value: unknown): boolean {
  return (
    isObject(value) &&
    isStr(value.provider) &&
    isStr(value.base_url) &&
    isStr(value.model) &&
    isStr(value.size) &&
    isStr(value.api_key_masked) &&
    isBool(value.has_key) &&
    isBool(value.configured) &&
    optional(value.saved_providers, isStringList)
  )
}

function isAdminKeyInfo(value: unknown): boolean {
  return (
    isObject(value) &&
    isStr(value.id) &&
    isStr(value.key_masked) &&
    isStr(value.room) &&
    isStr(value.name) &&
    isOneOf(value.role, PLAYER_ROLES) &&
    isOneOf(value.purpose, ADMIN_KEY_PURPOSES) &&
    (value.expires_at === null || isNum(value.expires_at))
  )
}

function isMintedKey(value: unknown): boolean {
  return (
    isObject(value) &&
    isStr(value.key) &&
    isStr(value.room) &&
    isStr(value.name) &&
    isOneOf(value.role, PLAYER_ROLES) &&
    isOneOf(value.purpose, ADMIN_KEY_PURPOSES) &&
    (value.expires_at === null || isNum(value.expires_at))
  )
}

function isAdminSkillInfo(value: unknown): boolean {
  return (
    isObject(value) &&
    isStr(value.id) &&
    isStr(value.name) &&
    isStr(value.description) &&
    isStr(value.content_rating) &&
    isBool(value.enabled)
  )
}

function isAdminRuleInfo(value: unknown): boolean {
  return isObject(value) && isStr(value.id) && isBool(value.built_in)
}

// Per-frame-type validation of the load-bearing required fields AND the nested
// shapes downstream clients dereference (`.map`, `.id`, `layers[wire.layer]`,
// `you.role`, …). A frame that passes the `type` check but carries null /
// primitive / missing-required entries in those arrays is DROPPED here so it
// can never crash a consumer. Unknown extra fields and unknown frame types
// stay additive (ignored, not rejected). One validator table protects every
// client.
const serverFrameValidators: Record<string, (f: Record<string, unknown>) => boolean> = {
  [FrameType.Welcome]: (f) =>
    isStr(f.protocol) &&
    isStr(f.room) &&
    isWelcomeYou(f.you) &&
    isStr(f.locale) &&
    isStr(f.server) &&
    optional(f.features, isStringList) &&
    optional(f.version, isStr),
  [FrameType.Error]: (f) => isStr(f.code) && isStr(f.message),
  [FrameType.MediaAccept]: (f) =>
    isStr(f.upload_id) &&
    optional(f.existing, isBool) &&
    optional(f.media, (v) => isObject(v) && v.type === FrameType.Media && isMediaFrameFields(v)) &&
    optional(f.audio, isAudioLibraryItem),
  [FrameType.Media]: (f) => isMediaFrameFields(f),
  [FrameType.MediaEnabled]: (f) => isBool(f.enabled),
  [FrameType.AudioLibraryItem]: (f) => isAudioLibraryItem(f),
  [FrameType.AudioControl]: (f) =>
    isStr(f.id) &&
    isOneOf(f.action, AUDIO_ACTIONS) &&
    isOneOf(f.layer, AUDIO_LAYERS) &&
    optional(f.hash, isStr) &&
    optional(f.mime, isStr) &&
    optional(f.name, isStr) &&
    optional(f.title, isStr) &&
    optional(f.loop, isBool) &&
    optional(f.volume, isNum) &&
    optional(f.fade_ms, isNum) &&
    optional(f.position_ms, isNum) &&
    optional(f.server_ts, isNum),
  [FrameType.AudioState]: (f) => everyItem(f.layers, isAudioLayerState),
  [FrameType.Narrative]: (f) =>
    isStr(f.id) && isOneOf(f.speaker, NARRATIVE_SPEAKERS) && isStr(f.text) && isOneOf(f.format, NARRATIVE_FORMATS),
  [FrameType.NarrativeDelta]: (f) => isStr(f.id) && isOneOf(f.speaker, NARRATIVE_SPEAKERS) && isStr(f.text),
  [FrameType.PackCards]: (f) => everyItem(f.cards, isPackCardEntry),
  [FrameType.Dice]: (f) =>
    isStr(f.actor) &&
    isOneOf(f.kind, DICE_KINDS) &&
    isStr(f.expr) &&
    everyItem(f.rolls, isNum) &&
    isNum(f.total) &&
    optional(f.target, isNum) &&
    optional(f.effective_target, isNum) &&
    optional(f.subsystem, isStr) &&
    optional(f.outcome, isDiceOutcome) &&
    optional(f.detail, isObject),
  [FrameType.Ui]: (f) => everyItem(f.blocks, isUiBlock) && isOneOf(f.panel, UI_PANELS),
  [FrameType.UiManifest]: (f) => everyItem(f.panels, isUiManifestPanel),
  [FrameType.PanelEvent]: (f) => isStr(f.panel) && f.panel.length > 0,
  [FrameType.State]: (f) =>
    optional(f.character, isCharacterState) &&
    everyItem(f.party, isPartyMember) &&
    optional(f.scene, isSceneState) &&
    optional(f.clock, isClockState) &&
    everyItem(f.initiative, isInitiativeEntry) &&
    isNum(f.online) &&
    optional(f.usage, isUsageState) &&
    optional(f.variables, (v) => everyItem(v, isModuleVariable)) &&
    optional(f.pregens, (v) => everyItem(v, isPregenEntry)) &&
    optional(f.systems, (v) => everyItem(v, isRuleSystemEntry)) &&
    optional(f.reset, isBool),
  [FrameType.Presence]: (f) => everyItem(f.players, isPresencePlayer) && isNum(f.online),
  [FrameType.System]: (f) => isOneOf(f.level, SYSTEM_LEVELS) && isStr(f.text) && optional(f.spinner, isBool),
  [FrameType.TurnStatus]: (f) =>
    (f.status === "busy" &&
      isStr(f.actor) &&
      f.actor.length > 0 &&
      optional(f.activity, isStr) &&
      optional(f.round, isNum)) ||
    f.status === "idle",
  [FrameType.Pong]: (f) => isNum(f.t),
  [FrameType.AdminConfig]: (f) =>
    isStr(f.provider) &&
    isStr(f.chat_model) &&
    isStr(f.base_url) &&
    isStr(f.api_key_masked) &&
    isStringList(f.providers) &&
    isStringList(f.saved_providers) &&
    isBool(f.override_active) &&
    optional(f.imagegen, isImageGenStatus) &&
    optional(f.using_demo, isBool) &&
    optional(f.subscription_status, (v) => v === "" || v === "logged_in" || v === "logged_out"),
  [FrameType.AdminModels]: (f) => isStr(f.provider) && isStringList(f.models) && optional(f.imagegen, isImageGenStatus),
  [FrameType.AdminKeys]: (f) => everyItem(f.keys, isAdminKeyInfo) && optional(f.minted, isMintedKey),
  [FrameType.AdminRoomOp]: (f) =>
    isOneOf(f.action, ADMIN_ROOM_OP_ACTIONS) &&
    isStr(f.room) &&
    isNum(f.keys) &&
    isNum(f.store_rows) &&
    isNum(f.vector_points) &&
    optional(f.path, isStr) &&
    optional(f.media_files, isNum) &&
    optional(f.scope, isStr),
  [FrameType.AdminError]: (f) => isStr(f.code) && optional(f.message, isStr),
  [FrameType.AdminSkills]: (f) => everyItem(f.skills, isAdminSkillInfo),
  [FrameType.AdminRules]: (f) => everyItem(f.systems, isAdminRuleInfo),
  [FrameType.AdminGenerated]: (f) =>
    isOneOf(f.kind, ADMIN_FORGE_KINDS) &&
    isBool(f.ok) &&
    optional(f.id, isStr) &&
    optional(f.name, isStr) &&
    optional(f.error, isStr) &&
    optional(f.detail, isStr),
  [FrameType.AdminUpdate]: (f) => (f.status === "restarting" || f.status === "failed") && optional(f.output, isStr),
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  if (typeof WebSocket === "undefined") {
    throw new Error("No global WebSocket is available; pass webSocketFactory to WsClient.")
  }
  // The DOM WebSocket satisfies our runtime needs; its structural type is wider
  // (send accepts Blob/ArrayBuffer, handlers are nullable), so bridge explicitly.
  return new WebSocket(url) as unknown as WebSocketLike
}

function toText(data: unknown): string {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (data && typeof Blob !== "undefined" && data instanceof Blob) {
    throw new Error("Blob WebSocket messages are not supported by WsClient.")
  }
  return String(data)
}

export function isServerFrame(value: unknown): value is ServerFrame {
  if (!isObject(value)) return false
  const validate = serverFrameValidators[String(value.type)]
  return validate !== undefined && validate(value)
}

export function isPingFrame(value: unknown): value is PingFrame {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === FrameType.Ping &&
      typeof (value as { t?: unknown }).t === "number",
  )
}

export class WsClient {
  private socket?: WebSocketLike
  private url?: string
  private manualClose = false
  private reconnectAttempts = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private lastJoin?: { key: string; name?: string }
  private readonly factory: WebSocketFactory
  private readonly clientInfo?: ClientInfo
  private readonly reconnect: boolean
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout
  private readonly onProtocolMismatch: ProtocolMismatchHandler
  // The banner repeats on every reconnect; the operator is told once per version, not
  // once per redial. Keyed by the announced string so a genuinely different peer still speaks up.
  private readonly warnedProtocols = new Set<string>()
  private readonly messageHandlers = new Set<MessageHandler>()
  private readonly typedHandlers = new Map<ServerFrame["type"], Set<MessageHandler>>()
  private readonly statusHandlers = new Set<StatusHandler>()
  private readonly pendingOffers: Array<{
    resolve: (frame: MediaAcceptFrame) => void
    reject: (error: Error) => void
  }> = []
  private readonly pendingGets = new Map<
    string,
    {
      resolve: (payload: MediaPayload) => void
      reject: (error: Error) => void
    }
  >()

  constructor(options: WsClientOptions = {}) {
    this.factory = options.webSocketFactory ?? defaultWebSocketFactory
    this.clientInfo = options.clientInfo
    this.reconnect = options.reconnect ?? true
    this.reconnectBaseMs = options.reconnectBaseMs ?? 250
    this.reconnectMaxMs = options.reconnectMaxMs ?? 5_000
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
    this.onProtocolMismatch = options.onProtocolMismatch ?? ((message) => console.warn(message))
  }

  async connect(url: string): Promise<void> {
    this.url = url
    this.manualClose = false
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.setStatus("connecting")

    const socket = this.factory(url)
    this.socket = socket

    return new Promise((resolve, reject) => {
      let settled = false

      const settleOpen = () => {
        settled = true
        this.reconnectAttempts = 0
        this.setStatus("online")
        resolve()
        if (this.lastJoin) {
          this.join(this.lastJoin.key, this.lastJoin.name)
        }
      }

      const settleError = (event: unknown) => {
        if (!settled) {
          settled = true
          reject(event instanceof Error ? event : new Error("WebSocket connection failed."))
        }
      }

      this.attach(socket, "open", settleOpen)
      this.attach(socket, "message", (event) => this.handleRawMessage(event.data))
      this.attach(socket, "close", () => this.handleClose())
      this.attach(socket, "error", settleError)
    })
  }

  close(code?: number, reason?: string): void {
    this.manualClose = true
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.setStatus("offline")
    this.socket?.close(code, reason)
  }

  join(key: string, name?: string): void {
    this.lastJoin = { key, name }
    const frame = {
      type: FrameType.Join,
      key,
      ...(name ? { name } : {}),
      ...(this.clientInfo ? { client: this.clientInfo } : {}),
    }
    this.send(frame)
  }

  sendInput(text: string): void {
    this.send({ type: FrameType.Input, text })
  }

  // v2.2: ask for the card files installed packs ship; the server answers with one
  // unicast `pack_cards` frame (empty `cards` when nothing is installed).
  listPackCards(): void {
    this.send({ type: FrameType.ListPackCards })
  }

  // v1.8: a module-panel interaction, routed server-side as if this player typed it.
  sendPanelIntent(panel: string, kind: PanelIntentKind, value: string): void {
    this.send({ type: FrameType.PanelIntent, panel, kind, value })
  }

  ping(t = Date.now()): void {
    this.send({ type: FrameType.Ping, t })
  }

  async uploadMedia(upload: MediaUpload): Promise<MediaFrame | undefined> {
    const accept = await this.offerMedia({
      type: FrameType.MediaOffer,
      name: upload.name,
      mime: upload.mime,
      size: upload.bytes.byteLength,
      sha256: upload.sha256,
    })
    if (accept.existing) return accept.media
    if (!accept.upload_id) return accept.media
    this.sendMedia({ op: "put", upload_id: accept.upload_id }, upload.bytes)
    return accept.media
  }

  getMedia(hash: string): Promise<MediaPayload> {
    if (!this.socket || this.socket.readyState !== OPEN) {
      return Promise.reject(new Error("WebSocket is not open."))
    }
    return new Promise((resolve, reject) => {
      this.pendingGets.set(hash, { resolve, reject })
      this.sendMedia({ op: "get", hash })
    })
  }

  setMediaEnabled(enabled: boolean): void {
    this.send({ type: FrameType.MediaSetEnabled, enabled })
  }

  setAvatar(hash: string): void {
    const frame: AvatarSetFrame = { type: FrameType.AvatarSet, hash }
    this.send(frame)
  }

  // ---- v1.1 admin (keeper-gated) requests --------------------------------
  // The server only honors these on a keeper-role connection; otherwise it
  // replies `admin_error {code:"forbidden"}`.

  adminGetConfig(): void {
    this.send({ type: FrameType.AdminGetConfig })
  }

  adminSetModel(provider: string, chatModel?: string, apiKey?: string, baseUrl?: string): void {
    const frame: AdminSetModelFrame = { type: FrameType.AdminSetModel, provider }
    if (chatModel) frame.chat_model = chatModel
    // Presence is meaningful: an explicit empty key/URL clears the saved field,
    // while `undefined` asks the server to reuse the unchanged endpoint pair.
    if (apiKey !== undefined) frame.api_key = apiKey
    if (baseUrl !== undefined) frame.base_url = baseUrl
    this.send(frame)
  }

  adminSetImagegen(provider: string, model: string, apiKey?: string, baseUrl?: string, size?: string): void {
    const frame: AdminSetImagegenFrame = { type: FrameType.AdminSetImagegen, provider, model }
    if (apiKey !== undefined) frame.api_key = apiKey
    if (baseUrl !== undefined) frame.base_url = baseUrl
    if (size) frame.size = size
    this.send(frame)
  }

  // Ask for a provider's live model catalog. Omit args to list the current provider;
  // pass provider (+ optional apiKey/baseUrl) to preview another before switching.
  adminListModels(provider?: string, apiKey?: string, baseUrl?: string): void {
    const frame: AdminListModelsFrame = { type: FrameType.AdminListModels }
    if (provider) frame.provider = provider
    if (apiKey !== undefined) frame.api_key = apiKey
    if (baseUrl !== undefined) frame.base_url = baseUrl
    this.send(frame)
  }

  adminListKeys(): void {
    this.send({ type: FrameType.AdminListKeys })
  }

  adminMintKey(
    room?: string,
    name?: string,
    role?: PlayerRole,
    purpose?: AdminKeyPurpose,
    expiresIn?: number,
  ): void {
    const frame: AdminMintKeyFrame = { type: FrameType.AdminMintKey }
    if (room !== undefined) frame.room = room
    if (name) frame.name = name
    if (role) frame.role = role
    if (purpose) frame.purpose = purpose
    if (expiresIn !== undefined) frame.expires_in = expiresIn
    this.send(frame)
  }

  adminUpdateKey(id: string, room?: string, name?: string, role?: PlayerRole): void {
    const frame: AdminUpdateKeyFrame = { type: FrameType.AdminUpdateKey, id }
    if (room !== undefined) frame.room = room
    if (name !== undefined) frame.name = name
    if (role !== undefined) frame.role = role
    this.send(frame)
  }

  adminDeleteKey(id: string): void {
    this.send({ type: FrameType.AdminDeleteKey, id })
  }

  adminDeleteRoom(room: string): void {
    this.send({ type: FrameType.AdminDeleteRoom, room })
  }

  adminExportRoom(room: string, path?: string): void {
    const frame: AdminExportRoomFrame = { type: FrameType.AdminExportRoom, room }
    if (path) frame.path = path
    this.send(frame)
  }

  adminImportRoom(path: string, room?: string): void {
    const frame: AdminImportRoomFrame = { type: FrameType.AdminImportRoom, path }
    if (room) frame.room = room
    this.send(frame)
  }

  adminDeleteRoomData(room: string, backup?: boolean, path?: string): void {
    const frame: AdminDeleteRoomDataFrame = { type: FrameType.AdminDeleteRoomData, room }
    if (backup !== undefined) frame.backup = backup
    if (path) frame.path = path
    this.send(frame)
  }

  adminResetRoom(room: string, scope?: AdminResetScope): void {
    const frame: AdminResetRoomFrame = { type: FrameType.AdminResetRoom, room }
    if (scope) frame.scope = scope
    this.send(frame)
  }

  adminUpdateServer(): void {
    this.send({ type: FrameType.AdminUpdateServer })
  }

  // ---- v1.1 additive: Layer B.4a plugin management (KP skills / rule systems / forge) ----

  adminListSkills(locale?: string): void {
    this.send({ type: FrameType.AdminListSkills, ...(locale ? { locale } : {}) })
  }

  adminEnableSkill(id: string, on: boolean, locale?: string): void {
    const frame: AdminEnableSkillFrame = { type: FrameType.AdminEnableSkill, id, on, ...(locale ? { locale } : {}) }
    this.send(frame)
  }

  adminListRules(): void {
    this.send({ type: FrameType.AdminListRules })
  }

  // Author + install a brand-new skill/rule system/module from a description via the matching
  // `agent.forge` generator. Slow (an LLM call) but still a plain request/reply — the caller
  // shows a spinner while awaiting the `admin_generated` reply.
  adminGenerate(kind: AdminForgeKind, description: string): void {
    const frame: AdminGenerateFrame = { type: FrameType.AdminGenerate, kind, description }
    this.send(frame)
  }

  send(frame: ClientFrame): void {
    if (!this.socket || this.socket.readyState !== OPEN) {
      throw new Error("WebSocket is not open.")
    }
    this.socket.send(JSON.stringify(frame))
  }

  onMessage(cb: MessageHandler): () => void {
    this.messageHandlers.add(cb)
    return () => this.messageHandlers.delete(cb)
  }

  on<T extends ServerFrame["type"]>(type: T, cb: TypedMessageHandler<T>): () => void {
    const handlers = this.typedHandlers.get(type) ?? new Set<MessageHandler>()
    handlers.add(cb as MessageHandler)
    this.typedHandlers.set(type, handlers)
    return () => handlers.delete(cb as MessageHandler)
  }

  // Optional: a small HUD indicator subscribes here rather than polling. Not called with
  // the current status on subscribe — only future transitions — so a fresh subscriber sees
  // "connecting" implicitly (no event yet) until the next real transition fires.
  onStatus(cb: StatusHandler): () => void {
    this.statusHandlers.add(cb)
    return () => this.statusHandlers.delete(cb)
  }

  private setStatus(status: ConnectionStatus): void {
    for (const handler of this.statusHandlers) handler(status)
  }

  private attach<T extends "open" | "message" | "close" | "error">(
    socket: WebSocketLike,
    type: T,
    listener: T extends "message" ? (event: { data: unknown }) => void : (event: unknown) => void,
  ): void {
    if (socket.addEventListener) {
      socket.addEventListener(type as never, listener as never)
      return
    }

    const property = `on${type}` as keyof WebSocketLike
    ;(socket[property] as typeof listener | undefined) = listener
  }

  private handleRawMessage(data: unknown): void {
    const binary = toUint8Array(data)
    if (binary) {
      this.handleMediaMessage(binary)
      return
    }
    // Untrusted transport: a non-JSON (or undecodable) message must never throw
    // out of the socket's message handler — drop it and keep the connection alive.
    let parsed: unknown
    try {
      parsed = JSON.parse(toText(data))
    } catch {
      return
    }
    if (isPingFrame(parsed)) {
      this.sendPong(parsed.t)
      return
    }
    if (!isServerFrame(parsed)) return
    if (parsed.type === FrameType.MediaAccept) {
      const pending = this.pendingOffers.shift()
      if (pending) pending.resolve(parsed)
    }
    if (parsed.type === FrameType.Welcome) {
      this.checkProtocol(parsed)
    }
    if (parsed.type === FrameType.Error) {
      const error = new Error(parsed.message)
      const pendingOffer = this.pendingOffers.shift()
      if (pendingOffer) pendingOffer.reject(error)
      for (const pending of this.pendingGets.values()) pending.reject(error)
      this.pendingGets.clear()
    }

    for (const handler of this.messageHandlers) handler(parsed)
    const typed = this.typedHandlers.get(parsed.type)
    if (!typed) return
    for (const handler of typed) handler(parsed)
  }

  // A WARNING, never a refusal: the frame is dispatched to subscribers either way and the
  // socket stays open. `welcome.protocol` is typed as a string but arrives off an untrusted
  // wire, so an absent/garbage banner announces no major and is passed over in silence.
  private checkProtocol(frame: WelcomeFrame): void {
    const mismatch = protocolMismatch(frame.protocol)
    if (!mismatch || this.warnedProtocols.has(mismatch.server)) return
    this.warnedProtocols.add(mismatch.server)
    this.onProtocolMismatch(protocolMismatchMessage(mismatch), mismatch)
  }

  private sendPong(t: number): void {
    if (!this.socket || this.socket.readyState !== OPEN) return
    const frame: PongFrame = { type: FrameType.Pong, t }
    this.socket.send(JSON.stringify(frame))
  }

  private handleClose(): void {
    if (this.manualClose || !this.reconnect || !this.url) return
    this.setStatus("reconnecting")
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.reconnectAttempts)
    this.reconnectAttempts += 1
    this.reconnectTimer = this.setTimeoutFn(() => {
      void this.connect(this.url!)
    }, delay)
  }

  private offerMedia(frame: MediaOfferFrame): Promise<MediaAcceptFrame> {
    if (!this.socket || this.socket.readyState !== OPEN) {
      return Promise.reject(new Error("WebSocket is not open."))
    }
    return new Promise((resolve, reject) => {
      this.pendingOffers.push({ resolve, reject })
      this.send(frame)
    })
  }

  private sendMedia(header: Record<string, unknown>, bytes: Uint8Array = new Uint8Array()): void {
    if (!this.socket || this.socket.readyState !== OPEN) {
      throw new Error("WebSocket is not open.")
    }
    this.socket.send(packMediaMessage(header, bytes))
  }

  private handleMediaMessage(payload: Uint8Array): void {
    let unpacked: { header: Record<string, unknown>; body: Uint8Array }
    try {
      unpacked = unpackMediaMessage(payload)
    } catch {
      return
    }
    const hash = String(unpacked.header.hash ?? "")
    const pending = this.pendingGets.get(hash)
    if (!pending) return
    this.pendingGets.delete(hash)
    pending.resolve({
      hash,
      mime: String(unpacked.header.mime ?? ""),
      name: String(unpacked.header.name ?? ""),
      bytes: unpacked.body,
    })
  }
}

export function packMediaMessage(header: Record<string, unknown>, body: Uint8Array = new Uint8Array()): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  const out = new Uint8Array(WS_MEDIA_HEADER_BYTES + headerBytes.byteLength + body.byteLength)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(0, headerBytes.byteLength)
  out.set(headerBytes, WS_MEDIA_HEADER_BYTES)
  out.set(body, WS_MEDIA_HEADER_BYTES + headerBytes.byteLength)
  return out
}

export function unpackMediaMessage(payload: Uint8Array): { header: Record<string, unknown>; body: Uint8Array } {
  if (payload.byteLength < WS_MEDIA_HEADER_BYTES) throw new Error("media message missing header length")
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const headerLength = view.getUint32(0)
  const start = WS_MEDIA_HEADER_BYTES
  const end = start + headerLength
  if (headerLength <= 0 || end > payload.byteLength) throw new Error("media message has invalid header length")
  const parsed = JSON.parse(new TextDecoder().decode(payload.subarray(start, end)))
  if (!isObject(parsed)) throw new Error("media header is not an object")
  return { header: parsed, body: payload.subarray(end) }
}

function toUint8Array(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return undefined
}
