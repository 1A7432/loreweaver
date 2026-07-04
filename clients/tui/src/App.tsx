import { useEffect, useMemo, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { FrameType, type PresenceFrame, type ServerFrame, type StateFrame, type WelcomeFrame } from "@loreweaver/protocol"
import { createClient, type AppClient } from "./client"
import type { SavedServer } from "./connectMemory"
import type { HostHandle } from "./hostLocal"
import { GameView, appendFrame } from "./GameView"
import type { LogFrame } from "./components/NarrativeLog"
import { CharacterScreen } from "./screens/CharacterScreen"
import { ConnectScreen } from "./screens/ConnectScreen"
import { KeeperKeys } from "./screens/KeeperKeys"
import { KeeperModel } from "./screens/KeeperModel"
import { KeeperModule } from "./screens/KeeperModule"
import { KeeperRules } from "./screens/KeeperRules"
import { KeeperSkills } from "./screens/KeeperSkills"
import { MainMenu } from "./screens/MainMenu"
import { HostLocalScreen } from "./screens/HostLocalScreen"
import { SettingsScreen } from "./screens/SettingsScreen"
import { defaultTuiLocale, normalizeLocale, tt, type TuiLocale } from "./i18n"
import { DEFAULT_THEME, themeOrder, themes, type ThemeName } from "./themes"

export type { AppClient } from "./client"

// CLI args become prefilled connect-form defaults (index.tsx no longer forces a
// --host/--key: a bare `loreweaver` lands on the connect screen).
export interface AppPrefill {
  host?: string
  key?: string
  name?: string
  locale?: TuiLocale
  servers?: SavedServer[]
}

export interface AppProps {
  // Injected in tests; defaults to a real WsClient (Bun's global WebSocket).
  client?: AppClient
  prefill?: AppPrefill
  onRememberConnect?: (memory: Required<AppPrefill>) => void
  // Persist a language choice made on the connect screen (before any welcome).
  onLocaleChange?: (locale: TuiLocale) => void
}

// Stage 2 adds "character"; Stage 3 adds the keeper-only "keeper_keys" / "keeper_model";
// Stage 4 adds the keeper-only "keeper_module"; Layer B.4b adds the keeper-only
// "keeper_rules" / "keeper_skills" (plugin management, docs/plugins.md "Layer B").
type Screen =
  | "connect"
  | "host_local"
  | "menu"
  | "settings"
  | "game"
  | "character"
  | "keeper_keys"
  | "keeper_module"
  | "keeper_model"
  | "keeper_rules"
  | "keeper_skills"

const EMPTY_STATE: StateFrame = { type: FrameType.State, party: [], initiative: [], online: 0 }

// F1..F5 select a theme by its position in themeOrder (five themes now).
const themeKeyIndex: Record<string, number> = { f1: 0, f2: 1, f3: 2, f4: 3, f5: 4 }

export function App({ client: injected, prefill, onRememberConnect, onLocaleChange }: AppProps) {
  const client = useMemo(() => injected ?? createClient(), [injected])
  const pendingConnect = useRef<Required<AppPrefill> | undefined>(undefined)
  // An explicit language pick (the connect-screen toggle, or a remembered one) wins over
  // the server's room locale, so the client UI stays in the language the user chose.
  const localePinned = useRef(Boolean(prefill?.locale))
  // A server spawned by the "host locally" screen; killed when the app exits.
  const localServer = useRef<HostHandle | undefined>(undefined)

  const [themeName, setThemeName] = useState<ThemeName>(DEFAULT_THEME)
  const theme = themes[themeName]
  const [locale, setLocale] = useState<TuiLocale>(() => prefill?.locale ?? defaultTuiLocale())
  const [screen, setScreen] = useState<Screen>("connect")
  const [welcome, setWelcome] = useState<WelcomeFrame>()
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string>()
  const [stateFrame, setStateFrame] = useState<StateFrame>(EMPTY_STATE)
  const [presence, setPresence] = useState<PresenceFrame>()
  // The room log, accumulated at the shell level from the moment we join — so the
  // join-time history replay (narrative frames the server delivers right after
  // `welcome`, while we're still on the menu, before GameView exists) isn't lost.
  // GameView seeds its own log from this on mount; see GameViewProps.initialFrames.
  const [frames, setFrames] = useState<LogFrame[]>([])

  // Theme cycling + Esc are safe to handle globally: F-keys / Escape never
  // collide with typing, arrow navigation, or a focused input, so the theme
  // persists across every screen. Screen-specific keys live in each screen.
  useKeyboard((event: KeyEvent) => {
    const name = typeof event.name === "string" ? event.name.toLowerCase() : ""
    const index = themeKeyIndex[name]
    if (index !== undefined && themeOrder[index]) setThemeName(themeOrder[index])
    // Esc returns from the game view to the menu; the menu is the top level.
    if (name === "escape") setScreen((prev) => (prev === "game" ? "menu" : prev))
  })

  useEffect(() => {
    return client.onMessage((frame: ServerFrame) => {
      if (frame.type === FrameType.Welcome) {
        if (pendingConnect.current) onRememberConnect?.(pendingConnect.current)
        setWelcome(frame)
        if (!localePinned.current) setLocale(normalizeLocale(frame.locale))
        setConnecting(false)
        setError(undefined)
        setScreen((prev) => (prev === "connect" || prev === "host_local" ? "menu" : prev))
        return
      }
      if (frame.type === FrameType.State) {
        setStateFrame(frame)
        return
      }
      if (frame.type === FrameType.Presence) {
        setPresence(frame)
        return
      }
      if (frame.type === FrameType.Narrative || frame.type === FrameType.Dice || frame.type === FrameType.System) {
        // Accumulate the room log even while off the game view (e.g. the menu), so
        // the join-time replay survives until the player opens GameView, which
        // seeds from it. GameView keeps its own copy for live play + dice effects.
        setFrames((current) => appendFrame(current, frame))
        return
      }
      if (frame.type === FrameType.Error && frame.code === "bad_key") {
        // A bad key is a permanent failure while still on the connect screen:
        // surface it, stay put, and stop the auto-reconnect/re-join loop so it
        // can't spam the same rejection. A fresh submit reconnects cleanly.
        setConnecting(false)
        pendingConnect.current = undefined
        setError(frame.message)
        client.close?.()
        setScreen((prev) => (prev === "connect" ? "connect" : prev))
      }
    })
  }, [client, onRememberConnect])

  const handleConnect = async (url: string, key: string, name: string) => {
    if (!key) {
      setError(tt(locale, "app.error.keyRequired"))
      return
    }
    setError(undefined)
    setConnecting(true)
    pendingConnect.current = { host: url, key, name: name || tt(locale, "connect.defaultName"), locale }
    try {
      await client.connect(url)
      client.join(key, name || undefined)
    } catch (err) {
      pendingConnect.current = undefined
      setConnecting(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // "Host locally & play": open the bring-up screen, which detects the environment, sets up +
  // starts a server (streaming its output), then logs straight in as Keeper (onReady, below).
  const handleHostLocal = () => setScreen("host_local")

  // Kill a button-spawned local server on exit so it doesn't outlive the client.
  useEffect(() => {
    const kill = () => localServer.current?.stop()
    process.on("exit", kill)
    process.on("SIGINT", kill)
    process.on("SIGTERM", kill)
    return () => {
      process.off("exit", kill)
      process.off("SIGINT", kill)
      process.off("SIGTERM", kill)
      kill()
    }
  }, [])

  // A language pick (connect screen or settings) is explicit: pin it so the server's
  // room locale won't override it, and persist it for next launch.
  const handleLocaleChange = (next: TuiLocale) => {
    setLocale(next)
    localePinned.current = true
    onLocaleChange?.(next)
  }

  if (screen === "host_local") {
    return (
      <HostLocalScreen
        theme={theme}
        locale={locale}
        onReady={(host, key, stop) => {
          localServer.current = { host, key, stop }
          void handleConnect(host, key, tt(locale, "menu.role.keeper"))
        }}
        onBack={() => setScreen("connect")}
      />
    )
  }

  if (screen === "settings" && welcome) {
    return (
      <SettingsScreen
        theme={theme}
        themeName={themeName}
        welcome={{ ...welcome, locale }}
        stateFrame={stateFrame}
        locale={locale}
        onLocaleChange={handleLocaleChange}
        onThemeChange={setThemeName}
        onBack={() => setScreen("menu")}
      />
    )
  }

  if (screen === "game" && welcome) {
    return <GameView client={client} welcome={{ ...welcome, locale }} theme={theme} themeName={themeName} initialFrames={frames} />
  }

  if (screen === "character" && welcome) {
    return (
      <CharacterScreen
        client={client}
        theme={theme}
        themeName={themeName}
        welcome={{ ...welcome, locale }}
        stateFrame={stateFrame}
        onBack={() => setScreen("menu")}
      />
    )
  }

  // Keeper-only screens: guarded on the welcome role (the MainMenu only offers them
  // to a keeper, and the server re-enforces role on every admin_* frame anyway).
  if (screen === "keeper_keys" && welcome?.you.role === "keeper") {
    return (
      <KeeperKeys
        client={client}
        theme={theme}
        themeName={themeName}
        welcome={{ ...welcome, locale }}
        stateFrame={stateFrame}
        onBack={() => setScreen("menu")}
      />
    )
  }

  if (screen === "keeper_module" && welcome?.you.role === "keeper") {
    return (
      <KeeperModule
        client={client}
        theme={theme}
        themeName={themeName}
        welcome={{ ...welcome, locale }}
        stateFrame={stateFrame}
        onBack={() => setScreen("menu")}
      />
    )
  }

  if (screen === "keeper_model" && welcome?.you.role === "keeper") {
    return (
      <KeeperModel
        client={client}
        theme={theme}
        themeName={themeName}
        welcome={{ ...welcome, locale }}
        stateFrame={stateFrame}
        onBack={() => setScreen("menu")}
      />
    )
  }

  if (screen === "keeper_rules" && welcome?.you.role === "keeper") {
    return (
      <KeeperRules
        client={client}
        theme={theme}
        themeName={themeName}
        welcome={{ ...welcome, locale }}
        stateFrame={stateFrame}
        onBack={() => setScreen("menu")}
      />
    )
  }

  if (screen === "keeper_skills" && welcome?.you.role === "keeper") {
    return (
      <KeeperSkills
        client={client}
        theme={theme}
        themeName={themeName}
        welcome={{ ...welcome, locale }}
        stateFrame={stateFrame}
        onBack={() => setScreen("menu")}
      />
    )
  }

  if (screen === "menu" && welcome) {
    return (
      <MainMenu
        welcome={{ ...welcome, locale }}
        theme={theme}
        themeName={themeName}
        stateFrame={stateFrame}
        presence={presence}
        onEnterGame={() => setScreen("game")}
        onCharacter={() => setScreen("character")}
        onSettings={() => setScreen("settings")}
        onKeeperKeys={() => setScreen("keeper_keys")}
        onKeeperModule={() => setScreen("keeper_module")}
        onKeeperModel={() => setScreen("keeper_model")}
        onKeeperRules={() => setScreen("keeper_rules")}
        onKeeperSkills={() => setScreen("keeper_skills")}
      />
    )
  }

  return (
    <ConnectScreen
      theme={theme}
      defaults={{ host: prefill?.host, key: prefill?.key, name: prefill?.name }}
      savedServers={prefill?.servers}
      connecting={connecting}
      error={error}
      locale={locale}
      onLocaleChange={handleLocaleChange}
      onHostLocal={handleHostLocal}
      onSubmit={handleConnect}
    />
  )
}

export default App
