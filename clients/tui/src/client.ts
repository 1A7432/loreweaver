import { WsClient, type PlayerRole, type ServerFrame } from "@trpg-kp/protocol"

// The full client surface the TUI shell needs. This is the superset the web
// client declares (`clients/web/src/ws.ts`): connect/join/sendInput/onMessage +
// the optional close and the keeper-only admin_* requests. The real `WsClient`
// from `@trpg-kp/protocol` implements every method, so it is what `createClient`
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
  adminSetModel(provider: string, chatModel?: string): void
  adminListKeys(): void
  adminMintKey(room: string, name?: string, role?: PlayerRole): void
  adminUpdateKey(id: string, room?: string, name?: string, role?: PlayerRole): void
  adminDeleteKey(id: string): void
  adminDeleteRoom(room: string): void
  adminExportRoom(room: string, path?: string): void
  adminImportRoom(path: string, room?: string): void
  adminDeleteRoomData(room: string, backup?: boolean, path?: string): void
}

// Bun exposes a global `WebSocket`, so `WsClient`'s default factory works with no
// extra wiring — this matches the construction the previous `index.tsx` used.
export function createClient(): AppClient {
  return new WsClient()
}
