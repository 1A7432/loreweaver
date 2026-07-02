import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent, SelectOption } from "@opentui/core"
import { stripControlChars, type StateFrame, type WelcomeFrame } from "@trpg-kp/protocol"
import { CharacterPanel } from "../components/CharacterPanel"
import { attributeLines } from "../components/characterAttributes"
import { StatusBar } from "../components/StatusBar"
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
type CreateField = "system" | "name"

interface ViewAction {
  label: string
  run: () => void
}

const CURSOR = "⚄"
const DICE_GLYPHS = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"]
const CREATE_FIELD_ORDER: CreateField[] = ["system", "name"]

// The roll flicker ticks at a fixed cadence and is capped at ROLL_MAX_TICKS so a
// slow/never-arriving reply can't spin forever-looking (still "rolling", just
// frozen on its last die face) — bounded per the design brief. Landing itself is
// never gated by this: it fires as soon as the awaited character actually changes.
const ROLL_TICK_MS = 110
const ROLL_MAX_TICKS = 48
const LAND_FLOURISH_MS = 420

const SYSTEM_OPTIONS: SelectOption[] = [
  { name: "CoC 7 版", description: "克苏鲁的呼唤 · 7th Edition", value: "coc" },
  { name: "D&D 5e", description: "龙与地下城 第五版", value: "dnd" },
]

const COC_ROLL_LABELS = ["力量", "体质", "体型", "敏捷", "外貌", "智力", "意志", "教育"]
const DND_ROLL_LABELS = ["力量", "敏捷", "体质", "智力", "感知", "魅力"]

// Identity, not reference: `net/state.py` rebuilds a brand-new `character` dict on
// *every* state frame (any room event), so a reference check alone would treat an
// unrelated broadcast as "the roll landed". Comparing content catches the case a
// reroll happens to keep the same name (isolated flicker, not a real bug).
function characterSignature(character?: CharacterState): string {
  return character ? JSON.stringify(character) : ""
}

function rollLabelsFor(systemValue: unknown): string[] {
  return systemValue === "dnd" ? DND_ROLL_LABELS : COC_ROLL_LABELS
}

