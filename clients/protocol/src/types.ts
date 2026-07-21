// Bumped to "1.5" for the additive room-wide AI-KP turn-status frame.
// `WelcomeFrame.protocol` stays a plain string so older minor clients keep accepting it.
export const PROTOCOL_VERSION = "1.5" as const

export const FrameType = {
  Join: "join",
  Input: "input",
  Ping: "ping",
  MediaOffer: "media_offer",
  MediaAccept: "media_accept",
  Media: "media",
  MediaSetEnabled: "media_set_enabled",
  MediaEnabled: "media_enabled",
  AvatarSet: "avatar_set",
  AudioLibraryItem: "audio_library_item",
  AudioControl: "audio_control",
  AudioState: "audio_state",
  Welcome: "welcome",
  Error: "error",
  Narrative: "narrative",
  Dice: "dice",
  State: "state",
  Presence: "presence",
  System: "system",
  TurnStatus: "turn_status",
  Pong: "pong",
  // v1.1 additive admin (keeper-gated) frames.
  AdminGetConfig: "admin_get_config",
  AdminSetModel: "admin_set_model",
  AdminSetImagegen: "admin_set_imagegen",
  AdminListModels: "admin_list_models",
  AdminListKeys: "admin_list_keys",
  AdminMintKey: "admin_mint_key",
  AdminUpdateKey: "admin_update_key",
  AdminDeleteKey: "admin_delete_key",
  AdminDeleteRoom: "admin_delete_room",
  AdminExportRoom: "admin_export_room",
  AdminImportRoom: "admin_import_room",
  AdminDeleteRoomData: "admin_delete_room_data",
  AdminResetRoom: "admin_reset_room",
  AdminConfig: "admin_config",
  AdminModels: "admin_models",
  AdminKeys: "admin_keys",
  AdminRoomOp: "admin_room_op",
  AdminError: "admin_error",
  // v1.1 additive: Layer B.4a plugin-management (KP skills, rule systems, self-extension forge).
  AdminListSkills: "admin_list_skills",
  AdminSkills: "admin_skills",
  AdminEnableSkill: "admin_enable_skill",
  AdminListRules: "admin_list_rules",
  AdminRules: "admin_rules",
  AdminGenerate: "admin_generate",
  AdminGenerated: "admin_generated",
} as const

export type FrameType = (typeof FrameType)[keyof typeof FrameType]

export type PlayerRole = "player" | "keeper"
export type AdminKeyPurpose = "join" | "chat_bind"
export type NarrativeSpeaker = "kp" | "player" | "system" | "npc"
export type NarrativeFormat = "markdown" | "plain"
export type ErrorCode =
  | "bad_key"
  | "bad_frame"
  | "input_too_long"
  | "rate_limited"
  | "server_error"
  | "join_timeout"
  | "too_many_connections"
  | "forbidden"
  | "media_disabled"
  | "media_rate_limited"
  | "media_bad_mime"
  | "media_too_large"
  | "media_quota_exceeded"
  | "media_bad_hash"
  | "media_bad_offer"
  | "media_bad_svg"
  | "media_bad_upload"
  | "media_size_mismatch"
  | "media_hash_mismatch"
  | "media_not_found"
  | "avatar_no_character"
export type DiceKind = "roll" | "check" | "sanity" | "opposed" | "init"
export type SystemLevel = "info" | "warn"
export type TurnActivity = "busy" | "idle"
export type AudioLayer = "bgm" | "ambience" | "sfx"
export type AudioAction = "play" | "stop" | "pause" | "resume" | "volume"
export type AdminErrorCode =
  | "forbidden"
  | "unknown_provider"
  | "bad_request"
  | "set_failed"
  | "not_found"
  | "op_failed"
export type AdminRoomOpAction = "export" | "import" | "delete" | "reset"
export type AdminForgeKind = "skill" | "rule" | "module"

export interface ClientInfo {
  name: string
  version: string
}

export interface JoinFrame {
  type: typeof FrameType.Join
  key: string
  name?: string
  client?: ClientInfo
}

export interface InputFrame {
  type: typeof FrameType.Input
  text: string
}

export interface PingFrame {
  type: typeof FrameType.Ping
  t: number
}

export interface MediaOfferFrame {
  type: typeof FrameType.MediaOffer
  name: string
  mime: string
  size: number
  sha256: string
}

export interface MediaRef {
  hash: string
  mime: string
  size: number
  name?: string
}

