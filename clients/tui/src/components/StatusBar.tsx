import { stripControlChars } from "loreweaver-protocol/v3"
import { tt } from "../i18n"
import type { Palette, ThemeName } from "../themes"

export interface StatusBarProps {
  /** The room id from the welcome; absent before one. */
  room?: string
  // The caller's online count, from the `party` view — the same source the header reads, so the
  // two can never disagree.
  online: number
  /** This client's language. */
  locale: string
  theme: Palette
  themeName: ThemeName
}

export function StatusBar({ room, online, locale, theme, themeName }: StatusBarProps) {
  const label = room ? stripControlChars(room) : tt(locale, "status.notJoined")
  return (
    <box height={1} backgroundColor={theme.border}>
      <text fg={theme.bg} bg={theme.border} wrapMode="none" truncate>
        {label} · {online} {tt(locale, "status.online")} · {locale} · {themeName} · F1-F5 {tt(locale, "status.theme")} ·{" "}
        {tt(locale, "status.help")}
      </text>
    </box>
  )
}
