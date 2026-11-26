import { useRef, useState } from "react"
import { stripControlChars } from "loreweaver-protocol/v3"
import type { Connection } from "../connection"
import { useConnectionState, useSnapshot } from "../hooks"
import { tt } from "../i18n"
import { MAX_UPLOAD_BYTES, readLocalFile } from "../media"
import type { Palette } from "../themes"
import { percent, transferErrorText, uploadBlocked } from "../transfer"

export interface ImportFormProps {
  connection: Connection
  /** `character`: the card becomes this member's character. `world`: the room's world (an admin's). */
  as: "character" | "world"
  theme: Palette
  locale: string
  /** Whether the path field owns the keyboard. */
  focused?: boolean
}

const MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))

type Outcome = { readonly ok: boolean; readonly text: string }

/**
 * Import a card file from this computer: a PNG card or a card as JSON, read after its size and
 * type are checked, uploaded with `purpose: "import"` (stored where no player can fetch it, never
 * shown to the table), then `import {file: <hash>, as}`. The command's answer — what was imported
 * and what was left behind — shows here, to this person.
 */
export function ImportForm({ connection, as, theme, locale, focused = true }: ImportFormProps) {
  const snapshot = useSnapshot(connection)
  const state = useConnectionState(connection)
  const blocked = uploadBlocked(snapshot)
  const [path, setPath] = useState("")
  const pathRef = useRef("")
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome>()

  const submit = async () => {
    if (busy || blocked !== null) return
    setBusy(true)
    setOutcome(undefined)
    try {
      const file = await readLocalFile(pathRef.current, "card")
      const stored = await connection.upload(file, "import")
      const result = await connection.runCommand("import", { file: stored.hash, as })
      if (result === null) setOutcome({ ok: false, text: tt(locale, "log.notConnected") })
      else if (!result.ok) setOutcome({ ok: false, text: stripControlChars(result.error.message) })
      else setOutcome({ ok: true, text: stripControlChars(result.text ?? tt(locale, "import.done")) })
    } catch (caught) {
      setOutcome({ ok: false, text: transferErrorText(caught, locale, MB) })
    } finally {
      setBusy(false)
    }
  }

  const upload = state.upload
  return (
    <box flexDirection="column" width="100%" minWidth={0} flexShrink={0}>
      <text fg={theme.dim}>{tt(locale, as === "world" ? "import.worldIntro" : "import.characterIntro")}</text>
      {blocked !== null ? (
        <text fg={theme.fumble}>{tt(locale, blocked)}</text>
      ) : (
        <box flexDirection="column" marginTop={1}>
          <text fg={focused ? theme.accent : theme.dim} wrapMode="none" truncate>
            {tt(locale, "import.path")}
          </text>
          <input
            flexGrow={1}
            value={path}
            focused={focused && !busy}
            placeholder={tt(locale, "import.placeholder")}
            onInput={(value: string) => {
              pathRef.current = value
              setPath(value)
            }}
            onSubmit={() => void submit()}
          />
        </box>
      )}
      {busy ? (
        <text fg={theme.dim} wrapMode="none" truncate>
          {upload !== null ? tt(locale, "upload.progress", { name: stripControlChars(upload.name), percent: percent(upload.sent, upload.size) }) : tt(locale, "import.working")}
        </text>
      ) : null}
      {outcome ? (
        <box marginTop={1} minWidth={0}>
          <text fg={outcome.ok ? theme.success : theme.fumble}>{outcome.text}</text>
        </box>
      ) : null}
      <box marginTop={1}>
        <text fg={theme.dim}>{tt(locale, "import.help", { mb: MB })}</text>
      </box>
    </box>
  )
}
