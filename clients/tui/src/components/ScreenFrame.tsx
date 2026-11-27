import type { ReactNode } from "react"
import { stripControlChars } from "loreweaver-protocol/v3"
import type { Palette, ThemeName } from "../themes"
import { StatusBar } from "./StatusBar"

export interface ScreenFrameProps {
  /** The heading after the wordmark. */
  title: string
  room: string
  online: number
  locale: string
  theme: Palette
  themeName: ThemeName
  children: ReactNode
}

/** The shell the admin screens share: the wordmark and title, a scrolling body, the status bar. */
export function ScreenFrame({ title, room, online, locale, theme, themeName, children }: ScreenFrameProps) {
  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
        <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} marginLeft={2}>
          <text fg={theme.accent} wrapMode="none" truncate>
            {title}
          </text>
          <text fg={theme.dim} wrapMode="none" truncate>
            {" · "}
            {stripControlChars(room)}
          </text>
        </box>
      </box>
      <scrollbox flexGrow={1} flexShrink={1} minHeight={8} minWidth={0} viewportCulling={false}>
        <box flexDirection="column" width="100%" minWidth={0} paddingX={2} paddingY={1} flexShrink={0}>
          {children}
        </box>
      </scrollbox>
      <StatusBar room={room} online={online} locale={locale} theme={theme} themeName={themeName} />
    </box>
  )
}

export default ScreenFrame
