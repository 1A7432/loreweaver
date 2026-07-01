// Bumped from "1" -> "1.1" for the additive keeper-gated admin frames below.
// The bump is backward compatible: pre-admin clients keep working unchanged and
// simply never send/handle `admin_*` frames. `WelcomeFrame.protocol` is a plain
// string so a v1 client still accepts a "1.1" welcome (forward compatible).
export const PROTOCOL_VERSION = "1.1" as const

export const FrameType = {
  Join: "join",
  Input: "input",
  Ping: "ping",
  Welcome: "welcome",
  Error: "error",
  Narrative: "narrative",
  Dice: "dice",
  State: "state",
  Presence: "presence",
  System: "system",
  Pong: "pong",
  // v1.1 additive admin (keeper-gated) frames.
  AdminGetConfig: "admin_get_config",
  AdminSetModel: "admin_set_model",
  AdminListKeys: "admin_list_keys",
  AdminMintKey: "admin_mint_key",
  AdminConfig: "admin_config",
  AdminKeys: "admin_keys",
  AdminError: "admin_error",
} as const

export type FrameType = (typeof FrameType)[keyof typeof FrameType]

export type PlayerRole = "player" | "keeper"
export type NarrativeSpeaker = "kp" | "player" | "system" | "npc"
export type NarrativeFormat = "markdown" | "plain"
export type ErrorCode = "bad_key" | "bad_frame" | "rate_limited" | "server_error"
export type DiceKind = "roll" | "check" | "sanity" | "opposed" | "init"
export type SystemLevel = "info" | "warn"
export type AdminErrorCode = "forbidden" | "unknown_provider" | "bad_request"

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
}

export interface PartyMember {
  name: string
  online: boolean
  active: boolean
  initiative?: number
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

export interface StateFrame {
  type: typeof FrameType.State
  character?: CharacterState
  party: PartyMember[]
  scene?: SceneState
  clock?: ClockState
  initiative: InitiativeEntry[]
  online: number
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
}

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
}

export interface AdminListKeysFrame {
  type: typeof FrameType.AdminListKeys
}

export interface AdminMintKeyFrame {
  type: typeof FrameType.AdminMintKey
  room: string
  name?: string
  role?: PlayerRole
}

export interface AdminConfigFrame {
  type: typeof FrameType.AdminConfig
  provider: string
  chat_model: string
  base_url: string
  api_key_masked: string
  providers: string[]
  override_active: boolean
}

export interface AdminKeyInfo {
  key_masked: string
  room: string
  name: string
  role: PlayerRole
}

// The freshly minted key is returned ONCE, in cleartext, so the keeper can copy
// it; every other view (including `keys` here) only ever carries `key_masked`.
export interface MintedKey {
  key: string
  room: string
  name: string
  role: PlayerRole
}

export interface AdminKeysFrame {
  type: typeof FrameType.AdminKeys
  keys: AdminKeyInfo[]
  minted?: MintedKey
}

export interface AdminErrorFrame {
  type: typeof FrameType.AdminError
  code: AdminErrorCode
  message?: string
}

export type ClientFrame =
  | JoinFrame
  | InputFrame
  | PingFrame
  | AdminGetConfigFrame
  | AdminSetModelFrame
  | AdminListKeysFrame
  | AdminMintKeyFrame

export type ServerFrame =
  | WelcomeFrame
  | ErrorFrame
  | NarrativeFrame
  | DiceFrame
  | StateFrame
  | PresenceFrame
  | SystemFrame
  | PongFrame
  | AdminConfigFrame
  | AdminKeysFrame
  | AdminErrorFrame

export type AnyFrame = ClientFrame | ServerFrame
