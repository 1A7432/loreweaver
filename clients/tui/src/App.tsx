import { useEffect, useMemo, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import {
  FrameType,
  type ConnectionStatus,
  type PresenceFrame,
  type ServerFrame,
  type StateFrame,
  type WelcomeFrame,
} from "@loreweaver/protocol"
import { AudioController } from "./audio"
import { createClient, type AppClient } from "./client"
import { forgetServer, type SavedServer } from "./connectMemory"
import type { HostHandle } from "./hostLocal"
import { GameView, appendFrame } from "./GameView"
import type { LogFrame } from "./components/NarrativeLog"
import type { RendererLike } from "./imageViewer"
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
import { defaultLocalServerHome } from "./localPaths"
import { DEFAULT_THEME, themeOrder, themes, type ThemeName } from "./themes"

export type { AppClient } from "./client"

// CLI args become prefilled connect-form defaults (index.tsx no longer forces a
// --host/--key: a bare `loreweaver` lands on the connect screen).
export interface AppPrefill {
  host?: string
  key?: string
  name?: string
  locale?: TuiLocale
  localServerHome?: string
  servers?: SavedServer[]
}

export interface AppProps {
  // Injected in tests; defaults to a real WsClient (Bun's global WebSocket).
  client?: AppClient
  prefill?: AppPrefill
  onRememberConnect?: (memory: AppPrefill) => void
  // Persist a language choice made on the connect screen (before any welcome).
  onLocaleChange?: (locale: TuiLocale) => void
  // Persist the one-click local server install/state directory.
  onLocalServerHomeChange?: (path: string) => void
  // Persist a saved-server deletion (index.tsx loads memory, applies forgetServer, re-saves).
  onForgetConnect?: (entry: SavedServer) => void
  // Restore the terminal (renderer.destroy) and exit the process. Falls back to a no-op so
  // tests (and any caller that doesn't pass it) don't need to stub process teardown.
  onQuit?: () => void
  renderer?: RendererLike
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

export function App({
  client: injected,
  prefill,
  onRememberConnect,
  onLocaleChange,
  onLocalServerHomeChange,
  onForgetConnect,
  onQuit,
  renderer,
}: AppProps) {
  const client = useMemo(() => injected ?? createClient(), [injected])
  const audioController = useMemo(() => new AudioController(), [])
  const pendingConnect = useRef<AppPrefill | undefined>(undefined)
  const welcomeIdentity = useRef<{ room: string; memberId: string; role: string } | undefined>(undefined)
  // index.tsx always supplies the remembered/environment-resolved local locale,
  // pinning it against a remote room's language. Embedders that omit it retain
  // the historical server-locale fallback.
  const localePinned = useRef(Boolean(prefill?.locale))
  // A server spawned by the "host locally" screen; killed when the app exits.
  const localServer = useRef<HostHandle | undefined>(undefined)

  const [themeName, setThemeName] = useState<ThemeName>(DEFAULT_THEME)
  const theme = themes[themeName]
  const [locale, setLocale] = useState<TuiLocale>(() => prefill?.locale ?? defaultTuiLocale())
  const [localServerHome, setLocalServerHome] = useState(() => prefill?.localServerHome ?? defaultLocalServerHome())
  const [screen, setScreen] = useState<Screen>("connect")
  const [welcome, setWelcome] = useState<WelcomeFrame>()
  // Held in local state (not read straight from `prefill`) so a delete updates the connect
  // screen immediately; `handleForgetServer` below keeps this and the persisted file in sync.
  const [savedServers, setSavedServers] = useState<SavedServer[]>(() => prefill?.servers ?? [])
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>()
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
        if (pendingConnect.current) {
          onRememberConnect?.(pendingConnect.current)
          pendingConnect.current = undefined
        }
        const previousIdentity = welcomeIdentity.current
        const nextIdentity = {
          room: frame.room,
          memberId: frame.you.id,
          role: frame.you.role,
        }
        const identityChanged = Boolean(
          previousIdentity &&
            (previousIdentity.room !== nextIdentity.room ||
              previousIdentity.memberId !== nextIdentity.memberId ||
              previousIdentity.role !== nextIdentity.role),
        )
        welcomeIdentity.current = nextIdentity
        if (identityChanged) {
          // An automatic reconnect normally returns the same identity and keeps the current
          // screen/log. A different key, room, or role is a new security context: never retain
          // the previous room's panels, presence, or replay in it.
          setStateFrame(EMPTY_STATE)
          setPresence(undefined)
          setFrames([])
          audioController.stopAll()
        }
        setWelcome(frame)
        if (!localePinned.current) setLocale(normalizeLocale(frame.locale))
        setConnecting(false)
        setError(undefined)
        setScreen((prev) =>
          prev === "connect" || prev === "host_local" || identityChanged ? "menu" : prev,
        )
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
      if (frame.type === FrameType.AdminConfig && typeof frame.using_demo === "boolean") {
        // A model save hot-swaps MutableLLM immediately. Keep the menu's guided
        // demo capability in sync too, instead of leaving a stale button until
        // the next reconnect/welcome frame.
        setWelcome((current) => {
          if (!current) return current
          const features = new Set(current.features ?? [])
          // A welcome advertises demo only after the server has verified that this
          // specific room is empty. A global switch back to the fallback therefore
          // must not add it blindly; reconnecting performs the room-scoped check.
          if (!frame.using_demo) features.delete("demo")
          return { ...current, features: [...features] }
        })
      }
      if (frame.type === FrameType.AudioLibraryItem || frame.type === FrameType.AudioControl || frame.type === FrameType.AudioState) {
        void audioController.handle(frame, client).catch((error) => {
          setFrames((current) =>
            appendFrame(current, {
              type: FrameType.System,
              level: "warn",
              text: tt(locale, "audio.playbackFailed", { error: error instanceof Error ? error.message : String(error) }),
            }),
          )
        })
      }
      if (
        frame.type === FrameType.Narrative ||
        frame.type === FrameType.Dice ||
        frame.type === FrameType.System ||
        frame.type === FrameType.Media ||
        frame.type === FrameType.AudioLibraryItem ||
        frame.type === FrameType.AudioControl
      ) {
        // Accumulate the room log even while off the game view (e.g. the menu), so
        // the join-time replay survives until the player opens GameView, which
        // seeds from it. GameView keeps its own copy for live play + dice effects.
        setFrames((current) => appendFrame(current, frame))
        return
      }
      if (
        frame.type === FrameType.Error &&
        (frame.code === "bad_key" || frame.code === "forbidden")
      ) {
        // `bad_key` rejects the join; a top-level `forbidden` means the active key no longer
        // authorizes this connection (admin permission failures use `admin_error` instead).
        // Both require a fresh credential and must drop all room-scoped state.
        setConnecting(false)
        pendingConnect.current = undefined
        welcomeIdentity.current = undefined
        setError(frame.message)
        setWelcome(undefined)
        setStateFrame(EMPTY_STATE)
        setPresence(undefined)
        setFrames([])
        setConnectionStatus(undefined)
        audioController.stopAll()
        client.close?.()
        setScreen("connect")
        return
      }
    })
  }, [client, onRememberConnect, audioController, locale])

  // Optional: an older mock client (or a transport with no `onStatus`) simply never fires,
  // so `connectionStatus` stays undefined and the HUD indicator renders nothing.
  useEffect(() => {
    return client.onStatus?.((status: ConnectionStatus) => setConnectionStatus(status))
  }, [client, audioController])

  const handleConnect = async (url: string, key: string, name: string) => {
    if (!key) {
      setError(tt(locale, "app.error.keyRequired"))
      return
    }
    setError(undefined)
    setConnecting(true)
    pendingConnect.current = { host: url, key, name: name || tt(locale, "connect.defaultName"), locale, localServerHome }
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

  // Kill a button-spawned local server AND close the client connection on exit, so a raw
  // Ctrl-C (or any process-level exit) doesn't leave a zombie server child or a p2p endpoint
  // still trying to redial in the background.
  useEffect(() => {
    const kill = () => {
      localServer.current?.stop()
      audioController.stopAll()
      client.close?.()
    }
    process.on("exit", kill)
    process.on("SIGINT", kill)
    process.on("SIGTERM", kill)
    return () => {
      process.off("exit", kill)
      process.off("SIGINT", kill)
      process.off("SIGTERM", kill)
      kill()
    }
  }, [client])

  // The TUI language is a local user preference (remembered choice, TRPG_LOCALE,
  // or system locale), independent from the server's narration/room locale.
  const handleLocaleChange = (next: TuiLocale) => {
    setLocale(next)
    localePinned.current = true
    if (pendingConnect.current) pendingConnect.current = { ...pendingConnect.current, locale: next }
    onLocaleChange?.(next)
  }

  const handleLocalServerHomeChange = (next: string) => {
    setLocalServerHome(next)
    onLocalServerHomeChange?.(next)
  }

  // A saved-server delete (Part C): update the connect screen's list immediately, and persist
  // it via the index.tsx-supplied callback (load memory, apply forgetServer, re-save).
  const handleForgetServer = (entry: SavedServer) => {
    setSavedServers((current: SavedServer[]) => forgetServer(current, entry))
    onForgetConnect?.(entry)
  }

  // A user-visible Quit (menu row / connect-screen button): release everything a raw Ctrl-C
  // would (stop a button-spawned local server, close the client so its reconnect loop can't
  // keep redialing), then hand off to the caller (index.tsx restores the terminal and exits).
  const handleQuit = () => {
    localServer.current?.stop()
    client.close?.()
    audioController.stopAll()
    onQuit?.()
  }

  const handleStartDemo = () => {
    // The server's demo responder treats this localized, human-readable action
    // as one guided transaction: install the sample module, create its pregenerated
    // investigator, inspect the module summary, then narrate the opening scene.
    setFrames((current) =>
      appendFrame(current, {
        type: FrameType.System,
        level: "info",
        text: tt(locale, "demo.starting"),
      }),
    )
    // The capability is single-use for an empty room. Remove it before sending so returning
    // to the menu cannot offer a stale second start while the server is creating the sample.
    setWelcome((current) =>
      current
        ? { ...current, features: (current.features ?? []).filter((feature) => feature !== "demo") }
        : current,
    )
    client.sendInput(tt(locale, "demo.action"))
    setScreen("game")
  }

  if (screen === "host_local") {
    return (
      <HostLocalScreen
        theme={theme}
        locale={locale}
        localServerHome={localServerHome}
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
    return (
      <GameView
        client={client}
        welcome={{ ...welcome, locale }}
        theme={theme}
        themeName={themeName}
        initialFrames={frames}
        initialState={stateFrame}
        initialPresence={presence}
        connectionStatus={connectionStatus}
        renderer={renderer}
      />
    )
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
        onStartDemo={handleStartDemo}
        onEnterGame={() => setScreen("game")}
        onCharacter={() => setScreen("character")}
        onSettings={() => setScreen("settings")}
        onKeeperKeys={() => setScreen("keeper_keys")}
        onKeeperModule={() => setScreen("keeper_module")}
        onKeeperModel={() => setScreen("keeper_model")}
        onKeeperRules={() => setScreen("keeper_rules")}
        onKeeperSkills={() => setScreen("keeper_skills")}
        onQuit={handleQuit}
      />
    )
  }

  return (
    <ConnectScreen
      theme={theme}
      defaults={{ host: prefill?.host, key: prefill?.key, name: prefill?.name, localServerHome }}
      savedServers={savedServers}
      connecting={connecting}
      error={error}
      locale={locale}
      onLocaleChange={handleLocaleChange}
      onLocalServerHomeChange={handleLocalServerHomeChange}
      onHostLocal={handleHostLocal}
      onSubmit={handleConnect}
      onForgetServer={handleForgetServer}
      onQuit={handleQuit}
    />
  )
}

export default App
