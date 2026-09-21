import { hello, readyEvent } from "./fixtures"

export interface FakeGatewayIdentify {
  token?: string
  intents?: number
  shard?: unknown
  properties?: unknown
}

export interface FakeQQBotGatewayOptions {
  heartbeatIntervalMs?: number
  sessionId?: string
  botUser?: { id: string; username: string; bot: boolean }
  /** Close the socket after Hello with this code instead of waiting for Identify. */
  closeAfterHello?: number
  /** Reply to Resume with op 9 (invalid session). */
  invalidResume?: boolean
  /** Reply to every Identify with op 9 (never Ready). */
  rejectIdentify?: boolean
}

type ClientData = { send(data: string): void; close(code?: number, reason?: string): void }

/**
 * Bun.serve WebSocket double of the official gateway: Hello (op 10) on open,
 * Ready after Identify, RESUMED after Resume, Heartbeat ACK (op 11).
 */
export class FakeQQBotGateway {
  readonly identifies: FakeGatewayIdentify[] = []
  readonly resumes: Array<{ token?: string; session_id?: string; seq?: number }> = []
  readonly heartbeats: Array<{ d: unknown; at: number }> = []
  readonly inbound: unknown[] = []
  connects = 0
  heartbeatIntervalMs: number
  sessionId: string
  botUser: { id: string; username: string; bot: boolean }
  invalidResume: boolean
  rejectIdentify: boolean
  closeAfterHello?: number
  private server: ReturnType<typeof Bun.serve<{ adapter?: ClientData }>>
  private clients: Array<{ ws: { send(data: string): void; close(code?: number, reason?: string): void } }> = []

  constructor(opts: FakeQQBotGatewayOptions = {}) {
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 40_000
    this.sessionId = opts.sessionId ?? "082ee18c-0be3-491b-9d8b-fbd95c51673a"
    this.botUser = opts.botUser ?? { id: "6158788878435714165", username: "群pro测试机器人", bot: true }
    this.invalidResume = opts.invalidResume ?? false
    this.rejectIdentify = opts.rejectIdentify ?? false
    this.closeAfterHello = opts.closeAfterHello
    const self = this
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return undefined as unknown as Response
        return new Response("expected websocket", { status: 400 })
      },
      websocket: {
        open(ws) {
          self.connects += 1
          self.clients.push({ ws })
          ws.send(JSON.stringify(hello(self.heartbeatIntervalMs)))
          if (self.closeAfterHello !== undefined) {
            queueMicrotask(() => {
              try {
                ws.close(self.closeAfterHello)
              } catch {
                // already gone
              }
            })
          }
        },
        message(ws, message) {
          const raw = typeof message === "string" ? message : new TextDecoder().decode(message)
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(raw) as Record<string, unknown>
          } catch {
            return
          }
          self.inbound.push(parsed)
          const op = Number(parsed.op)
          const d =
            parsed.d && typeof parsed.d === "object" && !Array.isArray(parsed.d)
              ? (parsed.d as Record<string, unknown>)
              : {}
          if (op === 2) {
            self.identifies.push({
              token: d.token !== undefined ? String(d.token) : undefined,
              intents: typeof d.intents === "number" ? d.intents : Number(d.intents),
              shard: d.shard,
              properties: d.properties,
            })
            if (self.rejectIdentify) {
              ws.send(JSON.stringify({ op: 9, d: false }))
              return
            }
            ws.send(
              JSON.stringify({
                op: 0,
                s: 1,
                t: "READY",
                id: "ready-event",
                d: readyEvent({ session_id: self.sessionId, user: self.botUser }),
              }),
            )
          } else if (op === 6) {
            self.resumes.push({
              token: d.token !== undefined ? String(d.token) : undefined,
              session_id: d.session_id !== undefined ? String(d.session_id) : undefined,
              seq: typeof d.seq === "number" ? d.seq : Number(d.seq),
            })
            if (self.invalidResume) {
              ws.send(JSON.stringify({ op: 9, d: false }))
              return
            }
            ws.send(JSON.stringify({ op: 0, s: (self.resumes.length + 1), t: "RESUMED", d: {} }))
          } else if (op === 1) {
            self.heartbeats.push({ d: parsed.d, at: Date.now() })
            ws.send(JSON.stringify({ op: 11, d: null }))
          }
        },
        close(ws) {
          self.clients = self.clients.filter((item) => item.ws !== ws)
        },
      },
    })
  }

  get url(): string {
    return `ws://127.0.0.1:${this.server.port}`
  }

  get clientCount(): number {
    return this.clients.length
  }

  sendDispatch(payload: Record<string, unknown>): void {
    const raw = JSON.stringify(payload)
    for (const client of this.clients) {
      try {
        client.ws.send(raw)
      } catch {
        // drop
      }
    }
  }

  sendOp(op: number, d: unknown = null): void {
    this.sendDispatch({ op, d })
  }

  closeClients(code?: number, reason?: string): void {
    for (const client of [...this.clients]) {
      try {
        client.ws.close(code, reason)
      } catch {
        // already gone
      }
    }
  }

  close(): void {
    this.closeClients()
    try {
      this.server.stop(true)
    } catch {
      // already gone
    }
  }
}

export function startFakeQQBotGateway(opts?: FakeQQBotGatewayOptions): FakeQQBotGateway {
  return new FakeQQBotGateway(opts)
}
