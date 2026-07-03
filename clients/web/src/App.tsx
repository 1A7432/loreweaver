import { useEffect, useMemo, useState } from "react"
import { type ServerFrame, type WelcomeFrame } from "@loreweaver/protocol"
import { AdminPanel } from "./admin/AdminPanel"
import { GameView } from "./GameView"
import { createClient, type AppClient } from "./ws"

export type { AppClient } from "./ws"

export interface AppProps {
  // Injected in tests; defaults to a real WsClient (native browser WebSocket).
  client?: AppClient
  // The keeper opens the admin panel with `?admin=1` (or `?admin`) in the URL;
  // tests force it explicitly. Defaults to reading the current URL.
  admin?: boolean
}

// Prefilled connect URL. A deployer can bake in their own endpoint at build time via
// VITE_WS_URL (e.g. VITE_WS_URL=wss://example.com/ws); otherwise it falls back to localhost.
const DEFAULT_URL = import.meta.env.VITE_WS_URL || "ws://127.0.0.1:8787/"

function readAdminFlag(): boolean {
  if (typeof window === "undefined") return false
  return new URLSearchParams(window.location.search).has("admin")
}

export function App({ client: injected, admin }: AppProps) {
  const client = useMemo(() => injected ?? createClient(), [injected])
  const adminMode = admin ?? readAdminFlag()

  const [url, setUrl] = useState(DEFAULT_URL)
  const [key, setKey] = useState("")
  const [name, setName] = useState("")
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string>()
  const [welcome, setWelcome] = useState<WelcomeFrame>()

  useEffect(() => {
    return client.onMessage((frame: ServerFrame) => {
      if (frame.type === "welcome") {
        setWelcome(frame)
        setConnecting(false)
        setError(undefined)
      } else if (frame.type === "error") {
        setError(frame.message)
        setConnecting(false)
        // A bad key is a permanent failure: stop the auto-reconnect loop so it
        // doesn't keep re-joining with the same rejected key and spamming the
        // same error. Transient errors (rate_limited, server_error, a
        // malformed mid-session frame) keep the session alive. Mirrors the
        // OpenTUI client (clients/tui/src/App.tsx).
        if (frame.code === "bad_key") {
          client.close?.()
        }
      }
    })
  }, [client])

  const handleConnect = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!key.trim()) {
      setError("A deployer key is required.")
      return
    }
    setError(undefined)
    setConnecting(true)
    try {
      await client.connect(url.trim())
      client.join(key.trim(), name.trim() ? name.trim() : undefined)
    } catch (err) {
      setConnecting(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (welcome) {
    return adminMode ? (
      <AdminPanel client={client} welcome={welcome} />
    ) : (
      <GameView client={client} welcome={welcome} />
    )
  }

  return (
    <div className="connect">
      <form className="connect-card" onSubmit={handleConnect}>
        <h1 className="connect-title">TRPG KP{adminMode ? " · Admin" : ""}</h1>
        <p className="connect-sub">
          {adminMode
            ? "Connect with a keeper key to manage the model and room keys."
            : "Connect to a Keeper session with a deployer key."}
        </p>

        <label className="field">
          <span>Server URL</span>
          <input
            aria-label="Server URL"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>Deployer key</span>
          <input
            aria-label="Deployer key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>Display name</span>
          <input
            aria-label="Display name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="optional"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <button type="submit" disabled={connecting}>
          {connecting ? "Connecting..." : "Connect"}
        </button>

        {error ? <p className="connect-error">{error}</p> : null}
      </form>
    </div>
  )
}

export default App
