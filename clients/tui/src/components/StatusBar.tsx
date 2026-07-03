import { stripControlChars, type PresenceFrame, type WelcomeFrame } from "@loreweaver/protocol"
import { tt } from "../i18n"
import type { Palette, ThemeName } from "../themes"

export interface StatusBarProps {
  welcome?: WelcomeFrame
  presence?: PresenceFrame
  online: number
  theme: Palette
  themeName: ThemeName
}

export function StatusBar({ welcome, presence, online, theme, themeName }: StatusBarProps) {
  const room = stripControlChars(welcome?.room ?? tt(welcome?.locale, "status.notJoined"))
  const locale = stripControlChars(welcome?.locale ?? "--")
  const count = presence?.online ?? online
  return (
    <box height={1} backgroundColor={theme.border}>
      <text fg={theme.bg} bg={theme.border}>
        {room} · {count} {tt(welcome?.locale, "status.online")} · {locale} · {themeName} · F1-F5{" "}
        {tt(welcome?.locale, "status.theme")} · {tt(welcome?.locale, "status.help")}
      </text>
    </box>
  )
}
