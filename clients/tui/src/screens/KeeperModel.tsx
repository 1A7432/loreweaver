import { useEffect, useMemo, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent, SelectOption } from "@opentui/core"
import {
  FrameType,
  stripControlChars,
  type AdminConfigFrame,
  type ImageGenStatus,
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
  adminSetImagegen(provider: string, model: string, apiKey?: string, baseUrl?: string, size?: string): void
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

type Field = "provider" | "apiKey" | "model" | "custom" | "imageProvider" | "imageBaseUrl" | "imageModel" | "imageSize" | "imageApiKey"
const FIELD_ORDER: Field[] = ["provider", "apiKey", "model", "custom", "imageProvider", "imageBaseUrl", "imageModel", "imageSize", "imageApiKey"]

/** ChatGPT aliases are dual-mode: explicit base_url = proxy; no base_url = subscription OAuth. */
const CHATGPT_PROVIDER_ALIASES = new Set(["chatgpt", "gpt-subscription"])

function normalizeProvider(name: string): string {
  return (name || "").trim().toLowerCase()
}

function isSupergrokProvider(name: string): boolean {
  return normalizeProvider(name) === "supergrok"
}

/** Whether the selected form provider is on the actual OAuth path represented by this config. */
function usesSubscriptionAuth(name: string, config?: AdminConfigFrame): boolean {
  const provider = normalizeProvider(name)
  if (provider === "supergrok") return true
  if (!CHATGPT_PROVIDER_ALIASES.has(provider)) return false

  // `admin_config` only describes the live/current provider. When another provider is merely
  // selected, keep the API-key field available because it may be a saved compatible proxy.
  if (!config || normalizeProvider(config.provider) !== provider) return false
  if (config.subscription_status === "logged_in" || config.subscription_status === "logged_out") return true
  return !config.base_url.trim()
}

function hasSavedProviderCredential(
  savedProviders: string[],
  name: string,
  config?: AdminConfigFrame,
): boolean {
  const provider = normalizeProvider(name)
  const saved = savedProviders.map(normalizeProvider)

  // Subscription credentials are stored under the canonical `chatgpt` name even when the live
  // provider is its `gpt-subscription` alias. Do not apply this aliasing to proxy API keys.
  const isCurrent = normalizeProvider(config?.provider ?? "") === provider
  if (isCurrent && usesSubscriptionAuth(provider, config)) {
    if (config?.subscription_status === "logged_in") return true
    if (config?.subscription_status === "logged_out") return false
    if (provider === "gpt-subscription") return saved.includes("chatgpt")
  }
  return saved.includes(provider)
}

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
  const [imagegen, setImagegen] = useState<ImageGenStatus>()
  const [imageProvider, setImageProvider] = useState("")
  const [imageBaseUrl, setImageBaseUrl] = useState("")
  const [imageModel, setImageModel] = useState("")
  const [imageSize, setImageSize] = useState("1024x1024")
  const [imageApiKey, setImageApiKey] = useState("")
  const [focused, setFocused] = useState<Field>("provider")

  // Latest-value mirrors so submit reads what is on screen regardless of render timing.
  const providerRef = useRef(provider)
  const apiKeyRef = useRef(apiKey)
  const selectedModelRef = useRef(selectedModel)
  const customModelRef = useRef(customModel)
  const imageProviderRef = useRef(imageProvider)
  const imageBaseUrlRef = useRef(imageBaseUrl)
  const imageModelRef = useRef(imageModel)
  const imageSizeRef = useRef(imageSize)
  const imageApiKeyRef = useRef(imageApiKey)

  const isKeeper = welcome.you.role === "keeper"
  // Form selection is on the actual OAuth path (API key field is replaced by a login hint).
  const formIsSubscription = usesSubscriptionAuth(provider, config)
  const providerHasSavedCredential = hasSavedProviderCredential(savedProviders, provider, config)
  // Live config's OAuth status (only set by server for pure OAuth path).
  const liveSubscriptionStatus = config?.subscription_status || ""
  const imageHasSavedKey = Boolean(imageProvider && imagegen?.saved_providers?.includes(imageProvider))
  const imageIsSupergrok = isSupergrokProvider(imageProvider)
  const visibleFieldOrder = useMemo(
    () =>
      FIELD_ORDER.filter(
        (field) =>
          !(formIsSubscription && field === "apiKey") &&
          !(imageIsSupergrok && (field === "imageBaseUrl" || field === "imageApiKey")),
      ),
    [formIsSubscription, imageIsSupergrok],
  )

  // A config reply or provider edit can hide the currently focused key input. Move focus to the
  // nearest visible field instead of leaving keyboard users on a non-existent control.
  useEffect(() => {
    if (formIsSubscription && focused === "apiKey") setFocused("model")
    if (imageIsSupergrok && focused === "imageApiKey") setFocused("imageSize")
    if (imageIsSupergrok && focused === "imageBaseUrl") setFocused("imageModel")
  }, [formIsSubscription, imageIsSupergrok, focused])

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
        setImagegen(frame.imagegen)
        const img = frame.imagegen
        setImageProvider(img?.provider ?? "")
        imageProviderRef.current = img?.provider ?? ""
        setImageBaseUrl(img?.base_url ?? "")
        imageBaseUrlRef.current = img?.base_url ?? ""
        setImageModel(img?.model ?? "")
        imageModelRef.current = img?.model ?? ""
        setImageSize(img?.size ?? "1024x1024")
        imageSizeRef.current = img?.size ?? "1024x1024"
        setImageApiKey("")
        imageApiKeyRef.current = ""
        setError(undefined)
        setModels([])
        setModelsLoading(true)
        client.adminListModels(frame.provider)
      } else if (frame.type === FrameType.AdminModels) {
        if (frame.imagegen) setImagegen(frame.imagegen)
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
  // server didn't advertise it (mirrors AdminPanel). Subscription providers with a saved grant also
  // get a ready mark (server puts them in saved_providers when access_token is present).
  const providerOptions: SelectOption[] = useMemo(() => {
    const list = config?.providers ?? []
    const withCurrent = provider && !list.includes(provider) ? [...list, provider] : list
    return withCurrent.map((name) => {
      const ready = hasSavedProviderCredential(savedProviders, name, config)
      const tag = ready
        ? usesSubscriptionAuth(name, config)
          ? `  ${tt(locale, "model.subscriptionReadyTag")}`
          : "  ✓"
        : ""
      return { name: `${name}${tag}`, value: name }
    })
  }, [config, provider, savedProviders, locale])

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
    // The actual OAuth path never sends an API key; dual-mode ChatGPT proxy aliases still do.
    const key = usesSubscriptionAuth(providerValue, config) ? undefined : apiKeyRef.current.trim() || undefined
    client.adminSetModel(providerValue, chatModel || undefined, key)
  }

  const saveImagegen = () => {
    const providerValue = imageProviderRef.current.trim()
    const modelValue = imageModelRef.current.trim()
    if (!providerValue || !modelValue) return
    const isSupergrok = isSupergrokProvider(providerValue)
    const key = isSupergrok ? undefined : imageApiKeyRef.current.trim() || undefined
    const baseUrl = isSupergrok ? undefined : imageBaseUrlRef.current.trim() || undefined
    client.adminSetImagegen(
      providerValue,
      modelValue,
      key,
      baseUrl,
      imageSizeRef.current.trim() || undefined,
    )
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
        const index = visibleFieldOrder.indexOf(prev)
        const start = index >= 0 ? index : 0
        const delta = event.shift ? visibleFieldOrder.length - 1 : 1
        return visibleFieldOrder[(start + delta) % visibleFieldOrder.length]
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
            <box marginBottom={1} height={3} border borderColor={theme.fumble} paddingX={1}>
              <text fg={theme.fumble}>{stripControlChars(error)}</text>
            </box>
          ) : null}

          <box flexDirection="row" height={7}>
            <box flexDirection="column" flexGrow={1} border borderColor={theme.border} paddingX={1}>
              <text fg={theme.accent}>{tt(locale, "model.current")}</text>
              {config ? (
                <>
                  <text fg={theme.fg}>Provider · {stripControlChars(config.provider)}</text>
                  <text fg={theme.fg}>Model · {stripControlChars(config.chat_model)}</text>
                  {liveSubscriptionStatus ? (
                    <text fg={liveSubscriptionStatus === "logged_in" ? theme.success : theme.dim}>
                      {tt(locale, "model.auth")} ·{" "}
                      {liveSubscriptionStatus === "logged_in"
                        ? tt(locale, "model.subscriptionLoggedIn")
                        : tt(locale, "model.subscriptionLoggedOut")}
                      {liveSubscriptionStatus === "logged_in" && config.api_key_masked
                        ? ` · ${stripControlChars(config.api_key_masked)}`
                        : ""}
                    </text>
                  ) : (
                    <text fg={theme.fg}>
                      API Key ·{" "}
                      {config.api_key_masked
                        ? stripControlChars(config.api_key_masked)
                        : tt(locale, "model.notSet")}
                    </text>
                  )}
                  <text fg={config.override_active ? theme.success : theme.dim}>
                    {tt(locale, "model.override")} ·{" "}
                    {config.override_active ? tt(locale, "model.overrideActive") : tt(locale, "model.overrideNone")}
                  </text>
                </>
              ) : (
                <text fg={theme.dim}>{tt(locale, "model.loading")}</text>
              )}
            </box>
            <box flexDirection="column" flexGrow={1} border borderColor={theme.border} paddingX={1} marginLeft={1}>
              <text fg={theme.accent}>{tt(locale, "imagegen.current")}</text>
              {config?.imagegen ? (
                <>
                  <text fg={theme.fg}>Provider · {stripControlChars(config.imagegen.provider || tt(locale, "model.notSet"))}</text>
                  <text fg={theme.fg}>Model · {stripControlChars(config.imagegen.model || tt(locale, "model.notSet"))}</text>
                  <text fg={theme.fg}>
                    API Key ·{" "}
                    {config.imagegen.has_key
                      ? isSupergrokProvider(config.imagegen.provider)
                        ? tt(locale, "model.subscriptionReadyTag")
                        : stripControlChars(config.imagegen.api_key_masked)
                      : tt(locale, "model.notSet")}
                  </text>
                  <text fg={config.imagegen.configured ? theme.success : theme.dim}>
                    {config.imagegen.configured ? tt(locale, "imagegen.configured") : tt(locale, "imagegen.notConfigured")}
                  </text>
                </>
              ) : config ? (
                <text fg={theme.dim}>{tt(locale, "imagegen.notConfigured")}</text>
              ) : (
                <text fg={theme.dim}>{tt(locale, "model.loading")}</text>
              )}
            </box>
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
                onSelect={() =>
                  setFocused(usesSubscriptionAuth(providerRef.current, config) ? "model" : "apiKey")
                }
              />
            </box>

            {formIsSubscription ? (
              <box flexDirection="column" marginTop={1}>
                <text fg={theme.dim}>{tt(locale, "model.subscriptionFieldNote")}</text>
                <text fg={providerHasSavedCredential ? theme.success : theme.dim}>
                  {providerHasSavedCredential
                    ? tt(locale, "model.subscriptionReadyTag")
                    : tt(locale, "model.subscriptionLoggedOut")}
                </text>
                <text fg={theme.dim}>{tt(locale, "model.subscriptionHint")}</text>
              </box>
            ) : (
              <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("apiKey")}>
                <box flexDirection="row">
                  <text fg={focused === "apiKey" ? theme.accent : theme.dim}>{tt(locale, "model.apiKey")}</text>
                  {providerHasSavedCredential ? (
                    <text fg={theme.success}>{"  " + tt(locale, "model.keySavedTag")}</text>
                  ) : null}
                </box>
                <input
                  flexGrow={1}
                  value={apiKey}
                  focused={focused === "apiKey"}
                  placeholder={providerHasSavedCredential ? tt(locale, "model.apiKeySaved") : tt(locale, "model.apiKeyPlaceholder")}
                  onInput={(value: string) => {
                    apiKeyRef.current = value
                    setApiKey(value)
                  }}
                  onSubmit={() => requestModels(providerRef.current, apiKeyRef.current.trim() || undefined)}
                />
              </box>
            )}

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

          <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} marginTop={1} width={64}>
            <text fg={theme.accent}>{tt(locale, "imagegen.title")}</text>
            <text fg={theme.dim}>{tt(locale, "imagegen.intro")}</text>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("imageProvider")}>
              <text fg={focused === "imageProvider" ? theme.accent : theme.dim}>{tt(locale, "imagegen.provider")}</text>
              <input
                flexGrow={1}
                value={imageProvider}
                focused={focused === "imageProvider"}
                placeholder="openai"
                onInput={(value: string) => {
                  imageProviderRef.current = value
                  setImageProvider(value)
                }}
                onSubmit={() =>
                  setFocused(isSupergrokProvider(imageProviderRef.current) ? "imageModel" : "imageBaseUrl")
                }
              />
            </box>

            {!imageIsSupergrok ? (
              <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("imageBaseUrl")}>
                <text fg={focused === "imageBaseUrl" ? theme.accent : theme.dim}>{tt(locale, "imagegen.baseUrl")}</text>
                <input
                  flexGrow={1}
                  value={imageBaseUrl}
                  focused={focused === "imageBaseUrl"}
                  placeholder={tt(locale, "imagegen.baseUrlPlaceholder")}
                  onInput={(value: string) => {
                    imageBaseUrlRef.current = value
                    setImageBaseUrl(value)
                  }}
                  onSubmit={() => setFocused("imageModel")}
                />
              </box>
            ) : null}

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("imageModel")}>
              <text fg={focused === "imageModel" ? theme.accent : theme.dim}>{tt(locale, "imagegen.model")}</text>
              <input
                flexGrow={1}
                value={imageModel}
                focused={focused === "imageModel"}
                placeholder={tt(locale, "imagegen.modelPlaceholder")}
                onInput={(value: string) => {
                  imageModelRef.current = value
                  setImageModel(value)
                }}
                onSubmit={() => setFocused("imageSize")}
              />
            </box>

            <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("imageSize")}>
              <text fg={focused === "imageSize" ? theme.accent : theme.dim}>{tt(locale, "imagegen.size")}</text>
              <input
                flexGrow={1}
                value={imageSize}
                focused={focused === "imageSize"}
                placeholder="1024x1024"
                onInput={(value: string) => {
                  imageSizeRef.current = value
                  setImageSize(value)
                }}
                onSubmit={() => {
                  if (isSupergrokProvider(imageProviderRef.current)) saveImagegen()
                  else setFocused("imageApiKey")
                }}
              />
            </box>

            {imageIsSupergrok ? (
              <box flexDirection="column" marginTop={1}>
                <text fg={theme.dim}>{tt(locale, "model.subscriptionFieldNote")}</text>
                <text fg={theme.dim}>{tt(locale, "model.subscriptionHint")}</text>
              </box>
            ) : (
              <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("imageApiKey")}>
                <box flexDirection="row">
                  <text fg={focused === "imageApiKey" ? theme.accent : theme.dim}>{tt(locale, "imagegen.apiKey")}</text>
                  {imageHasSavedKey ? <text fg={theme.success}>{"  " + tt(locale, "model.keySavedTag")}</text> : null}
                </box>
                <input
                  flexGrow={1}
                  value={imageApiKey}
                  focused={focused === "imageApiKey"}
                  placeholder={imageHasSavedKey ? tt(locale, "model.apiKeySaved") : tt(locale, "imagegen.apiKeyPlaceholder")}
                  onInput={(value: string) => {
                    imageApiKeyRef.current = value
                    setImageApiKey(value)
                  }}
                  onSubmit={saveImagegen}
                />
              </box>
            )}

            <box marginTop={1} onMouseDown={saveImagegen} backgroundColor={theme.accent} paddingX={1}>
              <text fg={theme.bg}>{tt(locale, "imagegen.save")}</text>
            </box>
          </box>
        </box>
      </box>

      <StatusBar welcome={welcome} online={stateFrame.online} theme={theme} themeName={themeName} />
    </box>
  )
}

export default KeeperModel
