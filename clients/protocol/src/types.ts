export const PROTOCOL_VERSION = "1" as const

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
} as const

export type FrameType = (typeof FrameType)[keyof typeof FrameType]

export type PlayerRole = "player" | "keeper"
export type NarrativeSpeaker = "kp" | "player" | "system" | "npc"
export type NarrativeFormat = "markdown" | "plain"
export type ErrorCode = "bad_key" | "bad_frame" | "rate_limited" | "server_error"
export type DiceKind = "roll" | "check" | "sanity" | "opposed" | "init"
export type SystemLevel = "info" | "warn"

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
  protocol: typeof PROTOCOL_VERSION
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

export type ClientFrame = JoinFrame | InputFrame | PingFrame

export type ServerFrame =
  | WelcomeFrame
  | ErrorFrame
  | NarrativeFrame
  | DiceFrame
  | StateFrame
  | PresenceFrame
  | SystemFrame
  | PongFrame

export type AnyFrame = ClientFrame | ServerFrame
