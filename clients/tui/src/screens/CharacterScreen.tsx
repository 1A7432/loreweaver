import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent, SelectOption } from "@opentui/core"
import { stripControlChars, type CharacterState, type StateFrame, type WelcomeFrame } from "@loreweaver/protocol"
import { CharacterPanel } from "../components/CharacterPanel"
import { attributeLines } from "../components/characterAttributes"
import { StatusBar } from "../components/StatusBar"
import { tt } from "../i18n"
import type { MessageKey } from "../i18n"
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
type CreateMode = "roll" | "manual" | "persona" | "import"
type CreateField = "method" | "system" | "name" | "attrs" | "description" | "importPath"
type SystemValue = "coc" | "dnd"

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

const COC_ROLL_LABELS = ["力量", "体质", "体型", "敏捷", "外貌", "智力", "意志", "教育"]
const DND_ROLL_LABELS = ["力量", "敏捷", "体质", "智力", "感知", "魅力"]

interface ManualAttrDef {
  key: string
  label: string
  min: number
  max: number
  step: number
}

const COC_MANUAL_ATTRS: ManualAttrDef[] = [
  { key: "STR", label: "力量", min: 15, max: 90, step: 5 },
  { key: "CON", label: "体质", min: 15, max: 90, step: 5 },
  { key: "SIZ", label: "体型", min: 40, max: 90, step: 5 },
  { key: "DEX", label: "敏捷", min: 15, max: 90, step: 5 },
  { key: "APP", label: "外貌", min: 15, max: 90, step: 5 },
  { key: "INT", label: "智力", min: 40, max: 90, step: 5 },
  { key: "POW", label: "意志", min: 15, max: 90, step: 5 },
  { key: "EDU", label: "教育", min: 40, max: 90, step: 5 },
  { key: "LUC", label: "幸运", min: 15, max: 90, step: 5 },
]

const DND_MANUAL_ATTRS: ManualAttrDef[] = [
  { key: "STR", label: "力量", min: 8, max: 15, step: 1 },
  { key: "DEX", label: "敏捷", min: 8, max: 15, step: 1 },
  { key: "CON", label: "体质", min: 8, max: 15, step: 1 },
  { key: "INT", label: "智力", min: 8, max: 15, step: 1 },
  { key: "WIS", label: "感知", min: 8, max: 15, step: 1 },
  { key: "CHA", label: "魅力", min: 8, max: 15, step: 1 },
]

const DND_POINT_BUY_COST: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 }
const DND_POINT_BUY_BUDGET = 27
const CREATE_MODE_VALUES: CreateMode[] = ["roll", "manual", "persona", "import"]
const SYSTEM_VALUES: SystemValue[] = ["coc", "dnd"]

function systemOptions(locale: string): SelectOption[] {
  return [
    { name: tt(locale, "character.system.coc"), description: tt(locale, "character.system.coc.desc"), value: "coc" },
    { name: tt(locale, "character.system.dnd"), description: tt(locale, "character.system.dnd.desc"), value: "dnd" },
  ]
}

function createModeOptions(locale: string): SelectOption[] {
  return [
    { name: tt(locale, "character.method.roll"), description: tt(locale, "character.method.roll.desc"), value: "roll" },
    { name: tt(locale, "character.method.manual"), description: tt(locale, "character.method.manual.desc"), value: "manual" },
    { name: tt(locale, "character.method.persona"), description: tt(locale, "character.method.persona.desc"), value: "persona" },
    { name: tt(locale, "character.method.import"), description: tt(locale, "character.method.import.desc"), value: "import" },
  ]
}

function createFieldOrderFor(mode: CreateMode): CreateField[] {
  if (mode === "manual") return ["method", "system", "name", "attrs"]
  if (mode === "persona") return ["method", "system", "name", "description"]
  if (mode === "import") return ["method", "system", "importPath"]
  return ["method", "system", "name"]
}

function createModeAt(index: number): CreateMode {
  return CREATE_MODE_VALUES[index] ?? "roll"
}

function systemValueAt(index: number): SystemValue {
  return SYSTEM_VALUES[index] ?? "coc"
}

function manualAttrDefs(system: SystemValue): ManualAttrDef[] {
  return system === "dnd" ? DND_MANUAL_ATTRS : COC_MANUAL_ATTRS
}

function initialManualAttrs(defs: ManualAttrDef[], value: number): Record<string, number> {
  return Object.fromEntries(defs.map((def) => [def.key, value]))
}

