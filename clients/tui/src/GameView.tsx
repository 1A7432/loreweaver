import { useEffect, useRef, useState } from "react"
import { useKeyboard, useTimeline } from "@opentui/react"
import type { InputRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import { FrameType, stripControlChars, type DiceFrame, type PresenceFrame, type ServerFrame, type StateFrame, type WelcomeFrame } from "@trpg-kp/protocol"
import { NarrativeLog, type LogFrame } from "./components/NarrativeLog"
import { PartyRoster } from "./components/PartyRoster"
import { ScenePanel } from "./components/ScenePanel"
import { StatusBar } from "./components/StatusBar"
import type { Palette, ThemeName } from "./themes"

// The game view needs only these three from the client. `WsClient` (and the
// shell's wider `AppClient`) satisfies it structurally; tests inject a mock.
// `close?` is optional and used only to stop the reconnect loop on a `bad_key`.
export interface GameClient {
  onMessage(cb: (frame: ServerFrame) => void): () => void
  sendInput(text: string): void
  close?(code?: number, reason?: string): void
}

export interface GameViewProps {
  client: GameClient
  welcome: WelcomeFrame
  theme: Palette
  themeName: ThemeName
}

// Cap a single streaming message so a hostile/runaway stream can't grow the
// merged text without bound (memory / render blowup).
const MAX_STREAM_TEXT = 20_000

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

function keyName(event: KeyEvent): string {
  return typeof event.name === "string" ? event.name.toLowerCase() : ""
}

function hasCtrl(event: KeyEvent): boolean {
  return Boolean(event.ctrl)
}

export function GameView({ client, welcome, theme, themeName }: GameViewProps) {
  const [presence, setPresence] = useState<PresenceFrame>()
  const [stateFrame, setStateFrame] = useState<StateFrame>({ type: FrameType.State, party: [], initiative: [], online: 0 })
  const [frames, setFrames] = useState<LogFrame[]>([])
  const [command, setCommand] = useState("")
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [inputVersion, setInputVersion] = useState(0)
  const [showHelp, setShowHelp] = useState(false)
  // True from the moment the player submits until the Keeper's reply lands, so the
  // narrative log can show an animated "构思中" liveness indicator meanwhile.
  const [kpWorking, setKpWorking] = useState(false)
  const [revealTicks, setRevealTicks] = useState(3)
  const [critFlash, setCritFlash] = useState(false)
  // Whether the party roster (vs the chat input) currently owns Enter — see
  // components/PartyRoster.tsx. Tab toggles it; the chat `<input>`'s own
  // `focused` prop below is kept the logical opposite so Enter is never
  // handled by both at once.
  const [rosterFocused, setRosterFocused] = useState(false)
  const scrollRef = useRef<ScrollBoxRenderable>(null)
  const inputRef = useRef<InputRenderable>(null)

  const diceTimeline = useTimeline({ duration: 360, loop: false, autoplay: false })

  useEffect(() => {
    return client.onMessage((frame) => {
      if (frame.type === FrameType.Presence) {
        setPresence(frame)
        return
      }
      if (frame.type === FrameType.State) {
        setStateFrame(frame)
        return
      }
      if (frame.type === FrameType.Narrative || frame.type === FrameType.Dice || frame.type === FrameType.System) {
        setFrames((current) => appendFrame(current, frame))
        // Clear the "Keeper is working" indicator once the reply actually lands. A
        // dice frame means the Keeper already acted; a `kp` narrative is the reply
        // itself — but it MAY stream, so a streaming chunk that isn't `done` yet is
        // still "working" (keep the spinner up until the terminal `done` chunk).
        if (frame.type === FrameType.Dice) setKpWorking(false)
        if (frame.type === FrameType.Narrative && frame.speaker === "kp" && (!frame.stream || frame.done)) {
          setKpWorking(false)
        }
        if (frame.type === FrameType.Dice) {
          setRevealTicks(0)
          diceTimeline.add(
            { tick: 0 },
            {
              tick: 3,
              duration: 360,
              onUpdate: (animation: { targets: Array<{ tick: number }> }) => {
                setRevealTicks(Math.round(animation.targets[0].tick))
              },
            },
          )
          if ((frame as DiceFrame).rank === 4) {
            setCritFlash(true)
            setTimeout(() => setCritFlash(false), 220)
          }
        }
        return
      }
      if (frame.type === FrameType.Error) {
        setFrames((current) => appendFrame(current, { type: FrameType.System, level: "warn", text: frame.message }))
        // An unrecognized key is a PERMANENT failure: stop the auto-reconnect loop so it
        // doesn't re-join and spam the same warning on every retry. Transient errors
        // (rate_limited, server_error, a malformed mid-session frame) keep the session.
        if (frame.code === "bad_key") {
          client.close?.()
        }
      }
    })
  }, [client, diceTimeline])

  const submit = (value?: string) => {
    const text = String(value ?? command).trim()
    if (!text) return
    client.sendInput(text)
    setKpWorking(true)
    // No optimistic local echo here: the TUI server always broadcasts the
    // player's own action back as a `narrative{speaker:"player"}` event (it
    // runs `run_turn` with `echo_exclude=None` — see gateway/turn.py — so a
    // solo terminal still sees its own echo, M4 behavior). Appending a local
    // frame here too used to double every submitted line; `onMessage` above
    // already renders the server's echo once it round-trips.
    setHistory((current) => [...current, text].slice(-50))
    setHistoryIndex(null)
    setCommand("")
    setInputVersion((current) => current + 1)
  }

  const recallHistory = (direction: -1 | 1) => {
    if (history.length === 0) return
    const nextIndex =
      historyIndex === null
        ? direction < 0
          ? history.length - 1
          : 0
        : Math.max(0, Math.min(history.length - 1, historyIndex + direction))
    setHistoryIndex(nextIndex)
    setCommand(history[nextIndex])
    if (inputRef.current) inputRef.current.value = history[nextIndex]
  }

  // Theme F-keys are owned globally by the App shell so a switch persists across
  // screens; this handler only covers game-view-local keys. It is installed only
  // while the game view is mounted, so it can't fight the menu's arrow handling.
  useKeyboard((event) => {
    const name = keyName(event)
    if (name === "?" || name === "slash") setShowHelp((value) => !value)
    if (name === "pageup") scrollRef.current?.scrollBy?.(-1, "viewport")
    if (name === "pagedown") scrollRef.current?.scrollBy?.(1, "viewport")
    if (name === "up") recallHistory(-1)
    if (name === "down") recallHistory(1)
    if (hasCtrl(event) && name === "l") setFrames([])
    // Tab moves focus to the roster (only worth it when there's an own character
    // to expand/collapse — otherwise Tab would blur the chat input with nothing
    // for the roster to do with it) and always back, so focus can never get
    // stranded off the input if a character disappears mid-session.
    if (name === "tab") {
      if (rosterFocused) setRosterFocused(false)
      else if (stateFrame.character) setRosterFocused(true)
    }
  })

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      {/* height=4 → 2 inner rows: exactly the height the `tiny` ascii-font needs,
          so its second row no longer bleeds into the border, and the status column
          gets its own two rows instead of collapsing both lines onto one. */}
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="TRPG KP" font="tiny" color={theme.accent} />
        <box flexDirection="column" marginLeft={2} justifyContent="center">
          <text fg={theme.accent}>joined {stripControlChars(welcome.room)}</text>
          {stateFrame.online > 0 ? <text fg={theme.dim}>{stateFrame.online} online</text> : null}
        </box>
      </box>

      <box flexDirection="row" flexGrow={1} minHeight={8}>
        <scrollbox
          ref={scrollRef}
          flexGrow={1}
          border
          borderColor={theme.border}
          stickyScroll
          stickyStart="bottom"
          viewportCulling={false}
        >
          <NarrativeLog frames={frames} theme={theme} revealTicks={revealTicks} critFlash={critFlash} kpWorking={kpWorking} />
        </scrollbox>

        <box width={32} flexDirection="column">
          <PartyRoster
            character={stateFrame.character}
            party={stateFrame.party}
            initiative={stateFrame.initiative}
            theme={theme}
            focused={rosterFocused}
            onFocus={() => setRosterFocused(true)}
          />
          <ScenePanel scene={stateFrame.scene} clock={stateFrame.clock} theme={theme} />
        </box>
      </box>

      <box height={3} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <text fg={theme.accent}>{"> "}</text>
        <input
          key={inputVersion}
          ref={inputRef}
          flexGrow={1}
          value={command}
          focused={!rosterFocused}
          placeholder="say or command"
          onInput={(value: string) => setCommand(value)}
          onSubmit={(value?: string) => submit(value)}
        />
      </box>

      {showHelp ? (
        <box border borderColor={theme.accent} paddingX={1} backgroundColor={theme.bg}>
          <text fg={theme.fg}>
            F1 lamplight · F2 df16 · F3 phosphor · F4 amber · F5 paperwhite · Esc menu · PgUp/PgDn scroll · Tab
            roster · Ctrl+L clear
          </text>
        </box>
      ) : null}

      <StatusBar welcome={welcome} presence={presence} online={stateFrame.online} theme={theme} themeName={themeName} />
    </box>
  )
}

export default GameView
