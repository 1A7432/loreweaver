import { useEffect, useRef, useState, type ReactNode } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { Connection } from "./connection"
import { forgetServer, rememberLocalKey, type LocalKey, type SavedServer } from "./connectMemory"
import { copySelection, usesAppClipboardCopy, type ClipboardRenderer, type CopyOutcome } from "./copy"
import { GameView } from "./GameView"
import { useConnectionState, useSnapshot } from "./hooks"
import type { BringUp, HostHandle } from "./hostLocal"
import { irohDialer, looksLikeTicket, type Dialer, type IrohMode } from "./irohLink"
import { CharacterScreen } from "./screens/CharacterScreen"
import { CommandsScreen } from "./screens/CommandsScreen"
import { ConnectScreen } from "./screens/ConnectScreen"
import { HostLocalScreen } from "./screens/HostLocalScreen"
import { MainMenu } from "./screens/MainMenu"
import { SettingsScreen } from "./screens/SettingsScreen"
import { defaultTuiLocale, tt, type TuiLocale } from "./i18n"
import { defaultLocalServerHome } from "./localPaths"
import { DEFAULT_THEME, themeOrder, themes, type Palette, type ThemeName } from "./themes"
import { clientInfo } from "./version"

// CLI args and the remembered connect file become prefilled connect-form defaults.
export interface AppPrefill {
  host?: string
  key?: string
  name?: string
  locale?: TuiLocale
  localServerHome?: string
  servers?: SavedServer[]
  localKeys?: LocalKey[]
}

export interface AppProps {
  prefill?: AppPrefill
  /** How a ticket is dialled; tests hand in a scripted server's dialler. Defaults to iroh. */
  dial?: (mode: IrohMode) => Dialer
  /** Brings a local server up; tests hand in a stand-in. Defaults to `hostLocal.ts`. */
  bringUp?: BringUp
  /** A connection that reached a welcome: remember the server (not called for a local one). */
  onRememberConnect?: (memory: { host: string; key: string; name?: string }) => void
  // Persist a language choice.
  onLocaleChange?: (locale: TuiLocale) => void
  // Persist the local server directory.
  onLocalServerHomeChange?: (path: string) => void
  /** Persist the admin key a fresh local server handed out (shown once, so it must be kept). */
  onLocalKey?: (entry: LocalKey) => void
  // Persist a saved-server deletion.
  onForgetConnect?: (entry: SavedServer) => void
  // Restore the terminal and exit. A no-op when absent (tests).
  onQuit?: () => void
  // The clipboard/selection owner for Ctrl+C (see `copy.ts`); the real `CliRenderer` fits.
  renderer?: ClipboardRenderer
  // Decides whether Ctrl+C copies (non-macOS) or only ever quits (macOS). Injectable for tests.
  platform?: string
}

type Screen = "connect" | "host_local" | "menu" | "settings" | "game" | "character" | "commands"

// F1..F5 select a theme by its position in themeOrder.
const themeKeyIndex: Record<string, number> = { f1: 0, f2: 1, f3: 2, f4: 3, f5: 4 }

interface Attempt {
  id: number
  connection: Connection
  remember: { host: string; key: string; name?: string } | null
}

