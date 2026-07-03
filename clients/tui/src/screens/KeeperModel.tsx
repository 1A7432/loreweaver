import { useEffect, useMemo, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent, SelectOption } from "@opentui/core"
import {
  FrameType,
  stripControlChars,
  type AdminConfigFrame,
  type ServerFrame,
  type StateFrame,
  type WelcomeFrame,
} from "@loreweaver/protocol"
import { StatusBar } from "../components/StatusBar"
import { tt } from "../i18n"
import type { Palette, ThemeName } from "../themes"

// Narrow superset of the web AdminPanel's `AdminClient`: view + hot-swap the
// Keeper's LLM provider/model. App owns the socket; the server gates these on the
// connection's keeper role (net/admin.py), so a non-keeper just gets `admin_error`.
export interface KeeperModelClient {
  onMessage(cb: (frame: ServerFrame) => void): () => void
  adminGetConfig(): void
  adminSetModel(provider: string, chatModel?: string): void
}

export interface KeeperModelProps {
  client: KeeperModelClient
  theme: Palette
  themeName: ThemeName
  welcome: WelcomeFrame
  // Threaded only for the shared StatusBar's online count (as CharacterScreen does).
  stateFrame: StateFrame
  onBack: () => void
}

type Field = "provider" | "model"
const FIELD_ORDER: Field[] = ["provider", "model"]

export function KeeperModel({ client, theme, themeName, welcome, stateFrame, onBack }: KeeperModelProps) {
  const locale = welcome.locale
  const [config, setConfig] = useState<AdminConfigFrame>()
  const [error, setError] = useState<string>()

  const [provider, setProvider] = useState("")
  const [chatModel, setChatModel] = useState("")
  const [focused, setFocused] = useState<Field>("provider")

  // Latest-value mirrors so submit reads what is on screen regardless of render
  // timing (the provider <select> commits via onChange; the model <input> via ref).
  const providerRef = useRef(provider)
  const chatModelRef = useRef(chatModel)

  const isKeeper = welcome.you.role === "keeper"

  // Subscribe first, then request the current config on mount. Every reply
  // (including the one that comes back from a save) is a fresh `admin_config`, so
  // it is the single source of truth: re-seed the form from it each time. Errors
  // (e.g. unknown_provider — or any code the wire sends) surface inline.
  useEffect(() => {
    const off = client.onMessage((frame) => {
      if (frame.type === FrameType.AdminConfig) {
        setConfig(frame)
        setProvider(frame.provider)
        providerRef.current = frame.provider
        setChatModel(frame.chat_model)
        chatModelRef.current = frame.chat_model
        setError(undefined)
      } else if (frame.type === FrameType.AdminError) {
        setError(frame.message ?? frame.code)
      }
    })
    client.adminGetConfig()
    return off
  }, [client])

  // Options come from the fetched config; keep the current provider selectable even
  // if the server didn't advertise it in `providers` (mirrors AdminPanel).
  const providerOptions: SelectOption[] = useMemo(() => {
    const list = config?.providers ?? []
    const withCurrent = provider && !list.includes(provider) ? [...list, provider] : list
    return withCurrent.map((name) => ({ name, value: name }))
  }, [config, provider])

  const providerIndex = Math.max(
    0,
    providerOptions.findIndex((option) => option.value === provider),
  )

  const save = () => {
    const providerValue = providerRef.current.trim()
    if (!providerValue) return
    client.adminSetModel(providerValue, chatModelRef.current.trim() || undefined)
  }

  // Scoped to this screen; Tab cycles fields, Esc goes back. Arrows are left to the
  // focused provider <select>; the model <input> submits on Enter (onSubmit) and the
  // select advances focus to the model field on Enter (onSelect).
  useKeyboard((event: KeyEvent) => {
    const keyName = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (keyName === "escape") {
      onBack()
      return
    }
    if (keyName === "tab") {
      setFocused((prev) => {
        const index = FIELD_ORDER.indexOf(prev)
        const delta = event.shift ? FIELD_ORDER.length - 1 : 1
        return FIELD_ORDER[(index + delta) % FIELD_ORDER.length]
      })
    }
  })

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={3} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
        <box flexDirection="row" marginLeft={2}>
          <text fg={theme.accent}>{tt(locale, "model.title")}</text>
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
              <text fg={theme.fumble}>{tt(locale, "keeper.notKeeper")}</text>
            </box>
          ) : null}

          {error ? (
            <box marginBottom={1} border borderColor={theme.fumble} paddingX={1}>
              <text fg={theme.fumble}>{stripControlChars(error)}</text>
            </box>
          ) : null}

          <box flexDirection="column" border borderColor={theme.border} paddingX={1}>
            <text fg={theme.accent}>{tt(locale, "model.current")}</text>
            {config ? (
              <>
                <text fg={theme.fg}>Provider · {stripControlChars(config.provider)}</text>
                <text fg={theme.fg}>Model · {stripControlChars(config.chat_model)}</text>
                <text fg={theme.fg}>
                  Base URL · {config.base_url ? stripControlChars(config.base_url) : tt(locale, "model.providerDefault")}
                </text>
                <text fg={theme.fg}>
                  API Key · {config.api_key_masked ? stripControlChars(config.api_key_masked) : tt(locale, "model.notSet")}
                </text>
                <text fg={config.override_active ? theme.success : theme.dim}>
                  {tt(locale, "model.override")} ·{" "}
                  {config.override_active ? tt(locale, "model.overrideActive") : tt(locale, "model.overrideNone")}
                </text>
              </>
            ) : (
              <text fg={theme.dim}>{tt(locale, "model.loading")}</text>
            )}
          </box>

          <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} marginTop={1} width={60}>
            <text fg={theme.dim}>{tt(locale, "model.intro")}</text>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("provider")}>
              <text fg={focused === "provider" ? theme.accent : theme.dim}>Provider</text>
              <select
                flexGrow={1}
                height={6}
                focused={focused === "provider"}
                options={providerOptions}
                selectedIndex={providerIndex}
                backgroundColor={theme.bg}
                textColor={theme.fg}
                focusedBackgroundColor={theme.bg}
                focusedTextColor={theme.accent}
                selectedBackgroundColor={theme.accent}
                selectedTextColor={theme.bg}
                descriptionColor={theme.dim}
                selectedDescriptionColor={theme.bg}
                onChange={(index: number) => {
                  const value = String(providerOptions[index]?.value ?? "")
                  providerRef.current = value
                  setProvider(value)
                }}
                onSelect={() => setFocused("model")}
              />
            </box>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("model")}>
              <text fg={focused === "model" ? theme.accent : theme.dim}>{tt(locale, "model.chatModel")}</text>
              <input
                flexGrow={1}
                value={chatModel}
                focused={focused === "model"}
                placeholder={tt(locale, "model.chatPlaceholder")}
                onInput={(value: string) => {
                  chatModelRef.current = value
                  setChatModel(value)
                }}
                onSubmit={save}
              />
            </box>

            <box marginTop={1} onMouseDown={save} backgroundColor={theme.accent} paddingX={1}>
              <text fg={theme.bg}>{tt(locale, "model.save")}</text>
            </box>

            <box marginTop={1}>
              <text fg={theme.dim}>{tt(locale, "model.help")}</text>
            </box>
          </box>
        </box>
      </box>

      <StatusBar welcome={welcome} online={stateFrame.online} theme={theme} themeName={themeName} />
    </box>
  )
}

export default KeeperModel
