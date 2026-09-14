import {
  FrameType,
  type AdminKeyPurpose,
  type AdminDeleteRoomDataFrame,
  type AdminEnableSkillFrame,
  type AdminExportRoomFrame,
  type AdminForgeKind,
  type AdminGenerateFrame,
  type AdminImportRoomFrame,
  type AdminListModelsFrame,
  type AdminMintKeyFrame,
  type AdminResetRoomFrame,
  type AdminResetScope,
  type AdminSetImagegenFrame,
  type AdminSetModelFrame,
  type AdminUpdateKeyFrame,
  type ClientFrame,
  type ClientInfo,
  type ConnectionStatus,
  type MediaFrame,
  type MediaPayload,
  type MediaUpload,
  type PlayerRole,
  type ServerFrame,
} from "loreweaver-protocol"
import type { AppClient } from "./client"
import {
  IrohLink,
  bindIrohEndpoint,
  closeIrohEndpoint,
  defaultLoadIroh,
  ticketAddr,
  type IrohEndpointLike,
  type LoadIroh,
} from "./irohLink"

export type { LoadIroh }

// Iroh tickets are base32 (they start with "endpoint"); anything that isn't a ws(s):// URL is
// treated as one, so the connect field accepts either a p2p ticket or a WebSocket URL.
export function isIrohTicket(target: string): boolean {
  return !/^wss?:\/\//i.test(target.trim())
}

export interface IrohClientOptions {
  // Injected in tests to avoid loading the native `@number0/iroh` module at all; defaults to
  // the real dynamic import.
  loadIroh?: LoadIroh
  clientInfo?: ClientInfo
  reconnect?: boolean
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

/**
 * The p2p transport, behind the same `AppClient` contract as `WsClient`. `@number0/iroh` is a
 * native (napi) module, imported DYNAMICALLY in `irohLink.ts` — the browser web client never
 * loads this file, and a WS-only run never pulls iroh into memory. Frames are newline-JSON over
 * one long-lived `openBi` stream, dispatched with the shared `loreweaver-protocol` validators.
 *
 * Reconnect parity with `WsClient` (clients/protocol/src/client.ts): `lastJoin` is re-sent on
 * every successful (re)dial; an unexpected end of the read loop (not a manual `close()`)
 * schedules a redial of the same ticket with the same exponential backoff (base 250ms, max
 * 5000ms); `close()` sets `manualClose` and permanently stops the loop.
 *
 * Each dial binds a FRESH native endpoint and opens one `IrohLink`. That is right for a single
 * TUI session; the bridge's `LinkPool` instead shares one endpoint across N member links.
 */
export class IrohClient implements AppClient {
  private endpoint: IrohEndpointLike | undefined
  private link: IrohLink | undefined
  private manualClose = false
  private ticket?: string
  private lastJoin?: { key: string; name?: string }
  private reconnectAttempts = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  // Bumped on every `dial()` so a stale readLoop from a superseded connection attempt can
  // never trigger a duplicate redial once a newer dial has taken over.
  private generation = 0
  private readonly handlers = new Set<(frame: ServerFrame) => void>()
  private readonly statusHandlers = new Set<(status: ConnectionStatus) => void>()
  private readonly loadIroh: LoadIroh
  private readonly clientInfo?: ClientInfo
  private readonly reconnect: boolean
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout

  constructor(options: IrohClientOptions = {}) {
    this.loadIroh = options.loadIroh ?? defaultLoadIroh
    this.clientInfo = options.clientInfo
    this.reconnect = options.reconnect ?? true
    this.reconnectBaseMs = options.reconnectBaseMs ?? 250
    this.reconnectMaxMs = options.reconnectMaxMs ?? 5_000
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
  }

  async connect(ticket: string): Promise<void> {
    this.ticket = ticket
    this.manualClose = false
    this.reconnectAttempts = 0
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    // A first-time connect failure rejects straight to the caller (the connect screen shows
    // the error) — it does NOT enter the redial loop; redials only start once a session has
    // actually been established (see `irohLink.ts` unexpected-end handling).
    await this.dial(ticket)
  }

  private async dial(ticket: string): Promise<void> {
    const myGeneration = ++this.generation
    this.setStatus("connecting")
    const { iroh, endpoint } = await bindIrohEndpoint(this.loadIroh)
    let link: IrohLink
    try {
      const addr = ticketAddr(iroh, ticket)
      link = await IrohLink.open(endpoint, addr)
    } catch (error) {
      closeIrohEndpoint(endpoint)
      throw error
    }

    // A manual close() (or a newer dial superseding this one) raced us while we were still
    // connecting — don't take over as the live connection; tear down what we just opened.
    if (this.manualClose || myGeneration !== this.generation) {
      link.close()
      closeIrohEndpoint(endpoint)
      return
    }

    // Hand over to the new connection FIRST, then close the one it supersedes. Each dial()
    // binds a fresh native Endpoint, so on a redial after an unexpected drop the prior endpoint
    // must be closed or every reconnect over a long, flap-prone session leaks its socket/QUIC
    // state. Closing only AFTER the handoff means the live stream is never dropped mid-swap.
    const supersededEndpoint = this.endpoint
    const supersededLink = this.link
    this.endpoint = endpoint
    this.link = link
    this.reconnectAttempts = 0
    link.onMessage((frame) => {
      for (const handler of this.handlers) handler(frame)
    })
    link.onUnexpectedEnd(() => {
      if (!this.manualClose && myGeneration === this.generation) this.scheduleRedial()
    })
    // Same order as `close()`: drop the superseded link, then its endpoint.
    supersededLink?.close()
    if (supersededEndpoint && supersededEndpoint !== endpoint) closeIrohEndpoint(supersededEndpoint)
    // F13: the superseded link is left with its own write chain. Nothing waits on a
    // hung writeAll against the dead stream; this dial's IrohLink started a fresh chain.
    this.setStatus("online")
    if (this.lastJoin) link.join(this.lastJoin.key, this.lastJoin.name, this.clientInfo)
    link.start()
  }

