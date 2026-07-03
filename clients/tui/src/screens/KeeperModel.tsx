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
// Keeper's LLM provider/model/key. App owns the socket; the server gates these on
// the connection's keeper role (net/admin.py), so a non-keeper just gets `admin_error`.
export interface KeeperModelClient {
  onMessage(cb: (frame: ServerFrame) => void): () => void
  adminGetConfig(): void
  adminSetModel(provider: string, chatModel?: string, apiKey?: string, baseUrl?: string): void
  adminListModels(provider?: string, apiKey?: string, baseUrl?: string): void
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

type Field = "provider" | "apiKey" | "model" | "custom"
const FIELD_ORDER: Field[] = ["provider", "apiKey", "model", "custom"]

export function KeeperModel({ client, theme, themeName, welcome, stateFrame, onBack }: KeeperModelProps) {
  const locale = welcome.locale
  const [config, setConfig] = useState<AdminConfigFrame>()
  const [error, setError] = useState<string>()

  const [provider, setProvider] = useState("")
  const [apiKey, setApiKey] = useState("")
  // Model has two inputs: a `<select>` populated from the provider's LIVE /models, and a free-text
  // fallback that wins if non-empty (for models the list doesn't surface, or offline providers).
  const [selectedModel, setSelectedModel] = useState("")
  const [customModel, setCustomModel] = useState("")
  const [models, setModels] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [savedProviders, setSavedProviders] = useState<string[]>([])
  const [focused, setFocused] = useState<Field>("provider")

  // Latest-value mirrors so submit reads what is on screen regardless of render timing.
  const providerRef = useRef(provider)
  const apiKeyRef = useRef(apiKey)
  const selectedModelRef = useRef(selectedModel)
  const customModelRef = useRef(customModel)

  const isKeeper = welcome.you.role === "keeper"
  const providerHasSavedKey = savedProviders.includes(provider)

  // Ask the server for a provider's live /models (server resolves the key: the one passed here,
  // else the provider's saved credential, else the current live config). Blanks the list while
  // loading; a matching `admin_models` reply repopulates it.
  const requestModels = (prov: string, key?: string) => {
    if (!prov) return
    providerRef.current = prov
    setModels([])
    setModelsLoading(true)
    client.adminListModels(prov, key || undefined)
  }

  // Subscribe first, then request the current config on mount. Every `admin_config` (incl. the one
  // echoed back from a save) is the single source of truth: re-seed the form and refetch models
  // from it. `admin_models` fills the model dropdown; errors surface inline.
  useEffect(() => {
    const off = client.onMessage((frame) => {
      if (frame.type === FrameType.AdminConfig) {
        setConfig(frame)
        setProvider(frame.provider)
        providerRef.current = frame.provider
        setSelectedModel(frame.chat_model)
        selectedModelRef.current = frame.chat_model
        setCustomModel("")
        customModelRef.current = ""
        // Never populate the key field from the (masked) server value — blank means "keep".
        setApiKey("")
        apiKeyRef.current = ""
        setSavedProviders(frame.saved_providers ?? [])
        setError(undefined)
        setModels([])
        setModelsLoading(true)
        client.adminListModels(frame.provider)
      } else if (frame.type === FrameType.AdminModels) {
        // Ignore a stale reply for a provider we've since switched away from.
        if (frame.provider === providerRef.current) {
          setModels(frame.models)
          setModelsLoading(false)
        }
      } else if (frame.type === FrameType.AdminError) {
        setError(frame.message ?? frame.code)
        setModelsLoading(false)
      }
    })
    client.adminGetConfig()
    return off
  }, [client])

  // Provider options come from the fetched config; keep the current provider selectable even if the
  // server didn't advertise it (mirrors AdminPanel).
  const providerOptions: SelectOption[] = useMemo(() => {
    const list = config?.providers ?? []
    const withCurrent = provider && !list.includes(provider) ? [...list, provider] : list
    return withCurrent.map((name) => ({
      name: savedProviders.includes(name) ? `${name}  ✓` : name,
      value: name,
    }))
  }, [config, provider, savedProviders])

  const providerIndex = Math.max(
    0,
    providerOptions.findIndex((option) => option.value === provider),
  )

  // Keep the current model selectable/highlighted even if the live catalog didn't list it (so the
  // dropdown's highlight always matches `selectedModel`), mirroring the provider list.
  const modelOptions: SelectOption[] = useMemo(() => {
    const list = selectedModel && !models.includes(selectedModel) ? [selectedModel, ...models] : models
    return list.map((name) => ({ name, value: name }))
  }, [models, selectedModel])
  const modelIndex = Math.max(
    0,
    modelOptions.findIndex((option) => option.value === selectedModel),
  )

  const save = () => {
    const providerValue = providerRef.current.trim()
    if (!providerValue) return
    const chatModel = customModelRef.current.trim() || selectedModelRef.current.trim()
    client.adminSetModel(providerValue, chatModel || undefined, apiKeyRef.current.trim() || undefined)
  }

  // Scoped to this screen; Tab cycles fields, Esc goes back. Arrows are left to the focused
  // <select>; the text inputs submit on Enter.
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
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
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

          <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} marginTop={1} width={64}>
            <text fg={theme.dim}>{tt(locale, "model.intro")}</text>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("provider")}>
              <text fg={focused === "provider" ? theme.accent : theme.dim}>Provider</text>
              <select
                flexGrow={1}
                height={4}
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
                  // Switching provider: blank the key (its saved one is reused server-side), reset the
                  // model, and refetch this provider's live catalog.
                  setApiKey("")
                  apiKeyRef.current = ""
                  setSelectedModel("")
                  selectedModelRef.current = ""
                  requestModels(value)
                }}
                onSelect={() => setFocused("apiKey")}
              />
            </box>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("apiKey")}>
              <box flexDirection="row">
                <text fg={focused === "apiKey" ? theme.accent : theme.dim}>{tt(locale, "model.apiKey")}</text>
                {providerHasSavedKey ? (
                  <text fg={theme.success}>{"  " + tt(locale, "model.keySavedTag")}</text>
                ) : null}
              </box>
              <input
                flexGrow={1}
                value={apiKey}
                focused={focused === "apiKey"}
                placeholder={providerHasSavedKey ? tt(locale, "model.apiKeySaved") : tt(locale, "model.apiKeyPlaceholder")}
                onInput={(value: string) => {
                  apiKeyRef.current = value
                  setApiKey(value)
                }}
                onSubmit={() => requestModels(providerRef.current, apiKeyRef.current.trim() || undefined)}
              />
            </box>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("model")}>
              <text fg={focused === "model" ? theme.accent : theme.dim}>{tt(locale, "model.modelSelect")}</text>
              {modelsLoading ? (
                <text fg={theme.dim}>{tt(locale, "model.modelsLoading")}</text>
              ) : modelOptions.length === 0 ? (
                <text fg={theme.dim}>{tt(locale, "model.modelsEmpty")}</text>
              ) : (
                <select
                  flexGrow={1}
                  height={6}
                  focused={focused === "model"}
                  options={modelOptions}
                  selectedIndex={modelIndex}
                  backgroundColor={theme.bg}
                  textColor={theme.fg}
                  focusedBackgroundColor={theme.bg}
                  focusedTextColor={theme.accent}
                  selectedBackgroundColor={theme.accent}
                  selectedTextColor={theme.bg}
                  descriptionColor={theme.dim}
                  selectedDescriptionColor={theme.bg}
                  onChange={(index: number) => {
                    const value = String(modelOptions[index]?.value ?? "")
                    selectedModelRef.current = value
                    setSelectedModel(value)
                  }}
                  onSelect={() => setFocused("custom")}
                />
              )}
            </box>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("custom")}>
              <text fg={focused === "custom" ? theme.accent : theme.dim}>{tt(locale, "model.modelCustom")}</text>
              <input
                flexGrow={1}
                value={customModel}
                focused={focused === "custom"}
                placeholder={selectedModel || tt(locale, "model.chatPlaceholder")}
                onInput={(value: string) => {
                  customModelRef.current = value
                  setCustomModel(value)
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
