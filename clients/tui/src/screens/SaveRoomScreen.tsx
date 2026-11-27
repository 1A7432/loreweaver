import { useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { ScreenFrame } from "../components/ScreenFrame"
import { Spinner } from "../components/Spinner"
import type { Connection } from "../connection"
import { useSnapshot, viewData } from "../hooks"
import { tt } from "../i18n"
import { saveRoom, type SaveOutcome } from "../save"
import type { Palette, ThemeName } from "../themes"

export interface SaveRoomScreenProps {
  connection: Connection
  theme: Palette
  themeName: ThemeName
  locale: string
  /** Where the file goes; `~/.loreweaver/saves` when absent (tests hand in a folder of their own). */
  saveDir?: string
  onBack: () => void
}

/**
 * The admin's "Save the room to a file": one action, Enter. The room comes back in the answer
 * to `save {op: "export"}` and is written under `~/.loreweaver/saves`; this screen tells the
 * path. Nothing of the room is shown or logged here: a save holds every secret.
 */
export function SaveRoomScreen({ connection, theme, themeName, locale, saveDir, onBack }: SaveRoomScreenProps) {
  const snapshot = useSnapshot(connection)
  const isAdmin = snapshot.welcome?.you.role === "admin"
  const room = snapshot.welcome?.room.id ?? ""
  const online = (viewData(snapshot, "party")?.members ?? []).filter((member) => member.online).length
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [outcome, setOutcome] = useState<SaveOutcome>()

  const save = async () => {
    if (busyRef.current || !isAdmin) return
    busyRef.current = true
    setBusy(true)
    setOutcome(undefined)
    try {
      setOutcome(await saveRoom(connection, { locale, ...(saveDir ? { dir: saveDir } : {}) }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  useKeyboard((event: KeyEvent) => {
    const key = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (key === "escape" && !busyRef.current) onBack()
    if ((key === "return" || key === "enter") && isAdmin) void save()
  })

  return (
    <ScreenFrame title={tt(locale, "save.title")} room={room} online={online} locale={locale} theme={theme} themeName={themeName}>
      {isAdmin ? (
        <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} width="100%" maxWidth={80} minWidth={0} flexShrink={0}>
          <text fg={theme.fg}>{tt(locale, "save.intro")}</text>
          <box marginTop={1}>
            <text fg={theme.fumble}>{tt(locale, "save.secret")}</text>
          </box>
          <box marginTop={1} onMouseDown={() => void save()} backgroundColor={theme.accent} paddingX={1}>
            <text fg={theme.bg}>{tt(locale, "save.button")}</text>
          </box>
          <box marginTop={1}>
            <text fg={theme.dim}>{tt(locale, "save.help")}</text>
          </box>
        </box>
      ) : (
        <text fg={theme.fumble}>{tt(locale, "admin.onlyAdmins")}</text>
      )}
      {outcome ? (
        <box marginTop={1} minWidth={0}>
          <text fg={outcome.ok ? theme.success : theme.fumble}>{outcome.text}</text>
        </box>
      ) : null}
      {busy ? (
        <box marginTop={1}>
          <Spinner active label={tt(locale, "save.working")} color={theme.accent} />
        </box>
      ) : null}
    </ScreenFrame>
  )
}

export default SaveRoomScreen
