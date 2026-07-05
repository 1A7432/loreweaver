import { useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { defaultTuiLocale, tt, type TuiLocale } from "../i18n"
import type { SavedServer } from "../connectMemory"
import type { Palette } from "../themes"

// Prefilled defaults come from CLI args (see index.tsx); the host falls back to
// the local dev server and the name to a generic investigator.
export interface ConnectDefaults {
  host?: string
  key?: string
  name?: string
}

export interface ConnectScreenProps {
  theme: Palette
  defaults: ConnectDefaults
  connecting: boolean
  error?: string
  locale?: string
  // Past connections (most-recent first); clicking one fills the form.
  savedServers?: SavedServer[]
  // Switch the connect-screen UI language before any welcome; the shell persists it.
  onLocaleChange?: (locale: TuiLocale) => void
  // Spawn a local server and log in as Keeper (one-click host & play).
  onHostLocal?: () => void
  // The shell owns the client: it awaits connect(url) then join(key,name) and
  // advances to the menu when `welcome` arrives.
  onSubmit: (url: string, key: string, name: string) => void
  // Remove a saved-server row (the "✕" affordance). Optional: without it the rows render
  // with no delete control at all (a caller that hasn't wired persistence yet).
  onForgetServer?: (entry: SavedServer) => void
  // Release resources (client + any button-spawned local server) and exit. Optional so a
  // caller that hasn't wired teardown yet just gets no Quit button.
  onQuit?: () => void
}


type Field = "host" | "key" | "name"
const FIELD_ORDER: Field[] = ["host", "key", "name"]

export function ConnectScreen({
  theme,
  defaults,
  connecting,
  error,
  locale = defaultTuiLocale(),
  savedServers,
  onLocaleChange,
  onHostLocal,
  onSubmit,
  onForgetServer,
  onQuit,
}: ConnectScreenProps) {
  const defaultName = tt(locale, "connect.defaultName")
  // Fields start EMPTY (unless remembered/CLI-prefilled) so the examples read as dim
  // placeholders, not pre-filled values the user has to clear: the host placeholder shows a
  // ticket shape, and `submit` still falls back to the default nickname when left blank.
  const [host, setHost] = useState(defaults.host ?? "")
  const [key, setKey] = useState(defaults.key ?? "")
  const [name, setName] = useState(defaults.name ?? "")
  const [focused, setFocused] = useState<Field>("host")

  // Mirror each field into a ref so submit always reads the latest typed value,
  // independent of when React commits the re-render or whether the intrinsic
  // <input> captured a stale onSubmit closure.
  const hostRef = useRef(host)
  const keyRef = useRef(key)
  const nameRef = useRef(name)

  const submit = () => onSubmit(hostRef.current.trim(), keyRef.current.trim(), nameRef.current.trim() || defaultName)

  // Scoped to this screen (mounted only on the connect screen), so Tab cycling
  // never collides with the menu's arrow navigation. The focused <input> still
  // receives typed characters; Tab/Enter are handled here / by onSubmit.
  useKeyboard((event: KeyEvent) => {
    const keyName = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (keyName === "tab") {
      setFocused((prev) => {
        const index = FIELD_ORDER.indexOf(prev)
        const delta = event.shift ? FIELD_ORDER.length - 1 : 1
        return FIELD_ORDER[(index + delta) % FIELD_ORDER.length]
      })
    }
  })

  const fieldColor = (field: Field) => (focused === field ? theme.accent : theme.dim)

  const pickServer = (server: SavedServer) => {
    setHost(server.host)
    hostRef.current = server.host
    setKey(server.key)
    keyRef.current = server.key
    if (server.name) {
      setName(server.name)
      nameRef.current = server.name
    }
    setFocused("key")
  }
  // A ticket is long base32; show a head…tail so the row stays readable.
  const shortHost = (host: string) => (host.length > 40 ? `${host.slice(0, 20)}…${host.slice(-6)}` : host)

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg} paddingX={2} paddingY={1}>
      <box marginBottom={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
      </box>
      <text fg={theme.dim}>{tt(locale, "connect.subtitle")}</text>

      <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} marginTop={1} width={60}>
        <box flexDirection="row" marginBottom={1}>
          <text fg={theme.dim}>{tt(locale, "connect.language")}{"  "}</text>
          <box onMouseDown={() => onLocaleChange?.("en")} backgroundColor={locale === "en" ? theme.accent : theme.bg} paddingX={1}>
            <text fg={locale === "en" ? theme.bg : theme.fg}>English</text>
          </box>
          <text>{" "}</text>
          <box onMouseDown={() => onLocaleChange?.("zh")} backgroundColor={locale === "zh" ? theme.accent : theme.bg} paddingX={1}>
            <text fg={locale === "zh" ? theme.bg : theme.fg}>中文</text>
          </box>
        </box>

        {onHostLocal ? (
          <box marginBottom={1} onMouseDown={() => onHostLocal()} backgroundColor={theme.success} paddingX={1}>
            <text fg={theme.bg}>{connecting ? tt(locale, "connect.connecting") : tt(locale, "connect.hostLocal")}</text>
          </box>
        ) : null}

        {savedServers && savedServers.length > 0 ? (
          <box flexDirection="column" marginBottom={1}>
            <text fg={theme.dim}>{tt(locale, "connect.saved")}</text>
            {savedServers.slice(0, 5).map((server) => (
              <box key={`${server.host}:${server.key}`} flexDirection="row" onMouseDown={() => pickServer(server)}>
                <box flexGrow={1}>
                  <text fg={theme.fg}>
                    · {server.name ? `${server.name} — ` : ""}
                    {shortHost(server.host)}
                  </text>
                </box>
                {onForgetServer ? (
                  <box
                    paddingX={1}
                    onMouseDown={(event) => {
                      // Don't let the delete also pick/fill this row (Part C requirement).
                      event.stopPropagation()
                      onForgetServer(server)
                    }}
                  >
                    <text fg={theme.fumble}>{tt(locale, "connect.forget")}</text>
                  </box>
                ) : null}
              </box>
            ))}
          </box>
        ) : null}

        <box flexDirection="column" onMouseDown={() => setFocused("host")}>
          <text fg={fieldColor("host")}>{tt(locale, "connect.host")}</text>
          <input
            flexGrow={1}
            value={host}
            focused={focused === "host"}
            placeholder={tt(locale, "connect.hostPlaceholder")}
            onInput={(value: string) => {
              hostRef.current = value
              setHost(value)
            }}
            onSubmit={submit}
          />
        </box>

        <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("key")}>
          <text fg={fieldColor("key")}>{tt(locale, "connect.key")}</text>
          <input
            flexGrow={1}
            value={key}
            focused={focused === "key"}
            placeholder="deployer / keeper key"
            onInput={(value: string) => {
              keyRef.current = value
              setKey(value)
            }}
            onSubmit={submit}
          />
        </box>

        <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("name")}>
          <text fg={fieldColor("name")}>{tt(locale, "connect.name")}</text>
          <input
            flexGrow={1}
            value={name}
            focused={focused === "name"}
            placeholder={defaultName}
            onInput={(value: string) => {
              nameRef.current = value
              setName(value)
            }}
            onSubmit={submit}
          />
        </box>

        <box marginTop={1} onMouseDown={submit} backgroundColor={theme.accent} paddingX={1}>
          <text fg={theme.bg}>{connecting ? tt(locale, "connect.connecting") : tt(locale, "connect.button")}</text>
        </box>

        {error ? (
          <box marginTop={1}>
            <text fg={theme.fumble}>{error}</text>
          </box>
        ) : null}

        {onQuit ? (
          <box marginTop={1} onMouseDown={() => onQuit()} backgroundColor={theme.border} paddingX={1}>
            <text fg={theme.bg}>{tt(locale, "connect.quit")}</text>
          </box>
        ) : null}
      </box>

      <box marginTop={1}>
        <text fg={theme.dim}>{tt(locale, "connect.help")}</text>
      </box>
    </box>
  )
}

export default ConnectScreen
