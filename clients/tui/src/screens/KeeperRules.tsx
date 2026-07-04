import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import {
  FrameType,
  stripControlChars,
  type AdminForgeKind,
  type AdminRuleInfo,
  type ServerFrame,
  type StateFrame,
  type WelcomeFrame,
} from "@loreweaver/protocol"
import { Spinner } from "../components/Spinner"
import { StatusBar } from "../components/StatusBar"
import { tt } from "../i18n"
import type { Palette, ThemeName } from "../themes"

// Narrow superset of the web AdminPanel's `AdminClient`: list rule systems (Layer A
// discovery) and describe->generate a brand-new one. App owns the socket; the server
// gates these on the connection's keeper role (net/admin.py), so a non-keeper just
// gets `admin_error`. Unlike skills, rule systems have no per-room enable — every
// discovered system is just listed as built-in or custom (generated/user-installed).
export interface KeeperRulesClient {
  onMessage(cb: (frame: ServerFrame) => void): () => void
  adminListRules(): void
  adminGenerate(kind: AdminForgeKind, description: string): void
}

export interface KeeperRulesProps {
  client: KeeperRulesClient
  theme: Palette
  themeName: ThemeName
  welcome: WelcomeFrame
  // Threaded only for the shared StatusBar's online count (as the sibling screens do).
  stateFrame: StateFrame
  onBack: () => void
}

type Field = "list" | "description"
const FIELD_ORDER: Field[] = ["list", "description"]

const CURSOR = "⚄"

export function KeeperRules({ client, theme, themeName, welcome, stateFrame, onBack }: KeeperRulesProps) {
  const locale = welcome.locale
  const [systems, setSystems] = useState<AdminRuleInfo[]>([])
  const [error, setError] = useState<string>()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [focused, setFocused] = useState<Field>("list")

  const [description, setDescription] = useState("")
  const [generating, setGenerating] = useState(false)
  const [generateResult, setGenerateResult] = useState<string>()

  // Mirror the description into a ref so submit always reads the latest typed value
  // regardless of render timing (same reason the sibling screens do it).
  const descriptionRef = useRef(description)

  const isKeeper = welcome.you.role === "keeper"

  // Subscribe for this screen only, then request the current list on mount. Every
  // `admin_rules` (including the one that follows a successful generate) is the
  // single source of truth: just repaint from it, mirroring KeeperModel's
  // `admin_config` handling.
  useEffect(() => {
    const off = client.onMessage((frame) => {
      if (frame.type === FrameType.AdminRules) {
        setSystems(frame.systems)
        setSelectedIndex((current: number) => Math.max(0, Math.min(current, frame.systems.length - 1)))
        setError(undefined)
      } else if (frame.type === FrameType.AdminGenerated && frame.kind === "rule") {
        setGenerating(false)
        if (frame.ok) {
          setGenerateResult(tt(locale, "rules.generateOk", { id: frame.id, name: stripControlChars(frame.name) }))
          // The new rule system only shows up in the list once we re-request it.
          client.adminListRules()
        } else {
          setGenerateResult(tt(locale, "rules.generateError", { error: stripControlChars(frame.error) }))
        }
      } else if (frame.type === FrameType.AdminError) {
        setError(frame.message ?? frame.code)
        setGenerating(false)
      } else if (frame.type === FrameType.Error) {
        // A backend failure during generate (LLM timeout / rate-limit / auth error) surfaces as a
        // GENERIC error frame, not admin_error — clear the spinner and show it, never hang.
        setError(frame.message ?? frame.code)
        setGenerating(false)
      }
    })
    client.adminListRules()
    return off
  }, [client, locale])

  const generate = () => {
    const value = descriptionRef.current.trim()
    if (!value) return
    setGenerateResult(undefined)
    setGenerating(true)
    client.adminGenerate("rule", value)
  }

  // Scoped to this screen; Tab cycles list/description, Esc goes back. The list has
  // no per-row action (rule systems are just listed), so arrows only move the
  // cursor; the description <input> gets Enter via its own onSubmit.
  useKeyboard((event: KeyEvent) => {
    const keyName = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (keyName === "escape") {
      onBack()
      return
    }
    if (keyName === "tab") {
      setFocused((prev: Field) => {
        const index = FIELD_ORDER.indexOf(prev)
        const delta = event.shift ? FIELD_ORDER.length - 1 : 1
        return FIELD_ORDER[(index + delta) % FIELD_ORDER.length]
      })
      return
    }
    if (focused === "list") {
      if (keyName === "up") setSelectedIndex((prev: number) => Math.max(0, prev - 1))
      if (keyName === "down" && systems.length) setSelectedIndex((prev: number) => Math.min(systems.length - 1, prev + 1))
    }
  })

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
        <box flexDirection="row" marginLeft={2}>
          <text fg={theme.accent}>{tt(locale, "rules.title")}</text>
          <text fg={theme.dim}>
            {" · "}
            {stripControlChars(welcome.room)}
          </text>
        </box>
      </box>

      <box flexDirection="row" flexGrow={1} minHeight={8}>
        <box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
          {!isKeeper ? (
            <box marginBottom={1}>
              <text fg={theme.fumble}>{tt(locale, "rules.notKeeper")}</text>
            </box>
          ) : null}

          {error ? (
            <box marginBottom={1} border borderColor={theme.fumble} paddingX={1}>
              <text fg={theme.fumble}>{stripControlChars(error)}</text>
            </box>
          ) : null}

          <box
            flexDirection="column"
            height={Math.min(Math.max(systems.length + 3, 4), 10)}
            border
            borderColor={theme.border}
            paddingX={1}
            onMouseDown={() => setFocused("list")}
          >
            <text fg={theme.accent}>{tt(locale, "rules.list")}</text>
            {systems.length ? (
              systems.map((entry: AdminRuleInfo, index: number) => (
                <text key={entry.id} fg={index === selectedIndex ? theme.accent : theme.fg}>
                  {index === selectedIndex ? CURSOR : " "} {stripControlChars(entry.id)} ·{" "}
                  <span fg={entry.built_in ? theme.dim : theme.success}>
                    {entry.built_in ? tt(locale, "rules.builtin") : tt(locale, "rules.custom")}
                  </span>
                </text>
              ))
            ) : (
              <text fg={theme.dim}>{tt(locale, "rules.none")}</text>
            )}
          </box>

          <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} marginTop={1} width={72}>
            <text fg={theme.dim}>{tt(locale, "rules.intro")}</text>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("description")}>
              <text fg={focused === "description" ? theme.accent : theme.dim}>{tt(locale, "rules.description")}</text>
              <input
                flexGrow={1}
                value={description}
                focused={focused === "description"}
                placeholder={tt(locale, "rules.descriptionPlaceholder")}
                onInput={(value: string) => {
                  descriptionRef.current = value
                  setDescription(value)
                }}
                onSubmit={generate}
              />
            </box>

            <box marginTop={1} onMouseDown={generate} backgroundColor={theme.accent} paddingX={1}>
              <text fg={theme.bg}>{tt(locale, "rules.generateButton")}</text>
            </box>

            <Spinner active={generating} label={tt(locale, "rules.generating")} color={theme.hard} />
            {!generating && generateResult ? <text fg={theme.fg}>{generateResult}</text> : null}

            <box marginTop={1}>
              <text fg={theme.dim}>{tt(locale, "rules.help")}</text>
            </box>
          </box>
        </box>
      </box>

      <StatusBar welcome={welcome} online={stateFrame.online} theme={theme} themeName={themeName} />
    </box>
  )
}

export default KeeperRules