export interface MediaFrame extends MediaRef {
  type: typeof FrameType.Media
  id: string
  name: string
  from: string
  ts: number
}

export interface MediaAcceptFrame {
  type: typeof FrameType.MediaAccept
  upload_id: string
  existing?: boolean
  media?: MediaFrame
  audio?: AudioLibraryItemFrame
}

export interface MediaSetEnabledFrame {
  type: typeof FrameType.MediaSetEnabled
  enabled: boolean
}

export interface MediaEnabledFrame {
  type: typeof FrameType.MediaEnabled
  enabled: boolean
}

export interface AvatarSetFrame {
  type: typeof FrameType.AvatarSet
  hash: string
}

export interface AudioLibraryItemFrame extends MediaRef {
  type: typeof FrameType.AudioLibraryItem
  id: string
  name: string
  from: string
  ts: number
  title?: string
  license?: string
  source?: string
  tags?: string[]
}

export interface AudioControlFrame {
  type: typeof FrameType.AudioControl
  id: string
  action: AudioAction
  layer: AudioLayer
  hash?: string
  mime?: string
  name?: string
  title?: string
  loop?: boolean
  volume?: number
  fade_ms?: number
  position_ms?: number
  server_ts?: number
}

export interface AudioLayerState {
  layer: AudioLayer
  hash?: string
  mime?: string
  name?: string
  title?: string
  playing: boolean
  volume?: number
  loop?: boolean
  started_at?: number
}

export interface AudioStateFrame {
  type: typeof FrameType.AudioState
  layers: AudioLayerState[]
}

export interface WelcomeFrame {
  type: typeof FrameType.Welcome
  // A plain string (not the literal) so a client pinned to an older minor still
  // type-checks against a newer server banner.
  protocol: string
  room: string
  you: {
    id: string
    name: string
    role: PlayerRole
  }
  locale: string
  server: string
  features?: string[]
}

export interface ErrorFrame {
  type: typeof FrameType.Error
  code: ErrorCode
  message: string
}

export interface NarrativeFrame {
  type: typeof FrameType.Narrative
  id: string
  speaker: NarrativeSpeaker
  name?: string
  text: string
  format: NarrativeFormat
  stream?: boolean
  done?: boolean
}

export interface DiceFrame {
  type: typeof FrameType.Dice
  actor: string
  kind: DiceKind
  expr: string
  rolls: number[]
  total: number
  target?: number
  rank?: number
  level?: string
  success?: boolean
}

export interface CharacterState {
  name: string
  system: string
  hp: number
  hpmax: number
  mp: number
  mpmax: number
  san: number
  sanmax: number
  attributes: Record<string, unknown>
  status_effects: string[]
  avatar?: MediaRef
}

export interface PartyMember {
  name: string
  online: boolean
  active: boolean
  initiative?: number
  hp?: number
  hpMax?: number
  san?: number
  sanMax?: number
  mp?: number
  mpMax?: number
  // M10: set when this roster member is an AI player-companion (vs a human
  // player's character), so clients can render an "AI" badge. Additive/
  // optional so older server payloads without it still type-check.
  ai?: boolean
  avatar?: MediaRef
}

export interface SceneState {
  name: string
  focus?: string
}

export interface ClockState {
  time: string
  round?: number
}

export interface InitiativeEntry {
  name: string
  value: number
  current: boolean
}

// Rolling per-room LLM token/cache usage aggregate (gateway/turn.py's
// `_record_usage_stats`, surfaced by `net.state.build_room_state`). Additive/
// optional -- an older server that never sends it still type-checks fine, and a
// brand-new room with no completed AI-KP turn yet simply omits the field.
export interface UsageState {
  context_tokens: number
  context_window: number
  input_tokens: number
  output_tokens: number
  cache_hit_tokens: number
  cache_miss_tokens: number
}

export interface StateFrame {
  type: typeof FrameType.State
  character?: CharacterState
  party: PartyMember[]
  scene?: SceneState
  clock?: ClockState
  initiative: InitiativeEntry[]
  online: number
  usage?: UsageState
  // Set once, on the state frame the server pushes right after a campaign reset
  // (`.reset` / `admin_reset_room`): besides the already-fresh (empty) panel data,
  // the client should also clear its locally-accumulated chat scrollback.
  reset?: boolean
}

export interface PresencePlayer {
  id: string
  name: string
  online: boolean
}

