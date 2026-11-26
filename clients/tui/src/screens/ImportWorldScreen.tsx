import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { stripControlChars } from "loreweaver-protocol/v3"
import { ImportForm } from "../components/ImportForm"
import { StatusBar } from "../components/StatusBar"
import type { Connection } from "../connection"
import { useSnapshot, viewData } from "../hooks"
import { tt } from "../i18n"
import type { Palette, ThemeName } from "../themes"

export interface ImportWorldScreenProps {
  connection: Connection
  theme: Palette
  themeName: ThemeName
  locale: string
  onBack: () => void
}

// The admin's "import a world card": the card's world machinery reaches the room only this way
// (`import {as: "world"}` is an admin command). The table hears one line, that a world was
// imported; the counts and what was left behind are for the admin alone, shown here.
export function ImportWorldScreen({ connection, theme, themeName, locale, onBack }: ImportWorldScreenProps) {
  const snapshot = useSnapshot(connection)
  const room = snapshot.welcome?.room.id ?? ""
  const online = (viewData(snapshot, "party")?.members ?? []).filter((member) => member.online).length

  useKeyboard((event: KeyEvent) => {
    if (typeof event.name === "string" && event.name.toLowerCase() === "escape") onBack()
  })

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
        <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} marginLeft={2}>
          <text fg={theme.accent} wrapMode="none" truncate>
            {tt(locale, "import.worldTitle")}
          </text>
          <text fg={theme.dim} wrapMode="none" truncate>
            {" · "}
            {stripControlChars(room)}
          </text>
        </box>
      </box>
      <scrollbox flexGrow={1} minHeight={8} viewportCulling={false}>
        <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} marginX={2} marginY={1} maxWidth={80} minWidth={0} flexShrink={0}>
          <ImportForm connection={connection} as="world" theme={theme} locale={locale} />
        </box>
      </scrollbox>
      <StatusBar room={room} online={online} locale={locale} theme={theme} themeName={themeName} />
    </box>
  )
}

export default ImportWorldScreen
