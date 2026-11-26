import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { stripControlChars } from "loreweaver-protocol/v3"
import { StatusBar } from "../components/StatusBar"
import type { Connection } from "../connection"
import { useSnapshot, viewData } from "../hooks"
import { tt, type TuiLocale } from "../i18n"
import { themeOrder, type Palette, type ThemeName } from "../themes"
import { roleLabel } from "./MainMenu"

// A real settings screen (the menu item used to just flash a note). Language and theme
// apply live; both are shell-owned so the choice persists across screens. Keyboard: ↑↓
// pick a theme + Enter applies, ←/→ switch language, Esc goes back — mouse works too.
export interface SettingsScreenProps {
  connection: Connection
  theme: Palette
  themeName: ThemeName
  locale: string
  onLocaleChange: (locale: TuiLocale) => void
  onThemeChange: (name: ThemeName) => void
  onBack: () => void
}

const CURSOR = "⚄"

export function SettingsScreen({
  connection,
  theme,
  themeName,
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

  const snapshot = useSnapshot(connection)
  const welcome = snapshot.welcome
  const room = viewData(snapshot, "room")
  const online = (viewData(snapshot, "party")?.members ?? []).filter((member) => member.online).length

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
        {/* The server took this client's language from `hello`; it changes on the next connect. */}
        {locale !== connection.locale ? (
          <box marginBottom={1}>
            <text fg={theme.fail}>{tt(locale, "settings.languageNextConnect")}</text>
          </box>
        ) : (
          <box marginBottom={1}>
            <text fg={theme.dim}>{tt(locale, "settings.languageNote")}</text>
          </box>
        )}

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
              name: stripControlChars(welcome?.you.name ?? ""),
              room: stripControlChars(welcome?.room.id ?? ""),
              role: roleLabel(snapshot, locale),
            })}
          </text>
        </box>
        {room ? (
          <box>
            <text fg={theme.dim}>
              {tt(locale, "settings.room", {
                language: stripControlChars(room.localeLabel),
                system: room.system ? stripControlChars(room.system.label) : tt(locale, "settings.noSystem"),
              })}
            </text>
          </box>
        ) : null}

        <box marginTop={1}>
          <text fg={theme.dim}>{tt(locale, "settings.help")}</text>
        </box>
      </box>

      <StatusBar room={welcome?.room.id} online={online} locale={locale} theme={theme} themeName={themeName} />
    </box>
  )
}

export default SettingsScreen
