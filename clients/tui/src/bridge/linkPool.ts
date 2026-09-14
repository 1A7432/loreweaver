import type { ClientInfo } from "loreweaver-protocol"
import {
  IrohLink,
  bindIrohEndpoint,
  closeIrohEndpoint,
  defaultLoadIroh,
  ticketAddr,
  type IrohEndpointLike,
  type LoadIroh,
} from "../irohLink"

const DEFAULT_IDLE_CLOSE_MS = 30 * 60 * 1000
const DEFAULT_RECONNECT_BASE_MS = 250
const DEFAULT_RECONNECT_MAX_MS = 5_000

export type LinkReadyReason = "open" | "redial"

export interface LinkPoolOptions {
  // Injected in tests to avoid loading the native `@number0/iroh` module at all; defaults to
  // the real dynamic import.
  loadIroh?: LoadIroh
  clientInfo?: ClientInfo
  reconnect?: boolean
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  /** Idle close; default 30 minutes. Persistent links (`idleClose: false`) ignore this. */
  idleCloseMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  /**
   * Fired after a link is opened or redialed, before join is sent and the read loop
   * starts, so the owner can attach a replay gate (WS2) to THIS connection.
   * Subscriptions do NOT migrate across redials — the owner re-attaches them
   * inside this hook for each new IrohLink.
   */
  onLinkReady?: (memberKey: string, link: IrohLink, reason: LinkReadyReason) => void
  /** Fired on an unexpected read-loop end so WS2 can queue input while the member reconnects. */
  onLinkDown?: (memberKey: string) => void
}

export interface OpenLinkOptions {
  name?: string
  /** When false, the link is never idle-closed (the observer). Default true. */
  idleClose?: boolean
}

interface MemberSlot {
  key: string
  name?: string
  idleClose: boolean
  link?: IrohLink
  opening?: Promise<IrohLink>
  generation: number
  reconnectAttempts: number
  lastTouch: number
  idleTimer?: ReturnType<typeof setTimeout>
  reconnectTimer?: ReturnType<typeof setTimeout>
  reconnectReject?: (error: Error) => void
}

/**
 * One Iroh endpoint, N `IrohLink`s keyed by member key. The TUI's `IrohClient` binds a
 * fresh endpoint per dial (right for a single session); the bridge shares one endpoint
 * across observer + player + admin links. Each link redials on drop with the TUI backoff
 * and starts a fresh F13 write chain; idle player links close after `idleCloseMs`.
 */
export class LinkPool {
  private endpoint: IrohEndpointLike | undefined
  private addr: unknown
  private ticket?: string
  private closed = false
  private readonly members = new Map<string, MemberSlot>()
  private readonly loadIroh: LoadIroh
  private readonly clientInfo?: ClientInfo
  private readonly reconnect: boolean
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly idleCloseMs: number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout
  private readonly onLinkReady?: (memberKey: string, link: IrohLink, reason: LinkReadyReason) => void
  private readonly onLinkDown?: (memberKey: string) => void

  constructor(options: LinkPoolOptions = {}) {
    this.loadIroh = options.loadIroh ?? defaultLoadIroh
    this.clientInfo = options.clientInfo
    this.reconnect = options.reconnect ?? true
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS
    this.idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
    this.onLinkReady = options.onLinkReady
    this.onLinkDown = options.onLinkDown
  }

  async connect(ticket: string): Promise<void> {
    if (this.closed) throw new Error("LinkPool is closed.")
    if (this.endpoint) {
      if (this.ticket === ticket) return
      throw new Error("LinkPool is already connected to a different ticket.")
    }
    const { iroh, endpoint } = await bindIrohEndpoint(this.loadIroh)
    if (this.closed) {
      closeIrohEndpoint(endpoint)
      throw new Error("LinkPool is closed.")
    }
    let addr: unknown
    try {
      addr = ticketAddr(iroh, ticket)
    } catch (error) {
      closeIrohEndpoint(endpoint)
      throw error
    }
    this.addr = addr
    this.ticket = ticket
    this.endpoint = endpoint
  }

  get(memberKey: string): IrohLink | undefined {
    const slot = this.members.get(memberKey)
    return slot?.link?.isAlive ? slot.link : undefined
  }

  async open(memberKey: string, options: OpenLinkOptions = {}): Promise<IrohLink> {
    if (this.closed) throw new Error("LinkPool is closed.")
    if (!this.endpoint) throw new Error("Iroh connection is not open.")
    let slot = this.members.get(memberKey)
    if (slot?.link?.isAlive) {
      this.touch(memberKey)
      return slot.link
    }
    if (slot?.opening) {
      this.touch(memberKey)
      return slot.opening
    }
    if (!slot) {
      slot = {
        key: memberKey,
        name: options.name,
        idleClose: options.idleClose ?? true,
        generation: 0,
        reconnectAttempts: 0,
        lastTouch: Date.now(),
      }
      this.members.set(memberKey, slot)
    } else {
      if (options.name !== undefined) slot.name = options.name
      if (options.idleClose !== undefined) slot.idleClose = options.idleClose
      slot.lastTouch = Date.now()
    }
    const promise = this.dialMember(slot, "open").then((link) => {
      this.armIdle(slot)
      return link
    })
    slot.opening = promise
    try {
      return await promise
    } catch (error) {
      if (!slot.link?.isAlive) this.members.delete(memberKey)
      throw error
    } finally {
      if (slot.opening === promise) slot.opening = undefined
    }
  }

