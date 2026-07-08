import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { bringUpServer, type LogKind } from "../hostLocal"
import { tt } from "../i18n"
import type { Palette } from "../themes"

interface Line {
  id: number
  text: string
  kind: LogKind
}

export interface HostLocalScreenProps {
  theme: Palette
  locale: string
  localServerHome: string
  // Called once the server is up; hands back its Iroh ticket, keeper key, and a stop().
  onReady: (host: string, key: string, stop: () => void) => void
  onBack: () => void
}

const MAX_LINES = 500
const VISIBLE = 22

// One-click host: runs the bring-up pipeline (fetch/uv/deps/serve) and streams every step's
// terminal output here, then hands the ready server to the shell to log in as Keeper.
export function HostLocalScreen({ theme, locale, localServerHome, onReady, onBack }: HostLocalScreenProps) {
  const [lines, setLines] = useState<Line[]>([])
  const [error, setError] = useState<string>()
  const [done, setDone] = useState(false)
  const started = useRef(false)
  const nextId = useRef(0)
  // `onReady` is a fresh inline closure each render; hold it in a ref so the bring-up effect can
  // run exactly once (empty deps) without re-firing — and re-running its abort cleanup — on every
  // parent re-render.
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
    const log = (text: string, kind: LogKind) =>
      setLines((prev) => [...prev, { id: nextId.current++, text, kind }].slice(-MAX_LINES))
    bringUpServer(log, controller.signal, { localServerHome })
      .then((handle) => {
        // The user hit Esc while we were bringing the server up: don't yank them back into the
        // connect flow — tear the just-started server down instead of leaking it.
        if (cancelled) {
          handle.stop()
          return
        }
        setDone(true)
        onReadyRef.current(handle.host, handle.key, handle.stop)
      })
      .catch((err) => {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        log(message, "fail")
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  const colorFor = (kind: LogKind): string =>
    kind === "step"
      ? theme.accent
      : kind === "ok"
        ? theme.success
        : kind === "fail"
          ? theme.fumble
          : kind === "err"
            ? theme.dim
            : theme.fg

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
