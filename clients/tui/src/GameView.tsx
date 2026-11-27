import { useEffect, useMemo, useRef, useState } from "react"
import { useKeyboard, useTerminalDimensions, useTimeline } from "@opentui/react"
import type { InputRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import { stripControlChars } from "loreweaver-protocol/v3"
import { HeaderBar, type LinkStatus } from "./components/HeaderBar"
import { NarrativeLog } from "./components/NarrativeLog"
import { hasChoices, panelSections, PanelsPanel, viewValues } from "./components/PanelsPanel"
import { PartyRoster, freeClaimables } from "./components/PartyRoster"
import { PictureViewer } from "./components/PictureViewer"
import { ScenePanel } from "./components/ScenePanel"
import { ShareForm } from "./components/ShareForm"
import { StatusBar } from "./components/StatusBar"
import type { UiChoice } from "./components/UiBlocks"
import { VariablesPanel } from "./components/VariablesPanel"
import { audioLine, type AudioController } from "./audio"
import type { Connection, ConnectionState } from "./connection"
import { useAudioState, useConnectionState, usePanelViews, useSnapshot, viewData } from "./hooks"
import { tt, type MessageKey } from "./i18n"
import { CHAT_INPUT_LIMIT, inputLimitState } from "./inputLimits"
import { sidebarCollapsed, sidebarWidth } from "./layout"
import { lastChoicesIndex, logItems, logPictures, type Cleared, type Picture } from "./log"
import type { Palette, ThemeName } from "./themes"
import { usesAppClipboardCopy } from "./copy"
import { reportOffer, saveReport } from "./report"
import { keepSavedResult, saveRoom } from "./save"
import { writeTranscript } from "./transcript"
import type { PanelEntry, Result, SessionSnapshot } from "loreweaver-protocol/v3"

const NO_PANELS: readonly PanelEntry[] = []

export interface GameViewProps {
  connection: Connection
  /** This client's language (the room's may differ: events are in the room's). */
  locale: string
  theme: Palette
  themeName: ThemeName
  // Transient confirmation for a Ctrl+C clipboard copy. The App shell owns that key (the same
  // press means quit when nothing is selected), so the outcome is handed down.
  copyNotice?: string
  // Selects the copy hint in the help line: macOS copies with the terminal's own Cmd+C,
  // everywhere else with the in-app Ctrl+C. See `copy.ts`.
  platform?: string
  // Injected by tests so an export can be asserted without touching `~/.loreweaver/transcripts`.
  transcriptDir?: string
  // Likewise for a report page (`~/.loreweaver/reports`).
  reportDir?: string
  // Likewise for a room save (`~/.loreweaver/saves`).
  saveDir?: string
  /** Open the command list (F7). */
  onCommands?: () => void
  /** A picture or the share form opened (true) or closed: while one is open, Esc is theirs, not the shell's. */
  onModalChange?: (open: boolean) => void
  /** The environment a picture's graphics protocol is chosen from; tests hand in `{}`. */
  pictureEnv?: Record<string, string | undefined>
  /** Whether a picture may use the terminal's own graphics (kitty, iTerm2, sixel); tests turn it off. */
  pictureGraphics?: boolean
  /** The room's sound, for the header's line (muted, no player); absent: no local marks. */
  audio?: AudioController
}

/** The link as the header shows it. */
export function linkStatus(snapshot: SessionSnapshot, state: ConnectionState): LinkStatus {
  if (snapshot.status === "ended" || state.phase === "ended") return "offline"
  if (snapshot.status === "online" && state.phase === "online") return "online"
  return "reconnecting"
}

const ACTIVITY_KEYS: ReadonlyMap<string, MessageKey> = new Map<string, MessageKey>([
  ["reading", "log.activity.reading"],
  ["dice", "log.activity.dice"],
  ["cast", "log.activity.cast"],
  ["bookkeeping", "log.activity.bookkeeping"],
])

function keyName(event: KeyEvent): string {
  return typeof event.name === "string" ? event.name.toLowerCase() : ""
}

/** Member names by id, from the `party` view: who shared a file. */
function memberNames(party: { members: { id: string; name: string }[] } | null): ReadonlyMap<string, string> {
  return new Map((party?.members ?? []).map((member) => [member.id, member.name]))
}

export function GameView({ connection, locale, theme, themeName, copyNotice, platform = process.platform, transcriptDir, reportDir, saveDir, onCommands, onModalChange, pictureEnv, pictureGraphics = true, audio }: GameViewProps) {
  const snapshot = useSnapshot(connection)
  const local = useConnectionState(connection)
  const sound = useAudioState(audio)
  const { width: terminalWidth } = useTerminalDimensions()
  const narrow = sidebarCollapsed(terminalWidth)
  const room = snapshot.welcome?.room.id ?? ""
  const me = viewData(snapshot, "me")
  const party = viewData(snapshot, "party")
  const characters = viewData(snapshot, "characters")
  const online = (party?.members ?? []).filter((member) => member.online).length
  const panels = viewData(snapshot, "panels")?.panels ?? NO_PANELS
  usePanelViews(connection, panels)
  const sections = useMemo(() => panelSections(panels, viewValues(snapshot.views)), [panels, snapshot.views])
  // Panels whose choices Tab can put the keys on, in sidebar order.
  const panelStops = sections.filter(hasChoices).map((section) => `panel:${section.id}`)

  const [cleared, setCleared] = useState<Cleared | null>(null)
  const [command, setCommand] = useState("")
  const [inputError, setInputError] = useState<string>()
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [inputVersion, setInputVersion] = useState(0)
  const [showHelp, setShowHelp] = useState(false)
  const [revealSeq, setRevealSeq] = useState<number>()
  const [revealTicks, setRevealTicks] = useState(3)
  const [critFlash, setCritFlash] = useState(false)
  // Whether the party roster / the latest choices select (vs the chat input) owns Enter. Tab
  // cycles; the chat `<input>`'s own `focused` prop is kept the logical opposite.
  const [rosterFocused, setRosterFocused] = useState(false)
  const [choicesFocused, setChoicesFocused] = useState(false)
  // The panel whose choices own the arrows and Enter, or null (see Tab below).
  const [panelFocus, setPanelFocus] = useState<string | null>(null)
  const [narrowSidebarOpen, setNarrowSidebarOpen] = useState(false)
  // Pictures: Tab puts the arrows on them, Enter (or a click) shows one; F8 opens the share form.
  const [picturesFocused, setPicturesFocused] = useState(false)
  const [pictureKey, setPictureKey] = useState<string | null>(null)
  const [viewing, setViewing] = useState<Picture | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const scrollRef = useRef<ScrollBoxRenderable>(null)
  const inputRef = useRef<InputRenderable>(null)
  // Narratives that replaced a draft streamed in front of this player (see NarrativeLog).
  const streamed = useRef(new Set<string>())
  for (const draft of snapshot.drafts) streamed.current.add(draft.id)

  const items = useMemo(() => logItems(snapshot.events, snapshot.drafts, local.lines, cleared), [snapshot.events, snapshot.drafts, local.lines, cleared])
  const diceTimeline = useTimeline({ duration: 360, loop: false, autoplay: false })
  const showSidebar = !narrow || narrowSidebarOpen
  const inputState = inputLimitState(command)
  const logChoices = lastChoicesIndex(items) !== -1
  const pictures = useMemo(() => logPictures(items), [items])
  const names = useMemo(() => memberNames(party), [party])
  const selectedPicture = pictures.find((picture) => picture.key === pictureKey) ?? pictures.at(-1)
  const modal = viewing !== null || shareOpen
  const rosterFocusable = Boolean(me?.character) || freeClaimables(characters).length > 0
  const turn = snapshot.turn
  const busy = turn?.status === "busy"
  const working = busy || local.pending > 0
  const workingLabel =
    turn?.status === "busy"
      ? `${tt(locale, "log.workingFor", { actor: stripControlChars(turn.actor) })}${turn.activity ? ` · ${tt(locale, ACTIVITY_KEYS.get(turn.activity) ?? "log.working")}` : ""}`
      : tt(locale, "log.working")
  const topHint = cleared ? tt(locale, "log.clearedHint") : snapshot.gap !== null || !snapshot.complete ? tt(locale, "log.olderHint") : undefined

  useEffect(() => {
    if (!showSidebar) setRosterFocused(false)
  }, [showSidebar])

  // When the last choices block leaves the log, focus falls back to the chat input.
  useEffect(() => {
    if (!logChoices) setChoicesFocused(false)
  }, [logChoices])
  useEffect(() => {
    if (pictures.length === 0) setPicturesFocused(false)
  }, [pictures.length])
  // A focused panel that left the sidebar (switched off, its choices hidden) gives focus back.
  useEffect(() => {
    if (panelFocus !== null && (!showSidebar || !panelStops.includes(`panel:${panelFocus}`))) setPanelFocus(null)
  }, [panelStops.join("\n"), showSidebar])

  useEffect(() => {
    onModalChange?.(modal)
  }, [modal])
  useEffect(() => () => onModalChange?.(false), [])

  const openPicture = (key: string) => {
    const picture = pictures.find((entry) => entry.key === key)
    if (!picture) return
    setPictureKey(key)
    setViewing(picture)
  }

  const movePicture = (direction: -1 | 1) => {
    if (pictures.length === 0) return
    const at = selectedPicture ? pictures.indexOf(selectedPicture) : pictures.length - 1
    const next = pictures[Math.max(0, Math.min(pictures.length - 1, at + direction))]
    if (next) setPictureKey(next.key)
  }

  // The dice reveal: the newest roll that arrives while this view is open tumbles, then settles;
  // a critical flashes. Rolls already in the log when the view opened do not animate.
  let latestDice: number | undefined
  for (let index = snapshot.events.length - 1; index >= 0; index -= 1) {
    const event = snapshot.events[index]
    if (event?.kind === "dice") {
      latestDice = event.seq
      break
    }
  }
  const seenDice = useRef<{ ready: boolean; seq?: number }>({ ready: false })
  useEffect(() => {
    const previous = seenDice.current
    seenDice.current = { ready: true, seq: latestDice ?? previous.seq }
    if (!previous.ready || latestDice === undefined) return
    if (previous.seq !== undefined && latestDice <= previous.seq) return
    setRevealSeq(latestDice)
    setRevealTicks(0)
    diceTimeline.items.length = 0
    diceTimeline.add(
      { tick: 0 },
      {
        tick: 3,
        duration: 360,
        onUpdate: (animation: { targets: Array<{ tick: number }> }) => setRevealTicks(Math.round(animation.targets[0].tick)),
      },
    )
    diceTimeline.restart()
    const event = snapshot.events.find((entry) => entry.seq === latestDice)
    if (event?.kind === "dice" && event.data.outcome?.critical) {
      setCritFlash(true)
      const id = setTimeout(() => setCritFlash(false), 220)
      return () => clearTimeout(id)
    }
  }, [latestDice])

  const resetInput = () => {
    setHistoryIndex(null)
    setCommand("")
    setInputError(undefined)
    setInputVersion((current) => current + 1)
  }

  const submit = (value?: string) => {
    const raw = String(value ?? command)
    if (inputLimitState(raw).atLimit) {
      setInputError(tt(locale, "game.inputAtLimit", { limit: CHAT_INPUT_LIMIT }))
      return
    }
    const text = raw.trim()
    if (!text) return
    // No local echo: the server logs the player's own line as a `narrative` event for everyone,
    // this player included. A command's answer comes back to this player alone, as a local line.
    void connection.input(text).then(keepResult)
    setHistory((current) => [...current, text].slice(-50))
    resetInput()
  }

  const pickChoice = (option: UiChoice) => {
    setChoicesFocused(false)
    setPanelFocus(null)
    void connection.runCommand(option.command, option.args ?? {}).then(keepResult)
  }

  const claim = (id: string) => {
    void connection.runCommand("pc", { op: "claim", name: id })
  }

  // Older history on demand: at the top of the log, PgUp (or the wheel) brings the hidden lines
  // back after a Ctrl+L, else loads the page before the oldest event held (or the gap a resume
  // could not replay).
  const loadOlder = () => {
    if ((scrollRef.current?.scrollTop ?? 0) > 0) return
    if (cleared) {
      setCleared(null)
      return
    }
    const current = connection.session.getSnapshot()
    if (current.gap !== null || !current.complete) void connection.session.loadOlder().catch(() => 0)
  }

  // A `report html` answer names a page, it does not carry it: fetch it now (the next page of
  // its edition replaces it on the server) and keep it as a file.
  const keepReport = async (result: Result | null) => {
    const offer = reportOffer(result)
    if (offer === null) return
    try {
      const file = await connection.fetchMedia(offer.hash, { mime: "text/html", name: offer.name }, { hold: false })
      const path = await saveReport(offer, file.bytes, reportDir)
      connection.note({ kind: "result", level: "info", text: tt(locale, "report.saved", { path }) })
    } catch (error) {
      connection.note({ kind: "result", level: "warn", text: tt(locale, "report.failed", { error: error instanceof Error ? error.message : String(error) }) })
    }
  }

  // A `save` answer carries the whole room (every secret of it) in its data: whatever command it
  // came from, it is written to a private file and only the path is told — the bundle itself is
  // in no local line, no transcript.
  const noteSave = (outcome: { ok: boolean; text: string }) => {
    connection.note({ kind: "result", level: outcome.ok ? "info" : "warn", text: outcome.text })
  }
  const keepSave = async (result: Result | null) => {
    const outcome = await keepSavedResult(connection, result, { locale, ...(saveDir ? { dir: saveDir } : {}) })
    if (outcome !== null) noteSave(outcome)
  }
  const keepResult = async (result: Result | null) => {
    await keepReport(result)
    await keepSave(result)
  }
  // Ctrl+Shift+S: `save` export, run on purpose and quietly (a refusal — the person is not an
  // admin — is shown as the server worded it), the room kept as a file.
  const saving = useRef(false)
  const saveToFile = async () => {
    if (saving.current) return
    saving.current = true
    try {
      noteSave(await saveRoom(connection, { locale, ...(saveDir ? { dir: saveDir } : {}) }))
    } finally {
      saving.current = false
    }
  }

  // Ctrl+S: the whole log to a text file — the lines that scrolled out of view included, and
  // the fallback on terminals that refuse a clipboard write.
  const exportTranscript = async () => {
    const all = logItems(snapshot.events, [], local.lines)
    if (all.length === 0) {
      connection.note({ kind: "result", level: "info", text: tt(locale, "transcript.empty") })
      return
    }
    try {
      const path = await writeTranscript(all, { room, at: new Date(), dir: transcriptDir, locale })
      connection.note({ kind: "result", level: "info", text: tt(locale, "transcript.saved", { path }) })
    } catch (error) {
      connection.note({ kind: "result", level: "warn", text: tt(locale, "transcript.failed", { error: error instanceof Error ? error.message : String(error) }) })
    }
  }

  const recallHistory = (direction: -1 | 1) => {
    if (history.length === 0) return
    const nextIndex =
      historyIndex === null ? (direction < 0 ? history.length - 1 : 0) : Math.max(0, Math.min(history.length - 1, historyIndex + direction))
    setHistoryIndex(nextIndex)
    setCommand(history[nextIndex] as string)
    if (inputRef.current) inputRef.current.value = history[nextIndex] as string
  }

  // Theme F-keys and Esc are the App shell's; these are the game view's own keys, installed only
  // while it is mounted.
  useKeyboard((event) => {
    const name = keyName(event)
    // An open picture or share form owns the keyboard (each closes itself).
    if (modal) return
    if (name === "f8") {
      setShareOpen(true)
      return
    }
    if (picturesFocused && (name === "up" || name === "down")) {
      movePicture(name === "up" ? -1 : 1)
      return
    }
    if (picturesFocused && (name === "return" || name === "enter")) {
      if (selectedPicture) openPicture(selectedPicture.key)
      return
    }
    if (name === "?" || name === "slash") setShowHelp((value) => !value)
    if (name === "pageup") {
      loadOlder()
      scrollRef.current?.scrollBy?.(-1, "viewport")
    }
    if (name === "pagedown") scrollRef.current?.scrollBy?.(1, "viewport")
    if (name === "up" && !rosterFocused && !choicesFocused && panelFocus === null) recallHistory(-1)
    if (name === "down" && !rosterFocused && !choicesFocused && panelFocus === null) recallHistory(1)
    if (event.ctrl && name === "l") {
      const current = connection.session.getSnapshot()
      setCleared({ seq: current.head, lineId: connection.getState().lines.at(-1)?.id ?? 0 })
    }
    if (event.ctrl && name === "s" && !event.shift) void exportTranscript()
    // Ctrl+Shift+S: the room checkpoint, written to a file (`save`, an admin command — a player gets the refusal).
    if (event.ctrl && name === "s" && event.shift) void saveToFile()
    if (name === "f6") setNarrowSidebarOpen((value) => !value)
    if (name === "f7") onCommands?.()
    // Tab cycles focus: chat input -> the latest choices select (when one is live) -> the
    // pictures in the log (when there are any) -> the roster (only when it can act) -> each panel
    // with choices -> back to the input, so focus is never stranded.
    if (name === "tab") {
      const stops = [
        "input",
        ...(logChoices ? ["choices"] : []),
        ...(pictures.length > 0 ? ["pictures"] : []),
        ...(showSidebar && rosterFocusable ? ["roster"] : []),
        ...(showSidebar ? panelStops : []),
      ]
      const current = choicesFocused ? "choices" : picturesFocused ? "pictures" : rosterFocused ? "roster" : panelFocus !== null ? `panel:${panelFocus}` : "input"
      const next = stops[(Math.max(0, stops.indexOf(current)) + 1) % stops.length] ?? "input"
      setChoicesFocused(next === "choices")
      setPicturesFocused(next === "pictures")
      setRosterFocused(next === "roster")
      setPanelFocus(next.startsWith("panel:") ? next.slice("panel:".length) : null)
    }
  })

  const scene = viewData(snapshot, "scene")
  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <HeaderBar
        room={room}
        scene={scene}
        usage={viewData(snapshot, "usage")}
        online={online}
        theme={theme}
        locale={locale}
        link={linkStatus(snapshot, local)}
        audio={audioLine(viewData(snapshot, "audio"), sound, locale)}
      />

      <box flexDirection="row" flexGrow={1} minHeight={8}>
        <scrollbox ref={scrollRef} flexGrow={1} border borderColor={theme.border} stickyScroll stickyStart="bottom" viewportCulling={false} onMouseScroll={loadOlder}>
          <NarrativeLog
            items={items}
            theme={theme}
            revealSeq={revealSeq}
            revealTicks={revealTicks}
            critFlash={critFlash}
            working={working}
            workingLabel={workingLabel}
            topHint={topHint}
            styledIds={streamed.current}
            locale={locale}
            choicesFocused={choicesFocused}
            onChoicePick={pickChoice}
            names={names}
            selectedPicture={picturesFocused || viewing !== null ? selectedPicture?.key : undefined}
            onPictureOpen={openPicture}
          />
        </scrollbox>

        {showSidebar ? (
          <scrollbox width={sidebarWidth(terminalWidth)} maxWidth="40%" flexShrink={0} viewportCulling={false}>
            <box flexDirection="column" width="100%" minWidth={0} flexShrink={0}>
              {narrow ? <ScenePanel scene={scene} theme={theme} locale={locale} established={3} /> : null}
              <PartyRoster
                character={me?.character}
                party={party}
                characters={characters}
                theme={theme}
                locale={locale}
                focused={rosterFocused}
                onFocus={() => setRosterFocused(true)}
                onClaim={claim}
                initiativeFirst={narrow}
              />
              {narrow ? null : <ScenePanel scene={scene} theme={theme} locale={locale} established={8} />}
              <VariablesPanel variables={viewData(snapshot, "variables")} theme={theme} locale={locale} />
              <PanelsPanel sections={sections} theme={theme} locale={locale} focused={panelFocus} onPick={pickChoice} />
            </box>
          </scrollbox>
        ) : null}
      </box>

      {viewing !== null ? (
        <PictureViewer
          connection={connection}
          picture={viewing}
          theme={theme}
          locale={locale}
          names={names}
          graphics={pictureGraphics}
          {...(pictureEnv ? { env: pictureEnv } : {})}
          onClose={() => setViewing(null)}
        />
      ) : null}

      {shareOpen ? <ShareForm connection={connection} theme={theme} locale={locale} onClose={() => setShareOpen(false)} /> : null}

      <box height={3} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <text fg={theme.accent}>{"> "}</text>
        <input
          key={inputVersion}
          ref={inputRef}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          value={command}
          maxLength={CHAT_INPUT_LIMIT}
          focused={!rosterFocused && !choicesFocused && !picturesFocused && panelFocus === null && !modal}
          placeholder={tt(locale, "game.placeholder")}
          onInput={(value: string) => {
            setCommand(value)
            setInputError(inputLimitState(value).atLimit ? tt(locale, "game.inputAtLimit", { limit: CHAT_INPUT_LIMIT }) : undefined)
          }}
          onSubmit={(value?: string) => submit(value)}
        />
        {inputState.showCounter ? (
          <box flexShrink={0} marginLeft={1}>
            <text fg={inputState.atLimit ? theme.fumble : theme.dim} wrapMode="none">
              {tt(locale, "game.inputCount", { count: inputState.count, limit: CHAT_INPUT_LIMIT })}
            </text>
          </box>
        ) : null}
        {narrow ? (
          <box flexShrink={0} marginLeft={1}>
            <text fg={narrowSidebarOpen ? theme.accent : theme.dim} wrapMode="none">
              {tt(locale, narrowSidebarOpen ? "game.sidebarHide" : "game.sidebarShow")}
            </text>
          </box>
        ) : null}
      </box>

      {inputError ? (
        <box height={1} paddingX={1} backgroundColor={theme.bg}>
          <text fg={theme.fumble} wrapMode="none" truncate>
            {inputError}
          </text>
        </box>
      ) : null}

      {copyNotice ? (
        <box height={1} paddingX={1} backgroundColor={theme.bg}>
          <text fg={theme.accent} wrapMode="none" truncate>
            {copyNotice}
          </text>
        </box>
      ) : null}

      {showHelp ? (
        // One key group per row; explicit height/flexShrink so the rows never collapse onto one.
        <box border borderColor={theme.accent} paddingX={1} backgroundColor={theme.bg} flexDirection="column" width="100%" height={8} flexShrink={0}>
          <text fg={theme.fg}>{tt(locale, "game.help")}</text>
          <text fg={theme.fg}>{tt(locale, "game.helpLog")}</text>
          <text fg={theme.fg}>{tt(locale, "game.helpDice")}</text>
          <text fg={theme.fg}>{tt(locale, "game.helpCommands")}</text>
          <text fg={theme.fg}>{tt(locale, "game.helpPictures")}</text>
          <text fg={theme.accent}>{tt(locale, usesAppClipboardCopy(platform) ? "game.helpCopy" : "game.helpCopyMac")}</text>
        </box>
      ) : null}

      <StatusBar room={room} online={online} locale={locale} theme={theme} themeName={themeName} />
    </box>
  )
}

export default GameView