export function CharacterScreen({ client, theme, themeName, welcome, stateFrame, onBack }: CharacterScreenProps) {
  const hasCharacter = Boolean(stateFrame.character)
  const [mode, setMode] = useState<Mode>(hasCharacter ? "view" : "create")
  const [selected, setSelected] = useState(0)

  // Create-flow fields (Tab-focus + ref-mirrored inputs, copied from ConnectScreen
  // so submit always reads the latest typed value regardless of render timing).
  const [systemIndex, setSystemIndex] = useState(0)
  const [name, setName] = useState("")
  const [createFocus, setCreateFocus] = useState<CreateField>("system")
  const nameRef = useRef(name)
  const [pendingName, setPendingName] = useState("")

  // Signature stat-roll reveal: the roll itself happens server-side (dice-first),
  // so this is purely a client-side "tumbling dice" flicker that plays while
  // awaiting the refreshed `state` frame, then settles once the character the
  // frame carries actually changes (see `characterSignature`).
  const [rolling, setRolling] = useState(false)
  const [landed, setLanded] = useState(false)
  const [rollTick, setRollTick] = useState(0)
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
      setMode("view")
      setSelected(0)
    }, LAND_FLOURISH_MS)
  }, [rolling, stateFrame.character])

  const beginRoll = () => {
    rollStartSignatureRef.current = characterSignature(stateFrame.character)
    setLanded(false)
    setRollTick(0)
    setRolling(true)
    stopRollInterval()
    rollIntervalRef.current = setInterval(() => {
      setRollTick((tick) => (tick + 1 >= ROLL_MAX_TICKS ? tick : tick + 1))
    }, ROLL_TICK_MS)
  }

  const submitCreate = () => {
    if (rolling) return
    const system = String(SYSTEM_OPTIONS[systemIndex]?.value ?? "coc")
    const trimmed = nameRef.current.trim()
    client.sendInput(trimmed ? `.${system} ${trimmed}` : `.${system}`)
    setPendingName(trimmed)
    beginRoll()
  }

  const submitTweak = () => {
    const text = tweakRef.current.trim()
    if (!text) return
    client.sendInput(`.st ${text}`)
    setTweakNote(`已发送 → .st ${text}`)
    tweakRef.current = ""
    setTweakText("")
  }

  const enterCreate = () => {
    setSystemIndex(0)
    setName("")
    nameRef.current = ""
    setCreateFocus("system")
    setMode("create")
  }

  const enterTweak = () => {
    setTweakText("")
    tweakRef.current = ""
    setTweakNote(undefined)
    setMode("tweak")
  }

  const viewActions: ViewAction[] = [
    { label: "重掷 / 新建", run: enterCreate },
    { label: "微调", run: enterTweak },
    { label: "返回", run: onBack },
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
  }

  // Scoped to this screen and further scoped by `mode`, so it can't fight the
  // menu's own arrow handling or a focused create/tweak-flow input/select.
  useKeyboard((event: KeyEvent) => {
    const key = typeof event.name === "string" ? event.name.toLowerCase() : ""

    if (mode === "view") {
      if (key === "up") setSelected((prev) => clampView(prev - 1))
      if (key === "down") setSelected((prev) => clampView(prev + 1))
      if (key === "return" || key === "enter") activateView(selected)
      if (key === "escape") onBack()
      return
    }

    if (mode === "create") {
      if (key === "tab") {
        setCreateFocus((prev) => {
          const index = CREATE_FIELD_ORDER.indexOf(prev)
          const delta = event.shift ? CREATE_FIELD_ORDER.length - 1 : 1
          return CREATE_FIELD_ORDER[(index + delta) % CREATE_FIELD_ORDER.length]
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

  const rollLabels = rollLabelsFor(SYSTEM_OPTIONS[systemIndex]?.value)

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={3} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="TRPG KP" font="tiny" color={theme.accent} />
        <box flexDirection="row" marginLeft={2}>
          <text fg={theme.accent}>我的角色</text>
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
                <text fg={theme.dim}>↑↓ 选择 · Enter 确认 · Esc 返回菜单</text>
              </box>
            </>
          ) : null}

          {mode === "create" ? (
            <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} width={60}>
              <text fg={theme.dim}>选规则系统 → 输姓名 → 提交后当场掷属性</text>

              <box flexDirection="column" marginTop={1} onMouseDown={() => setCreateFocus("system")}>
                <text fg={createFocus === "system" ? theme.accent : theme.dim}>规则系统</text>
                <select
                  flexGrow={1}
                  height={6}
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
                  onChange={(index: number) => setSystemIndex(index)}
                  onSelect={() => setCreateFocus("name")}
                />
              </box>

              <box flexDirection="column" marginTop={1} onMouseDown={() => setCreateFocus("name")}>
                <text fg={createFocus === "name" ? theme.accent : theme.dim}>姓名（留空用默认）</text>
                <input
                  flexGrow={1}
                  value={name}
                  focused={createFocus === "name"}
                  placeholder={SYSTEM_OPTIONS[systemIndex]?.value === "dnd" ? "英雄" : "调查员"}
                  onInput={(value: string) => {
                    nameRef.current = value
                    setName(value)
                  }}
                  onSubmit={submitCreate}
                />
              </box>

              <box marginTop={1} onMouseDown={submitCreate} backgroundColor={theme.accent} paddingX={1}>
                <text fg={theme.bg}>{rolling ? "⚄ 掷骰中…" : "⚄ 建卡"}</text>
              </box>

              <box marginTop={1}>
                <text fg={theme.dim}>Tab 切换字段 · Enter 确认 · Esc {hasCharacter ? "返回查看" : "返回菜单"}</text>
              </box>
            </box>
          ) : null}

          {mode === "tweak" ? (
            <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} width={60}>
              <text fg={theme.dim}>格式:属性名+新值,空格连写多组,如 力量60 侦查70</text>
              <box flexDirection="column" marginTop={1}>
                <text fg={theme.accent}>微调指令</text>
                <input
                  flexGrow={1}
                  value={tweakText}
                  focused
                  placeholder="力量60 侦查70"
                  onInput={(value: string) => {
                    tweakRef.current = value
                    setTweakText(value)
                  }}
                  onSubmit={submitTweak}
                />
              </box>
              <box marginTop={1} onMouseDown={submitTweak} backgroundColor={theme.accent} paddingX={1}>
                <text fg={theme.bg}>⚄ 应用</text>
              </box>
              {tweakNote ? (
                <box marginTop={1}>
                  <text fg={theme.dim}>{stripControlChars(tweakNote)}</text>
                </box>
              ) : null}
              <box marginTop={1}>
                <text fg={theme.dim}>Enter 应用 · Esc 返回查看</text>
              </box>
            </box>
          ) : null}
        </box>

        <box width={32} flexDirection="column">
          {rolling ? (
            <box flexDirection="column" border borderColor={theme.accent} paddingX={1}>
              <text fg={theme.accent}>CHARACTER {landed ? "· 落定" : "· 掷骰中"}</text>
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
                    {CURSOR} {stripControlChars(pendingName || "新的角色")}…
                  </text>
                  {rollLabels.map((label, index) => (
                    <text key={label} fg={theme.accent}>
                      {label} {DICE_GLYPHS[(rollTick + index) % DICE_GLYPHS.length]}
                      {DICE_GLYPHS[(rollTick + index * 3 + 2) % DICE_GLYPHS.length]}
                    </text>
                  ))}
                </>
              )}
            </box>
          ) : (
            <>
              <CharacterPanel character={stateFrame.character} theme={theme} />
              {stateFrame.character ? (
                <box flexDirection="column" border borderColor={theme.border} paddingX={1} marginTop={1}>
                  <text fg={theme.accent}>属性 / ATTRIBUTES</text>
                  {attributeLines(stateFrame.character).map(({ key, line }) => (
                    <text key={key} fg={theme.fg}>
                      {line}
                    </text>
                  ))}
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