  touch(memberKey: string): void {
    const slot = this.members.get(memberKey)
    if (!slot) return
    slot.lastTouch = Date.now()
    this.armIdle(slot)
  }

  closeLink(memberKey: string): void {
    const slot = this.members.get(memberKey)
    if (!slot) return
    this.dropSlot(slot)
    this.members.delete(memberKey)
  }

  close(): void {
    this.closed = true
    for (const slot of [...this.members.values()]) this.dropSlot(slot)
    this.members.clear()
    closeIrohEndpoint(this.endpoint)
    this.endpoint = undefined
  }

  private async dialMember(slot: MemberSlot, reason: LinkReadyReason): Promise<IrohLink> {
    if (this.closed || !this.endpoint) throw new Error("Iroh connection is not open.")
    const myGeneration = ++slot.generation
    const link = await IrohLink.open(this.endpoint, this.addr)
    if (this.closed || slot.generation !== myGeneration) {
      link.close()
      throw new Error("Iroh connection is not open.")
    }
    const superseded = slot.link
    slot.link = link
    if (slot.reconnectTimer) {
      this.clearTimeoutFn(slot.reconnectTimer)
      slot.reconnectTimer = undefined
    }
    link.onUnexpectedEnd(() => {
      if (this.closed || slot.generation !== myGeneration) return
      this.scheduleRedial(slot)
      try {
        this.onLinkDown?.(slot.key)
      } catch {
        // a notification must not decide the redial
      }
    })
    // F13: the superseded link keeps its hung write chain; this dial's IrohLink is fresh.
    if (superseded && superseded !== link) superseded.close()
    try {
      this.onLinkReady?.(slot.key, link, reason)
    } catch {
      // a notification must not decide the dial
    }
    link.join(slot.key, slot.name, this.clientInfo)
    link.start()
    slot.reconnectAttempts = 0
    return link
  }

  private scheduleRedial(slot: MemberSlot): void {
    if (this.closed || !this.reconnect || !this.ticket) return
    if (slot.opening) return
    // Assign the shared promise SYNCHRONOUSLY so a concurrent open() (or onLinkDown
    // calling open) joins this redial instead of starting a second connect.
    let settle: (link: IrohLink) => void = () => {}
    let fail: (error: unknown) => void = () => {}
    const promise = new Promise<IrohLink>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    slot.opening = promise
    void this.redialUntilUp(slot).then(settle, fail)
    void promise.catch(() => {})
    void promise.finally(() => {
      if (slot.opening === promise) slot.opening = undefined
    })
  }

  private async redialUntilUp(slot: MemberSlot): Promise<IrohLink> {
    while (!this.closed && this.reconnect) {
      const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** slot.reconnectAttempts)
      slot.reconnectAttempts += 1
      await this.sleep(delay, slot)
      if (this.closed) throw new Error("LinkPool is closed.")
      try {
        return await this.dialMember(slot, "redial")
      } catch (error) {
        if (this.closed || !this.reconnect) throw error instanceof Error ? error : new Error("Iroh connection is not open.")
      }
    }
    throw new Error("LinkPool is closed.")
  }

  private sleep(ms: number, slot: MemberSlot): Promise<void> {
    return new Promise((resolve, reject) => {
      slot.reconnectReject = reject
      slot.reconnectTimer = this.setTimeoutFn(() => {
        slot.reconnectTimer = undefined
        slot.reconnectReject = undefined
        resolve()
      }, ms)
    })
  }

  private armIdle(slot: MemberSlot): void {
    if (slot.idleTimer) {
      this.clearTimeoutFn(slot.idleTimer)
      slot.idleTimer = undefined
    }
    if (!slot.idleClose || this.closed) return
    const remaining = this.idleCloseMs - (Date.now() - slot.lastTouch)
    const delay = Math.max(0, remaining)
    slot.idleTimer = this.setTimeoutFn(() => {
      if (this.closed) return
      this.closeLink(slot.key)
    }, delay)
  }

  private dropSlot(slot: MemberSlot): void {
    slot.generation += 1
    if (slot.idleTimer) {
      this.clearTimeoutFn(slot.idleTimer)
      slot.idleTimer = undefined
    }
    if (slot.reconnectTimer) {
      this.clearTimeoutFn(slot.reconnectTimer)
      slot.reconnectTimer = undefined
    }
    if (slot.reconnectReject) {
      slot.reconnectReject(new Error("LinkPool is closed."))
      slot.reconnectReject = undefined
    }
    slot.link?.close()
  }
}
