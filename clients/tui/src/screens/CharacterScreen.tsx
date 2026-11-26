import { useEffect, useRef, useState, type ReactNode } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { KeyEvent, SelectOption } from "@opentui/core"
import { stripControlChars, type Result } from "loreweaver-protocol/v3"
import { CharacterPanel } from "../components/CharacterPanel"
import { attributeLines } from "../components/characterAttributes"
import { ImportForm } from "../components/ImportForm"
import { freeClaimables } from "../components/PartyRoster"
import { StatusBar } from "../components/StatusBar"
import type { Connection } from "../connection"
import { useSnapshot, viewData } from "../hooks"
import { tt } from "../i18n"
import { sidebarCollapsed, sidebarWidth } from "../layout"
import type { Palette, ThemeName } from "../themes"

export interface CharacterScreenProps {
  connection: Connection
  theme: Palette
  themeName: ThemeName
  locale: string
  onBack: () => void
}

type Mode = "view" | "create" | "claim" | "edit" | "rename" | "import"

interface ViewAction {
  label: string
  run: () => void
}

const CURSOR = "⚄"
const DICE_GLYPHS = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"]
// The roll flicker ticks at a fixed cadence, capped so a slow reply cannot spin forever; landing
// is never gated by it — it fires the moment the command answers.
const ROLL_TICK_MS = 110
const ROLL_MAX_TICKS = 48
const LAND_FLOURISH_MS = 420

const SELECT_COLORS = (theme: Palette) => ({
  backgroundColor: theme.bg,
  textColor: theme.fg,
  focusedBackgroundColor: theme.bg,
  focusedTextColor: theme.accent,
  selectedBackgroundColor: theme.accent,
  selectedTextColor: theme.bg,
  descriptionColor: theme.dim,
  selectedDescriptionColor: theme.bg,
})

/** The text a person reads for a command's answer: its text, a refusal's message, or nothing. */
function answerText(result: Result | null): string | undefined {
  if (result === null) return undefined
  if (!result.ok) return result.error.message
  return result.text
}

