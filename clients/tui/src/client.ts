import {
  WsClient,
  type AdminForgeKind,
  type ConnectionStatus,
  type MediaFrame,
  type MediaPayload,
  type MediaUpload,
  type PlayerRole,
  type ServerFrame,
} from "@loreweaver/protocol"
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
  uploadMedia(upload: MediaUpload): Promise<MediaFrame | undefined>
  getMedia(hash: string): Promise<MediaPayload>
  setMediaEnabled(enabled: boolean): void
  setAvatar(hash: string): void
  onMessage(cb: (frame: ServerFrame) => void): () => void
  close?(code?: number, reason?: string): void
  // Optional: a coarse liveness signal ("connecting"/"online"/"reconnecting"/"offline") for a
  // small HUD indicator (GameView's HeaderBar). Optional so a test mock need not implement it —
  // the shell renders nothing/neutral when it's absent.
  onStatus?(cb: (status: ConnectionStatus) => void): () => void
  adminGetConfig(): void
  adminSetModel(provider: string, chatModel?: string, apiKey?: string, baseUrl?: string): void
  adminSetImagegen(provider: string, model: string, apiKey?: string, baseUrl?: string, size?: string): void
  adminListModels(provider?: string, apiKey?: string, baseUrl?: string): void
  adminListKeys(): void
  adminMintKey(room: string, name?: string, role?: PlayerRole): void
  adminUpdateKey(id: string, room?: string, name?: string, role?: PlayerRole): void
  adminDeleteKey(id: string): void
  adminDeleteRoom(room: string): void
  adminExportRoom(room: string, path?: string): void
  adminImportRoom(path: string, room?: string): void
  adminDeleteRoomData(room: string, backup?: boolean, path?: string): void
  // v1.1 additive: Layer B.4a plugin management (KP skills / rule systems / self-extension forge).
  adminListSkills(): void
  adminEnableSkill(id: string, on: boolean): void
  adminListRules(): void
  adminGenerate(kind: AdminForgeKind, description: string): void
}

// Picks the transport on connect by the shape of the target: a `ws(s)://` URL -> `WsClient`
// (browser-safe, zero deps), anything else (an Iroh ticket) -> `IrohClient` (p2p QUIC). The
// shell holds ONE stable client and subscribes `onMessage` once; this forwards frames from
// whichever transport is live, so the connect screen's host field transparently accepts
// either a `wss://…/ws` URL or a p2p ticket with no shell changes.
class TransportClient implements AppClient {
  private inner?: AppClient
  private readonly handlers = new Set<(frame: ServerFrame) => void>()
  private readonly statusHandlers = new Set<(status: ConnectionStatus) => void>()

  async connect(target: string): Promise<void> {
    const inner = isIrohTicket(target) ? new IrohClient() : new WsClient()
    this.inner = inner
    inner.onMessage((frame) => {
      for (const handler of this.handlers) handler(frame)
    })
    inner.onStatus?.((status) => {
      for (const handler of this.statusHandlers) handler(status)
    })
    await inner.connect(target)
  }

  join(key: string, name?: string): void {
    this.inner?.join(key, name)
  }
  sendInput(text: string): void {
    this.inner?.sendInput(text)
  }
  uploadMedia(upload: MediaUpload): Promise<MediaFrame | undefined> {
    return this.inner?.uploadMedia(upload) ?? Promise.reject(new Error("not connected"))
  }
  getMedia(hash: string): Promise<MediaPayload> {
    return this.inner?.getMedia(hash) ?? Promise.reject(new Error("not connected"))
  }
  setMediaEnabled(enabled: boolean): void {
    this.inner?.setMediaEnabled(enabled)
  }
  setAvatar(hash: string): void {
    this.inner?.setAvatar(hash)
  }
  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.handlers.add(cb)
    return () => this.handlers.delete(cb)
  }
  onStatus(cb: (status: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(cb)
    return () => this.statusHandlers.delete(cb)
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
  adminSetImagegen(provider: string, model: string, apiKey?: string, baseUrl?: string, size?: string): void {
    this.inner?.adminSetImagegen(provider, model, apiKey, baseUrl, size)
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
  adminListSkills(): void {
    this.inner?.adminListSkills()
  }
  adminEnableSkill(id: string, on: boolean): void {
    this.inner?.adminEnableSkill(id, on)
  }
  adminListRules(): void {
    this.inner?.adminListRules()
  }
  adminGenerate(kind: AdminForgeKind, description: string): void {
    this.inner?.adminGenerate(kind, description)
  }
}

// Bun exposes a global `WebSocket` (used by `WsClient`); `@number0/iroh` is imported lazily
// by `IrohClient` only when a ticket is dialed, so a WS connection pulls in no native code.
export function createClient(): AppClient {
  return new TransportClient()
}
