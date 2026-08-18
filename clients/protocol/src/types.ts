// Protocol 2.1 — the MAJOR version is the compatibility contract: refuse (or clearly
// warn on) a `welcome.protocol` whose major differs; minors within a major stay
// additive. 2.1 adds the M19 presentation surface: the `image` and performance block
// kinds, and `visible_when` on panel template blocks. 2.2 adds the installed-pack
// card listing (`list_pack_cards` → `pack_cards`), the structured lane behind every
// "import from installed pack" picker. 2.3 adds each listed card's `kind`, so a picker
// can send the right import verb. A 2.0/2.1 client ignores all of it.
export const PROTOCOL_VERSION = "2.3" as const

export const FrameType = {
  Join: "join",
  Input: "input",
  Ping: "ping",
  // v2.2 additive: installed-pack card discovery (player-open) — the structured
  // lane behind "import from installed pack" pickers.
  ListPackCards: "list_pack_cards",
  PackCards: "pack_cards",
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
  NarrativeDelta: "narrative_delta",
  Dice: "dice",
  Ui: "ui",
  // v1.8 additive: module UI panels (M15).
  UiManifest: "ui_manifest",
  PanelEvent: "panel_event",
  PanelIntent: "panel_intent",
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
  // Keeper-triggered in-place server self-update (gated by the server's "update" feature).
  AdminUpdateServer: "admin_update_server",
  AdminUpdate: "admin_update",
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
export type DiceKind = "roll" | "check" | "subsystem" | "opposed" | "init"
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
  | "not_configured"
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

// v2.2: ask the server for the card files installed packs ship. Player-open —
// filenames are claimable knowledge (the install banner prints them), never content.
export interface ListPackCardsFrame {
  type: typeof FrameType.ListPackCards
}

// One importable card from an installed pack: `ref` is exactly what
// `.import <ref> pc` accepts; `pack` and `name` (the filename stem) are for display.
export interface PackCardEntry {
  ref: string
  pack: string
  name: string
  /** v2.3: the card's 拆卡 classification. A `world` card is module machinery and
   * imports through the KEEPER's `.import <ref> world`; a `character` card is the
   * ordinary `.import <ref> pc`. Absent from a pre-2.3 server — treat that as
   * `"character"`, which is what every client assumed before this field existed. */
  kind?: "character" | "world"
}

// v2.2: the unicast answer to `list_pack_cards`. `cards` is empty (not absent)
// when no installed pack ships card files.
export interface PackCardsFrame {
  type: typeof FrameType.PackCards
  cards: PackCardEntry[]
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
  // The server's own release version (see infra.version.resolve_version). Absent on
  // older servers. Clients compare it to their own to detect a version mismatch and,
  // when `features` includes "update", offer a keeper the server self-update control.
  version?: string
}

export interface ErrorFrame {
  type: typeof FrameType.Error
  code: ErrorCode
  message: string
}

// A `narrative` frame always carries the COMPLETE final text. When its `id`
// matches a draft bubble accumulated from `narrative_delta` frames, the final
// text REPLACES that draft (post-generation corrections are already folded in).
export interface NarrativeFrame {
  type: typeof FrameType.Narrative
  id: string
  speaker: NarrativeSpeaker
  name?: string
  text: string
  format: NarrativeFormat
}

// One streaming text delta for the draft bubble `id`; concatenate deltas
// sharing an id. The stream ends when the `narrative` frame with the SAME id
// arrives (servers guarantee that closing frame, even on a failed turn).
export interface NarrativeDeltaFrame {
  type: typeof FrameType.NarrativeDelta
  id: string
  speaker: NarrativeSpeaker
  name?: string
  text: string
}

// A graded check's outcome: `id` is the rule system's own rank vocabulary
// (presentation only — never branch on it), `label` is already localized, and
// clients color by the semantic flags, optionally shading by `tier` (ladder
// ordinal, higher is better). `margin` is the signed distance from the target
// in the system's own metric (positive = success side).
export interface DiceOutcome {
  id: string
  label: string
  success: boolean
  critical: boolean
  fumble: boolean
  tier: number
  margin?: number
}

export interface DiceFrame {
  type: typeof FrameType.Dice
  actor: string
  kind: DiceKind
  expr: string
  rolls: number[]
  total: number
  target?: number
  effective_target?: number
  // kind === "subsystem": which rule subsystem ran (e.g. a sanity check).
  subsystem?: string
  outcome?: DiceOutcome
  // System-declared roll data (bonus/penalty dice, loss/remaining, advantage
  // candidates, opposed left/right/winner, ...) a client may surface verbatim
  // but never needs to understand.
  detail?: Record<string, unknown>
}

// ---- v1.7 additive: declarative hook-emitted UI frames ---------------------
// Server-side room hooks (a skill's / card's `hooks.js` — see docs/plugins.md) emit
// these via `emitUI(blocks, opts?)`. The engine validates, whitelists and caps every
// block before it reaches the wire, so clients may render them as-is. Content is
// player-visible authorial output — the same trust stance as narration.

export type UiPanel = "inline" | "sidebar"
export type UiBadgeTone = "info" | "warn" | "danger"
export type UiTextStyle = "quote" | "warning"

export interface UiMeterBlock {
  kind: "meter"
  label: string
  value: number
  min: number
  max: number
}

export interface UiStatBlock {
  kind: "stat"
  label: string
  value: number | string | boolean
}

export interface UiBadgeBlock {
  kind: "badge"
  label: string
  tone?: UiBadgeTone
}

export interface UiTextBlock {
  kind: "text"
  text: string
  style?: UiTextStyle
}

export interface UiDividerBlock {
  kind: "divider"
}

// v2.1 additive (M19): a picture the room can already fetch, named by CONTENT HASH —
// the same address the media byte channel answers (`{op:"get", hash}`). The server
// only ever emits a hash reachable from this room (room media or an enabled pack's
// asset) and stamps the authoritative `mime`, so a client may fetch it directly.
// Text-first clients degrade to the caption/alt line plus their normal media
// affordance.
export interface UiImageBlock {
  kind: "image"
  hash: string
  mime?: string
  // Byte length, present on pack-asset images (a manifest knows it up front).
  size?: number
  caption?: string
  alt?: string
}

export interface UiChoiceOption {
  id: string
  label: string
  // Picking this option sends `input` back verbatim as a NORMAL `input` frame —
  // there is no dedicated client→server frame type for choices.
  input: string
}

export interface UiChoicesBlock {
  kind: "choices"
  prompt?: string
  options: UiChoiceOption[]
}

// v2.1 additive (M19): the performance-grade templates. Declarative, not markup —
// a rich client styles a `letter` as stationery and a `title_card` as a full-bleed act
// card; a text-first client prints the same fields as lines. Emitted by the Stage
// Director on story beats, and available to pack panels as authored templates.

export interface UiLetterBlock {
  kind: "letter"
  body: string
  from?: string
  to?: string
  date?: string
}

export interface UiClippingBlock {
  kind: "clipping"
  headline: string
  body: string
  source?: string
  date?: string
}

// A marker on a map image. `x`/`y` are FRACTIONS of the image's own box (0..1), so a
// client scales the pin to whatever size it renders the map at.
export interface UiMapPinBlock {
  kind: "map_pin"
  hash: string
  mime?: string
  size?: number
  label: string
  x: number
  y: number
  note?: string
}

export interface UiTitleCardBlock {
  kind: "title_card"
  title: string
  subtitle?: string
  act?: string
}

export type UiBlock =
  | UiMeterBlock
  | UiStatBlock
  | UiBadgeBlock
  | UiTextBlock
  | UiDividerBlock
  | UiChoicesBlock
  | UiImageBlock
  | UiLetterBlock
  | UiClippingBlock
  | UiMapPinBlock
  | UiTitleCardBlock

export interface UiFrame {
  type: typeof FrameType.Ui
  blocks: UiBlock[]
  // "inline" renders into the narrative stream; "sidebar" into a persistent panel region.
  panel: UiPanel
  // Names a UI region. A later sidebar frame with the same id replaces that region's
  // content; an inline frame with `replace:true` MAY update the prior inline frame
  // with the same id in place (a client without in-place updates simply appends).
  id?: string
  replace?: boolean
}

// ---- v1.8 additive: module UI panels (M15) ---------------------------------
// A pack declares named panels (`ui/panels.yaml`); the keeper admits them to a room
// with `.panels enable <packId>`. The server resolves `audience` per viewer BEFORE the
// wire — a manifest is this viewer's complete panel list (full-replace semantics), and
// keeper-only panels structurally never appear in a player's manifest. Tier-1 panels
// are templates over the v1.7 `ui` block vocabulary with live variable bindings the
// CLIENT substitutes from its own `state.variables`; tier-2 panels ship sandboxed
// HTML/JS assets (rich clients) plus a tier-1 `fallback` for everyone else.

export type PanelSlot = "sidebar" | "tray" | "modal"
export type PanelIntentKind = "choice" | "input" | "roll"

// Localized template text: the server normalizes plain strings to `{en: ...}`.
export interface PanelText {
  en?: string
  zh?: string
}

// `{$var: "<id>"}` — substitute the viewer's own `state.variables` entry with that id.
// The variable being absent/hidden for this viewer omits the WHOLE block (fail-closed:
// a panel can never widen visibility; the state wire filter stays the choke point).
export interface PanelVarBinding {
  $var: string
}

// `{$leaf: ...}` — inside a `repeat` template only: the matched variable's field.
export interface PanelLeafBinding {
  $leaf: "id" | "label" | "value"
}

export type PanelBindable<T> = T | PanelVarBinding | PanelLeafBinding
export type PanelTextValue = PanelBindable<PanelText>

export interface PanelMeterBlock {
  kind: "meter"
  label: PanelTextValue
  value: PanelBindable<number>
  min: PanelBindable<number>
  max: PanelBindable<number>
}

export interface PanelStatBlock {
  kind: "stat"
  label: PanelTextValue
  value: PanelBindable<number | string | boolean>
}

export interface PanelBadgeBlock {
  kind: "badge"
  label: PanelTextValue
  tone?: PanelBindable<UiBadgeTone>
}

export interface PanelTextBlock {
  kind: "text"
  text: PanelTextValue
  style?: UiTextStyle
}

export interface PanelDividerBlock {
  kind: "divider"
}

// v2.1 additive: every panel template block may carry `visible_when` — a condexpr
// condition the CLIENT evaluates against its own `state.variables` (see `condexpr.ts`).
// Absent means visible; an undecidable condition hides the block (fail-closed).
export interface PanelVisibility {
  visible_when?: string
}

// The panel form of `UiImageBlock`. Authors write a pack-relative `src` path; the
// server resolves it to this content-addressed triple at manifest build, so a panel
// can only ever point at a picture its own pack ships. No `$var` binding: the address
// is decided by the pack build, never by live state.
export interface PanelImageBlock {
  kind: "image"
  hash: string
  mime: string
  size: number
  caption?: PanelText
  alt?: PanelText
}

export interface PanelChoiceOption {
  id: string
  label: PanelTextValue
  // Picking this option sends a `panel_intent{kind:"choice", value: input}`.
  input: string
}

export interface PanelChoicesBlock {
  kind: "choices"
  prompt?: PanelTextValue
  options: PanelChoiceOption[]
}

// One instance per visible variable whose id starts with `prefix` (client-capped at
// MAX_PANEL_REPEAT_INSTANCES); `$leaf` bindings substitute inside. Does not nest.
export interface PanelRepeatBlock {
  repeat: {
    prefix: string
    block: PanelTemplateBlock
  }
}

// The panel forms of the M19 performance templates: every text field is localized,
// and `map_pin` resolves its map from an authored `src` path exactly like `image`.
export interface PanelLetterBlock {
  kind: "letter"
  body: PanelTextValue
  from?: PanelTextValue
  to?: PanelTextValue
  date?: PanelTextValue
}

export interface PanelClippingBlock {
  kind: "clipping"
  headline: PanelTextValue
  body: PanelTextValue
  source?: PanelTextValue
  date?: PanelTextValue
}

export interface PanelMapPinBlock {
  kind: "map_pin"
  hash: string
  mime: string
  size: number
  label: PanelTextValue
  x: PanelBindable<number>
  y: PanelBindable<number>
  note?: PanelTextValue
}

export interface PanelTitleCardBlock {
  kind: "title_card"
  title: PanelTextValue
  subtitle?: PanelTextValue
  act?: PanelTextValue
}

export type PanelTemplateBlock = PanelTemplateBlockKind & PanelVisibility

type PanelTemplateBlockKind =
  | PanelMeterBlock
  | PanelStatBlock
  | PanelBadgeBlock
  | PanelTextBlock
  | PanelDividerBlock
  | PanelChoicesBlock
  | PanelImageBlock
  | PanelLetterBlock
  | PanelClippingBlock
  | PanelMapPinBlock
  | PanelTitleCardBlock
  | PanelRepeatBlock

// Render-side cap on `repeat` expansion, mirrored from the server-side schema.
export const MAX_PANEL_REPEAT_INSTANCES = 32

export interface PanelAssetRef {
  // RELATIVE to the entry document's directory (each tier-2 panel is a self-contained
  // static root); fetch by `hash` over the media byte channel and verify before use.
  path: string
  hash: string
  size: number
  mime: string
}

export interface UiManifestPanel {
  // Wire id "<packId>/<panelId>" — the id `panel_event`/`panel_intent` frames carry.
  id: string
  title: PanelText
  slot: PanelSlot
  tier: 1 | 2
  // Tier 1 only.
  blocks?: PanelTemplateBlock[]
  // Tier 2 only: the entry document + its assets, content-addressed.
  entry?: { hash: string; size: number }
  assets?: PanelAssetRef[]
  // Tier 2 only: tier-1 blocks for clients that do not run panel code; an explicit
  // `null` means the author opted out (render a localized "rich client only" line).
  fallback?: PanelTemplateBlock[] | null
}

// Server→client, on join (after `state`) and after any `.panels` enable change.
// FULL-REPLACE: this viewer's complete panel list; empty = no panels.
export interface UiManifestFrame {
  type: typeof FrameType.UiManifest
  panels: UiManifestPanel[]
}

// Server→client: an opaque JSON payload a room hook emitted via `emitPanel(...)`,
// delivered only to viewers whose manifest contains `panel`.
export interface PanelEventFrame {
  type: typeof FrameType.PanelEvent
  panel: string
  payload: unknown
}

// Client→server: a panel interaction, routed server-side exactly as if this player
// typed it (`choice`/`input` verbatim; `roll` becomes a public `.r <value>`). The
// server refuses intents against panels outside the sender's own manifest.
export interface PanelIntentFrame {
  type: typeof FrameType.PanelIntent
  panel: string
  kind: PanelIntentKind
  value: string
}

// One vital meter (HP, sanity, mana, ...) as generic data: clients render the
// list without knowing any rule system's field names. Entries arrive in render
// order.
export interface ResourceState {
  id: string
  label: string
  value: number
  max?: number
}

export interface CharacterState {
  name: string
  system: string
  resources: ResourceState[]
  attributes: Record<string, unknown>
  status_effects: string[]
  avatar?: MediaRef
}

export interface PartyMember {
  name: string
  online: boolean
  active: boolean
  initiative?: number
  resources?: ResourceState[]
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

export type ModuleVariableKind = "number" | "bool" | "text" | "enum"

// v1.6 additive: one player-visible module/story variable (a "tracker": suspicion,
// doom, supplies, ...). Player connections only ever receive player-visible
// variables — keeper-only ones are filtered server-side, never here. `label`
// arrives already localized to the room locale. `min`/`max` apply to the "number"
// kind only and are present only when the variable is bounded.
export interface ModuleVariable {
  id: string
  label: string
  kind: ModuleVariableKind
  value: number | boolean | string
  min?: number
  max?: number
  // v1.7 additive (type added in v1.9 — servers have sent it since v1.7): on KEEPER
  // connections only, an imported-card (MVU) variable the keeper has not `.var expose`d
  // yet arrives flagged `hidden: true` so the keeper can watch module internals live.
  // A player connection never receives a hidden variable at all (filtered server-side);
  // clients should render hidden rows visually locked/dimmed, never as player data.
  hidden?: boolean
}

// v1.9 additive: one claimable pre-generated character from the module's cast
// (`.pc list` / `.pc claim` on the command surface). `claimed_by` is the claiming
// member's id, or "" while unclaimed. Public to every viewer.
export interface PregenEntry {
  name: string
  claimed_by: string
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
  // v1.6 additive: player-visible module variables in definition order (render as
  // received, do not sort). Absent — not an empty array — when the room has none;
  // an older server that never sends it still type-checks fine.
  variables?: ModuleVariable[]
  // v1.9 additive: the module's claimable pregen cast, insertion-ordered. Absent —
  // never an empty array — when the room has no roster (no world import landed one).
  pregens?: PregenEntry[]
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

// Scope of an in-place campaign restart (see AdminResetRoomFrame):
//  - "story": clear the story/progress only (keep characters, module, lore, media)
//  - "chars": also roll new characters (keep the module)
//  - "all":   erase everything (characters, module, lore, media, story)
// Room settings (language, house rules) and connections survive every scope.
export type AdminResetScope = "story" | "chars" | "all"

// In-place campaign restart: wipe part of this room's campaign state while keeping
// keystore keys and live connections — no backup, no key removal. Contrast
// AdminDeleteRoomData, which backs up and evicts.
export interface AdminResetRoomFrame {
  type: typeof FrameType.AdminResetRoom
  room: string
  scope?: AdminResetScope
}

// Keeper asks the server to run its configured self-update command and re-exec into the
// new code. No parameters: the command is server-side operator config, never client input.
export interface AdminUpdateServerFrame {
  type: typeof FrameType.AdminUpdateServer
}

// Server's reply to AdminUpdateServer. "restarting": the update succeeded and the server is
// re-execing (expect a brief disconnect + reconnect). "failed": the command ran but exited
// non-zero; `output` is the tail of its combined stdout/stderr for the keeper to inspect.
export interface AdminUpdateFrame {
  type: typeof FrameType.AdminUpdate
  status: "restarting" | "failed"
  output?: string
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
  // Present on a "reset" op: which scope was applied (see AdminResetScope).
  scope?: AdminResetScope
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
  // Optional UI-locale hint ("en" | "zh"): the server localizes skill display
  // metadata (`name-zh`/`description-zh` frontmatter) to it when present;
  // absent means the server's own locale applies. Additive — older servers
  // ignore it and reply with the server-locale list.
  locale?: string
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
  // Same optional locale hint as `AdminListSkillsFrame` — the post-toggle
  // refresh is localized to the requesting client's UI language.
  locale?: string
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
  | ListPackCardsFrame
  | PanelIntentFrame
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
  | AdminUpdateServerFrame
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
  | NarrativeDeltaFrame
  | PackCardsFrame
  | DiceFrame
  | UiFrame
  | UiManifestFrame
  | PanelEventFrame
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
  | AdminUpdateFrame

export type AnyFrame = ClientFrame | ServerFrame
