import { useEffect, useRef, useState } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { KeyEvent, SelectOption } from "@opentui/core"
import { stripControlChars, type CharacterState, type RuleSystemEntry, type StateFrame, type WelcomeFrame } from "loreweaver-protocol"
import { CharacterPanel } from "../components/CharacterPanel"
import { attributeLines } from "../components/characterAttributes"
import { StatusBar } from "../components/StatusBar"
import { tt } from "../i18n"
import { sidebarCollapsed, sidebarWidth } from "../layout"
import type { Palette, ThemeName } from "../themes"

// Only `sendInput` is needed here: the screen's data arrives via the `stateFrame`
// prop (App owns the socket and funnels every `state` frame to every screen), so
// this mirrors GameView's narrow `GameClient` interface rather than the full
// `AppClient` surface.
export interface CharacterClient {
  sendInput(text: string): void
}

export interface CharacterScreenProps {
  client: CharacterClient
  theme: Palette
  themeName: ThemeName
  welcome: WelcomeFrame
  stateFrame: StateFrame
  onBack: () => void
}

type Mode = "view" | "create" | "tweak"
// Protocol 2.3 removed the fourth ("manual") lane on purpose: a point-buy/budget
// editor can only be drawn from a pack's `creation_constraints`, and no frame
// carries those — offering one meant hard-coding one system's cost curve in a
// client. Every remaining lane is expressible with what the wire actually sends.
type CreateMode = "roll" | "persona" | "import"
type CreateField = "method" | "system" | "name" | "description" | "importPath"

interface ViewAction {
  label: string
  run: () => void
}

const CURSOR = "⚄"
const DICE_GLYPHS = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"]

// The roll flicker ticks at a fixed cadence and is capped at ROLL_MAX_TICKS so a
// slow/never-arriving reply can't spin forever-looking (still "rolling", just
// frozen on its last die face) — bounded per the design brief. Landing itself is
// never gated by this: it fires as soon as the awaited character actually changes.
const ROLL_TICK_MS = 110
const ROLL_MAX_TICKS = 48
const LAND_FLOURISH_MS = 420

const CREATE_MODE_VALUES: CreateMode[] = ["roll", "persona", "import"]

function createModeOptions(locale: string): SelectOption[] {
  return [
    { name: tt(locale, "character.method.roll"), description: tt(locale, "character.method.roll.desc"), value: "roll" },
    { name: tt(locale, "character.method.persona"), description: tt(locale, "character.method.persona.desc"), value: "persona" },
    { name: tt(locale, "character.method.import"), description: tt(locale, "character.method.import.desc"), value: "import" },
  ]
}

/** The systems this mode can actually offer.
 *
 * `roll` needs the pack's own make-character word (`make_char`) — a system that
 * declares none can still be imported into or described into, it simply carries no
 * command to create with. Everything here comes from `StateFrame.systems`; the
 * client knows no rule system by name. */
function offeredSystems(systems: RuleSystemEntry[], mode: CreateMode): RuleSystemEntry[] {
  return mode === "roll" ? systems.filter((entry) => Boolean(entry.make_char)) : systems
}

// The wire carries an id and nothing else — no display name, no description — so
// the picker shows the id verbatim rather than inventing prose for it.
function systemOptions(systems: RuleSystemEntry[]): SelectOption[] {
  return systems.map((entry) => ({ name: entry.id, description: "", value: entry.id }))
}

function createFieldOrderFor(mode: CreateMode): CreateField[] {
  if (mode === "persona") return ["method", "system", "name", "description"]
  if (mode === "import") return ["method", "system", "importPath"]
  return ["method", "system", "name"]
}

function createModeAt(index: number): CreateMode {
  return CREATE_MODE_VALUES[index] ?? "roll"
}

function pendingLabel(kind: CreateMode, locale: string): string {
  if (kind === "persona") return tt(locale, "character.pending.persona")
  if (kind === "import") return tt(locale, "character.pending.import")
  return tt(locale, "character.pending.roll")
}

// Identity, not reference: `net/state.py` rebuilds a brand-new `character` dict on
// *every* state frame (any room event), so a reference check alone would treat an
// unrelated broadcast as "the roll landed". Comparing content catches the case a
// reroll happens to keep the same name (isolated flicker, not a real bug).
function characterSignature(character?: CharacterState): string {
  return character ? JSON.stringify(character) : ""
}

