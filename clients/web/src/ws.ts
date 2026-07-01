import { WsClient, type ServerFrame } from "@trpg-kp/protocol"

// Minimal surface the UI needs from a client. WsClient satisfies it; tests
// inject a mock. The browser has a native WebSocket, so the WsClient default
// factory works with no extra wiring.
export interface AppClient {
  connect(url: string): Promise<void>
  join(key: string, name?: string): void
  sendInput(text: string): void
  onMessage(cb: (frame: ServerFrame) => void): () => void
  close?(code?: number, reason?: string): void
}

export function createClient(): AppClient {
  return new WsClient()
}
