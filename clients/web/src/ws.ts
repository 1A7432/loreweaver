import { WsClient, type PlayerRole, type ServerFrame } from "@trpg-kp/protocol"

// Minimal surface the UI needs from a client. WsClient satisfies it; tests
// inject a mock. The browser has a native WebSocket, so the WsClient default
// factory works with no extra wiring. The `admin*` methods are used by the
// keeper-only admin panel (v1.1); a player connection just never opens it.
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

export function createClient(): AppClient {
  return new WsClient()
}
