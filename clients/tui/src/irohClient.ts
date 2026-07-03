import {
  FrameType,
  isPingFrame,
  isServerFrame,
  type AdminDeleteRoomDataFrame,
  type AdminExportRoomFrame,
  type AdminImportRoomFrame,
  type AdminMintKeyFrame,
  type AdminUpdateKeyFrame,
  type ClientFrame,
  type PlayerRole,
  type ServerFrame,
} from "@loreweaver/protocol"
import type { AppClient } from "./client"

// The ALPN + newline framing MUST match net/iroh_server.py. A QUIC bidi stream is a raw byte
// stream (no message boundaries), so every frame is one compact JSON object + "\n".
const ALPN = "loreweaver/tui/1"
const NEWLINE = 10
const enc = new TextEncoder()
const dec = new TextDecoder()
const toBytes = (text: string): number[] => Array.from(enc.encode(text))

// Iroh tickets are base32 (they start with "endpoint"); anything that isn't a ws(s):// URL is
// treated as one, so the connect field accepts either a p2p ticket or a WebSocket URL.
export function isIrohTicket(target: string): boolean {
  return !/^wss?:\/\//i.test(target.trim())
}

/**
 * The p2p transport, behind the same `AppClient` contract as `WsClient`. `@number0/iroh` is a
 * native (napi) module, imported DYNAMICALLY in `connect` — the browser web client never loads
 * this file, and a WS-only run never pulls iroh into memory. Frames are newline-JSON over one
 * long-lived `openBi` stream, dispatched with the shared `@loreweaver/protocol` validators.
 */
export class IrohClient implements AppClient {
  private endpoint: unknown
  private sendStream: { writeAll(buf: number[]): Promise<void> } | undefined
  private closed = false
  private writeChain: Promise<void> = Promise.resolve()
  private readonly handlers = new Set<(frame: ServerFrame) => void>()

  async connect(ticket: string): Promise<void> {
    const iroh = await import("@number0/iroh")
    const builder = iroh.Endpoint.builder()
    iroh.presetN0(builder)
    const endpoint = await builder.bind()
    this.endpoint = endpoint
    await endpoint.online()
    const addr = iroh.EndpointTicket.fromString(ticket.trim()).endpointAddr()
    const conn = await this.connectWithRetry(endpoint, addr, toBytes(ALPN))
    const bi = await conn.openBi()
    this.sendStream = bi.send
    void this.readLoop(bi.recv)
  }

  private async connectWithRetry(endpoint: any, addr: unknown, alpn: number[], tries = 2): Promise<any> {
    let lastError: unknown
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        return await endpoint.connect(addr, alpn)
      } catch (error) {
        lastError = error // p2p first-connect can flake on relay warm-up — one retry
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Iroh connection failed.")
  }

  private async readLoop(recv: { read(limit: number): Promise<number[] | null> }): Promise<void> {
    let buffer = new Uint8Array(0)
    try {
      while (!this.closed) {
        const chunk = await recv.read(65536)
        if (!chunk || chunk.length === 0) break // EOF / reset
        buffer = concat(buffer, Uint8Array.from(chunk))
        let nl: number
        while ((nl = buffer.indexOf(NEWLINE)) >= 0) {
          this.dispatch(dec.decode(buffer.subarray(0, nl)))
          buffer = buffer.subarray(nl + 1)
        }
      }
    } catch {
      // stream closed / reset — nothing more to read
    }
  }

  private dispatch(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return // untrusted transport: a non-JSON line must never throw out of the read loop
    }
    if (isPingFrame(parsed)) {
      this.sendFrame({ type: FrameType.Pong, t: parsed.t })
      return
    }
    if (!isServerFrame(parsed)) return
    for (const handler of this.handlers) handler(parsed)
  }

  private sendFrame(frame: ClientFrame): void {
    const line = toBytes(`${JSON.stringify(frame)}\n`)
    // Serialize writes: interleaved writeAll on one QUIC stream would corrupt the framing.
    this.writeChain = this.writeChain.then(() => this.sendStream?.writeAll(line)).catch(() => {})
  }

  join(key: string, name?: string): void {
    this.sendFrame(name ? { type: FrameType.Join, key, name } : { type: FrameType.Join, key })
  }

  sendInput(text: string): void {
    this.sendFrame({ type: FrameType.Input, text })
  }

  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.handlers.add(cb)
    return () => this.handlers.delete(cb)
  }

  close(): void {
    this.closed = true
    try {
      ;(this.endpoint as { close?: () => void } | undefined)?.close?.()
    } catch {
      // ignore — already gone
    }
  }

  // ---- v1.1 admin (keeper-gated) requests, identical wire to WsClient -------
  adminGetConfig(): void {
    this.sendFrame({ type: FrameType.AdminGetConfig })
  }

  adminSetModel(provider: string, chatModel?: string): void {
    this.sendFrame(
      chatModel
        ? { type: FrameType.AdminSetModel, provider, chat_model: chatModel }
        : { type: FrameType.AdminSetModel, provider },
    )
  }

  adminListKeys(): void {
    this.sendFrame({ type: FrameType.AdminListKeys })
  }

  adminMintKey(room: string, name?: string, role?: PlayerRole): void {
    const frame: AdminMintKeyFrame = { type: FrameType.AdminMintKey, room }
    if (name) frame.name = name
    if (role) frame.role = role
    this.sendFrame(frame)
  }

  adminUpdateKey(id: string, room?: string, name?: string, role?: PlayerRole): void {
    const frame: AdminUpdateKeyFrame = { type: FrameType.AdminUpdateKey, id }
    if (room) frame.room = room
    if (name) frame.name = name
    if (role) frame.role = role
    this.sendFrame(frame)
  }

  adminDeleteKey(id: string): void {
    this.sendFrame({ type: FrameType.AdminDeleteKey, id })
  }

  adminDeleteRoom(room: string): void {
    this.sendFrame({ type: FrameType.AdminDeleteRoom, room })
  }

  adminExportRoom(room: string, path?: string): void {
    const frame: AdminExportRoomFrame = { type: FrameType.AdminExportRoom, room }
    if (path) frame.path = path
    this.sendFrame(frame)
  }

  adminImportRoom(path: string, room?: string): void {
    const frame: AdminImportRoomFrame = { type: FrameType.AdminImportRoom, path }
    if (room) frame.room = room
    this.sendFrame(frame)
  }

  adminDeleteRoomData(room: string, backup?: boolean, path?: string): void {
    const frame: AdminDeleteRoomDataFrame = { type: FrameType.AdminDeleteRoomData, room }
    if (backup !== undefined) frame.backup = backup
    if (path) frame.path = path
    this.sendFrame(frame)
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}