export interface PresenceFrame {
  type: typeof FrameType.Presence
  players: PresencePlayer[]
  online: number
}

export interface SystemFrame {
  type: typeof FrameType.System
  level: SystemLevel
  text: string
  spinner?: boolean
}

export type TurnStatusFrame =
  | { type: typeof FrameType.TurnStatus; status: "busy"; actor: string }
  | { type: typeof FrameType.TurnStatus; status: "idle"; actor?: never }

export interface PongFrame {
  type: typeof FrameType.Pong
  t: number
}

// ---- v1.1 admin (keeper-gated) frames ------------------------------------
// A deployer/keeper opens the web admin panel with a keeper-role key; the server
// answers these ONLY for a keeper connection (else `admin_error {code:"forbidden"}`).

export interface AdminGetConfigFrame {
  type: typeof FrameType.AdminGetConfig
}

export interface AdminSetModelFrame {
  type: typeof FrameType.AdminSetModel
  provider: string
  chat_model?: string
  // Optional: set/replace this provider's key (blank = keep the saved one). The server
  // remembers it per-provider so a later switch back to this provider won't re-ask.
  api_key?: string
  base_url?: string
}

export interface ImageGenStatus {
  provider: string
  base_url: string
  model: string
  size: string
  api_key_masked: string
  has_key: boolean
  configured: boolean
  saved_providers?: string[]
}

export interface AdminSetImagegenFrame {
  type: typeof FrameType.AdminSetImagegen
  provider: string
  base_url?: string
  model: string
  api_key?: string
  size?: string
}

// Ask the server for a provider's live model catalog (OpenAI-compatible GET /models).
// All fields optional: omit to list the current provider; pass provider (+ optional
// api_key/base_url) to preview another provider's models before committing.
export interface AdminListModelsFrame {
  type: typeof FrameType.AdminListModels
  provider?: string
  api_key?: string
  base_url?: string
}

export interface AdminListKeysFrame {
  type: typeof FrameType.AdminListKeys
}

export interface AdminMintKeyFrame {
  type: typeof FrameType.AdminMintKey
  room?: string
  name?: string
  role?: PlayerRole
  purpose?: AdminKeyPurpose
  expires_in?: number
}

export interface AdminUpdateKeyFrame {
  type: typeof FrameType.AdminUpdateKey
  id: string
  room?: string
  name?: string
  role?: PlayerRole
}

export interface AdminDeleteKeyFrame {
  type: typeof FrameType.AdminDeleteKey
  id: string
}

export interface AdminDeleteRoomFrame {
  type: typeof FrameType.AdminDeleteRoom
  room: string
}

export interface AdminExportRoomFrame {
  type: typeof FrameType.AdminExportRoom
  room: string
  path?: string
}

export interface AdminImportRoomFrame {
  type: typeof FrameType.AdminImportRoom
  path: string
  room?: string
}

export interface AdminDeleteRoomDataFrame {
  type: typeof FrameType.AdminDeleteRoomData
  room: string
  backup?: boolean
  path?: string
}

// In-place campaign restart: wipe this room's campaign state (characters, story,
// module, lore, media) while keeping keystore keys and live connections — no
// backup, no key removal. Contrast AdminDeleteRoomData, which backs up and evicts.
export interface AdminResetRoomFrame {
  type: typeof FrameType.AdminResetRoom
  room: string
}

export interface AdminConfigFrame {
  type: typeof FrameType.AdminConfig
  provider: string
  chat_model: string
  base_url: string
  api_key_masked: string
  providers: string[]
  // Providers that already have a saved API key or OAuth grant — the model screen marks these 'ready'.
  saved_providers: string[]
  override_active: boolean
  imagegen?: ImageGenStatus
  /** True only while turns route to the server's offline sample Keeper. */
  using_demo?: boolean
  /**
   * Subscription OAuth status for the *current* provider when it uses a ChatGPT /
   * SuperGrok grant (no new frame type — optional field only). Empty or absent for
   * classic API-key providers, including dual-mode ChatGPT aliases with an explicit
   * proxy `base_url`. Login itself is still a chat command (`.model login`).
   */
  subscription_status?: "" | "logged_in" | "logged_out"
}

// The live model catalog for `provider` (empty when the provider is a native SDK,
// the key is missing/invalid, or /models is unreachable — client falls back to free-text).
export interface AdminModelsFrame {
  type: typeof FrameType.AdminModels
  provider: string
  models: string[]
  imagegen?: ImageGenStatus
}