export function App({
  prefill,
  dial = (mode) => irohDialer({ mode }),
  bringUp,
  onRememberConnect,
  onLocaleChange,
  onLocalServerHomeChange,
  onLocalKey,
  onForgetConnect,
  onQuit,
  renderer,
  platform = process.platform,
}: AppProps) {
  const [themeName, setThemeName] = useState<ThemeName>(DEFAULT_THEME)
  const theme = themes[themeName]
  const [locale, setLocale] = useState<TuiLocale>(() => prefill?.locale ?? defaultTuiLocale())
  const [localServerHome, setLocalServerHome] = useState(() => prefill?.localServerHome ?? defaultLocalServerHome())
  const [localKeys, setLocalKeys] = useState<LocalKey[]>(() => prefill?.localKeys ?? [])
  const [screen, setScreen] = useState<Screen>("connect")
  const [savedServers, setSavedServers] = useState<SavedServer[]>(() => prefill?.servers ?? [])
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string>()
  // A server the "host locally" screen started; stopped when the app exits.
  const localServer = useRef<HostHandle | undefined>(undefined)
  const localStopping = useRef<Promise<unknown> | undefined>(undefined)
  const stopLocal = (): Promise<unknown> | undefined => {
    const handle = localServer.current
    localServer.current = undefined
    if (handle) localStopping.current = handle.stop()
    return localStopping.current
  }
  const current = useRef<Connection | null>(null)
  const attempts = useRef(0)
  current.current = attempt?.connection ?? null

  // A transient confirmation for a Ctrl+C copy, shown in the game view.
  const [copyNotice, setCopyNotice] = useState<string>()
  const copyNoticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showCopyNotice = (outcome: Exclude<CopyOutcome, { kind: "empty" }>) => {
    setCopyNotice(outcome.kind === "copied" ? tt(locale, "copy.copied", { chars: String(outcome.chars) }) : tt(locale, "copy.unsupported"))
    if (copyNoticeTimer.current) clearTimeout(copyNoticeTimer.current)
    copyNoticeTimer.current = setTimeout(() => setCopyNotice(undefined), 4000)
  }
  useEffect(
    () => () => {
      if (copyNoticeTimer.current) clearTimeout(copyNoticeTimer.current)
    },
    [],
  )

  const handleQuit = () => {
    current.current?.stop()
    void stopLocal()
    onQuit?.()
  }

  // Release the connection and a button-started server on any process exit, so a raw Ctrl+C
  // never leaves a server child or a redialling endpoint behind.
  useEffect(() => {
    const kill = () => {
      current.current?.stop()
      void stopLocal()
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
  }, [])

  // Theme keys and Esc never collide with typing, so they are global. Ctrl+C copies the selection
  // in the game view (not on macOS, where copy is the terminal's Cmd+C) and otherwise quits.
  useKeyboard((event: KeyEvent) => {
    const name = typeof event.name === "string" ? event.name.toLowerCase() : ""
    const index = themeKeyIndex[name]
    if (index !== undefined && themeOrder[index]) setThemeName(themeOrder[index])
    if (name === "escape") setScreen((prev) => (prev === "game" || prev === "commands" ? "menu" : prev))
    if (event.ctrl && name === "c") {
      const copyable = screen === "game" && usesAppClipboardCopy(platform)
      const outcome = copyable ? copySelection(renderer) : { kind: "empty" as const }
      if (outcome.kind === "empty") handleQuit()
      else showCopyNotice(outcome)
    }
  })

  const connect = async (host: string, key: string, name: string, mode: IrohMode, remember: boolean) => {
    const ticket = host.trim()
    if (!key) {
      setError(tt(locale, "app.error.keyRequired"))
      return
    }
    if (!looksLikeTicket(ticket)) {
      setError(tt(locale, /^wss?:\/\//i.test(ticket) ? "app.error.noWebSocket" : "app.error.badTicket"))
      return
    }
    current.current?.stop()
    setError(undefined)
    setConnecting(true)
    const connection = new Connection({ ticket, key, ...(name ? { name } : {}), locale, client: clientInfo(), dial: dial(mode) })
    try {
      await connection.start()
    } catch (caught) {
      setConnecting(false)
      setError(tt(locale, "app.error.dialFailed", { reason: caught instanceof Error ? caught.message : String(caught) }))
      setScreen("connect")
      return
    }
    setAttempt({ id: ++attempts.current, connection, remember: remember ? { host: ticket, key, ...(name ? { name } : {}) } : null })
  }

  /** The session is over: back to the connect screen, saying why. */
  const ended = (message: string | undefined) => {
    current.current?.stop()
    setAttempt(null)
    setConnecting(false)
    setError(message)
    setScreen("connect")
  }

  const welcomed = () => {
    setConnecting(false)
    setError(undefined)
    if (attempt?.remember) {
      onRememberConnect?.(attempt.remember)
      setSavedServers((servers) => [attempt.remember as SavedServer, ...servers.filter((s) => !(s.host === attempt.remember?.host && s.key === attempt.remember?.key))])
    }
    setScreen((prev) => (prev === "connect" || prev === "host_local" ? "menu" : prev))
  }

  const handleLocaleChange = (next: TuiLocale) => {
    setLocale(next)
    onLocaleChange?.(next)
  }

  const handleLocalServerHomeChange = (next: string) => {
    setLocalServerHome(next)
    onLocalServerHomeChange?.(next)
  }

  const handleForgetServer = (entry: SavedServer) => {
    setSavedServers((servers) => forgetServer(servers, entry))
    onForgetConnect?.(entry)
  }

  const connectScreen = (
    <ConnectScreen
      theme={theme}
      defaults={{ host: prefill?.host, key: prefill?.key, name: prefill?.name, localServerHome }}
      savedServers={savedServers}
      connecting={connecting || attempt !== null}
      error={error}
      locale={locale}
      onLocaleChange={handleLocaleChange}
      onLocalServerHomeChange={handleLocalServerHomeChange}
      onHostLocal={() => {
        // A server started earlier is stopped first: the new one takes its folder.
        current.current?.stop()
        void stopLocal()
        setScreen("host_local")
      }}
      onSubmit={(host, key, name) => void connect(host, key, name, "n0", true)}
      onForgetServer={handleForgetServer}
      onQuit={handleQuit}
    />
  )

  if (screen === "host_local" && attempt === null) {
    return (
      <HostLocalScreen
        theme={theme}
        locale={locale}
        localServerHome={localServerHome}
        knownKey={localKeys.find((entry) => entry.home === localServerHome)?.key}
        bringUp={bringUp}
        after={localStopping.current}
        onReady={(handle) => {
          localServer.current = handle
          if (handle.newKey) {
            const entry = { home: localServerHome, key: handle.key }
            setLocalKeys((keys) => rememberLocalKey(keys, entry))
            onLocalKey?.(entry)
          }
          void connect(handle.ticket, handle.key, prefill?.name ?? "", "local", false)
        }}
        onBack={() => setScreen("connect")}
      />
    )
  }

  if (attempt === null) return connectScreen

  return (
    <Table
      key={attempt.id}
      connection={attempt.connection}
      screen={screen}
      setScreen={setScreen}
      theme={theme}
      themeName={themeName}
      setThemeName={setThemeName}
      locale={locale}
      onLocaleChange={handleLocaleChange}
      copyNotice={copyNotice}
      platform={platform}
      onWelcome={welcomed}
      onEnded={ended}
      onQuit={handleQuit}
      waiting={connectScreen}
    />
  )
}

interface TableProps {
  connection: Connection
  screen: Screen
  setScreen: (screen: Screen | ((prev: Screen) => Screen)) => void
  theme: Palette
  themeName: ThemeName
  setThemeName: (name: ThemeName) => void
  locale: TuiLocale
  onLocaleChange: (locale: TuiLocale) => void
  copyNotice?: string
  platform: string
  onWelcome: () => void
  onEnded: (message: string | undefined) => void
  onQuit: () => void
  /** What shows before the welcome: the connect screen, busy. */
  waiting: ReactNode
}

/** Everything behind a connection: it reads the session and routes the screens. */
function Table({ connection, screen, setScreen, theme, themeName, setThemeName, locale, onLocaleChange, copyNotice, platform, onWelcome, onEnded, onQuit, waiting }: TableProps) {
  const snapshot = useSnapshot(connection)
  const state = useConnectionState(connection)
  const welcome = snapshot.welcome
  const welcomedOnce = useRef(false)

  useEffect(() => {
    if (welcome && !welcomedOnce.current) {
      welcomedOnce.current = true
      onWelcome()
    }
  }, [welcome])

  // A session that is over for good — refused, or a first connection that never got in.
  useEffect(() => {
    const failure = snapshot.lastError
    if (snapshot.status === "ended") {
      if (failure?.code === "ended") return
      if (failure?.code === "protocol_mismatch" && /^server /.test(failure.message)) {
        const [, server = "?", client = "?"] = /^server (\S+), client (\S+)$/.exec(failure.message) ?? []
        onEnded(tt(locale, "app.error.protocolMismatch", { server, client }))
        return
      }
      onEnded(failure?.message || tt(locale, "app.error.ended"))
      return
    }
    if (state.phase === "ended" && !welcomedOnce.current) onEnded(tt(locale, "app.error.closedBeforeWelcome"))
  }, [snapshot.status, state.phase])

  if (!welcome) return <>{waiting}</>

  if (screen === "settings") {
    return (
      <SettingsScreen
        connection={connection}
        theme={theme}
        themeName={themeName}
        locale={locale}
        onLocaleChange={onLocaleChange}
        onThemeChange={setThemeName}
        onBack={() => setScreen("menu")}
      />
    )
  }
  if (screen === "game") {
    return (
      <GameView
        connection={connection}
        locale={locale}
        theme={theme}
        themeName={themeName}
        copyNotice={copyNotice}
        platform={platform}
        onCommands={() => setScreen("commands")}
      />
    )
  }
  if (screen === "character") {
    return <CharacterScreen connection={connection} theme={theme} themeName={themeName} locale={locale} onBack={() => setScreen("menu")} />
  }
  if (screen === "commands") {
    return <CommandsScreen connection={connection} theme={theme} themeName={themeName} locale={locale} onBack={() => setScreen("menu")} />
  }
  return (
    <MainMenu
      connection={connection}
      theme={theme}
      themeName={themeName}
      locale={locale}
      onEnterGame={() => setScreen("game")}
      onCharacter={() => setScreen("character")}
      onCommands={() => setScreen("commands")}
      onSettings={() => setScreen("settings")}
      onQuit={onQuit}
    />
  )
}

export default App
