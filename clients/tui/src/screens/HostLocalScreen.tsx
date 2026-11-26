import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { stripControlChars } from "loreweaver-protocol/v3"
import { bringUpServer, HostLocalError, type BringUp, type BringUpLine, type HostHandle } from "../hostLocal"
import { tt } from "../i18n"
import type { Palette } from "../themes"

interface Line {
  id: number
  text: string
  kind: BringUpLine["kind"]
}

export interface HostLocalScreenProps {
  theme: Palette
  locale: string
  localServerHome: string
  /** The admin key kept from an earlier start in this folder. */
  knownKey?: string
  /** Injected by tests; the real bring-up otherwise. */
  bringUp?: BringUp
  /** A server this client started earlier and is stopping: two must never share a data folder. */
  after?: Promise<unknown>
  // Called once the server is up, with its ticket, an admin key and a way to stop it.
  onReady: (handle: HostHandle) => void
  onBack: () => void
}

const MAX_LINES = 500
const VISIBLE = 22

// Starts a local server and streams every step of the bring-up here, then hands the ready server
// to the shell, which dials it as the room's admin.
export function HostLocalScreen({ theme, locale, localServerHome, knownKey, bringUp = bringUpServer, after, onReady, onBack }: HostLocalScreenProps) {
  const [lines, setLines] = useState<Line[]>([])
  const [error, setError] = useState<string>()
  const [done, setDone] = useState(false)
  const started = useRef(false)
  const nextId = useRef(0)
  // `onReady` is a fresh closure each render; a ref lets the bring-up run exactly once.
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  useKeyboard((event: KeyEvent) => {
    if (typeof event.name === "string" && event.name.toLowerCase() === "escape") onBack()
  })

  useEffect(() => {
    if (started.current) return
    started.current = true
    const controller = new AbortController()
    let cancelled = false
    const log = (line: BringUpLine) => {
      const text = line.key ? tt(locale, line.key, line.vars) : stripControlChars(line.text ?? "")
      setLines((prev) => [...prev, { id: nextId.current++, text, kind: line.kind }].slice(-MAX_LINES))
    }
    Promise.resolve(after)
      .catch(() => undefined)
      .then(() => bringUp(log, controller.signal, { localServerHome, ...(knownKey ? { knownKey } : {}) }))
      .then((handle) => {
        // Esc while the server was coming up: tear it down instead of leaking it.
        if (cancelled) {
          void handle.stop()
          return
        }
        setDone(true)
        onReadyRef.current(handle)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        const message = caught instanceof HostLocalError ? tt(locale, caught.key, caught.vars) : caught instanceof Error ? caught.message : String(caught)
        setError(message)
        log({ kind: "fail", text: message })
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  const colorFor = (kind: Line["kind"]): string =>
    kind === "step" ? theme.accent : kind === "ok" ? theme.success : kind === "fail" ? theme.fumble : theme.fg

  const visible = lines.slice(-VISIBLE)

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg} paddingX={2} paddingY={1}>
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
        <box flexDirection="row" marginLeft={2}>
          <text fg={theme.accent}>{tt(locale, "hostlocal.title")}</text>
        </box>
      </box>

      <box flexDirection="column" flexGrow={1} minHeight={8} border borderColor={theme.border} paddingX={1} marginTop={1}>
        {visible.length === 0 ? (
          <text fg={theme.dim}>{tt(locale, "hostlocal.starting")}</text>
        ) : (
          visible.map((line) => (
            <text key={line.id} fg={colorFor(line.kind)}>
              {line.text.slice(0, 240)}
            </text>
          ))
        )}
      </box>

      <box marginTop={1}>
        <text fg={error ? theme.fumble : done ? theme.success : theme.dim}>
          {error ? tt(locale, "hostlocal.failed") : done ? tt(locale, "hostlocal.ready") : tt(locale, "hostlocal.help")}
        </text>
      </box>
    </box>
  )
}

export default HostLocalScreen
