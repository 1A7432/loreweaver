import { useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { defaultTuiLocale, tt } from "../i18n"
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
  // The shell owns the client: it awaits connect(url) then join(key,name) and
  // advances to the menu when `welcome` arrives.
  onSubmit: (url: string, key: string, name: string) => void
}

const DEFAULT_HOST = "ws://127.0.0.1:8787"

type Field = "host" | "key" | "name"
const FIELD_ORDER: Field[] = ["host", "key", "name"]

export function ConnectScreen({ theme, defaults, connecting, error, locale = defaultTuiLocale(), onSubmit }: ConnectScreenProps) {
  const defaultName = tt(locale, "connect.defaultName")
  const [host, setHost] = useState(defaults.host ?? DEFAULT_HOST)
  const [key, setKey] = useState(defaults.key ?? "")
  const [name, setName] = useState(defaults.name ?? defaultName)
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

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg} paddingX={2} paddingY={1}>
      <box marginBottom={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
      </box>
      <text fg={theme.dim}>{tt(locale, "connect.subtitle")}</text>

      <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} marginTop={1} width={60}>
        <box flexDirection="column" onMouseDown={() => setFocused("host")}>
          <text fg={fieldColor("host")}>{tt(locale, "connect.host")}</text>
          <input
            flexGrow={1}
            value={host}
            focused={focused === "host"}
            placeholder="ws://127.0.0.1:8787"
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
      </box>

      <box marginTop={1}>
        <text fg={theme.dim}>{tt(locale, "connect.help")}</text>
      </box>
    </box>
  )
}

export default ConnectScreen
