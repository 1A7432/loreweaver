import { stripControlChars, type WelcomeFrame } from "@loreweaver/protocol"
import { tt } from "../i18n"
import type { Palette, ThemeName } from "../themes"

export interface StatusBarProps {
  welcome?: WelcomeFrame
  // The caller's single merged online count — the status bar must never derive
  // its own from a different frame source than the header (they'd disagree
  // after a disconnect).
  online: number
  theme: Palette
  themeName: ThemeName
}

export function StatusBar({ welcome, online, theme, themeName }: StatusBarProps) {
  const room = stripControlChars(welcome?.room ?? tt(welcome?.locale, "status.notJoined"))
  const locale = stripControlChars(welcome?.locale ?? "--")
  const count = online
  return (
    <box height={1} backgroundColor={theme.border}>
      <text fg={theme.bg} bg={theme.border} wrapMode="none" truncate>
        {room} · {count} {tt(welcome?.locale, "status.online")} · {locale} · {themeName} · F1-F5{" "}
        {tt(welcome?.locale, "status.theme")} · {tt(welcome?.locale, "status.help")}
      </text>
    </box>
  )
}
