import { useEffect, useState } from "react"
import {
  FrameType,
  type AdminConfigFrame,
  type AdminKeyInfo,
  type MintedKey,
  type PlayerRole,
  type ServerFrame,
  type WelcomeFrame,
} from "@trpg-kp/protocol"

// The subset of the WS client the admin panel drives. WsClient satisfies it;
// tests inject a mock.
export interface AdminClient {
  onMessage(cb: (frame: ServerFrame) => void): () => void
  adminGetConfig(): void
  adminSetModel(provider: string, chatModel?: string): void
  adminListKeys(): void
  adminMintKey(room: string, name?: string, role?: PlayerRole): void
}

export interface AdminPanelProps {
  client: AdminClient
  welcome: WelcomeFrame
}

const ROLES: PlayerRole[] = ["player", "keeper"]

// Keeper-only admin surface: view + hot-swap the Keeper's LLM provider/model,
// and view + mint room access keys. All mutations are gated server-side by the
// connection's keystore role — a non-keeper key just gets admin_error frames,
// surfaced inline here.
export function AdminPanel({ client, welcome }: AdminPanelProps) {
  const [config, setConfig] = useState<AdminConfigFrame>()
  const [keys, setKeys] = useState<AdminKeyInfo[]>([])
  const [minted, setMinted] = useState<MintedKey>()
  const [error, setError] = useState<string>()

  const [provider, setProvider] = useState("")
  const [chatModel, setChatModel] = useState("")

  const [room, setRoom] = useState("")
  const [keyName, setKeyName] = useState("")
  const [role, setRole] = useState<PlayerRole>("player")

  useEffect(() => {
    const off = client.onMessage((frame) => {
      if (frame.type === FrameType.AdminConfig) {
        setConfig(frame)
        setProvider(frame.provider)
        setChatModel(frame.chat_model)
        setError(undefined)
      } else if (frame.type === FrameType.AdminKeys) {
        setKeys(frame.keys)
        if (frame.minted) setMinted(frame.minted)
        setError(undefined)
      } else if (frame.type === FrameType.AdminError) {
        setError(frame.message ?? frame.code)
      }
    })
    client.adminGetConfig()
    client.adminListKeys()
    return off
  }, [client])

  const isKeeper = welcome.you.role === "keeper"

  const saveModel = (event: React.FormEvent) => {
    event.preventDefault()
    if (!provider.trim()) return
    client.adminSetModel(provider.trim(), chatModel.trim() || undefined)
  }

  const mintKey = (event: React.FormEvent) => {
    event.preventDefault()
    if (!room.trim()) return
    client.adminMintKey(room.trim(), keyName.trim() || undefined, role)
    setRoom("")
    setKeyName("")
  }

  return (
    <div className="admin">
      <header className="game-header">
        <span className="game-brand">TRPG KP</span>
        <span className="game-header-meta">
          admin · {welcome.room} as {welcome.you.name} · {welcome.you.role}
        </span>
      </header>

      <div className="admin-body">
        {!isKeeper ? (
          <p className="connect-error" role="alert">
            This key is not a keeper key — admin actions will be refused.
          </p>
        ) : null}
        {error ? (
          <p className="connect-error" role="alert">
            {error}
          </p>
        ) : null}

        <section className="panel" aria-label="LLM configuration">
          <div className="panel-title">LLM CONFIG</div>
          {config ? (
            <dl className="admin-config">
              <div>
                <dt>Provider</dt>
                <dd>{config.provider}</dd>
              </div>
              <div>
                <dt>Chat model</dt>
                <dd>{config.chat_model}</dd>
              </div>
              <div>
                <dt>Base URL</dt>
                <dd>{config.base_url || <span className="muted">(provider default)</span>}</dd>
              </div>
              <div>
                <dt>API key</dt>
                <dd>{config.api_key_masked || <span className="muted">(not set)</span>}</dd>
              </div>
              <div>
                <dt>Override</dt>
                <dd>{config.override_active ? "active (runtime)" : "none (environment)"}</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">Loading current configuration…</p>
          )}

          <form className="admin-form" onSubmit={saveModel}>
            <label className="field">
              <span>Provider</span>
              <select
                aria-label="Provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              >
                {(config?.providers ?? []).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {config && !config.providers.includes(provider) && provider ? (
                  <option value={provider}>{provider}</option>
                ) : null}
              </select>
            </label>
            <label className="field">
              <span>Chat model</span>
              <input
                aria-label="Chat model"
                value={chatModel}
                onChange={(event) => setChatModel(event.target.value)}
                placeholder="leave blank for provider default"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button type="submit">Save model</button>
          </form>
        </section>

        <section className="panel" aria-label="Room keys">
          <div className="panel-title">ROOM KEYS</div>
          {minted ? (
            <p className="admin-minted" role="status">
              New key for {minted.room} ({minted.role}): <code>{minted.key}</code> — copy it now, it
              is shown only once.
            </p>
          ) : null}
          {keys.length ? (
            <ul className="admin-keys">
              {keys.map((entry, index) => (
                <li key={`${entry.key_masked}-${index}`}>
                  <code>{entry.key_masked}</code> · {entry.room} · {entry.name || "—"} · {entry.role}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No keys yet.</p>
          )}

          <form className="admin-form" onSubmit={mintKey}>
            <label className="field">
              <span>Room</span>
              <input
                aria-label="Room"
                value={room}
                onChange={(event) => setRoom(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span>Name</span>
              <input
                aria-label="Key name"
                value={keyName}
                onChange={(event) => setKeyName(event.target.value)}
                placeholder="optional"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span>Role</span>
              <select aria-label="Role" value={role} onChange={(event) => setRole(event.target.value as PlayerRole)}>
                {ROLES.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">Mint key</button>
          </form>
        </section>
      </div>
    </div>
  )
}

export default AdminPanel
