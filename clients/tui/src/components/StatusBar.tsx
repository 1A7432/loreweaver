import type { PresenceFrame, WelcomeFrame } from "@trpg-kp/protocol"
import type { Palette, ThemeName } from "../themes"

export interface StatusBarProps {
  welcome?: WelcomeFrame
  presence?: PresenceFrame
  online: number
  theme: Palette
  themeName: ThemeName
}

export function StatusBar({ welcome, presence, online, theme, themeName }: StatusBarProps) {
  const room = welcome?.room ?? "not joined"
  const locale = welcome?.locale ?? "--"
  const count = presence?.online ?? online
  return (
    <box height={1} backgroundColor={theme.border}>
      <text fg={theme.bg} bg={theme.border}>
        {room} · {count} online · {locale} · {themeName} · F1-F4 theme · ? help
      </text>
    </box>
  )
}

