import { WsClient, type PlayerRole, type ServerFrame } from "@loreweaver/protocol"
import { IrohClient, isIrohTicket } from "./irohClient"

// The full client surface the TUI shell needs. This is the superset the web
// client declares (`clients/web/src/ws.ts`): connect/join/sendInput/onMessage +
// the optional close and the keeper-only admin_* requests. The real `WsClient`
// from `@loreweaver/protocol` implements every method, so it is what `createClient`
// hands back; tests inject a mock that satisfies the same interface.
//
// The `admin*` methods are only exercised by keeper-only screens (Stage 3); a
// player connection simply never calls them. `close?` is optional because a mock
// need not implement it, but `WsClient` does — the shell uses it to stop the
// auto-reconnect/re-join loop after a permanent `bad_key`.
export interface AppClient {
  connect(url: string): Promise<void>
  join(key: string, name?: string): void
  sendInput(text: string): void
  onMessage(cb: (frame: ServerFrame) => void): () => void
  close?(code?: number, reason?: string): void
  adminGetConfig(): void
  adminSetModel(provider: string, chatModel?: string, apiKey?: string, baseUrl?: string): void
  adminListModels(provider?: string, apiKey?: string, baseUrl?: string): void
  adminListKeys(): void
  adminMintKey(room: string, name?: string, role?: PlayerRole): void
  adminUpdateKey(id: string, room?: string, name?: string, role?: PlayerRole): void
  adminDeleteKey(id: string): void
  adminDeleteRoom(room: string): void
  adminExportRoom(room: string, path?: string): void
  adminImportRoom(path: string, room?: string): void
  adminDeleteRoomData(room: string, backup?: boolean, path?: string): void
}

// Picks the transport on connect by the shape of the target: a `ws(s)://` URL -> `WsClient`
// (browser-safe, zero deps), anything else (an Iroh ticket) -> `IrohClient` (p2p QUIC). The
// shell holds ONE stable client and subscribes `onMessage` once; this forwards frames from
// whichever transport is live, so the connect screen's host field transparently accepts
// either a `wss://…/ws` URL or a p2p ticket with no shell changes.
class TransportClient implements AppClient {
  private inner?: AppClient
  private readonly handlers = new Set<(frame: ServerFrame) => void>()

  async connect(target: string): Promise<void> {
    const inner = isIrohTicket(target) ? new IrohClient() : new WsClient()
    this.inner = inner
    inner.onMessage((frame) => {
      for (const handler of this.handlers) handler(frame)
    })
    await inner.connect(target)
  }

  join(key: string, name?: string): void {
    this.inner?.join(key, name)
  }
  sendInput(text: string): void {
    this.inner?.sendInput(text)
  }
  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.handlers.add(cb)
    return () => this.handlers.delete(cb)
  }
  close(code?: number, reason?: string): void {
    this.inner?.close?.(code, reason)
  }
  adminGetConfig(): void {
    this.inner?.adminGetConfig()
  }
  adminSetModel(provider: string, chatModel?: string, apiKey?: string, baseUrl?: string): void {
    this.inner?.adminSetModel(provider, chatModel, apiKey, baseUrl)
  }
  adminListModels(provider?: string, apiKey?: string, baseUrl?: string): void {
    this.inner?.adminListModels(provider, apiKey, baseUrl)
  }
  adminListKeys(): void {
    this.inner?.adminListKeys()
  }
  adminMintKey(room: string, name?: string, role?: PlayerRole): void {
    this.inner?.adminMintKey(room, name, role)
  }
  adminUpdateKey(id: string, room?: string, name?: string, role?: PlayerRole): void {
    this.inner?.adminUpdateKey(id, room, name, role)
  }
  adminDeleteKey(id: string): void {
    this.inner?.adminDeleteKey(id)
  }
  adminDeleteRoom(room: string): void {
    this.inner?.adminDeleteRoom(room)
  }
  adminExportRoom(room: string, path?: string): void {
    this.inner?.adminExportRoom(room, path)
  }
  adminImportRoom(path: string, room?: string): void {
    this.inner?.adminImportRoom(path, room)
  }
  adminDeleteRoomData(room: string, backup?: boolean, path?: string): void {
    this.inner?.adminDeleteRoomData(room, backup, path)
  }
}

// Bun exposes a global `WebSocket` (used by `WsClient`); `@number0/iroh` is imported lazily
// by `IrohClient` only when a ticket is dialed, so a WS connection pulls in no native code.
export function createClient(): AppClient {
  return new TransportClient()
}
