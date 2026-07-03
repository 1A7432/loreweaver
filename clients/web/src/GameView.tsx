import { useEffect, useMemo, useRef, useState } from "react"
import {
  FrameType,
  type PresenceFrame,
  type ServerFrame,
  type StateFrame,
  type WelcomeFrame,
} from "@loreweaver/protocol"
import { CharacterPanel } from "./components/CharacterPanel"
import { NarrativeLog, type LogFrame } from "./components/NarrativeLog"
import { PartyPanel } from "./components/PartyPanel"
import { ScenePanel } from "./components/ScenePanel"
import { StatusBar } from "./components/StatusBar"
import { applyTheme, DEFAULT_THEME, type ThemeName } from "./themes"

export interface GameClient {
  onMessage(cb: (frame: ServerFrame) => void): () => void
  sendInput(text: string): void
}

export interface GameViewProps {
  client: GameClient
  welcome: WelcomeFrame
}

const EMPTY_STATE: StateFrame = {
  type: FrameType.State,
  party: [],
  initiative: [],
  online: 0,
}

// Cap a single streaming message so a hostile/runaway stream can't grow the
// merged text without bound (memory / render blowup).
const MAX_STREAM_TEXT = 20_000

// Merge streaming narrative chunks (same id) in place; otherwise append and cap
// the log so it can't grow unbounded. Mirrors the OpenTUI client.
function appendFrame(frames: LogFrame[], frame: LogFrame): LogFrame[] {
  if (frame.type !== FrameType.Narrative || !frame.stream) return [...frames, frame].slice(-200)
  const next = [...frames]
  const index = next.findIndex((item) => item.type === FrameType.Narrative && item.id === frame.id)
  if (index === -1) return [...next, frame].slice(-200)
  const existing = next[index]
  if (existing.type !== FrameType.Narrative) return [...next, frame].slice(-200)
  next[index] = { ...existing, text: (existing.text + frame.text).slice(0, MAX_STREAM_TEXT), done: frame.done }
  return next
}

export function GameView({ client, welcome }: GameViewProps) {
  const [theme, setTheme] = useState<ThemeName>(DEFAULT_THEME)
  const [frames, setFrames] = useState<LogFrame[]>([])
  const [stateFrame, setStateFrame] = useState<StateFrame>(EMPTY_STATE)
  const [presence, setPresence] = useState<PresenceFrame>()
  const [command, setCommand] = useState("")
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const narrativeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    return client.onMessage((frame) => {
      switch (frame.type) {
        case FrameType.State:
          setStateFrame(frame)
          return
        case FrameType.Presence:
          setPresence(frame)
          return
        case FrameType.Narrative:
        case FrameType.Dice:
        case FrameType.System:
          setFrames((current) => appendFrame(current, frame))
          return
        case FrameType.Error:
          setFrames((current) =>
            appendFrame(current, { type: FrameType.System, level: "warn", text: frame.message }),
          )
          return
        default:
          return
      }
    })
  }, [client])

  // Keep the narrative log pinned to the newest entry.
  useEffect(() => {
    const el = narrativeRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [frames])

  const online = useMemo(() => presence?.online ?? stateFrame.online, [presence, stateFrame.online])

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const text = command.trim()
    if (!text) return
    client.sendInput(text)
    // No optimistic local echo here: per docs/protocol.md (turn flow step 3)
    // the server always broadcasts the player's own action back as a
    // `narrative{speaker:"player"}` frame, including to the sender. Appending
    // a local frame here too used to double every submitted line; `onMessage`
    // above already renders the server's echo once it round-trips. Mirrors
    // the OpenTUI client (clients/tui/src/GameView.tsx).
    setHistory((current) => [...current, text].slice(-50))
    setHistoryIndex(null)
    setCommand("")
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    if (history.length === 0) return
    event.preventDefault()
    const direction = event.key === "ArrowUp" ? -1 : 1
    const nextIndex =
      historyIndex === null
        ? direction < 0
          ? history.length - 1
          : 0
        : Math.max(0, Math.min(history.length - 1, historyIndex + direction))
    setHistoryIndex(nextIndex)
    setCommand(history[nextIndex])
  }

  return (
    <div className="game">
      <header className="game-header">
        <span className="game-brand">TRPG KP</span>
        <span className="game-header-meta">
          joined {welcome.room} as {welcome.you.name} · {welcome.you.role}
        </span>
      </header>

      <div className="game-body">
        <main className="narrative" ref={narrativeRef} aria-label="Narrative log">
          <NarrativeLog frames={frames} />
        </main>
        <aside className="rail">
          <CharacterPanel character={stateFrame.character} />
          <PartyPanel party={stateFrame.party} initiative={stateFrame.initiative} />
          <ScenePanel scene={stateFrame.scene} clock={stateFrame.clock} />
        </aside>
      </div>

      <form className="command" onSubmit={submit}>
        <span className="prompt">&gt;</span>
        <input
          aria-label="Command input"
          placeholder="say something or type a command"
          value={command}
          autoFocus
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit">Send</button>
      </form>

      <StatusBar welcome={welcome} online={online} theme={theme} onThemeChange={setTheme} />
    </div>
  )
}

export default GameView