export function CharacterScreen({ client, theme, themeName, welcome, stateFrame, onBack }: CharacterScreenProps) {
  const { width: terminalWidth } = useTerminalDimensions()
  const showSheet = !sidebarCollapsed(terminalWidth)
  const locale = welcome.locale
  const CREATE_MODE_OPTIONS = createModeOptions(locale)
  const hasCharacter = Boolean(stateFrame.character)
  const [mode, setMode] = useState<Mode>(hasCharacter ? "view" : "create")
  const [selected, setSelected] = useState(0)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [viewNote, setViewNote] = useState<string>()

  // Create-flow fields (Tab-focus + ref-mirrored inputs, copied from ConnectScreen
  // so submit always reads the latest typed value regardless of render timing).
  const [createModeIndex, setCreateModeIndex] = useState(0)
  // The chosen system is held as an ID, not an index: the offered list narrows in
  // `roll` mode (make_char only), so an index would silently point at a different
  // system when the method changes.
  const [systemId, setSystemId] = useState("")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [importPath, setImportPath] = useState("")
  const [createFocus, setCreateFocus] = useState<CreateField>("method")
  const nameRef = useRef(name)
  const descriptionRef = useRef(description)
  const importPathRef = useRef(importPath)
  const [pendingName, setPendingName] = useState("")
  const [createNote, setCreateNote] = useState<string>()

  // Signature stat-roll reveal: the roll itself happens server-side (dice-first),
  // so this is purely a client-side "tumbling dice" flicker that plays while
  // awaiting the refreshed `state` frame, then settles once the character the
  // frame carries actually changes (see `characterSignature`).
  const [rolling, setRolling] = useState(false)
  const [landed, setLanded] = useState(false)
  const [rollTick, setRollTick] = useState(0)
  const [pendingKind, setPendingKind] = useState<CreateMode>("roll")
  const rollStartSignatureRef = useRef("")
  const rollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const landTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Tweak-flow field.
  const [tweakText, setTweakText] = useState("")
  const tweakRef = useRef(tweakText)
  const [tweakNote, setTweakNote] = useState<string>()

  const createMode = createModeAt(createModeIndex)
  // v2.3: every rule system the server discovered. Absent means a server older than
  // the frame that carries it — the screen says so instead of guessing a system.
  const systems = stateFrame.systems ?? []
  const offered = offeredSystems(systems, createMode)
  const systemIndex = Math.max(0, offered.findIndex((entry) => entry.id === systemId))
  const activeSystem = offered[systemIndex]
  const SYSTEM_OPTIONS = systemOptions(offered)

  const stopRollInterval = () => {
    if (rollIntervalRef.current !== null) {
      clearInterval(rollIntervalRef.current)
      rollIntervalRef.current = null
    }
  }
  const clearLandTimeout = () => {
    if (landTimeoutRef.current !== null) {
      clearTimeout(landTimeoutRef.current)
      landTimeoutRef.current = null
    }
  }

  // Timers are cleared on unmount so leaving the screen mid-roll can't leak them.
  useEffect(() => {
    return () => {
      stopRollInterval()
      clearLandTimeout()
    }
  }, [])

  // The landing signal: once the awaited roll's `state` frame actually differs
  // from the one captured at submit time, stop the flicker, flash the settled
  // values in `theme.success`, then drop back into view mode.
  useEffect(() => {
    if (!rolling) return
    const signature = characterSignature(stateFrame.character)
    if (signature === rollStartSignatureRef.current) return
    stopRollInterval()
    setLanded(true)
    landTimeoutRef.current = setTimeout(() => {
      landTimeoutRef.current = null
      setRolling(false)
      setLanded(false)
      setPendingKind("roll")
      setMode("view")
      setSelected(0)
    }, LAND_FLOURISH_MS)
  }, [rolling, stateFrame.character])

  const beginRoll = (kind: CreateMode) => {
    rollStartSignatureRef.current = characterSignature(stateFrame.character)
    setLanded(false)
    setRollTick(0)
    setRolling(true)
    setPendingKind(kind)
    stopRollInterval()
    if (kind === "roll") {
      rollIntervalRef.current = setInterval(() => {
        setRollTick((tick) => (tick + 1 >= ROLL_MAX_TICKS ? tick : tick + 1))
      }, ROLL_TICK_MS)
    }
  }

  const submitCreate = () => {
    if (rolling) return
    // The dot-command word is the pack's own (`RuleSystemEntry.make_char`), never a
    // word this client knows: `.<make_char> [name]` is what `cmd_make_char` parses.
    const word = activeSystem?.make_char
    if (!word) {
      setCreateNote(tt(locale, "character.note.noRollSystem"))
      return
    }
    const trimmed = nameRef.current.trim()
    client.sendInput(trimmed ? `.${word} ${trimmed}` : `.${word}`)
    setPendingName(trimmed)
    beginRoll("roll")
  }

  const submitPersona = () => {
    if (rolling) return
    const descriptionValue = descriptionRef.current.trim()
    if (!descriptionValue) {
      setCreateNote(tt(locale, "character.note.descriptionRequired"))
      return
    }
    const system = activeSystem?.id
    if (!system) {
      setCreateNote(tt(locale, "character.note.noSystemSelected"))
      return
    }
    const trimmed = nameRef.current.trim()
    const command = trimmed ? `.genchar ${system} ${trimmed} | ${descriptionValue}` : `.genchar ${system} | ${descriptionValue}`
    client.sendInput(command)
    setPendingName(trimmed)
    setCreateNote(tt(locale, "character.note.genSent", { system }))
    beginRoll("persona")
  }

  const submitImport = () => {
    if (rolling) return
    const path = importPathRef.current.trim()
    if (!path) return
    const system = activeSystem?.id
    if (!system) {
      setCreateNote(tt(locale, "character.note.noSystemSelected"))
      return
    }
    const command = `.import ${path} ${system} pc`
    client.sendInput(command)
    setCreateNote(tt(locale, "character.note.sent", { command }))
    setPendingName(path.split("/").filter(Boolean).pop() ?? "")
    beginRoll("import")
  }

  const submitTweak = () => {
    const text = tweakRef.current.trim()
    if (!text) return
    client.sendInput(`.st ${text}`)
    setTweakNote(tt(locale, "character.note.tweakSent", { text }))
    tweakRef.current = ""
    setTweakText("")
  }

  // `.st finalize` re-derives the current vitals from the sheet's characteristics.
  // The CANONICAL word, not a locale dialect one: `_SHEET_FINALIZE_WORDS` accepts
  // `finalize` / `定稿` / `初始化` because a HUMAN may type any of them, but a client
  // issuing the command programmatically has no locale to speak.
  const finalizeCurrent = () => {
    if (!stateFrame.character) return
    client.sendInput(".st finalize")
    setViewNote(tt(locale, "character.note.finalizeSent"))
    setDeleteArmed(false)
  }

  const enterCreate = () => {
    setDeleteArmed(false)
    setViewNote(undefined)
    setCreateModeIndex(0)
    setSystemId("")
    setName("")
    setDescription("")
    setImportPath("")
    nameRef.current = ""
    descriptionRef.current = ""
    importPathRef.current = ""
    setCreateNote(undefined)
    setCreateFocus("method")
    setMode("create")
  }

  const enterTweak = () => {
    setDeleteArmed(false)
    setViewNote(undefined)
    setTweakText("")
    tweakRef.current = ""
    setTweakNote(undefined)
    setMode("tweak")
  }

  const deleteCurrent = () => {
    if (!stateFrame.character) return
    if (!deleteArmed) {
      setDeleteArmed(true)
      setViewNote(tt(locale, "character.note.confirmDelete"))
      return
    }
    client.sendInput(".st delete")
    setViewNote(tt(locale, "character.note.deleteSent", { name: stateFrame.character.name }))
    setDeleteArmed(false)
  }

  const viewActions: ViewAction[] = [
    { label: tt(locale, "character.view.new"), run: enterCreate },
    { label: tt(locale, "character.view.tweak"), run: enterTweak },
    { label: tt(locale, "character.view.finalize"), run: finalizeCurrent },
    { label: deleteArmed ? tt(locale, "character.view.confirmDelete") : tt(locale, "character.view.delete"), run: deleteCurrent },
    { label: tt(locale, "character.view.back"), run: onBack },
  ]
  const clampView = (index: number) => Math.max(0, Math.min(viewActions.length - 1, index))
  const activateView = (index: number) => {
    const target = clampView(index)
    setSelected(target)
    viewActions[target]?.run()
  }

  const bailRoll = () => {
    stopRollInterval()
    clearLandTimeout()
    setRolling(false)
    setLanded(false)
    setPendingKind("roll")
  }

  // Scoped to this screen and further scoped by `mode`, so it can't fight the
  // menu's own arrow handling or a focused create/tweak-flow input/select.
  useKeyboard((event: KeyEvent) => {
    const key = typeof event.name === "string" ? event.name.toLowerCase() : ""

    if (mode === "view") {
      if (key === "up") setSelected((prev) => clampView(prev - 1))
      if (key === "down") setSelected((prev) => clampView(prev + 1))
      if (key === "return" || key === "enter") activateView(selected)
      if (key === "escape") {
        if (deleteArmed) {
          setDeleteArmed(false)
          setViewNote(undefined)
        } else {
          onBack()
        }
      }
      return
    }

    if (mode === "create") {
      if (key === "tab") {
        setCreateFocus((prev) => {
          const order = createFieldOrderFor(createMode)
          const index = Math.max(0, order.indexOf(prev))
          const delta = event.shift ? order.length - 1 : 1
          return order[(index + delta) % order.length]
        })
      }
      if (key === "escape") {
        // Esc always provides an exit, even mid-roll: a stuck/slow reply can't
        // trap the player on this screen.
        bailRoll()
        if (hasCharacter) setMode("view")
        else onBack()
      }
      return
    }

    if (mode === "tweak") {
      if (key === "escape") setMode("view")
    }
  })

  const sheetContent = rolling ? (
    <box flexDirection="column" border borderColor={theme.accent} paddingX={1}>
      <text fg={theme.accent} wrapMode="none" truncate>
        CHARACTER {landed ? `· ${tt(locale, "character.landed")}` : `· ${pendingLabel(pendingKind, locale)}`}
      </text>
      {landed ? (
        <>
          <text fg={theme.success} wrapMode="none" truncate>
            {CURSOR} {stripControlChars(stateFrame.character?.name ?? pendingName)}
          </text>
          {attributeLines(stateFrame.character).map(({ key, line }) => (
            <text key={key} fg={theme.success} wrapMode="none" truncate>
              {line}
            </text>
          ))}
        </>
      ) : (
        <>
          <text fg={theme.accent} wrapMode="none" truncate>
            {DICE_GLYPHS[rollTick % DICE_GLYPHS.length]}{" "}
            {stripControlChars(pendingName || tt(locale, "character.newCharacter"))}…
          </text>
          {/* Dice glyphs only. Which characteristics a roll produces is the pack's
              business, and the landed sheet below names them itself the moment the
              state frame arrives — so nothing here needs a per-system label table. */}
          {pendingKind === "roll" ? (
            <text fg={theme.accent} wrapMode="none" truncate>
              {DICE_GLYPHS.map((_, index) => DICE_GLYPHS[(rollTick + index * 2) % DICE_GLYPHS.length]).join(" ")}
            </text>
          ) : null}
          {pendingKind === "persona" ? <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "character.personaPending")}</text> : null}
          {pendingKind === "import" ? <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "character.importPending")}</text> : null}
        </>
      )}
    </box>
  ) : (
    <>
      <CharacterPanel character={stateFrame.character} theme={theme} locale={locale} />
      {stateFrame.character ? (
        <box flexDirection="column" border borderColor={theme.border} paddingX={1} marginTop={1}>
          <text fg={theme.accent} wrapMode="none" truncate>{tt(locale, "character.attributesTitle")}</text>
          {attributeLines(stateFrame.character).map(({ key, line }) => (
            <text key={key} fg={theme.fg} wrapMode="none" truncate>
              {line}
            </text>
          ))}
        </box>
      ) : null}
      {viewNote ? (
        <box marginTop={1} minWidth={0}>
          <text fg={deleteArmed ? theme.fumble : theme.dim} wrapMode="none" truncate>{stripControlChars(viewNote)}</text>
        </box>
      ) : null}
    </>
  )

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
        <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} marginLeft={2}>
          <text fg={theme.accent} wrapMode="none" truncate>{tt(locale, "character.title")}</text>
          <text fg={theme.dim} wrapMode="none" truncate>
            {" · "}
            {stripControlChars(welcome.room)}
          </text>
        </box>
      </box>

      <box key={mode} flexDirection="row" flexGrow={1} minHeight={8}>
        <scrollbox flexGrow={1} flexShrink={1} minWidth={0} viewportCulling={false}>
        <box flexDirection="column" width="100%" minWidth={0} paddingX={2} paddingY={1} flexShrink={0}>
          {mode === "view" ? (
            <>
              <box marginBottom={1}>
                <text fg={stateFrame.character?.avatar ? theme.success : theme.dim} wrapMode="none" truncate>
                  {tt(locale, stateFrame.character?.avatar ? "character.avatar.set" : "character.avatar.unset")}
                </text>
              </box>
              {viewActions.map((action, index) => (
                <box
                  key={action.label}
                  height={1}
                  backgroundColor={selected === index ? theme.accent : theme.bg}
                  onMouseOver={() => setSelected(index)}
                  onMouseDown={() => activateView(index)}
                >
                  <text fg={selected === index ? theme.bg : theme.fg} wrapMode="none" truncate>
                    {selected === index ? `${CURSOR} ` : "  "}
                    {action.label}
                  </text>
                </box>
              ))}
              <box marginTop={1}>
                <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "character.view.help")}</text>
              </box>
            </>
          ) : null}

          {mode === "create" && systems.length === 0 ? (
            <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} width="100%" maxWidth={72} minWidth={0} flexShrink={0}>
              <text fg={theme.fumble}>{tt(locale, "character.noSystems")}</text>
              <box marginTop={1}>
                <text fg={theme.dim}>
                  {tt(locale, "character.createHelp", {
                    target: hasCharacter ? tt(locale, "character.backToView") : tt(locale, "character.backToMenu"),
                  })}
                </text>
              </box>
            </box>
          ) : null}

          {mode === "create" && systems.length > 0 ? (
            <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} width="100%" maxWidth={72} minWidth={0} flexShrink={0}>
              <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "character.createIntro")}</text>

              <box flexDirection="column" marginTop={1} onMouseDown={() => setCreateFocus("method")}>
                <text fg={createFocus === "method" ? theme.accent : theme.dim} wrapMode="none" truncate>{tt(locale, "character.method")}</text>
                <select
                  flexGrow={1}
                  height={6}
                  focused={createFocus === "method"}
                  options={CREATE_MODE_OPTIONS}
                  selectedIndex={createModeIndex}
                  backgroundColor={theme.bg}
                  textColor={theme.fg}
                  focusedBackgroundColor={theme.bg}
                  focusedTextColor={theme.accent}
                  selectedBackgroundColor={theme.accent}
                  selectedTextColor={theme.bg}
                  descriptionColor={theme.dim}
                  selectedDescriptionColor={theme.bg}
                  onChange={(index: number) => {
                    setCreateModeIndex(index)
                    setCreateNote(undefined)
                  }}
                  onSelect={() => setCreateFocus("system")}
                />
              </box>

              <box flexDirection="column" marginTop={1} onMouseDown={() => setCreateFocus("system")}>
                <text fg={createFocus === "system" ? theme.accent : theme.dim} wrapMode="none" truncate>{tt(locale, "character.system")}</text>
                {offered.length > 0 ? (
                  <select
                    flexGrow={1}
                    height={Math.min(4, offered.length)}
                    focused={createFocus === "system"}
                    options={SYSTEM_OPTIONS}
                    selectedIndex={systemIndex}
                    showDescription={false}
                    backgroundColor={theme.bg}
                    textColor={theme.fg}
                    focusedBackgroundColor={theme.bg}
                    focusedTextColor={theme.accent}
                    selectedBackgroundColor={theme.accent}
                    selectedTextColor={theme.bg}
                    descriptionColor={theme.dim}
                    selectedDescriptionColor={theme.bg}
                    onChange={(index: number) => {
                      setSystemId(offered[index]?.id ?? "")
                      setCreateNote(undefined)
                    }}
                    onSelect={() => setCreateFocus(createMode === "import" ? "importPath" : "name")}
                  />
                ) : (
                  <text fg={theme.fumble} wrapMode="none" truncate>{tt(locale, "character.note.noRollSystem")}</text>
                )}
              </box>

              {createMode !== "import" ? (
                <box flexDirection="column" marginTop={1} onMouseDown={() => setCreateFocus("name")}>
                  <text fg={createFocus === "name" ? theme.accent : theme.dim} wrapMode="none" truncate>{tt(locale, "character.name")}</text>
                  <input
                    flexGrow={1}
                    value={name}
                    focused={createFocus === "name"}
                    placeholder={tt(locale, "character.namePlaceholder")}
                    onInput={(value: string) => {
                      nameRef.current = value
                      setName(value)
                    }}
                    onSubmit={createMode === "persona" ? submitPersona : submitCreate}
                  />
                </box>
              ) : null}

              {createMode === "roll" ? (
                <box marginTop={1} onMouseDown={submitCreate} backgroundColor={theme.accent} paddingX={1}>
                  <text fg={theme.bg}>{rolling ? tt(locale, "character.rolling") : tt(locale, "character.roll")}</text>
                </box>
              ) : null}

              {createMode === "persona" ? (
                <box flexDirection="column" marginTop={1} onMouseDown={() => setCreateFocus("description")}>
                  <text fg={createFocus === "description" ? theme.accent : theme.dim} wrapMode="none" truncate>{tt(locale, "character.description")}</text>
                  <input
                    flexGrow={1}
                    value={description}
                    focused={createFocus === "description"}
                    placeholder={tt(locale, "character.descriptionPlaceholder")}
                    onInput={(value: string) => {
                      descriptionRef.current = value
                      setDescription(value)
                    }}
                    onSubmit={submitPersona}
                  />
                  <box marginTop={1} onMouseDown={submitPersona} backgroundColor={theme.accent} paddingX={1}>
                    <text fg={theme.bg}>{tt(locale, "character.persona")}</text>
                  </box>
                </box>
              ) : null}

              {createMode === "import" ? (
                <box flexDirection="column" marginTop={1} onMouseDown={() => setCreateFocus("importPath")}>
                  <text fg={createFocus === "importPath" ? theme.accent : theme.dim} wrapMode="none" truncate>{tt(locale, "character.import")}</text>
                  <input
                    flexGrow={1}
                    value={importPath}
                    focused={createFocus === "importPath"}
                    placeholder={tt(locale, "character.importPlaceholder")}
                    onInput={(value: string) => {
                      importPathRef.current = value
                      setImportPath(value)
                    }}
                    onSubmit={submitImport}
                  />

                  <box marginTop={1} onMouseDown={submitImport} backgroundColor={theme.accent} paddingX={1}>
                    <text fg={theme.bg}>{tt(locale, "character.importButton")}</text>
                  </box>
                </box>
              ) : null}

              {createNote ? (
                <box marginTop={1}>
                  <text fg={theme.dim} wrapMode="none" truncate>{stripControlChars(createNote)}</text>
                </box>
              ) : null}

              <box marginTop={1}>
                <text fg={theme.dim}>
                  {tt(locale, "character.createHelp", {
                    target: hasCharacter ? tt(locale, "character.backToView") : tt(locale, "character.backToMenu"),
                  })}
                </text>
              </box>
            </box>
          ) : null}

          {mode === "tweak" ? (
            <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} width="100%" maxWidth={60} minWidth={0} flexShrink={0}>
              <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "character.tweakIntro")}</text>
              <box flexDirection="column" marginTop={1}>
                <text fg={theme.accent} wrapMode="none" truncate>{tt(locale, "character.tweakCommand")}</text>
                <input
                  flexGrow={1}
                  value={tweakText}
                  focused
                  placeholder={tt(locale, "character.tweakPlaceholder")}
                  onInput={(value: string) => {
                    tweakRef.current = value
                    setTweakText(value)
                  }}
                  onSubmit={submitTweak}
                />
              </box>
              <box marginTop={1} onMouseDown={submitTweak} backgroundColor={theme.accent} paddingX={1}>
                <text fg={theme.bg}>{tt(locale, "character.apply")}</text>
              </box>
              {tweakNote ? (
                <box marginTop={1}>
                  <text fg={theme.dim} wrapMode="none" truncate>{stripControlChars(tweakNote)}</text>
                </box>
              ) : null}
              <box marginTop={1}>
                <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "character.tweakHelp")}</text>
              </box>
            </box>
          ) : null}
          {!showSheet ? (
            <box key={rolling ? (landed ? "landed-narrow" : "rolling-narrow") : "sheet-narrow"} flexDirection="column" width="100%" minWidth={0} flexShrink={0} marginTop={1}>
              {sheetContent}
            </box>
          ) : null}
        </box>
        </scrollbox>

        {showSheet ? <box key={rolling ? (landed ? "landed" : "rolling") : "sheet"} width={sidebarWidth(terminalWidth)} maxWidth="40%" flexShrink={0} flexDirection="column">
          {sheetContent}
        </box> : null}
      </box>

      <StatusBar welcome={welcome} online={stateFrame.online} theme={theme} themeName={themeName} />
    </box>
  )
}

export default CharacterScreen
