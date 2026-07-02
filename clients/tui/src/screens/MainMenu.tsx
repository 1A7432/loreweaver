import { Fragment, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { stripControlChars, type PresenceFrame, type StateFrame, type WelcomeFrame } from "@trpg-kp/protocol"
import { CharacterPanel } from "../components/CharacterPanel"
import { PartyPanel } from "../components/PartyPanel"
import { ScenePanel } from "../components/ScenePanel"
import { StatusBar } from "../components/StatusBar"
import type { Palette, ThemeName } from "../themes"

export interface MainMenuProps {
  welcome: WelcomeFrame
  theme: Palette
  themeName: ThemeName
  stateFrame: StateFrame
  presence?: PresenceFrame
  onEnterGame: () => void
  onCharacter: () => void
}

interface MenuItem {
  label: string
  keeper: boolean
  run: () => void
}

// The selection cursor is the die glyph (a signature nod to the dice-first rule),
// not a generic ▶.
const CURSOR = "⚄"

export function MainMenu({ welcome, theme, themeName, stateFrame, presence, onEnterGame, onCharacter }: MainMenuProps) {
  const [selected, setSelected] = useState(0)
  const [note, setNote] = useState<string>()
  const isKeeper = welcome.you.role === "keeper"

  const items: MenuItem[] = [
    { label: "进入游戏", keeper: false, run: () => onEnterGame() },
    { label: "我的角色", keeper: false, run: () => onCharacter() },
    {
      label: "设置",
      keeper: false,
      run: () => setNote(`设置 · 主题 F1–F5 切换（当前 ${themeName}）· 昵称 ${stripControlChars(welcome.you.name)}`),
    },
  ]
  if (isKeeper) {
    items.push(
      { label: "房间与邀请", keeper: true, run: () => setNote("房间与邀请 · 即将推出（第三阶段）") },
      { label: "导入模组", keeper: true, run: () => setNote("导入模组 · 即将推出（第四阶段）") },
      { label: "模型 / 配置", keeper: true, run: () => setNote("模型 / 配置 · 即将推出（第三阶段）") },
    )
  }

  const clamp = (index: number) => Math.max(0, Math.min(items.length - 1, index))
  const activate = (index: number) => {
    const target = clamp(index)
    setSelected(target)
    items[target]?.run()
  }

  // Scoped to the menu (mounted only here) so it can't fight the connect screen's
  // Tab handling or a focused input. Arrows move the shared cursor, Enter activates.
  useKeyboard((event: KeyEvent) => {
    const keyName = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (keyName === "up") setSelected((prev) => clamp(prev - 1))
    if (keyName === "down") setSelected((prev) => clamp(prev + 1))
    if (keyName === "return" || keyName === "enter") activate(selected)
  })

  const firstKeeperIndex = items.findIndex((item) => item.keeper)

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      {/* A bordered height-3 header exposes a single content row, so the room +
          role sit side by side on one line (two stacked lines would overlap). */}
      <box height={3} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="TRPG KP" font="tiny" color={theme.accent} />
        <box flexDirection="row" marginLeft={2}>
          <text fg={theme.accent}>牌桌「{stripControlChars(welcome.room)}」</text>
          <text fg={theme.dim}>
            {" · "}
            {stripControlChars(welcome.you.name)} · {welcome.you.role === "keeper" ? "守秘人" : "调查员"}
          </text>
        </box>
      </box>

      <box flexDirection="row" flexGrow={1} minHeight={8}>
        <box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          {items.map((item, index) => (
            <Fragment key={item.label}>
              {index === firstKeeperIndex ? (
                <box marginTop={1}>
                  <text fg={theme.fumble}>── 守秘人 ──</text>
                </box>
              ) : null}
              <box
                height={1}
                backgroundColor={selected === index ? theme.accent : theme.bg}
                onMouseOver={() => setSelected(index)}
                onMouseDown={() => activate(index)}
              >
                <text fg={selected === index ? theme.bg : theme.fg}>
                  {selected === index ? `${CURSOR} ` : "  "}
                  {item.label}
                </text>
              </box>
            </Fragment>
          ))}

          {note ? (
            <box marginTop={1} border borderColor={theme.border} paddingX={1}>
              <text fg={theme.dim}>{note}</text>
            </box>
          ) : null}
        </box>

        <box width={32} flexDirection="column">
          <CharacterPanel character={stateFrame.character} theme={theme} />
          <PartyPanel party={stateFrame.party} initiative={stateFrame.initiative} theme={theme} />
          <ScenePanel scene={stateFrame.scene} clock={stateFrame.clock} theme={theme} />
        </box>
      </box>

      <StatusBar welcome={welcome} presence={presence} online={stateFrame.online} theme={theme} themeName={themeName} />
    </box>
  )
}

export default MainMenu
