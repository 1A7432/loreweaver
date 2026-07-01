import { useEffect, useMemo, useRef, useState } from "react"
import { useKeyboard, useTerminalDimensions, useTimeline } from "@opentui/react"
import type { InputRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import { FrameType, type DiceFrame, type PresenceFrame, type ServerFrame, type StateFrame, type WelcomeFrame } from "@trpg-kp/protocol"
import { CharacterPanel } from "./components/CharacterPanel"
import { NarrativeLog, type LogFrame } from "./components/NarrativeLog"
import { PartyPanel } from "./components/PartyPanel"
import { ScenePanel } from "./components/ScenePanel"
import { StatusBar } from "./components/StatusBar"
import { themeOrder, themes, type ThemeName } from "./themes"

export interface AppClient {
  onMessage(cb: (frame: ServerFrame) => void): () => void
  sendInput(text: string): void
}

export interface AppProps {
  client: AppClient
}

function appendFrame(frames: LogFrame[], frame: LogFrame): LogFrame[] {
  if (frame.type !== FrameType.Narrative || !frame.stream) return [...frames, frame].slice(-200)
  const next = [...frames]
  const index = next.findIndex((item) => item.type === FrameType.Narrative && item.id === frame.id)
  if (index === -1) return [...next, frame].slice(-200)
  const existing = next[index]
  if (existing.type !== FrameType.Narrative) return [...next, frame].slice(-200)
  next[index] = { ...existing, text: existing.text + frame.text, done: frame.done }
  return next
}

function keyName(event: KeyEvent): string {
  return typeof event.name === "string" ? event.name.toLowerCase() : ""
}

function hasCtrl(event: KeyEvent): boolean {
  return Boolean(event.ctrl)
}

export function App({ client }: AppProps) {
  const [themeName, setThemeName] = useState<ThemeName>("df16")
  const theme = themes[themeName]
  const [welcome, setWelcome] = useState<WelcomeFrame>()
  const [presence, setPresence] = useState<PresenceFrame>()
  const [stateFrame, setStateFrame] = useState<StateFrame>({ type: FrameType.State, party: [], initiative: [], online: 0 })
  const [frames, setFrames] = useState<LogFrame[]>([])
  const [command, setCommand] = useState("")
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [inputVersion, setInputVersion] = useState(0)
  const [showHelp, setShowHelp] = useState(false)
  const [bootStep, setBootStep] = useState(0)
  const [revealTicks, setRevealTicks] = useState(3)
  const [critFlash, setCritFlash] = useState(false)
  const scrollRef = useRef<ScrollBoxRenderable>(null)
  const inputRef = useRef<InputRenderable>(null)
  const dimensions = useTerminalDimensions()

  const bootTimeline = useTimeline({ duration: 450, loop: false, autoplay: false })
  const diceTimeline = useTimeline({ duration: 360, loop: false, autoplay: false })

  useEffect(() => {
    const steps = [0, 1, 2, 3]
    for (const step of steps) {
      setTimeout(() => setBootStep(step), step * 120)
    }
    bootTimeline.add(
      { value: 0 },
      {
        value: 1,
        duration: 450,
        onUpdate: () => undefined,
      },
    )
  }, [])

  useEffect(() => {
    return client.onMessage((frame) => {
      if (frame.type === FrameType.Welcome) {
        setWelcome(frame)
        return
      }
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
      }
    })
  }, [client, diceTimeline])

  const submit = (value?: string) => {
    const text = String(value ?? command).trim()
    if (!text) return
    client.sendInput(text)
    setFrames((current) =>
      appendFrame(current, {
        type: FrameType.Narrative,
        id: `local-${Date.now()}`,
        speaker: "player",
        name: welcome?.you.name ?? "You",
        text,
        format: "plain",
      }),
    )
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

  useKeyboard((event) => {
    const name = keyName(event)
    if (name === "f1") setThemeName("df16")
    if (name === "f2") setThemeName("phosphor")
    if (name === "f3") setThemeName("amber")
    if (name === "f4") setThemeName("paperwhite")
    if (name === "?" || name === "slash") setShowHelp((value) => !value)
    if (name === "pageup") scrollRef.current?.scrollBy?.(-1, "viewport")
    if (name === "pagedown") scrollRef.current?.scrollBy?.(1, "viewport")
    if (name === "up") recallHistory(-1)
    if (name === "down") recallHistory(1)
    if (hasCtrl(event) && name === "l") setFrames([])
  })

  const bootText = useMemo(() => {
    const dots = ".".repeat(bootStep % 4)
    return `CONNECTING TO KEEPER${dots}`
  }, [bootStep])

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={3} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="TRPG KP" font="tiny" color={theme.accent} />
        <box flexDirection="column" marginLeft={2}>
          <text fg={theme.accent}>{bootText}</text>
          <text fg={theme.dim}>
            {dimensions.width}x{dimensions.height} · {welcome ? `joined ${welcome.room}` : "mock/server pending"}
          </text>
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
          <NarrativeLog frames={frames} theme={theme} revealTicks={revealTicks} critFlash={critFlash} />
        </scrollbox>

        <box width={32} flexDirection="column">
          <CharacterPanel character={stateFrame.character} theme={theme} />
          <PartyPanel party={stateFrame.party} initiative={stateFrame.initiative} theme={theme} />
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
          focused
          placeholder="say or command"
          onInput={(value: string) => setCommand(value)}
          onSubmit={(value?: string) => submit(value)}
        />
      </box>

      {showHelp ? (
        <box border borderColor={theme.accent} paddingX={1} backgroundColor={theme.bg}>
          <text fg={theme.fg}>F1 df16 · F2 phosphor · F3 amber · F4 paperwhite · PgUp/PgDn scroll · Ctrl+L clear</text>
        </box>
      ) : null}

      <StatusBar welcome={welcome} presence={presence} online={stateFrame.online} theme={theme} themeName={themeName} />
    </box>
  )
}

export default App

