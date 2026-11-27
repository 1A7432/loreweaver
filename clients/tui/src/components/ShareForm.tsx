import { useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { stripControlChars } from "loreweaver-protocol/v3"
import type { Connection } from "../connection"
import { useConnectionState, useSnapshot } from "../hooks"
import { tt, type MessageKey } from "../i18n"
import { MAX_AUDIO_UPLOAD_BYTES, MAX_UPLOAD_BYTES, readLocalFile } from "../media"
import type { Palette } from "../themes"
import { percent, transferErrorText, uploadBlocked } from "../transfer"

export interface ShareFormProps {
  connection: Connection
  theme: Palette
  locale: string
  onClose: () => void
  /** `share` (default): a picture for the table. `audio`: an admin's sound for the room's audio library. */
  purpose?: "share" | "audio"
}

const MB = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))
const AUDIO_MB = Math.round(MAX_AUDIO_UPLOAD_BYTES / (1024 * 1024))

const WORDS: Record<"share" | "audio", { title: MessageKey; placeholder: MessageKey; help: MessageKey }> = {
  share: { title: "share.title", placeholder: "share.placeholder", help: "share.help" },
  audio: { title: "sound.title", placeholder: "sound.placeholder", help: "sound.help" },
}

/** The library title the server gives an uploaded sound: its file name without the extension. */
export function soundTitle(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * Share a picture from this computer with the table: a path typed here is read (after its size
 * and type are checked), offered with `purpose: "share"` and sent over the byte channel; the
 * server then shows it to everyone as a `media` event. When this member may not upload, the form
 * says why instead of offering the field. Esc closes it.
 *
 * With `purpose: "audio"` the same form takes a sound for the room's audio library (an admin's;
 * sound files only). No limit but the byte channel's is checked here: the server's own comes
 * back as its coded refusal, shown in its words.
 */
export function ShareForm({ connection, theme, locale, onClose, purpose = "share" }: ShareFormProps) {
  const words = WORDS[purpose]
  const mb = purpose === "audio" ? AUDIO_MB : MB
  const snapshot = useSnapshot(connection)
  const state = useConnectionState(connection)
  const blocked = uploadBlocked(snapshot)
  const [path, setPath] = useState("")
  const pathRef = useRef("")
  const [error, setError] = useState<string>()
  // A sound added: said here (the form stays open for the next one) as well as in the log.
  const [done, setDone] = useState<string>()
  const [busy, setBusy] = useState(false)

  useKeyboard((event: KeyEvent) => {
    const name = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (name === "escape") onClose()
  })

  const submit = async () => {
    if (busy || blocked !== null) return
    setBusy(true)
    setError(undefined)
    setDone(undefined)
    try {
      const file = purpose === "audio" ? await readLocalFile(pathRef.current, "audio", MAX_AUDIO_UPLOAD_BYTES) : await readLocalFile(pathRef.current, "image")
      const stored = await connection.upload(file, purpose)
      const name = stripControlChars(stored.name)
      if (purpose === "audio") {
        const text = tt(locale, "sound.done", { name, title: soundTitle(name) })
        connection.note({ kind: "result", level: "info", text })
        setDone(text)
        pathRef.current = ""
        setPath("")
        return
      }
      connection.note({ kind: "result", level: "info", text: tt(locale, "share.done", { name }) })
      onClose()
    } catch (caught) {
      setError(transferErrorText(caught, locale, mb))
    } finally {
      setBusy(false)
    }
  }

  const upload = state.upload
  return (
    <box flexDirection="column" border borderColor={theme.accent} paddingX={1} backgroundColor={theme.bg} width="100%" flexShrink={0}>
      <text fg={theme.accent} wrapMode="none" truncate>
        {tt(locale, words.title)}
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
            placeholder={tt(locale, words.placeholder)}
            onInput={(value: string) => {
              pathRef.current = value
              setPath(value)
            }}
            onSubmit={() => void submit()}
          />
        </box>
      )}
      {upload !== null && upload.purpose === purpose ? (
        <text fg={theme.dim} wrapMode="none" truncate>
          {tt(locale, "upload.progress", { name: stripControlChars(upload.name), percent: percent(upload.sent, upload.size) })}
        </text>
      ) : null}
      {error ? <text fg={theme.fumble}>{error}</text> : null}
      {done ? <text fg={theme.success}>{done}</text> : null}
      <text fg={theme.dim} wrapMode="none" truncate>
        {tt(locale, blocked !== null ? "share.helpBlocked" : words.help, { mb })}
      </text>
    </box>
  )
}
