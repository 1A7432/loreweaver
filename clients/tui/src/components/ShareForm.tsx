import { useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { stripControlChars } from "loreweaver-protocol/v3"
import type { Connection } from "../connection"
import { useConnectionState, useSnapshot } from "../hooks"
import { tt } from "../i18n"
import { MAX_UPLOAD_BYTES, readLocalFile } from "../media"
import type { Palette } from "../themes"
import { percent, transferErrorText, uploadBlocked } from "../transfer"

export interface ShareFormProps {
  connection: Connection
  theme: Palette
  locale: string
  onClose: () => void
}

const MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))

/**
 * Share a picture from this computer with the table: a path typed here is read (after its size
 * and type are checked), offered with `purpose: "share"` and sent over the byte channel; the
 * server then shows it to everyone as a `media` event. When this member may not upload, the form
 * says why instead of offering the field. Esc closes it.
 */
export function ShareForm({ connection, theme, locale, onClose }: ShareFormProps) {
  const snapshot = useSnapshot(connection)
  const state = useConnectionState(connection)
  const blocked = uploadBlocked(snapshot)
  const [path, setPath] = useState("")
  const pathRef = useRef("")
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useKeyboard((event: KeyEvent) => {
    const name = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (name === "escape") onClose()
  })

  const submit = async () => {
    if (busy || blocked !== null) return
    setBusy(true)
    setError(undefined)
    try {
      const file = await readLocalFile(pathRef.current, "image")
      const stored = await connection.upload(file, "share")
      connection.note({ kind: "result", level: "info", text: tt(locale, "share.done", { name: stripControlChars(stored.name) }) })
      onClose()
    } catch (caught) {
      setError(transferErrorText(caught, locale, MB))
    } finally {
      setBusy(false)
    }
  }

  const upload = state.upload
  return (
    <box flexDirection="column" border borderColor={theme.accent} paddingX={1} backgroundColor={theme.bg} width="100%" flexShrink={0}>
      <text fg={theme.accent} wrapMode="none" truncate>
        {tt(locale, "share.title")}
      </text>
      {blocked !== null ? (
        <text fg={theme.fumble}>{tt(locale, blocked)}</text>
      ) : (
        <box flexDirection="row" height={1}>
          <text fg={theme.dim}>{tt(locale, "share.path")} </text>
          <input
            flexGrow={1}
            minWidth={0}
            value={path}
            focused={!busy}
            placeholder={tt(locale, "share.placeholder")}
            onInput={(value: string) => {
              pathRef.current = value
              setPath(value)
            }}
            onSubmit={() => void submit()}
          />
        </box>
      )}
      {upload !== null && upload.purpose === "share" ? (
        <text fg={theme.dim} wrapMode="none" truncate>
          {tt(locale, "upload.progress", { name: stripControlChars(upload.name), percent: percent(upload.sent, upload.size) })}
        </text>
      ) : null}
      {error ? <text fg={theme.fumble}>{error}</text> : null}
      <text fg={theme.dim} wrapMode="none" truncate>
        {tt(locale, blocked !== null ? "share.helpBlocked" : "share.help", { mb: MB })}
      </text>
    </box>
  )
}