// Your character, on commands and views: everything here is `command.run` with the command's
// typed arguments (`new_character`, `pc`, `sheet`, `rename`), and what shows comes from the `me`
// and `characters` views. The client knows no rule system: systems, stats and labels are the
// server's.
export function CharacterScreen({ connection, theme, themeName, locale, onBack }: CharacterScreenProps) {
  const snapshot = useSnapshot(connection)
  const { width: terminalWidth } = useTerminalDimensions()
  const showSheet = !sidebarCollapsed(terminalWidth)
  const me = viewData(snapshot, "me")
  const characters = viewData(snapshot, "characters")
  const character = me?.character ?? null
  const systems = characters?.systems ?? []
  const free = freeClaimables(characters)
  const stats = character ? [...character.attributes, ...character.skills] : []
  const online = (viewData(snapshot, "party")?.members ?? []).filter((member) => member.online).length
  const room = snapshot.welcome?.room.id ?? ""

  const [mode, setMode] = useState<Mode>(character ? "view" : "create")
  const [selected, setSelected] = useState(0)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [note, setNote] = useState<string>()
  const [busy, setBusy] = useState(false)

  // Create.
  const [systemId, setSystemId] = useState("")
  const [name, setName] = useState("")
  const nameRef = useRef("")
  const [createFocus, setCreateFocus] = useState<"system" | "name">("system")
  const [rolling, setRolling] = useState(false)
  const [landed, setLanded] = useState(false)
  const [rollTick, setRollTick] = useState(0)
  const [pendingName, setPendingName] = useState("")
  const rollInterval = useRef<ReturnType<typeof setInterval> | null>(null)
  const landTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Claim / edit / rename.
  const [claimIndex, setClaimIndex] = useState(0)
  const [statIndex, setStatIndex] = useState(0)
  const [editFocus, setEditFocus] = useState<"stat" | "value">("stat")
  const [value, setValue] = useState("")
  const valueRef = useRef("")
  const [renameText, setRenameText] = useState("")
  const renameRef = useRef("")

  const activeSystems = [...systems].sort((a, b) => Number(b.active) - Number(a.active))
  const systemIndex = Math.max(0, activeSystems.findIndex((entry) => entry.id === systemId))
  const chosenSystem = activeSystems[systemIndex]

  const stopRoll = () => {
    if (rollInterval.current !== null) clearInterval(rollInterval.current)
    rollInterval.current = null
  }
  useEffect(
    () => () => {
      stopRoll()
      if (landTimeout.current !== null) clearTimeout(landTimeout.current)
    },
    [],
  )

  const toView = (message?: string) => {
    setNote(message)
    setDeleteArmed(false)
    setSelected(0)
    setMode("view")
  }

  /** Run one command; its answer shows on this screen. */
  const run = async (id: string, args: Record<string, unknown>): Promise<Result | null> => {
    setBusy(true)
    try {
      const result = await connection.runCommand(id, args)
      setNote(answerText(result) ?? (result === null ? tt(locale, "log.notConnected") : undefined))
      return result
    } finally {
      setBusy(false)
    }
  }

  const submitCreate = async () => {
    if (rolling || busy) return
    if (!chosenSystem) {
      setNote(tt(locale, "character.noSystems"))
      return
    }
    const trimmed = nameRef.current.trim()
    setPendingName(trimmed)
    setLanded(false)
    setRollTick(0)
    setRolling(true)
    stopRoll()
    rollInterval.current = setInterval(() => setRollTick((tick) => (tick + 1 >= ROLL_MAX_TICKS ? tick : tick + 1)), ROLL_TICK_MS)
    const result = await run("new_character", { system: chosenSystem.id, ...(trimmed ? { name: trimmed } : {}) })
    stopRoll()
    if (result?.ok) {
      setLanded(true)
      landTimeout.current = setTimeout(() => {
        landTimeout.current = null
        setRolling(false)
        setLanded(false)
        toView(answerText(result))
      }, LAND_FLOURISH_MS)
    } else {
      setRolling(false)
    }
  }

  const submitClaim = async () => {
    const entry = free[Math.min(claimIndex, free.length - 1)]
    if (!entry || busy) return
    const result = await run("pc", { op: "claim", name: entry.id })
    if (result?.ok) toView(answerText(result) ?? tt(locale, "character.note.claimed", { name: stripControlChars(entry.name) }))
  }

  const submitEdit = async () => {
    const stat = stats[Math.min(statIndex, stats.length - 1)]
    const text = valueRef.current.trim()
    if (!stat || !text || busy) return
    const result = await run("sheet", { op: "set", writes: [{ name: stat.key, op: "=", value: text }] })
    if (result?.ok) {
      valueRef.current = ""
      setValue("")
      setEditFocus("stat")
    }
  }

  const submitRename = async () => {
    const text = renameRef.current.trim()
    if (!text || busy) return
    const result = await run("rename", { name: text })
    if (result?.ok) toView(answerText(result) ?? tt(locale, "character.note.renamed", { name: text }))
  }

  const release = async () => {
    const result = await run("pc", { op: "release" })
    if (result?.ok) toView(answerText(result) ?? tt(locale, "character.note.released"))
  }

  const finalize = async () => {
    await run("sheet", { op: "finalize" })
  }

  const remove = async () => {
    if (!deleteArmed) {
      setDeleteArmed(true)
      setNote(tt(locale, "character.note.confirmDelete"))
      return
    }
    setDeleteArmed(false)
    await run("sheet", { op: "clear" })
  }

  const enter = (next: Mode) => {
    setDeleteArmed(false)
    setNote(undefined)
    if (next === "create") {
      setSystemId("")
      setName("")
      nameRef.current = ""
      setCreateFocus("system")
    }
    if (next === "edit") {
      setStatIndex(0)
      setValue("")
      valueRef.current = ""
      setEditFocus("stat")
    }
    if (next === "rename") {
      const current = character ? stripControlChars(character.name) : ""
      setRenameText(current)
      renameRef.current = current
    }
    if (next === "claim") setClaimIndex(0)
    setMode(next)
  }

  const viewActions: ViewAction[] = [{ label: tt(locale, "character.view.new"), run: () => enter("create") }]
  if (free.length > 0) viewActions.push({ label: tt(locale, "character.view.claim"), run: () => enter("claim") })
  if (character) {
    viewActions.push(
      { label: tt(locale, "character.view.edit"), run: () => enter("edit") },
      { label: tt(locale, "character.view.rename"), run: () => enter("rename") },
      { label: tt(locale, "character.view.finalize"), run: () => void finalize() },
      { label: tt(locale, "character.view.release"), run: () => void release() },
      { label: deleteArmed ? tt(locale, "character.view.confirmDelete") : tt(locale, "character.view.delete"), run: () => void remove() },
    )
  }
  viewActions.push({ label: tt(locale, "character.view.import"), run: () => enter("import") })
  viewActions.push({ label: tt(locale, "character.view.back"), run: onBack })
  const clampView = (index: number) => Math.max(0, Math.min(viewActions.length - 1, index))
  const activateView = (index: number) => {
    const target = clampView(index)
    setSelected(target)
    viewActions[target]?.run()
  }

  useKeyboard((event: KeyEvent) => {
    const key = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (mode === "view") {
      if (key === "up") setSelected((prev) => clampView(prev - 1))
      if (key === "down") setSelected((prev) => clampView(prev + 1))
      if (key === "return" || key === "enter") activateView(selected)
      if (key === "escape") {
        if (deleteArmed) {
          setDeleteArmed(false)
          setNote(undefined)
        } else onBack()
      }
      return
    }
    if (key === "escape") {
      // Esc always leaves, even mid-roll: a slow reply cannot trap the player here.
      stopRoll()
      setRolling(false)
      setLanded(false)
      if (character || mode !== "create") toView()
      else onBack()
      return
    }
    if (key === "tab") {
      if (mode === "create") setCreateFocus((prev) => (prev === "system" ? "name" : "system"))
      if (mode === "edit") setEditFocus((prev) => (prev === "stat" ? "value" : "stat"))
    }
  })

  const systemOptions: SelectOption[] = activeSystems.map((entry) => ({
    name: `${stripControlChars(entry.label)}${entry.active ? ` · ${tt(locale, "character.systemActive")}` : ""}`,
    description: "",
    value: entry.id,
  }))
  const claimOptions: SelectOption[] = free.map((entry) => ({ name: stripControlChars(entry.name), description: stripControlChars(entry.blurb.replace(/\s+/g, " ")), value: entry.id }))
  const statOptions: SelectOption[] = attributeLines(stats).map((line) => ({ name: line.line, description: "", value: line.key }))

  const sheetContent = rolling ? (
    <box flexDirection="column" border borderColor={theme.accent} paddingX={1}>
      <text fg={theme.accent} wrapMode="none" truncate>
        {tt(locale, "character.panelTitle")} · {landed ? tt(locale, "character.landed") : tt(locale, "character.pending.roll")}
      </text>
      {landed && character ? (
        <>
          <text fg={theme.success} wrapMode="none" truncate>
            {CURSOR} {stripControlChars(character.name)}
          </text>
          {attributeLines(character.attributes).map(({ key, line }) => (
            <text key={key} fg={theme.success} wrapMode="none" truncate>
              {line}
            </text>
          ))}
        </>
      ) : (
        <>
          <text fg={theme.accent} wrapMode="none" truncate>
            {DICE_GLYPHS[rollTick % DICE_GLYPHS.length]} {stripControlChars(pendingName || tt(locale, "character.newCharacter"))}…
          </text>
          <text fg={theme.accent} wrapMode="none" truncate>
            {DICE_GLYPHS.map((_, index) => DICE_GLYPHS[(rollTick + index * 2) % DICE_GLYPHS.length]).join(" ")}
          </text>
        </>
      )}
    </box>
  ) : (
    <>
      <CharacterPanel character={character} theme={theme} locale={locale} />
      {character && character.skills.length > 0 ? (
        <box flexDirection="column" border borderColor={theme.border} paddingX={1} marginTop={1}>
          <text fg={theme.accent} wrapMode="none" truncate>
            {tt(locale, "character.skillsTitle")}
          </text>
          {attributeLines(character.skills).map(({ key, line }) => (
            <text key={key} fg={theme.fg} wrapMode="none" truncate>
              {line}
            </text>
          ))}
        </box>
      ) : null}
    </>
  )

  const panel = (children: ReactNode) => (
    <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} width="100%" maxWidth={72} minWidth={0} flexShrink={0}>
      {children}
    </box>
  )

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
        <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} marginLeft={2}>
          <text fg={theme.accent} wrapMode="none" truncate>
            {tt(locale, "character.title")}
          </text>
          <text fg={theme.dim} wrapMode="none" truncate>
            {" · "}
            {stripControlChars(room)}
          </text>
        </box>
      </box>

      <box key={mode} flexDirection="row" flexGrow={1} minHeight={8}>
        <scrollbox flexGrow={1} flexShrink={1} minWidth={0} viewportCulling={false}>
          <box flexDirection="column" width="100%" minWidth={0} paddingX={2} paddingY={1} flexShrink={0}>
            {mode === "view" ? (
              <>
                {viewActions.map((action, index) => (
                  <box
                    key={action.label}
                    height={1}
                    backgroundColor={selected === index ? theme.accent : theme.bg}
                    // The pointer MOVING onto a row selects it. Not `onMouseOver`: that also fires when a new
                    // screen puts a row under a pointer that has not moved, and the row under the button
                    // just clicked can be Quit or Delete — one Enter away.
                    onMouseMove={() => setSelected(index)}
                    onMouseDown={() => activateView(index)}
                  >
                    <text fg={selected === index ? theme.bg : theme.fg} wrapMode="none" truncate>
                      {selected === index ? `${CURSOR} ` : "  "}
                      {action.label}
                    </text>
                  </box>
                ))}
                <box marginTop={1}>
                  <text fg={theme.dim} wrapMode="none" truncate>
                    {tt(locale, "character.view.help")}
                  </text>
                </box>
              </>
            ) : null}

            {mode === "create"
              ? panel(
                  systems.length === 0 ? (
                    <text fg={theme.fumble}>{characters === null ? tt(locale, "commands.loading") : tt(locale, "character.noSystems")}</text>
                  ) : (
                    <>
                      <text fg={theme.dim} wrapMode="none" truncate>
                        {tt(locale, "character.createIntro")}
                      </text>
                      <box flexDirection="column" marginTop={1} onMouseDown={() => setCreateFocus("system")}>
                        <text fg={createFocus === "system" ? theme.accent : theme.dim} wrapMode="none" truncate>
                          {tt(locale, "character.system")}
                        </text>
                        <select
                          flexGrow={1}
                          height={Math.min(4, systemOptions.length)}
                          focused={createFocus === "system"}
                          options={systemOptions}
                          selectedIndex={systemIndex}
                          showDescription={false}
                          {...SELECT_COLORS(theme)}
                          onChange={(index: number) => setSystemId(activeSystems[index]?.id ?? "")}
                          onSelect={() => setCreateFocus("name")}
                        />
                      </box>
                      <box flexDirection="column" marginTop={1} onMouseDown={() => setCreateFocus("name")}>
                        <text fg={createFocus === "name" ? theme.accent : theme.dim} wrapMode="none" truncate>
                          {tt(locale, "character.name")}
                        </text>
                        <input
                          flexGrow={1}
                          value={name}
                          focused={createFocus === "name"}
                          placeholder={tt(locale, "character.namePlaceholder")}
                          onInput={(text: string) => {
                            nameRef.current = text
                            setName(text)
                          }}
                          onSubmit={() => void submitCreate()}
                        />
                      </box>
                      <box marginTop={1} onMouseDown={() => void submitCreate()} backgroundColor={theme.accent} paddingX={1}>
                        <text fg={theme.bg}>{rolling ? tt(locale, "character.rolling") : tt(locale, "character.roll")}</text>
                      </box>
                      <box marginTop={1}>
                        <text fg={theme.dim}>{tt(locale, "character.createHelp", { target: character ? tt(locale, "character.backToView") : tt(locale, "character.backToMenu") })}</text>
                      </box>
                    </>
                  ),
                )
              : null}

            {mode === "claim"
              ? panel(
                  free.length === 0 ? (
                    <text fg={theme.dim}>{tt(locale, "character.noClaimable")}</text>
                  ) : (
                    <>
                      <text fg={theme.dim} wrapMode="none" truncate>
                        {tt(locale, "character.claimIntro")}
                      </text>
                      <select
                        flexGrow={1}
                        height={Math.min(10, claimOptions.length * 2)}
                        focused
                        options={claimOptions}
                        selectedIndex={Math.min(claimIndex, claimOptions.length - 1)}
                        {...SELECT_COLORS(theme)}
                        onChange={(index: number) => setClaimIndex(index)}
                        onSelect={() => void submitClaim()}
                      />
                      <box marginTop={1}>
                        <text fg={theme.dim}>{tt(locale, "character.claimHelp")}</text>
                      </box>
                    </>
                  ),
                )
              : null}

            {mode === "edit"
              ? panel(
                  stats.length === 0 ? (
                    <text fg={theme.dim}>{tt(locale, "character.noStats")}</text>
                  ) : (
                    <>
                      <text fg={theme.dim} wrapMode="none" truncate>
                        {tt(locale, "character.editIntro")}
                      </text>
                      <box flexDirection="column" marginTop={1} onMouseDown={() => setEditFocus("stat")}>
                        <select
                          flexGrow={1}
                          height={Math.min(10, statOptions.length)}
                          focused={editFocus === "stat"}
                          options={statOptions}
                          selectedIndex={Math.min(statIndex, statOptions.length - 1)}
                          showDescription={false}
                          {...SELECT_COLORS(theme)}
                          onChange={(index: number) => setStatIndex(index)}
                          onSelect={() => setEditFocus("value")}
                        />
                      </box>
                      <box flexDirection="column" marginTop={1} onMouseDown={() => setEditFocus("value")}>
                        <text fg={editFocus === "value" ? theme.accent : theme.dim} wrapMode="none" truncate>
                          {tt(locale, "character.newValue", { name: stats[Math.min(statIndex, stats.length - 1)]?.label ?? "" })}
                        </text>
                        <input
                          flexGrow={1}
                          value={value}
                          focused={editFocus === "value"}
                          placeholder={tt(locale, "character.valuePlaceholder")}
                          onInput={(text: string) => {
                            valueRef.current = text
                            setValue(text)
                          }}
                          onSubmit={() => void submitEdit()}
                        />
                      </box>
                      <box marginTop={1}>
                        <text fg={theme.dim}>{tt(locale, "character.editHelp")}</text>
                      </box>
                    </>
                  ),
                )
              : null}

            {mode === "rename"
              ? panel(
                  <>
                    <text fg={theme.accent} wrapMode="none" truncate>
                      {tt(locale, "character.name")}
                    </text>
                    <input
                      flexGrow={1}
                      value={renameText}
                      focused
                      placeholder={tt(locale, "character.namePlaceholder")}
                      onInput={(text: string) => {
                        renameRef.current = text
                        setRenameText(text)
                      }}
                      onSubmit={() => void submitRename()}
                    />
                    <box marginTop={1}>
                      <text fg={theme.dim}>{tt(locale, "character.renameHelp")}</text>
                    </box>
                  </>,
                )
              : null}

            {mode === "import" ? panel(<ImportForm connection={connection} as="character" theme={theme} locale={locale} />) : null}

            {note ? (
              <box marginTop={1} minWidth={0}>
                <text fg={deleteArmed ? theme.fumble : theme.dim}>{stripControlChars(note)}</text>
              </box>
            ) : null}

            {!showSheet ? (
              <box key={rolling ? (landed ? "landed-narrow" : "rolling-narrow") : "sheet-narrow"} flexDirection="column" width="100%" minWidth={0} flexShrink={0} marginTop={1}>
                {sheetContent}
              </box>
            ) : null}
          </box>
        </scrollbox>

        {showSheet ? (
          <box key={rolling ? (landed ? "landed" : "rolling") : "sheet"} width={sidebarWidth(terminalWidth)} maxWidth="40%" flexShrink={0} flexDirection="column">
            {sheetContent}
          </box>
        ) : null}
      </box>

      <StatusBar room={room} online={online} locale={locale} theme={theme} themeName={themeName} />
    </box>
  )
}

export default CharacterScreen
