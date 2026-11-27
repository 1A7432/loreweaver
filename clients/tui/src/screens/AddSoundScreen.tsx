import { stripControlChars } from "loreweaver-protocol/v3"
import { ShareForm } from "../components/ShareForm"
import { StatusBar } from "../components/StatusBar"
import type { Connection } from "../connection"
import { useSnapshot, viewData } from "../hooks"
import { tt } from "../i18n"
import type { Palette, ThemeName } from "../themes"

export interface AddSoundScreenProps {
  connection: Connection
  theme: Palette
  themeName: ThemeName
  locale: string
  onBack: () => void
}

// The admin's "add a sound": the upload form with `purpose: "audio"`. The sound joins the room's
// audio library (the `audio` view) under its file name; `.bgm play <title>` plays it.
export function AddSoundScreen({ connection, theme, themeName, locale, onBack }: AddSoundScreenProps) {
  const snapshot = useSnapshot(connection)
  const room = snapshot.welcome?.room.id ?? ""
  const online = (viewData(snapshot, "party")?.members ?? []).filter((member) => member.online).length

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
        <box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} marginLeft={2}>
          <text fg={theme.accent} wrapMode="none" truncate>
            {tt(locale, "menu.addSound")}
          </text>
          <text fg={theme.dim} wrapMode="none" truncate>
            {" · "}
            {stripControlChars(room)}
          </text>
        </box>
      </box>
      <box flexGrow={1} minHeight={8} paddingX={2} paddingY={1}>
        <ShareForm connection={connection} theme={theme} locale={locale} purpose="audio" onClose={onBack} />
      </box>
      <StatusBar room={room} online={online} locale={locale} theme={theme} themeName={themeName} />
    </box>
  )
}

export default AddSoundScreen