  private scheduleRedial(): void {
    if (this.manualClose || !this.reconnect || !this.ticket) return
    this.setStatus("reconnecting")
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.reconnectAttempts)
    this.reconnectAttempts += 1
    this.reconnectTimer = this.setTimeoutFn(() => {
      // A redial attempt itself can fail (still no network) — unlike `connect()`, keep
      // retrying with the same backoff rather than giving up silently.
      this.dial(this.ticket!).catch(() => this.scheduleRedial())
    }, delay)
  }

  private sendFrame(frame: ClientFrame): void {
    this.link?.send(frame)
  }

  join(key: string, name?: string): void {
    this.lastJoin = { key, name }
    this.link?.join(key, name, this.clientInfo)
  }

  sendInput(text: string): void {
    this.sendFrame({ type: FrameType.Input, text })
  }

  // v2.2: the installed-pack card listing request, identical wire to WsClient.
  listPackCards(): void {
    this.sendFrame({ type: FrameType.ListPackCards })
  }

  async uploadMedia(upload: MediaUpload): Promise<MediaFrame | undefined> {
    if (!this.link) throw new Error("Iroh connection is not open.")
    return this.link.uploadMedia(upload)
  }

  async getMedia(hash: string): Promise<MediaPayload> {
    if (!this.link) throw new Error("Iroh connection is not open.")
    return this.link.getMedia(hash)
  }

  setMediaEnabled(enabled: boolean): void {
    this.sendFrame({ type: FrameType.MediaSetEnabled, enabled })
  }

  setAvatar(hash: string): void {
    this.sendFrame({ type: FrameType.AvatarSet, hash })
  }

  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.handlers.add(cb)
    return () => this.handlers.delete(cb)
  }

  onStatus(cb: (status: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(cb)
    return () => this.statusHandlers.delete(cb)
  }

  private setStatus(status: ConnectionStatus): void {
    for (const cb of this.statusHandlers) cb(status)
  }

  close(): void {
    this.manualClose = true
    this.generation += 1
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.setStatus("offline")
    this.link?.close()
    this.link = undefined
    closeIrohEndpoint(this.endpoint)
    this.endpoint = undefined
  }

  // ---- v1.1 admin (keeper-gated) requests, identical wire to WsClient -------
  adminGetConfig(): void {
    this.sendFrame({ type: FrameType.AdminGetConfig })
  }

  adminSetModel(provider: string, chatModel?: string, apiKey?: string, baseUrl?: string): void {
    const frame: AdminSetModelFrame = { type: FrameType.AdminSetModel, provider }
    if (chatModel) frame.chat_model = chatModel
    // Empty and omitted have different protocol semantics: empty clears a saved
    // credential field; undefined reuses the unchanged endpoint pair.
    if (apiKey !== undefined) frame.api_key = apiKey
    if (baseUrl !== undefined) frame.base_url = baseUrl
    this.sendFrame(frame)
  }

  adminSetImagegen(provider: string, model: string, apiKey?: string, baseUrl?: string, size?: string): void {
    const frame: AdminSetImagegenFrame = { type: FrameType.AdminSetImagegen, provider, model }
    if (apiKey !== undefined) frame.api_key = apiKey
    if (baseUrl !== undefined) frame.base_url = baseUrl
    if (size) frame.size = size
    this.sendFrame(frame)
  }

  adminListModels(provider?: string, apiKey?: string, baseUrl?: string): void {
    const frame: AdminListModelsFrame = { type: FrameType.AdminListModels }
    if (provider) frame.provider = provider
    if (apiKey !== undefined) frame.api_key = apiKey
    if (baseUrl !== undefined) frame.base_url = baseUrl
    this.sendFrame(frame)
  }

  adminListKeys(): void {
    this.sendFrame({ type: FrameType.AdminListKeys })
  }

  adminMintKey(
    room?: string,
    name?: string,
    role?: PlayerRole,
    purpose?: AdminKeyPurpose,
    expiresIn?: number,
  ): void {
    const frame: AdminMintKeyFrame = { type: FrameType.AdminMintKey }
    if (room !== undefined) frame.room = room
    if (name) frame.name = name
    if (role) frame.role = role
    if (purpose) frame.purpose = purpose
    if (expiresIn !== undefined) frame.expires_in = expiresIn
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

  adminResetRoom(room: string, scope?: AdminResetScope): void {
    const frame: AdminResetRoomFrame = { type: FrameType.AdminResetRoom, room }
    if (scope) frame.scope = scope
    this.sendFrame(frame)
  }

  adminUpdateServer(): void {
    this.sendFrame({ type: FrameType.AdminUpdateServer })
  }

  // ---- v1.1 additive: Layer B.4a plugin management, identical wire to WsClient ------
  adminListSkills(locale?: string): void {
    this.sendFrame({ type: FrameType.AdminListSkills, ...(locale ? { locale } : {}) })
  }

  adminEnableSkill(id: string, on: boolean, locale?: string): void {
    const frame: AdminEnableSkillFrame = { type: FrameType.AdminEnableSkill, id, on, ...(locale ? { locale } : {}) }
    this.sendFrame(frame)
  }

  adminListRules(): void {
    this.sendFrame({ type: FrameType.AdminListRules })
  }

  adminGenerate(kind: AdminForgeKind, description: string): void {
    const frame: AdminGenerateFrame = { type: FrameType.AdminGenerate, kind, description }
    this.sendFrame(frame)
  }
}
