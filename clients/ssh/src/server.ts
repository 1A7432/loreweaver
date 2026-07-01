// The SSH front-end server. Public-key auth only (no password / keyboard-
// interactive). Each authorized session spawns the OpenTUI client via
// bridgeSession, pointed at the local WS server, so the SSH player joins the
// same RoomHub room as WS/chat players.
import ssh2 from "ssh2"
import { authorize, loadSshKeys, type AuthorizedKey, type SshKeyMap } from "./keys"
import { loadOrCreateHostKey } from "./host_key"
import {
  bridgeSession,
  type BridgeOpts,
  type PtyInfo,
  type SpawnFn,
  type TerminalFactory,
} from "./bridge"

const { Server } = ssh2

const DEFAULT_WS_URL = "ws://127.0.0.1:8787/"
const DEFAULT_HOST_KEY_PATH = "data/ssh_host_key"

export interface ServerOpts {
  port?: number
  host?: string
  wsUrl?: string
  /** Absolute path to clients/tui/src/index.tsx. */
  clientEntry: string
  bunPath?: string
  // Sources (a path OR a pre-built value; the value wins if both are given).
  sshKeysPath?: string
  keys?: SshKeyMap
  hostKeyPath?: string
  hostKey?: string
  // Injectables for tests.
  spawnFn?: SpawnFn
  terminalFactory?: TerminalFactory
  // Resource-exhaustion hardening (all optional; sane defaults below).
  /** Max concurrent client connections; further connections are dropped. Default 100. */
  maxConnections?: number
  /** Max concurrent bridged sessions per connection (each spawns a client process). Default 2. */
  maxSessionsPerConnection?: number
  /** Close a connection after this many ms with no activity (0 disables). Default 5 min. */
  idleTimeoutMs?: number
}

export interface RunningServer {
  port: number
  close(): Promise<void>
}

export async function startSshServer(opts: ServerOpts): Promise<RunningServer> {
  const keys: SshKeyMap = opts.keys ?? loadSshKeys(requirePath(opts.sshKeysPath, "sshKeysPath"))
  const hostKey: string = opts.hostKey ?? loadOrCreateHostKey(opts.hostKeyPath ?? DEFAULT_HOST_KEY_PATH)
  const spawnFn: SpawnFn = opts.spawnFn ?? (Bun.spawn as unknown as SpawnFn)
  const terminalFactory: TerminalFactory | undefined = opts.terminalFactory

  const bridgeOpts: BridgeOpts = {
    wsUrl: opts.wsUrl ?? DEFAULT_WS_URL,
    clientEntry: opts.clientEntry,
    bunPath: opts.bunPath,
  }

  const maxConnections = opts.maxConnections ?? 100
  const maxSessionsPerConnection = opts.maxSessionsPerConnection ?? 2
  const idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000

  const clients = new Set<any>()

  const server = new Server({ hostKeys: [hostKey] }, (client: any) => {
    // Connection cap: refuse new connections past the limit so a flood of
    // sockets can't exhaust process resources.
    if (clients.size >= maxConnections) {
      try {
        client.end()
      } catch {
        // ignore
      }
      try {
        client.destroy?.()
      } catch {
        // ignore
      }
      return
    }
    clients.add(client)

    let authed: AuthorizedKey | null = null
    let activeSessions = 0

    // Idle timeout: drop a connection that has seen no activity (auth, a new
    // session, or channel traffic) for `idleTimeoutMs`, freeing its resources.
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }
    const dropIdle = () => {
      clearIdle()
      try {
        client.end()
      } catch {
        // ignore
      }
      try {
        client.destroy?.()
      } catch {
        // ignore
      }
    }
    const bumpIdle = () => {
      if (idleTimeoutMs <= 0) return
      clearIdle()
      idleTimer = setTimeout(dropIdle, idleTimeoutMs)
      // Don't let the idle timer alone keep the event loop (or a test) alive.
      ;(idleTimer as any).unref?.()
    }
    bumpIdle()

    client.on("close", () => {
      clients.delete(client)
      clearIdle()
    })
    client.on("error", () => {})

    client.on("authentication", (ctx: any) => {
      bumpIdle()
      if (ctx.method !== "publickey") {
        return ctx.reject(["publickey"])
      }
      const entry = authorize(keys, ctx.key)
      if (!entry) {
        return ctx.reject()
      }
      if (ctx.signature) {
        let ok = false
        try {
          // 2-arg form: passing the algo string throws under Bun.
          ok = entry.parsed.verify(ctx.blob, ctx.signature)
        } catch {
          ok = false
        }
        if (!ok) return ctx.reject()
        authed = entry
        return ctx.accept()
      }
      // Signature-less probe: the key is listed, ask the client to sign.
      return ctx.accept()
    })

    client.on("session", (acceptSession: any) => {
      bumpIdle()
      const session = acceptSession()
      let ptyInfo: PtyInfo = { cols: 80, rows: 24 }
      let channel: any = null

      session.on("pty", (accept: any, _reject: any, info: any) => {
        ptyInfo = { cols: info.cols, rows: info.rows, term: info.term }
        if (accept) accept()
      })

      session.on("window-change", (accept: any, _reject: any, info: any) => {
        if (accept) accept()
        // ssh2 fires window-change on the session; forward it onto the channel
        // the bridge listens to.
        channel?.emit?.("window-change", info)
      })

      const startClient = (acceptChannel: any) => {
        channel = acceptChannel()
        if (!authed) {
          channel.end()
          return
        }
        // Session cap: each bridged session spawns a client process, so refuse
        // more than `maxSessionsPerConnection` concurrent ones per connection.
        // Signal the refusal with an exit status (like the bridge's teardown)
        // before ending, so the peer isn't left hanging on an open channel.
        if (activeSessions >= maxSessionsPerConnection) {
          try {
            channel.exit?.(1)
          } catch {
            // ignore
          }
          channel.end()
          return
        }
        activeSessions += 1
        bumpIdle()
        channel.on("data", bumpIdle)
        channel.on("close", () => {
          activeSessions = activeSessions > 0 ? activeSessions - 1 : 0
        })
        bridgeSession(channel, ptyInfo, authed, bridgeOpts, spawnFn, terminalFactory)
      }

      session.on("shell", startClient)
      session.on("exec", startClient)
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject)
    server.listen(opts.port ?? 2222, opts.host ?? "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve((server.address() as any).port)
    })
  })

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) {
          try {
            client.end()
          } catch {
            // ignore
          }
          try {
            client.destroy?.()
          } catch {
            // ignore
          }
        }
        clients.clear()
        const timer = setTimeout(resolve, 500)
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
      }),
  }
}

function requirePath(value: string | undefined, name: string): string {
  if (!value) throw new Error(`startSshServer: ${name} is required when no in-memory value is provided`)
  return value
}