function attrLabel(key: string, locale: string): string {
  return tt(locale, `attrs.${key}` as MessageKey)
}

function manualBudgetText(system: SystemValue, attrs: Record<string, number>, locale: string): string {
  if (system === "dnd") {
    return tt(locale, "character.budget.dnd", { spent: dndPointBuySpent(attrs), budget: DND_POINT_BUY_BUDGET })
  }
  return tt(locale, "character.budget.coc", {
    interest: (attrs.INT ?? 50) * 2,
    occupation: (attrs.EDU ?? 50) * 4,
  })
}

function manualValidation(system: SystemValue, attrs: Record<string, number>, locale: string): string[] {
  const messages: string[] = []
  for (const def of manualAttrDefs(system)) {
    const value = attrs[def.key] ?? def.min
    if (value < def.min || value > def.max) {
      messages.push(tt(locale, "character.validation.range", { label: attrLabel(def.key, locale), min: def.min, max: def.max }))
    }
  }
  if (system === "dnd") {
    const spent = dndPointBuySpent(attrs)
    if (spent > DND_POINT_BUY_BUDGET) {
      messages.push(tt(locale, "character.validation.budget", { spent, budget: DND_POINT_BUY_BUDGET }))
    }
  }
  return messages
}

function dndPointBuySpent(attrs: Record<string, number>): number {
  return DND_MANUAL_ATTRS.reduce((sum, def) => sum + (DND_POINT_BUY_COST[attrs[def.key] ?? def.min] ?? 0), 0)
}

