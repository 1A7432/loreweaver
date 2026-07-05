import { useEffect, useRef, useState } from "react"
import { useKeyboard, useTimeline } from "@opentui/react"
import type { InputRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import {
  FrameType,
  type ConnectionStatus,
  type DiceFrame,
  type MediaFrame,
  type MediaPayload,
  type MediaUpload,
  type PresenceFrame,
  type ServerFrame,
  type StateFrame,
  type WelcomeFrame,
} from "@loreweaver/protocol"
import { HeaderBar } from "./components/HeaderBar"
import { NarrativeLog, type LogFrame } from "./components/NarrativeLog"
import { PartyRoster } from "./components/PartyRoster"
import { ScenePanel } from "./components/ScenePanel"
import { StatusBar } from "./components/StatusBar"
import { tt } from "./i18n"
import { viewImage, type RendererLike } from "./imageViewer"
import { droppedImagePath, openMedia, readAudioUpload, readUpload, type HalfBlockLine } from "./media"
import type { Palette, ThemeName } from "./themes"

// The game view needs only these three from the client. `WsClient` (and the
// shell's wider `AppClient`) satisfies it structurally; tests inject a mock.
// `close?` is optional and used only to stop the reconnect loop on a `bad_key`.
export interface GameClient {
  onMessage(cb: (frame: ServerFrame) => void): () => void
  sendInput(text: string): void
  uploadMedia(upload: MediaUpload): Promise<MediaFrame | undefined>
  getMedia(hash: string): Promise<MediaPayload>
  setAvatar(hash: string): void
  close?(code?: number, reason?: string): void
}

export interface GameViewProps {
  client: GameClient
  welcome: WelcomeFrame
  theme: Palette
  themeName: ThemeName
  // The room log already accumulated by the shell (App) before this view mounted
  // — the join-time history replay + anything that arrived while on the menu. The
  // server delivers those frames right after `welcome`, long before the player
  // opens the game view, so without seeding here they'd be lost. Seeds the local
  // log ONCE on mount; live frames from here on are appended by `onMessage` below.
  initialFrames?: LogFrame[]
  // Threaded from the shell's `client.onStatus?.(...)` subscription (App.tsx); undefined when
  // the client doesn't implement `onStatus` — the HeaderBar then renders no indicator at all.
  connectionStatus?: ConnectionStatus
  renderer?: RendererLike
}

// Cap a single streaming message so a hostile/runaway stream can't grow the
// merged text without bound (memory / render blowup).
const MAX_STREAM_TEXT = 20_000

export function appendFrame(frames: LogFrame[], frame: LogFrame): LogFrame[] {
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

export function GameView({ client, welcome, theme, themeName, initialFrames, connectionStatus, renderer }: GameViewProps) {
  const locale = welcome.locale
  const [presence, setPresence] = useState<PresenceFrame>()
  const [stateFrame, setStateFrame] = useState<StateFrame>({ type: FrameType.State, party: [], initiative: [], online: 0 })
  const [frames, setFrames] = useState<LogFrame[]>(() => initialFrames ?? [])
  const [command, setCommand] = useState("")
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [inputVersion, setInputVersion] = useState(0)
  const [showHelp, setShowHelp] = useState(false)
  const [selectedMedia, setSelectedMedia] = useState<MediaFrame | undefined>()
  const [viewerLines, setViewerLines] = useState<HalfBlockLine[] | undefined>()
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
      if (
        frame.type === FrameType.Narrative ||
        frame.type === FrameType.Dice ||
        frame.type === FrameType.System ||
        frame.type === FrameType.Media ||
        frame.type === FrameType.AudioLibraryItem ||
        frame.type === FrameType.AudioControl
      ) {
        setFrames((current) => appendFrame(current, frame))
        if (frame.type === FrameType.Media) setSelectedMedia(frame)
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
    if (!text) {
      if (selectedMedia) {
        void openSelectedMedia(false)
      }
      return
    }
    if (text.startsWith("/attach ")) {
      void attachMedia(text.slice("/attach ".length).trim())
      return
    }
    if (text.startsWith("/audio ")) {
      void attachAudio(text.slice("/audio ".length).trim())
      return
    }
    if (text.startsWith("/avatar ")) {
      void attachAvatar(text.slice("/avatar ".length).trim())
      return
    }
    const droppedImage = droppedImagePath(text)
    if (droppedImage) {
      void attachMedia(droppedImage)
      return
    }
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

  const openSelectedMedia = async (forceSystem: boolean) => {
    if (!selectedMedia) return
    try {
      const lines = forceSystem
        ? await openMedia(client, selectedMedia).then(() => undefined)
        : await viewImage({ client, media: selectedMedia, renderer, locale })
      setViewerLines(lines)
    } catch (error) {
      setFrames((current) =>
        appendFrame(current, { type: FrameType.System, level: "warn", text: error instanceof Error ? error.message : String(error) }),
      )
    }
  }

  const attachMedia = async (path: string) => {
    if (!path) return
    setFrames((current) => appendFrame(current, { type: FrameType.System, level: "info", text: tt(locale, "media.uploading") }))
    try {
      const upload = await readUpload(path)
      if (!upload.mime) throw new Error(tt(locale, "media.unsupported"))
      await client.uploadMedia(upload)
      setFrames((current) => appendFrame(current, { type: FrameType.System, level: "info", text: tt(locale, "media.uploaded", { name: upload.name }) }))
      setHistory((current) => [...current, `/attach ${path}`].slice(-50))
      setHistoryIndex(null)
      setCommand("")
      setInputVersion((current) => current + 1)
    } catch (error) {
      setFrames((current) =>
        appendFrame(current, { type: FrameType.System, level: "warn", text: error instanceof Error ? error.message : String(error) }),
      )
    }
  }

  const attachAudio = async (path: string) => {
    if (!path) return
    setFrames((current) => appendFrame(current, { type: FrameType.System, level: "info", text: tt(locale, "audio.uploading") }))
    try {
      const upload = await readAudioUpload(path)
      if (!upload.mime) throw new Error(tt(locale, "audio.unsupported"))
      await client.uploadMedia(upload)
      setFrames((current) => appendFrame(current, { type: FrameType.System, level: "info", text: tt(locale, "audio.uploaded", { name: upload.name }) }))
      setHistory((current) => [...current, `/audio ${path}`].slice(-50))
      setHistoryIndex(null)
      setCommand("")
      setInputVersion((current) => current + 1)
    } catch (error) {
      setFrames((current) =>
        appendFrame(current, { type: FrameType.System, level: "warn", text: error instanceof Error ? error.message : String(error) }),
      )
    }
  }

  const attachAvatar = async (path: string) => {
    if (!path) return
    setFrames((current) => appendFrame(current, { type: FrameType.System, level: "info", text: tt(locale, "avatar.uploading") }))
    try {
      const upload = await readUpload(path)
      if (!upload.mime) throw new Error(tt(locale, "media.unsupported"))
      await client.uploadMedia(upload)
      client.setAvatar(upload.sha256)
      setFrames((current) => appendFrame(current, { type: FrameType.System, level: "info", text: tt(locale, "avatar.uploaded", { name: upload.name }) }))
      setHistory((current) => [...current, `/avatar ${path}`].slice(-50))
      setHistoryIndex(null)
      setCommand("")
      setInputVersion((current) => current + 1)
    } catch (error) {
      setFrames((current) =>
        appendFrame(current, { type: FrameType.System, level: "warn", text: error instanceof Error ? error.message : String(error) }),
      )
    }
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
    if (selectedMedia && (name === "o" || name === "O")) void openSelectedMedia(true)
    if (viewerLines && (name === "escape" || name === "q" || name === "return" || name === "enter")) setViewerLines(undefined)
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
      <HeaderBar
        welcome={welcome}
        scene={stateFrame.scene}
        clock={stateFrame.clock}
        usage={stateFrame.usage}
        online={stateFrame.online}
        theme={theme}
        locale={locale}
        connectionStatus={connectionStatus}
      />

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
          <NarrativeLog
            frames={frames}
            theme={theme}
            revealTicks={revealTicks}
            critFlash={critFlash}
            kpWorking={kpWorking}
            locale={locale}
            client={client}
            selectedMediaHash={selectedMedia?.hash}
            onSelectMedia={setSelectedMedia}
          />
        </scrollbox>

        <box width={32} flexDirection="column">
          <PartyRoster
            character={stateFrame.character}
            party={stateFrame.party}
            initiative={stateFrame.initiative}
            theme={theme}
            locale={locale}
            client={client}
            focused={rosterFocused}
            onFocus={() => setRosterFocused(true)}
          />
          <ScenePanel scene={stateFrame.scene} clock={stateFrame.clock} theme={theme} locale={locale} />
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
          placeholder={tt(locale, "game.placeholder")}
          onInput={(value: string) => setCommand(value)}
          onSubmit={(value?: string) => submit(value)}
        />
      </box>

      {showHelp ? (
        <box border borderColor={theme.accent} paddingX={1} backgroundColor={theme.bg}>
          <text fg={theme.fg}>
            {tt(locale, "game.help")}
          </text>
        </box>
      ) : null}

      {viewerLines ? (
        <box position="absolute" top={1} left={2} right={2} bottom={1} flexDirection="column" border borderColor={theme.accent} backgroundColor={theme.bg} paddingX={1}>
          <text fg={theme.accent}>{tt(locale, "viewer.close")}</text>
          {viewerLines.map((line, row) => (
            <box key={`viewer-${row}`} flexDirection="row">
              {line.cells.map((cell, col) => (
                <text key={`viewer-${row}-${col}`} fg={cell.fg} bg={cell.bg}>
                  {cell.char}
                </text>
              ))}
            </box>
          ))}
        </box>
      ) : null}

      <StatusBar welcome={welcome} presence={presence} online={stateFrame.online} theme={theme} themeName={themeName} />
    </box>
  )
}

export default GameView