export interface AdminKeyInfo {
  id: string
  key_masked: string
  room: string
  name: string
  role: PlayerRole
  purpose: AdminKeyPurpose
  expires_at: number | null
}

// The freshly minted key is returned ONCE, in cleartext, so the keeper can copy
// it; every other view (including `keys` here) only ever carries `key_masked`.
export interface MintedKey {
  key: string
  room: string
  name: string
  role: PlayerRole
  purpose: AdminKeyPurpose
  expires_at: number | null
}

export interface AdminKeysFrame {
  type: typeof FrameType.AdminKeys
  keys: AdminKeyInfo[]
  minted?: MintedKey
}

export interface AdminRoomOpFrame {
  type: typeof FrameType.AdminRoomOp
  action: AdminRoomOpAction
  room: string
  path?: string
  keys: number
  store_rows: number
  vector_points: number
  media_files?: number
}

export interface AdminErrorFrame {
  type: typeof FrameType.AdminError
  code: AdminErrorCode
  message?: string
}

// ---- v1.1 additive: Layer B.4a plugin management (KP skills, rule systems, self-extension
// forge) — see `docs/plugins.md` "Layer B". Keeper-gated exactly like every other `admin_*` frame.

export interface AdminListSkillsFrame {
  type: typeof FrameType.AdminListSkills
}

export interface AdminSkillInfo {
  id: string
  name: string
  description: string
  content_rating: string
  // Per the CALLING keeper's own room, not global.
  enabled: boolean
}

export interface AdminSkillsFrame {
  type: typeof FrameType.AdminSkills
  skills: AdminSkillInfo[]
}

export interface AdminEnableSkillFrame {
  type: typeof FrameType.AdminEnableSkill
  id: string
  on: boolean
}

export interface AdminListRulesFrame {
  type: typeof FrameType.AdminListRules
}

export interface AdminRuleInfo {
  id: string
  built_in: boolean
}

export interface AdminRulesFrame {
  type: typeof FrameType.AdminRules
  systems: AdminRuleInfo[]
}

// Ask the server to author + install a brand-new skill/rule system/module from a natural-language
// description via the matching `agent.forge` generator. A slow LLM call answered as a normal
// request/reply — the client shows a spinner while it awaits `AdminGeneratedFrame`.
export interface AdminGenerateFrame {
  type: typeof FrameType.AdminGenerate
  kind: AdminForgeKind
  description: string
}

export interface AdminGeneratedFrame {
  type: typeof FrameType.AdminGenerated
  kind: AdminForgeKind
  ok: boolean
  id: string
  name: string
  error: string
  // Per-room install outcome. For kind:"module" this is the only signal of whether the module
  // actually landed in the room (ok merely means a valid document was authored + written); empty
  // for skill/rule, which have no per-room install step.
  detail: string
}

export type ClientFrame =
  | JoinFrame
  | InputFrame
  | PingFrame
  | MediaOfferFrame
  | MediaSetEnabledFrame
  | AvatarSetFrame
  | AdminGetConfigFrame
  | AdminSetModelFrame
  | AdminSetImagegenFrame
  | AdminListModelsFrame
  | AdminListKeysFrame
  | AdminMintKeyFrame
  | AdminUpdateKeyFrame
  | AdminDeleteKeyFrame
  | AdminDeleteRoomFrame
  | AdminExportRoomFrame
  | AdminImportRoomFrame
  | AdminDeleteRoomDataFrame
  | AdminResetRoomFrame
  | AdminListSkillsFrame
  | AdminEnableSkillFrame
  | AdminListRulesFrame
  | AdminGenerateFrame

export type ServerFrame =
  | WelcomeFrame
  | ErrorFrame
  | MediaAcceptFrame
  | MediaFrame
  | MediaEnabledFrame
  | AudioLibraryItemFrame
  | AudioControlFrame
  | AudioStateFrame
  | NarrativeFrame
  | DiceFrame
  | StateFrame
  | PresenceFrame
  | SystemFrame
  | TurnStatusFrame
  | PongFrame
  | AdminConfigFrame
  | AdminModelsFrame
  | AdminKeysFrame
  | AdminRoomOpFrame
  | AdminErrorFrame
  | AdminSkillsFrame
  | AdminRulesFrame
  | AdminGeneratedFrame

export type AnyFrame = ClientFrame | ServerFrame
