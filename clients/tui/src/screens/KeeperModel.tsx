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

type Field =
  | "provider"
  | "proxyMode"
  | "apiKey"
  | "baseUrl"
  | "model"
  | "custom"
  | "imageProvider"
  | "imageBaseUrl"
  | "imageModel"
  | "imageSize"
  | "imageApiKey"
const FIELD_ORDER: Field[] = [
  "provider",
  "proxyMode",
  "apiKey",
  "baseUrl",
  "model",
  "custom",
  "imageProvider",
  "imageBaseUrl",
  "imageModel",
  "imageSize",
  "imageApiKey",
]

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

/** Preserve the wire distinction between an untouched field and an explicit clear. */
function touchedValue(touched: boolean, value: string): string | undefined {
  return touched ? value.trim() : undefined
}

export function KeeperModel({ client, theme, themeName, welcome, stateFrame, onBack }: KeeperModelProps) {
  const locale = welcome.locale
  const [config, setConfig] = useState<AdminConfigFrame>()
  const [error, setError] = useState<string>()

  const [provider, setProvider] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKeyClearPending, setApiKeyClearPending] = useState(false)
  const [baseUrlClearPending, setBaseUrlClearPending] = useState(false)
  const [proxyEditing, setProxyEditing] = useState(false)
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
  const [imageBaseUrlClearPending, setImageBaseUrlClearPending] = useState(false)
  const [imageApiKeyClearPending, setImageApiKeyClearPending] = useState(false)
  const [focused, setFocused] = useState<Field>("provider")

  // Latest-value mirrors so submit reads what is on screen regardless of render timing.
  const providerRef = useRef(provider)
  const apiKeyRef = useRef(apiKey)
  const baseUrlRef = useRef(baseUrl)
  const apiKeyTouchedRef = useRef(false)
  const baseUrlTouchedRef = useRef(false)
  // OpenTUI's controlled input can emit onInput while React synchronizes a new `value` prop.
  // Suppress that one matching emission so config hydration/provider reset is not mistaken for a
  // user edit (which would otherwise resend effective URLs as explicit overrides).
  const apiKeySyncRef = useRef<string | null>(null)
  const baseUrlSyncRef = useRef<string | null>(null)
  const selectedModelRef = useRef(selectedModel)
  const customModelRef = useRef(customModel)
  const imageProviderRef = useRef(imageProvider)
  const imageBaseUrlRef = useRef(imageBaseUrl)
  const imageModelRef = useRef(imageModel)
  const imageSizeRef = useRef(imageSize)
  const imageApiKeyRef = useRef(imageApiKey)
  const imageBaseUrlTouchedRef = useRef(false)
  const imageApiKeyTouchedRef = useRef(false)
  const imageBaseUrlSyncRef = useRef<string | null>(null)
  const imageApiKeySyncRef = useRef<string | null>(null)

  const isKeeper = welcome.you.role === "keeper"
  // Whether the live/current selection is on OAuth (used for status and credential labeling).
  const formIsSubscription = usesSubscriptionAuth(provider, config)
  const providerHasSavedCredential = hasSavedProviderCredential(savedProviders, provider, config)
  const providerIsCurrent = normalizeProvider(config?.provider ?? "") === normalizeProvider(provider)
  // `saved_providers` excludes environment-only credentials. The live masked key still needs an
  // explicit clear affordance; conversely an OAuth grant must never be presented as a static key.
  const providerHasSavedStaticCredential = Boolean(
    !formIsSubscription &&
      (providerHasSavedCredential || (providerIsCurrent && config?.api_key_masked)),
  )
  // SuperGrok has a fixed OAuth endpoint. ChatGPT aliases are dual-mode, so their static fields
  // stay reachable even while the current live config uses OAuth; entering a URL opts into proxy.
  const hideChatStaticFields = isSupergrokProvider(provider)
  const offerProxyMode = formIsSubscription && !hideChatStaticFields && !proxyEditing
  const showChatStaticFields = !hideChatStaticFields && (!formIsSubscription || proxyEditing)
  // Live config's OAuth status (only set by server for pure OAuth path).
  const liveSubscriptionStatus = config?.subscription_status || ""
  const imageHasSavedKey = Boolean(
    imageProvider &&
      (imagegen?.saved_providers?.some(
        (saved) => normalizeProvider(saved) === normalizeProvider(imageProvider),
      ) ||
        (normalizeProvider(imagegen?.provider ?? "") === normalizeProvider(imageProvider) &&
          imagegen?.has_key)),
  )
  const imageIsSupergrok = isSupergrokProvider(imageProvider)
  const visibleFieldOrder = useMemo(
    () =>
      FIELD_ORDER.filter(
        (field) =>
          !(field === "proxyMode" && !offerProxyMode) &&
          !(field === "apiKey" && !showChatStaticFields) &&
          !(field === "baseUrl" && !showChatStaticFields) &&
          !(imageIsSupergrok && (field === "imageBaseUrl" || field === "imageApiKey")),
      ),
    [offerProxyMode, showChatStaticFields, imageIsSupergrok],
  )

  // A config reply or provider edit can hide the currently focused key input. Move focus to the
  // nearest visible field instead of leaving keyboard users on a non-existent control.
  useEffect(() => {
    if (!showChatStaticFields && focused === "apiKey") setFocused(offerProxyMode ? "proxyMode" : "model")
    if (!showChatStaticFields && focused === "baseUrl") setFocused(offerProxyMode ? "proxyMode" : "model")
    if (!offerProxyMode && focused === "proxyMode") setFocused(showChatStaticFields ? "apiKey" : "model")
    if (imageIsSupergrok && focused === "imageApiKey") setFocused("imageSize")
    if (imageIsSupergrok && focused === "imageBaseUrl") setFocused("imageModel")
  }, [offerProxyMode, showChatStaticFields, imageIsSupergrok, focused])

  // Ask the server for a provider's live /models (server resolves the key: the one passed here,
  // else the provider's saved credential, else the current live config). Blanks the list while
  // loading; a matching `admin_models` reply repopulates it.
  const requestModels = (prov: string) => {
    if (!prov) return
    providerRef.current = prov
    setModels([])
    setModelsLoading(true)
    const fixedSubscription = isSupergrokProvider(prov)
    const key = fixedSubscription
      ? undefined
      : touchedValue(apiKeyTouchedRef.current, apiKeyRef.current)
    const url = fixedSubscription
      ? undefined
      : touchedValue(baseUrlTouchedRef.current, baseUrlRef.current)
    client.adminListModels(prov, key, url)
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
        apiKeyTouchedRef.current = false
        apiKeySyncRef.current = ""
        setApiKeyClearPending(false)
        setBaseUrl(frame.base_url)
        baseUrlRef.current = frame.base_url
        baseUrlTouchedRef.current = false
        baseUrlSyncRef.current = frame.base_url
        setBaseUrlClearPending(false)
        setProxyEditing(false)
        setSavedProviders(frame.saved_providers ?? [])
        setImagegen(frame.imagegen)
        const img = frame.imagegen
        setImageProvider(img?.provider ?? "")
        imageProviderRef.current = img?.provider ?? ""
        setImageBaseUrl(img?.base_url ?? "")
        imageBaseUrlRef.current = img?.base_url ?? ""
        imageBaseUrlTouchedRef.current = false
        imageBaseUrlSyncRef.current = img?.base_url ?? ""
        setImageBaseUrlClearPending(false)
        setImageModel(img?.model ?? "")
        imageModelRef.current = img?.model ?? ""
        setImageSize(img?.size ?? "1024x1024")
        imageSizeRef.current = img?.size ?? "1024x1024"
        setImageApiKey("")
        imageApiKeyRef.current = ""
        imageApiKeyTouchedRef.current = false
        imageApiKeySyncRef.current = ""
        setImageApiKeyClearPending(false)
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
    // SuperGrok's fixed OAuth path never sends static credentials. ChatGPT aliases are dual-mode:
    // untouched fields preserve OAuth/current proxy state, while entered values switch to a proxy
    // and a touched blank stays "" (clear/switch back to OAuth server-side).
    const fixedSubscription = isSupergrokProvider(providerValue)
    const key = fixedSubscription
      ? undefined
      : touchedValue(apiKeyTouchedRef.current, apiKeyRef.current)
    const url = fixedSubscription
      ? undefined
      : touchedValue(baseUrlTouchedRef.current, baseUrlRef.current)
    client.adminSetModel(providerValue, chatModel || undefined, key, url)
  }

  const saveImagegen = () => {
    const providerValue = imageProviderRef.current.trim()
    const modelValue = imageModelRef.current.trim()
    if (!providerValue || !modelValue) return
    const isSupergrok = isSupergrokProvider(providerValue)
    const key = isSupergrok
      ? undefined
      : touchedValue(imageApiKeyTouchedRef.current, imageApiKeyRef.current)
    const baseUrl = isSupergrok
      ? undefined
      : touchedValue(imageBaseUrlTouchedRef.current, imageBaseUrlRef.current)
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
    if ((keyName === "return" || keyName === "enter") && focused === "proxyMode") {
      setProxyEditing(true)
      setFocused("apiKey")
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
                  // endpoint/model, and refetch this provider's live catalog. Untouched blanks tell
                  // the server to reuse any saved provider credential rather than clear it.
                  setApiKey("")
                  apiKeyRef.current = ""
                  apiKeyTouchedRef.current = false
                  apiKeySyncRef.current = ""
                  setApiKeyClearPending(false)
                  setBaseUrl("")
                  baseUrlRef.current = ""
                  baseUrlTouchedRef.current = false
                  baseUrlSyncRef.current = ""
                  setBaseUrlClearPending(false)
                  setProxyEditing(false)
                  setSelectedModel("")
                  selectedModelRef.current = ""
                  requestModels(value)
                }}
                onSelect={() => {
                  if (isSupergrokProvider(providerRef.current)) setFocused("model")
                  else if (usesSubscriptionAuth(providerRef.current, config)) setFocused("proxyMode")
                  else setFocused("apiKey")
                }}
              />
            </box>

            {formIsSubscription && !proxyEditing ? (
              <box flexDirection="column" marginTop={1}>
                {hideChatStaticFields ? (
                  <text fg={theme.dim}>{tt(locale, "model.subscriptionFieldNote")}</text>
                ) : null}
                <box flexDirection="row">
                  <text fg={providerHasSavedCredential ? theme.success : theme.dim}>
                    {providerHasSavedCredential
                      ? tt(locale, "model.subscriptionReadyTag")
                      : tt(locale, "model.subscriptionLoggedOut")}
                  </text>
                  {!hideChatStaticFields ? (
                    <box
                      marginLeft={2}
                      backgroundColor={focused === "proxyMode" ? theme.accent : theme.bg}
                      onMouseDown={() => {
                        setProxyEditing(true)
                        setFocused("apiKey")
                      }}
                    >
                      <text fg={focused === "proxyMode" ? theme.bg : theme.accent}>
                        {`⚄ ${tt(locale, "model.configureProxy")}`}
                      </text>
                    </box>
                  ) : null}
                </box>
                <text fg={theme.dim}>{tt(locale, "model.subscriptionHint")}</text>
              </box>
            ) : null}

            {showChatStaticFields ? (
              <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("apiKey")}>
                <box flexDirection="row">
                  <text fg={focused === "apiKey" ? theme.accent : theme.dim}>{tt(locale, "model.apiKey")}</text>
                  {providerHasSavedStaticCredential ? (
                    <text fg={theme.success}>{"  " + tt(locale, "model.keySavedTag")}</text>
                  ) : null}
                  {providerHasSavedStaticCredential ? (
                    <box
                      marginLeft={2}
                      onMouseDown={() => {
                        apiKeyRef.current = ""
                        apiKeyTouchedRef.current = true
                        setApiKey("")
                        setApiKeyClearPending(true)
                        requestModels(providerRef.current)
                      }}
                    >
                      <text fg={apiKeyClearPending ? theme.fumble : theme.accent}>
                        {apiKeyClearPending
                          ? tt(locale, "model.clearPending")
                          : tt(locale, "model.clearSavedKey")}
                      </text>
                    </box>
                  ) : null}
                </box>
                <input
                  flexGrow={1}
                  value={apiKey}
                  focused={focused === "apiKey"}
                  placeholder={providerHasSavedStaticCredential ? tt(locale, "model.apiKeySaved") : tt(locale, "model.apiKeyPlaceholder")}
                  onInput={(value: string) => {
                    apiKeyRef.current = value
                    if (apiKeySyncRef.current === value) {
                      apiKeySyncRef.current = null
                      setApiKey(value)
                      return
                    }
                    apiKeySyncRef.current = null
                    apiKeyTouchedRef.current = true
                    setApiKey(value)
                    setApiKeyClearPending(!value.trim())
                  }}
                  onSubmit={() => requestModels(providerRef.current)}
                />
              </box>
            ) : null}

            {showChatStaticFields ? (
              <box flexDirection="column" marginTop={1} onMouseDown={() => setFocused("baseUrl")}>
                <box flexDirection="row">
                  <text fg={focused === "baseUrl" ? theme.accent : theme.dim}>
                    {tt(locale, "model.baseUrl")}
                  </text>
                  <box
                    marginLeft={2}
                    onMouseDown={() => {
                      baseUrlRef.current = ""
                      baseUrlTouchedRef.current = true
                      setBaseUrl("")
                      setBaseUrlClearPending(true)
                      requestModels(providerRef.current)
                    }}
                  >
                    <text fg={baseUrlClearPending ? theme.fumble : theme.accent}>
                      {baseUrlClearPending
                        ? tt(locale, "model.clearPending")
                        : tt(locale, "model.clearBaseUrl")}
                    </text>
                  </box>
                </box>
                <input
                  flexGrow={1}
                  value={baseUrl}
                  focused={focused === "baseUrl"}
                  placeholder={tt(locale, "model.baseUrlPlaceholder")}
                  onInput={(value: string) => {
                    baseUrlRef.current = value
                    if (baseUrlSyncRef.current === value) {
                      baseUrlSyncRef.current = null
                      setBaseUrl(value)
                      return
                    }
                    baseUrlSyncRef.current = null
                    baseUrlTouchedRef.current = true
                    setBaseUrl(value)
                    setBaseUrlClearPending(!value.trim())
                  }}
                  onSubmit={() => requestModels(providerRef.current)}
                />
              </box>
            ) : null}

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
                <box flexDirection="row">
                  <text fg={focused === "imageBaseUrl" ? theme.accent : theme.dim}>
                    {tt(locale, "imagegen.baseUrl")}
                  </text>
                  <box
                    marginLeft={2}
                    onMouseDown={() => {
                      imageBaseUrlRef.current = ""
                      imageBaseUrlTouchedRef.current = true
                      setImageBaseUrl("")
                      setImageBaseUrlClearPending(true)
                    }}
                  >
                    <text fg={imageBaseUrlClearPending ? theme.fumble : theme.accent}>
                      {imageBaseUrlClearPending
                        ? tt(locale, "model.clearPending")
                        : tt(locale, "model.clearBaseUrl")}
                    </text>
                  </box>
                </box>
                <input
                  flexGrow={1}
                  value={imageBaseUrl}
                  focused={focused === "imageBaseUrl"}
                  placeholder={tt(locale, "imagegen.baseUrlPlaceholder")}
                  onInput={(value: string) => {
                    imageBaseUrlRef.current = value
                    if (imageBaseUrlSyncRef.current === value) {
                      imageBaseUrlSyncRef.current = null
                      setImageBaseUrl(value)
                      return
                    }
                    imageBaseUrlSyncRef.current = null
                    imageBaseUrlTouchedRef.current = true
                    setImageBaseUrl(value)
                    setImageBaseUrlClearPending(!value.trim())
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
                  {imageHasSavedKey ? (
                    <box
                      marginLeft={2}
                      onMouseDown={() => {
                        imageApiKeyRef.current = ""
                        imageApiKeyTouchedRef.current = true
                        setImageApiKey("")
                        setImageApiKeyClearPending(true)
                      }}
                    >
                      <text fg={imageApiKeyClearPending ? theme.fumble : theme.accent}>
                        {imageApiKeyClearPending
                          ? tt(locale, "model.clearPending")
                          : tt(locale, "model.clearSavedKey")}
                      </text>
                    </box>
                  ) : null}
                </box>
                <input
                  flexGrow={1}
                  value={imageApiKey}
                  focused={focused === "imageApiKey"}
                  placeholder={imageHasSavedKey ? tt(locale, "model.apiKeySaved") : tt(locale, "imagegen.apiKeyPlaceholder")}
                  onInput={(value: string) => {
                    imageApiKeyRef.current = value
                    if (imageApiKeySyncRef.current === value) {
                      imageApiKeySyncRef.current = null
                      setImageApiKey(value)
                      return
                    }
                    imageApiKeySyncRef.current = null
                    imageApiKeyTouchedRef.current = true
                    setImageApiKey(value)
                    setImageApiKeyClearPending(!value.trim())
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