function pendingLabel(kind: CreateMode, locale: string): string {
  if (kind === "manual") return tt(locale, "character.pending.manual")
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

function rollLabelsFor(systemValue: unknown, locale: string): string[] {
  const labels = systemValue === "dnd" ? DND_MANUAL_ATTRS.map((def) => def.key) : COC_MANUAL_ATTRS.slice(0, 8).map((def) => def.key)
  if (locale.startsWith("en")) return labels
  return systemValue === "dnd" ? DND_ROLL_LABELS : COC_ROLL_LABELS
}

export function CharacterScreen({ client, theme, themeName, welcome, stateFrame, onBack }: CharacterScreenProps) {
  const locale = welcome.locale
  const SYSTEM_OPTIONS = systemOptions(locale)
  const CREATE_MODE_OPTIONS = createModeOptions(locale)
  const hasCharacter = Boolean(stateFrame.character)
  const [mode, setMode] = useState<Mode>(hasCharacter ? "view" : "create")
  const [selected, setSelected] = useState(0)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [viewNote, setViewNote] = useState<string>()

  // Create-flow fields (Tab-focus + ref-mirrored inputs, copied from ConnectScreen
  // so submit always reads the latest typed value regardless of render timing).
  const [createModeIndex, setCreateModeIndex] = useState(0)
  const [systemIndex, setSystemIndex] = useState(0)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [importPath, setImportPath] = useState("")
  const [createFocus, setCreateFocus] = useState<CreateField>("method")
  const [manualAttrIndex, setManualAttrIndex] = useState(0)
  const [manualCocAttrs, setManualCocAttrs] = useState(() => initialManualAttrs(COC_MANUAL_ATTRS, 50))
  const [manualDndAttrs, setManualDndAttrs] = useState(() => initialManualAttrs(DND_MANUAL_ATTRS, 8))
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
    const system = systemValueAt(systemIndex)
    const trimmed = nameRef.current.trim()
    client.sendInput(trimmed ? `.${system} ${trimmed}` : `.${system}`)
    setPendingName(trimmed)
    beginRoll("roll")
  }

  const submitManual = () => {
    if (rolling) return
    const system = systemValueAt(systemIndex)
    const defs = manualAttrDefs(system)
    const attrs = system === "dnd" ? manualDndAttrs : manualCocAttrs
    const errors = manualValidation(system, attrs, locale)
    if (errors.length) {
      setCreateNote(errors[0])
      return
    }
    const trimmed = nameRef.current.trim()
    client.sendInput(trimmed ? `.${system} ${trimmed}` : `.${system}`)
    client.sendInput(`.st ${defs.map((def) => `${def.label}${attrs[def.key] ?? def.min}`).join(" ")}`)
    // `.coc`/`.dnd` seeds the sheet with DEFAULT characteristics (deriving current
    // HP/MP/SAN from those), then `.st` overwrites them with the manually-chosen
    // ones -- but `.st` validates as an in-play EDIT (preserve current vitals, never
    // auto-heal), so without this the finished character keeps the DEFAULT-derived
    // vitals instead of full HP/MP and starting SAN for the CHOSEN characteristics.
    // `.st 定稿` re-derives current HP/MP/SAN to their maxima for the final sheet.
    client.sendInput(`.st 定稿`)
    setPendingName(trimmed)
    setCreateNote(tt(locale, "character.note.manualSent"))
    beginRoll("manual")
  }

  const submitPersona = () => {
    if (rolling) return
    const descriptionValue = descriptionRef.current.trim()
    if (!descriptionValue) {
      setCreateNote(tt(locale, "character.note.descriptionRequired"))
      return
    }
    const system = systemValueAt(systemIndex)
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
    const system = systemValueAt(systemIndex)
    const command = `.import ${path} ${system} pc`
    client.sendInput(command)
    setCreateNote(tt(locale, "character.note.sent", { command }))
    setPendingName(path.split("/").filter(Boolean).pop() ?? "")
    beginRoll("import")
  }

  const adjustManualAttr = (key: string, direction: number) => {
    const system = systemValueAt(systemIndex)
    const defs = manualAttrDefs(system)
    const def = defs.find((item) => item.key === key) ?? defs[0]
    const attrs = system === "dnd" ? manualDndAttrs : manualCocAttrs
    const current = attrs[def.key] ?? def.min
    const next = current + direction * def.step
    if (next < def.min || next > def.max) {
      setCreateNote(tt(locale, "character.note.attrAtLimit", { label: attrLabel(def.key, locale), min: def.min, max: def.max }))
      return
    }
    const setter = system === "dnd" ? setManualDndAttrs : setManualCocAttrs
    setter((prev) => ({ ...prev, [def.key]: next }))
    setCreateNote(undefined)
  }

  const submitTweak = () => {
    const text = tweakRef.current.trim()
    if (!text) return
    client.sendInput(`.st ${text}`)
    setTweakNote(tt(locale, "character.note.tweakSent", { text }))
    tweakRef.current = ""
    setTweakText("")
  }

  const enterCreate = () => {
    setDeleteArmed(false)
    setViewNote(undefined)
    setCreateModeIndex(0)
    setSystemIndex(0)
    setName("")
    setDescription("")
    setImportPath("")
    nameRef.current = ""
    descriptionRef.current = ""
    importPathRef.current = ""
    setCreateNote(undefined)
    setManualAttrIndex(0)
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
    const sequence = typeof (event as KeyEvent & { sequence?: unknown }).sequence === "string" ? (event as KeyEvent & { sequence: string }).sequence : ""

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
          const order = createFieldOrderFor(createModeAt(createModeIndex))
          const index = Math.max(0, order.indexOf(prev))
          const delta = event.shift ? order.length - 1 : 1
          return order[(index + delta) % order.length]
        })
      }
      if (createFocus === "attrs") {
        const system = systemValueAt(systemIndex)
        const defs = manualAttrDefs(system)
        if (key === "up" || key === "arrowup") setManualAttrIndex((prev) => Math.max(0, prev - 1))
        if (key === "down" || key === "arrowdown") setManualAttrIndex((prev) => Math.min(defs.length - 1, prev + 1))
        if (key === "left" || key === "arrowleft") adjustManualAttr(defs[manualAttrIndex]?.key ?? defs[0].key, -1)
        if (key === "right" || key === "arrowright") adjustManualAttr(defs[manualAttrIndex]?.key ?? defs[0].key, 1)
        if (key === "minus" || sequence === "-") adjustManualAttr(defs[manualAttrIndex]?.key ?? defs[0].key, -1)
        if (key === "plus" || key === "equal" || sequence === "+" || sequence === "=") {
          adjustManualAttr(defs[manualAttrIndex]?.key ?? defs[0].key, 1)
        }
        if (key === "return" || key === "enter") submitManual()
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

  const createMode = createModeAt(createModeIndex)
  const systemValue = systemValueAt(systemIndex)
  const manualDefs = manualAttrDefs(systemValue)
  const manualAttrs = systemValue === "dnd" ? manualDndAttrs : manualCocAttrs
  const manualMessages = manualValidation(systemValue, manualAttrs, locale)
  const rollLabels = rollLabelsFor(systemValue, locale)

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
        <box flexDirection="row" marginLeft={2}>
          <text fg={theme.accent}>{tt(locale, "character.title")}</text>
          <text fg={theme.dim}>
            {" · "}
            {stripControlChars(welcome.room)}
          </text>
        </box>
      </box>

      <box flexDirection="row" flexGrow={1} minHeight={8}>
        <box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          {mode === "view" ? (
            <>
              {viewActions.map((action, index) => (
                <box
                  key={action.label}
                  height={1}
                  backgroundColor={selected === index ? theme.accent : theme.bg}
                  onMouseOver={() => setSelected(index)}
                  onMouseDown={() => activateView(index)}
                >
                  <text fg={selected === index ? theme.bg : theme.fg}>
                    {selected === index ? `${CURSOR} ` : "  "}
                    {action.label}
                  </text>
                </box>
              ))}
              <box marginTop={1}>
                <text fg={theme.dim}>{tt(locale, "character.view.help")}</text>
              </box>
            </>
          ) : null}

          {mode === "create" ? (
            <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} width={72}>
              <text fg={theme.dim}>{tt(locale, "character.createIntro")}</text>

              <box flexDirection="column" marginTop={1} onMouseDown={() => setCreateFocus("method")}>
                <text fg={createFocus === "method" ? theme.accent : theme.dim}>{tt(locale, "character.method")}</text>
                <select
                  flexGrow={1}
                  height={8}
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
                <text fg={createFocus === "system" ? theme.accent : theme.dim}>{tt(locale, "character.system")}</text>
                <select
                  flexGrow={1}
                  height={4}
                  focused={createFocus === "system"}
                  options={SYSTEM_OPTIONS}
                  selectedIndex={systemIndex}
                  backgroundColor={theme.bg}
                  textColor={theme.fg}
                  focusedBackgroundColor={theme.bg}
                  focusedTextColor={theme.accent}
                  selectedBackgroundColor={theme.accent}
                  selectedTextColor={theme.bg}
                  descriptionColor={theme.dim}
                  selectedDescriptionColor={theme.bg}
                  onChange={(index: number) => {
                    setSystemIndex(index)
                    setManualAttrIndex(0)
                    setCreateNote(undefined)
                  }}
                  onSelect={() => setCreateFocus(createMode === "import" ? "importPath" : "name")}
                />
              </box>

              {createMode !== "import" ? (
                <box flexDirection="column" marginTop={1} onMouseDown={() => setCreateFocus("name")}>
                  <text fg={createFocus === "name" ? theme.accent : theme.dim}>{tt(locale, "character.name")}</text>
                  <input
                    flexGrow={1}
                    value={name}
                    focused={createFocus === "name"}
                    placeholder={systemValue === "dnd" ? tt(locale, "character.hero") : tt(locale, "character.investigator")}
                    onInput={(value: string) => {
                      nameRef.current = value
                      setName(value)
                    }}
                    onSubmit={createMode === "persona" ? submitPersona : createMode === "manual" ? submitManual : submitCreate}
                  />
                </box>
              ) : null}

              {createMode === "manual" ? (
                <box flexDirection="column" marginTop={1} onMouseDown={() => setCreateFocus("attrs")}>
                  <text fg={createFocus === "attrs" ? theme.accent : theme.dim}>{tt(locale, "character.attrs")}</text>
                  <text fg={manualMessages.length ? theme.fumble : theme.dim}>{manualBudgetText(systemValue, manualAttrs, locale)}</text>
                  {manualDefs.map((def, index) => {
                    const selectedAttr = createFocus === "attrs" && manualAttrIndex === index
                    const value = manualAttrs[def.key] ?? def.min
                    return (
                      <box
                        key={def.key}
                        flexDirection="row"
                        onMouseOver={() => setManualAttrIndex(index)}
                      >
                        <text fg={selectedAttr ? theme.accent : theme.fg}>
                          {selectedAttr ? `${CURSOR} ` : "  "}
                          {def.key.padEnd(3)} {attrLabel(def.key, locale).padEnd(2)} {String(value).padStart(2)}
                        </text>
                        <box marginLeft={1} paddingX={1} backgroundColor={theme.border} onMouseDown={() => adjustManualAttr(def.key, -1)}>
                          <text fg={theme.fg}>-</text>
                        </box>
                        <box marginLeft={1} paddingX={1} backgroundColor={theme.border} onMouseDown={() => adjustManualAttr(def.key, 1)}>
                          <text fg={theme.fg}>+</text>
                        </box>
                        <text fg={theme.dim}> {def.min}-{def.max}</text>
                      </box>
                    )
                  })}
                  {manualMessages.slice(0, 2).map((message) => (
                    <text key={message} fg={theme.fumble}>
                      {message}
                    </text>
                  ))}
                  <box marginTop={1} onMouseDown={submitManual} backgroundColor={theme.accent} paddingX={1}>
                    <text fg={theme.bg}>{tt(locale, "character.manualWrite")}</text>
                  </box>
                </box>
              ) : null}

              {createMode === "roll" ? (
                <box marginTop={1} onMouseDown={submitCreate} backgroundColor={theme.accent} paddingX={1}>
                  <text fg={theme.bg}>{rolling ? tt(locale, "character.rolling") : tt(locale, "character.roll")}</text>
                </box>
              ) : null}

              {createMode === "persona" ? (
                <box flexDirection="column" marginTop={1} onMouseDown={() => setCreateFocus("description")}>
                  <text fg={createFocus === "description" ? theme.accent : theme.dim}>{tt(locale, "character.description")}</text>
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
                  <text fg={createFocus === "importPath" ? theme.accent : theme.dim}>{tt(locale, "character.import")}</text>
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
                  <text fg={theme.dim}>{stripControlChars(createNote)}</text>
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
            <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} width={60}>
              <text fg={theme.dim}>{tt(locale, "character.tweakIntro")}</text>
              <box flexDirection="column" marginTop={1}>
                <text fg={theme.accent}>{tt(locale, "character.tweakCommand")}</text>
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
                  <text fg={theme.dim}>{stripControlChars(tweakNote)}</text>
                </box>
              ) : null}
              <box marginTop={1}>
                <text fg={theme.dim}>{tt(locale, "character.tweakHelp")}</text>
              </box>
            </box>
          ) : null}
        </box>

        <box width={32} flexDirection="column">
          {rolling ? (
            <box flexDirection="column" border borderColor={theme.accent} paddingX={1}>
              <text fg={theme.accent}>
                CHARACTER {landed ? `· ${tt(locale, "character.landed")}` : `· ${pendingLabel(pendingKind, locale)}`}
              </text>
              {landed ? (
                <>
                  <text fg={theme.success}>
                    {CURSOR} {stripControlChars(stateFrame.character?.name ?? pendingName)}
                  </text>
                  {attributeLines(stateFrame.character).map(({ key, line }) => (
                    <text key={key} fg={theme.success}>
                      {line}
                    </text>
                  ))}
                </>
              ) : (
                <>
                  <text fg={theme.accent}>
                    {DICE_GLYPHS[rollTick % DICE_GLYPHS.length]}{" "}
                    {stripControlChars(pendingName || tt(locale, "character.newCharacter"))}…
                  </text>
                  {pendingKind === "roll"
                    ? rollLabels.map((label, index) => (
                        <text key={label} fg={theme.accent}>
                          {label} {DICE_GLYPHS[(rollTick + index) % DICE_GLYPHS.length]}
                          {DICE_GLYPHS[(rollTick + index * 3 + 2) % DICE_GLYPHS.length]}
                        </text>
                      ))
                    : null}
                  {pendingKind === "manual"
                    ? manualDefs.map((def) => (
                        <text key={def.key} fg={theme.accent}>
                          {def.key} {manualAttrs[def.key] ?? def.min}
                        </text>
                      ))
                    : null}
                  {pendingKind === "persona" ? <text fg={theme.dim}>{tt(locale, "character.personaPending")}</text> : null}
                  {pendingKind === "import" ? <text fg={theme.dim}>{tt(locale, "character.importPending")}</text> : null}
                </>
              )}
            </box>
          ) : (
            <>
              <CharacterPanel character={stateFrame.character} theme={theme} locale={locale} />
              {stateFrame.character ? (
                <box flexDirection="column" border borderColor={theme.border} paddingX={1} marginTop={1}>
                  <text fg={theme.accent}>{tt(locale, "character.attributesTitle")}</text>
                  {attributeLines(stateFrame.character).map(({ key, line }) => (
                    <text key={key} fg={theme.fg}>
                      {line}
                    </text>
                  ))}
                </box>
              ) : null}
              {viewNote ? (
                <box marginTop={1}>
                  <text fg={deleteArmed ? theme.fumble : theme.dim}>{stripControlChars(viewNote)}</text>
                </box>
              ) : null}
            </>
          )}
        </box>
      </box>

      <StatusBar welcome={welcome} online={stateFrame.online} theme={theme} themeName={themeName} />
    </box>
  )
}

export default CharacterScreen
