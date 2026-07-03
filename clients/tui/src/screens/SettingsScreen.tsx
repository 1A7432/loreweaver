import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { stripControlChars, type StateFrame, type WelcomeFrame } from "@loreweaver/protocol"
import { StatusBar } from "../components/StatusBar"
import { tt, type TuiLocale } from "../i18n"
import { themeOrder, type Palette, type ThemeName } from "../themes"

// A real settings screen (the menu item used to just flash a note). Language and theme
// apply live; both are shell-owned so the choice persists across screens. Keyboard: ↑↓
// pick a theme + Enter applies, ←/→ switch language, Esc goes back — mouse works too.
export interface SettingsScreenProps {
  theme: Palette
  themeName: ThemeName
  welcome: WelcomeFrame
  stateFrame: StateFrame
  locale: string
  onLocaleChange: (locale: TuiLocale) => void
  onThemeChange: (name: ThemeName) => void
  onBack: () => void
}

const CURSOR = "⚄"

export function SettingsScreen({
  theme,
  themeName,
  welcome,
  stateFrame,
  locale,
  onLocaleChange,
  onThemeChange,
  onBack,
}: SettingsScreenProps) {
  const [selected, setSelected] = useState(Math.max(0, themeOrder.indexOf(themeName)))
  const clamp = (index: number) => Math.max(0, Math.min(themeOrder.length - 1, index))

  useKeyboard((event: KeyEvent) => {
    const keyName = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (keyName === "escape") {
      onBack()
      return
    }
    if (keyName === "up") setSelected((prev) => clamp(prev - 1))
    if (keyName === "down") setSelected((prev) => clamp(prev + 1))
    if (keyName === "return" || keyName === "enter") onThemeChange(themeOrder[clamp(selected)])
    if (keyName === "left") onLocaleChange("en")
    if (keyName === "right") onLocaleChange("zh")
  })

  const roleLabel = welcome.you.role === "keeper" ? tt(locale, "menu.role.keeper") : tt(locale, "menu.role.player")

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
        <box flexDirection="row" marginLeft={2}>
          <text fg={theme.accent}>{tt(locale, "settings.title")}</text>
        </box>
      </box>

      <box flexDirection="column" flexGrow={1} minHeight={8} paddingX={2} paddingY={1}>
        {/* Language */}
        <box flexDirection="row" marginBottom={1}>
          <text fg={theme.dim}>{tt(locale, "connect.language")}{"  "}</text>
          <box onMouseDown={() => onLocaleChange("en")} backgroundColor={locale === "en" ? theme.accent : theme.bg} paddingX={1}>
            <text fg={locale === "en" ? theme.bg : theme.fg}>English</text>
          </box>
          <text>{" "}</text>
          <box onMouseDown={() => onLocaleChange("zh")} backgroundColor={locale === "zh" ? theme.accent : theme.bg} paddingX={1}>
            <text fg={locale === "zh" ? theme.bg : theme.fg}>中文</text>
          </box>
        </box>

        {/* Theme */}
        <text fg={theme.dim}>{tt(locale, "settings.theme")}</text>
        {themeOrder.map((name, index) => (
          <box
            key={name}
            onMouseDown={() => {
              setSelected(index)
              onThemeChange(name)
            }}
          >
            <text fg={name === themeName ? theme.accent : index === selected ? theme.fg : theme.dim}>
              {name === themeName ? `${CURSOR} ` : index === selected ? "› " : "  "}
              {name}
              {name === themeName ? ` ${tt(locale, "settings.current")}` : ""}
            </text>
          </box>
        ))}

        {/* Connection — read-only */}
        <box marginTop={1}>
          <text fg={theme.dim}>
            {tt(locale, "settings.you", {
              name: stripControlChars(welcome.you.name),
              room: stripControlChars(welcome.room),
              role: roleLabel,
            })}
          </text>
        </box>

        <box marginTop={1}>
          <text fg={theme.dim}>{tt(locale, "settings.help")}</text>
        </box>
      </box>

      <StatusBar welcome={welcome} online={stateFrame.online} theme={theme} themeName={themeName} />
    </box>
  )
}

export default SettingsScreen
