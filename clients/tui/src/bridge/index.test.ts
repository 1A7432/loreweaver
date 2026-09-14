import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { FrameType } from "loreweaver-protocol"
import type { LoadIroh } from "../irohLink"
import { tt } from "../i18n"
import {
  isDroppedOneBotSender,
  onebotTransportOptions,
  parseBridgeConfig,
  runBridge,
  runBridgeFromFile,
} from "./index"
import type { ConnectFactory, OneBotInbound, OneBotSocket } from "./onebot"

const TICKET = "endpointaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const KEEP = "KEEP-SECRET"
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function createMockIroh() {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const sent: string[] = []
  const joins: Array<{ key: string; name?: string; stream: ReturnType<typeof makeRecvStream> }> = []

  function makeRecvStream() {
    const queue: Array<number[] | null> = []
    let waiter: ((value: number[] | null) => void) | undefined
    return {
      end(): void {
        if (waiter) {
          const resolve = waiter
          waiter = undefined
          resolve(null)
        } else {
          queue.push(null)
        }
      },
      push(text: string): void {
        this.pushBytes(enc.encode(text))
      },
      pushBytes(data: Uint8Array | number[]): void {
        const bytes = Array.from(data)
        if (waiter) {
          const resolve = waiter
          waiter = undefined
          resolve(bytes)
        } else {
          queue.push(bytes)
        }
      },
      async read(): Promise<number[] | null> {
        if (queue.length > 0) return queue.shift()!
        return new Promise((resolve) => {
          waiter = resolve
        })
      },
    }
  }

  const streams: Array<ReturnType<typeof makeRecvStream>> = []

  const loadIroh: LoadIroh = async () => ({
    Endpoint: {
      builder: () => ({
        bind: async () => ({
          online: async () => {},
          connect: async () => ({
            openBi: async () => {
              const recv = makeRecvStream()
              streams.push(recv)
              return {
                send: {
                  writeAll: async (buf: number[]) => {
                    const text = dec.decode(Uint8Array.from(buf))
                    sent.push(text)
                    for (const line of text.split("\n").filter(Boolean)) {
                      let frame: Record<string, unknown>
                      try {
                        frame = JSON.parse(line) as Record<string, unknown>
                      } catch {
                        continue
                      }
                      if (frame.type === FrameType.Join) {
                        joins.push({
                          key: String(frame.key),
                          name: typeof frame.name === "string" ? frame.name : undefined,
                          stream: recv,
                        })
                      }
                      if (frame.type === FrameType.AdminMintKey) {
                        const name = String(frame.name)
                        const role = frame.role === "keeper" ? "keeper" : "player"
                        const key = `k-${name}`
                        const id = `id-${name}`
                        recv.push(
                          `${JSON.stringify({
                            type: FrameType.AdminKeys,
                            keys: [
                              {
                                id,
                                key_masked: "xxxx",
                                room: "arkham",
                                name,
                                role,
                                purpose: "join",
                                expires_at: null,
                              },
                            ],
                            minted: { key, room: "arkham", name, role, purpose: "join", expires_at: null },
                          })}\n`,
                        )
                      }
                      if (frame.type === FrameType.MediaOffer) {
                        recv.push(
                          `${JSON.stringify({
                            type: FrameType.MediaAccept,
                            upload_id: "existing",
                            existing: true,
                            media: {
                              type: FrameType.Media,
                              id: "m1",
                              hash: String(frame.sha256),
                              mime: String(frame.mime),
                              size: Number(frame.size),
                              name: String(frame.name),
                              from: "qq",
                              ts: 1,
                            },
                          })}\n`,
                        )
                      }
                      if (frame.op === "get") {
                        const hash = String(frame.hash)
                        const body = enc.encode("PNG")
                        const header = enc.encode(
                          `${JSON.stringify({ op: "get", hash, size: body.length, mime: "image/png", name: "shot.png" })}\n`,
                        )
                        const combined = new Uint8Array(header.length + body.length)
                        combined.set(header, 0)
                        combined.set(body, header.length)
                        recv.pushBytes(combined)
                      }
                    }
                  },
                },
                recv,
              }
            },
          }),
          close: () => {},
        }),
      }),
    },
    presetN0: () => {},
    EndpointTicket: { fromString: () => ({ endpointAddr: () => ({}) }) },
  })

  return { loadIroh, sent, streams, joins }
}

class AckSocket implements OneBotSocket {
  sent: string[] = []
  failPrivate = false
  closeArgs?: { code?: number; reason?: string }
  private readonly queue: string[] = []
  private waiter?: (result: IteratorResult<string>) => void
  private closed = false
  private ids = 100

  send(data: string): void {
    this.sent.push(data)
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    if (parsed.echo && parsed.action) {
      const fail = this.failPrivate && parsed.action === "send_private_msg"
      const echo = parsed.echo
      queueMicrotask(() => {
        this.push({
          status: fail ? "failed" : "ok",
          retcode: fail ? 1 : 0,
          echo,
          wording: fail ? "not friend" : "",
          data: fail ? {} : { message_id: ++this.ids },
        })
      })
    }
  }

  close(code?: number, reason?: string): void {
    this.closeArgs = { code, reason }
    this.end()
  }

  push(payload: unknown): void {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload)
    if (this.closed) return
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter({ value: raw, done: false })
    } else {
      this.queue.push(raw)
    }
  }

  end(): void {
    if (this.closed) return
    this.closed = true
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift()!, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiter = resolve
        })
      },
    }
  }
}

function framesOf(sent: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const chunk of sent) {
    for (const line of chunk.split("\n").filter(Boolean)) {
      try {
        out.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // ignore binary media chunks
      }
    }
  }
  return out
}

function onebotActions(socket: AckSocket): Array<Record<string, unknown>> {
  return socket.sent.map((line) => JSON.parse(line) as Record<string, unknown>)
}

function groupEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    time: 1,
    self_id: 1,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: 10,
    group_id: 99,
    user_id: 7,
    message: [{ type: "text", data: { text: ".r 3d6" } }],
    sender: { nickname: "Ada", card: "Investigator" },
    ...overrides,
  }
}

async function ungate(
  iroh: ReturnType<typeof createMockIroh>,
  key: string,
  locale?: string,
  role: "player" | "keeper" = "player",
): Promise<void> {
  await waitFor(() => iroh.joins.some((row) => row.key === key))
  const row = iroh.joins.find((item) => item.key === key)!
  row.stream.push(
    `${JSON.stringify({
      type: FrameType.Welcome,
      room: "arkham",
      you: { name: row.name || "n", role },
      locale: locale ?? "en",
    })}\n`,
  )
  row.stream.push(`${JSON.stringify({ type: FrameType.UiManifest, panels: [] })}\n`)
  await settle(0)
}

async function tmpState(): Promise<string> {
  return mkdtemp(join(tmpdir(), "lw-bridge-"))
}

function baseConfig(stateDir: string, extra: Record<string, unknown> = {}) {
  return parseBridgeConfig({
    ticket: TICKET,
    keeper_key: KEEP,
    onebot: { mode: "forward", ws_url: "ws://127.0.0.1:3001", access_token: "tok", request_timeout: 2, reconnect_delay: 0.05 },
    groups: [{ group_id: 99, admins: [42], mode: "mention" }],
    busy_notice: true,
    idle_close_minutes: 30,
    state_dir: stateDir,
    ...extra,
  })
}

async function startBridge(
  iroh: ReturnType<typeof createMockIroh>,
  socket: AckSocket,
  extra: Record<string, unknown> = {},
  hostLocal?: () => Promise<{ host: string; key: string; stop: () => void }>,
) {
  const stateDir = await tmpState()
  const sockets: AckSocket[] = []
  const factory: ConnectFactory = async () => {
    sockets.push(socket)
    return socket
  }
  const handle = await runBridge(baseConfig(stateDir, extra), {
    loadIroh: iroh.loadIroh,
    connectFactory: factory,
    hostLocal,
    installSignals: false,
    onLog: () => {},
  })
  await waitFor(() => iroh.joins.some((row) => row.key === KEEP))
  await waitFor(() => iroh.joins.some((row) => row.key.startsWith("k-qq:observer:")))
  const observerKey = iroh.joins.find((row) => row.key.startsWith("k-qq:observer:"))!.key
  await ungate(iroh, KEEP, extra.locale as string | undefined, "keeper")
  await ungate(iroh, observerKey, extra.locale as string | undefined, "player")
  return { handle, stateDir, observerKey, sockets }
}

describe("onebotTransportOptions", () => {
  test("converts config seconds to transport milliseconds", () => {
    const cfg = parseBridgeConfig({
      onebot: { mode: "forward", ws_url: "ws://127.0.0.1:3001", request_timeout: 10, reconnect_delay: 1 },
      groups: [{ group_id: 1 }],
    })
    expect(onebotTransportOptions(cfg)).toEqual({
      mode: "forward",
      wsUrl: "ws://127.0.0.1:3001",
      accessToken: undefined,
      requestTimeoutMs: 10_000,
      reconnectDelayMs: 1_000,
    })
    const reverse = parseBridgeConfig({
      groups: [{ group_id: 1 }],
      onebot: { mode: "reverse", listen_host: "127.0.0.1", listen_port: 6700, request_timeout: 4 },
    })
    const opts = onebotTransportOptions(reverse)
    expect(opts.mode).toBe("reverse")
    expect(opts.listenPort).toBe(6700)
    expect(opts.requestTimeoutMs).toBe(4_000)
  })
})

describe("QQ bridge entry", () => {
  test("hostLocal is called when the config has no ticket, and not when it does", async () => {
    const iroh = createMockIroh()
    const socket = new AckSocket()
    let hosted = 0
    let stopped = 0
    const { handle } = await startBridge(iroh, socket, { ticket: undefined, keeper_key: undefined }, async () => {
      hosted += 1
      return { host: TICKET, key: KEEP, stop: () => { stopped += 1 } }
    })
    expect(hosted).toBe(1)
    expect(handle.hosted).toBe(true)
    expect(handle.ticket).toBe(TICKET)
    expect(iroh.joins.some((row) => row.key === KEEP && row.name === undefined)).toBe(true)
    expect(iroh.joins.some((row) => row.key.startsWith("k-qq:observer:") && row.name === "qq:observer:99")).toBe(true)
    await handle.stop()
    expect(stopped).toBe(1)

    const iroh2 = createMockIroh()
    const socket2 = new AckSocket()
    let hosted2 = 0
    const second = await startBridge(iroh2, socket2, {}, async () => {
      hosted2 += 1
      return { host: TICKET, key: KEEP, stop: () => {} }
    })
    expect(hosted2).toBe(0)
    expect(second.handle.hosted).toBe(false)
    await second.handle.stop()
  })

  test("a group .r 3d6 becomes input on that user's link; observer dice is one group post", async () => {
    const iroh = createMockIroh()
    const socket = new AckSocket()
    const { handle, observerKey } = await startBridge(iroh, socket)
    socket.push(groupEvent())
    await waitFor(() => iroh.joins.some((row) => row.key === "k-qq:7"))
    expect(iroh.joins.find((row) => row.key === "k-qq:7")?.name).toBe("Investigator")
    await ungate(iroh, "k-qq:7")
    await waitFor(() => framesOf(iroh.sent).some((frame) => frame.type === FrameType.Input && frame.text === ".r 3d6"))
    const playerInputs = framesOf(iroh.sent).filter((frame) => frame.type === FrameType.Input)
    expect(playerInputs).toEqual([{ type: FrameType.Input, text: ".r 3d6" }])

    const observer = iroh.joins.find((row) => row.key === observerKey)!
    observer.stream.push(
      `${JSON.stringify({
        type: FrameType.Dice,
        actor: "Ada",
        kind: "roll",
        expr: "3d6",
        total: 11,
        rolls: [4, 4, 3],
      })}\n`,
    )
    await waitFor(() => onebotActions(socket).some((row) => row.action === "send_group_msg"))
    const groupPosts = onebotActions(socket).filter((row) => row.action === "send_group_msg")
    expect(groupPosts).toHaveLength(1)
    const message = (groupPosts[0]!.params as { message: Array<{ type: string; data: { text?: string } }> }).message
    expect(message.some((seg) => seg.type === "text" && seg.data.text === "Ada 3d6 11")).toBe(true)
    await handle.stop()
  })

  test("an admin system reply goes to private chat only", async () => {
    const iroh = createMockIroh()
    const socket = new AckSocket()
    const { handle } = await startBridge(iroh, socket)
    socket.push(
      groupEvent({
        user_id: 42,
        message_id: 20,
        message: [{ type: "text", data: { text: ".lore" } }],
        sender: { nickname: "Admin", card: "KeeperAdmin" },
      }),
    )
    await waitFor(() => iroh.joins.some((row) => row.key === "k-qq:42"))
    await ungate(iroh, "k-qq:42", "en", "keeper")
    await waitFor(() => framesOf(iroh.sent).some((frame) => frame.type === FrameType.Input && frame.text === ".lore"))
    const admin = iroh.joins.find((row) => row.key === "k-qq:42")!
    admin.stream.push(`${JSON.stringify({ type: FrameType.System, level: "info", text: "secret lore" })}\n`)
    await waitFor(() => onebotActions(socket).some((row) => row.action === "send_private_msg"))
    const priv = onebotActions(socket).filter((row) => row.action === "send_private_msg")
    const group = onebotActions(socket).filter((row) => row.action === "send_group_msg")
    expect(priv.some((row) => JSON.stringify(row.params).includes("secret lore"))).toBe(true)
    expect(group.some((row) => JSON.stringify(row.params).includes("secret lore"))).toBe(false)
    await handle.stop()
  })

  test("private delivery failure tells the group to add the bot as a friend and never posts the content", async () => {
    const iroh = createMockIroh()
    const socket = new AckSocket()
    socket.failPrivate = true
    const { handle } = await startBridge(iroh, socket)
    socket.push(
      groupEvent({
        user_id: 42,
        message_id: 21,
        message: [{ type: "text", data: { text: ".lore" } }],
        sender: { nickname: "Admin" },
      }),
    )
    await waitFor(() => iroh.joins.some((row) => row.key === "k-qq:42"))
    await ungate(iroh, "k-qq:42", "en", "keeper")
    const admin = iroh.joins.find((row) => row.key === "k-qq:42")!
    admin.stream.push(`${JSON.stringify({ type: FrameType.System, level: "info", text: "secret lore" })}\n`)
    await waitFor(() =>
      onebotActions(socket).some(
        (row) => row.action === "send_group_msg" && JSON.stringify(row.params).includes("friend"),
      ),
    )
    const groupText = onebotActions(socket)
      .filter((row) => row.action === "send_group_msg")
      .map((row) => JSON.stringify(row.params))
      .join("\n")
    expect(groupText).toContain("friend")
    expect(groupText).not.toContain("secret lore")
    await handle.stop()
  })

  test("drops own messages, other bots, and groups not in the config", async () => {
    const iroh = createMockIroh()
    const socket = new AckSocket()
    const { handle } = await startBridge(iroh, socket)
    const before = iroh.joins.length
    socket.push(groupEvent({ user_id: 42, self_id: 42, message_id: 30 }))
    socket.push(
      groupEvent({
        user_id: 88,
        message_id: 31,
        sender: { nickname: "DiceBot", bot: true },
      }),
    )
    socket.push(groupEvent({ group_id: 123456, user_id: 9, message_id: 32 }))
    await settle(80)
    expect(iroh.joins.length).toBe(before)
    expect(framesOf(iroh.sent).some((frame) => frame.type === FrameType.Input)).toBe(false)
    await handle.stop()
  })

  test("a burst yields one reply-to notice, not a wall", async () => {
    const iroh = createMockIroh()
    const socket = new AckSocket()
    const { handle } = await startBridge(iroh, socket)
    for (let i = 0; i < 8; i++) {
      socket.push(groupEvent({ message_id: 40 + i, message: [{ type: "text", data: { text: `.r ${i}` } }] }))
    }
    await waitFor(() => iroh.joins.some((row) => row.key === "k-qq:7"))
    await ungate(iroh, "k-qq:7")
    await waitFor(() => framesOf(iroh.sent).filter((frame) => frame.type === FrameType.Input).length === 5)
    await waitFor(
      () =>
        onebotActions(socket).filter(
          (row) => row.action === "send_group_msg" && JSON.stringify(row.params).includes("Slow down"),
        ).length === 1,
    )
    const notices = onebotActions(socket).filter(
      (row) => row.action === "send_group_msg" && JSON.stringify(row.params).includes("Slow down"),
    )
    expect(notices).toHaveLength(1)
    const reply = (notices[0]!.params as { message: Array<{ type: string }> }).message
    expect(reply[0]?.type).toBe("reply")
    expect(framesOf(iroh.sent).filter((frame) => frame.type === FrameType.Input)).toHaveLength(5)
    await handle.stop()
  })

  test("player image attachments upload on that user's link", async () => {
    const iroh = createMockIroh()
    const socket = new AckSocket()
    const { handle } = await startBridge(iroh, socket)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")
    socket.push(
      groupEvent({
        message_id: 50,
        message: [
          { type: "text", data: { text: "look" } },
          { type: "image", data: { file: `base64://${png}`, name: "shot.png" } },
        ],
      }),
    )
    await waitFor(() => iroh.joins.some((row) => row.key === "k-qq:7"))
    await ungate(iroh, "k-qq:7")
    await waitFor(() => framesOf(iroh.sent).some((frame) => frame.type === FrameType.MediaOffer))
    const offer = framesOf(iroh.sent).find((frame) => frame.type === FrameType.MediaOffer)
    expect(offer?.name).toBe("shot.png")
    await handle.stop()
  })

  test("observer media is fetched via getMedia and sent as a OneBot image", async () => {
    const iroh = createMockIroh()
    const socket = new AckSocket()
    const { handle, observerKey } = await startBridge(iroh, socket)
    const observer = iroh.joins.find((row) => row.key === observerKey)!
    observer.stream.push(
      `${JSON.stringify({
        type: FrameType.Media,
        id: "m-live",
        hash: "ab".repeat(32),
        mime: "image/png",
        size: 3,
        name: "shot.png",
        from: "kp",
        ts: 1,
      })}\n`,
    )
    await waitFor(() =>
      onebotActions(socket).some(
        (row) =>
          row.action === "send_group_msg" &&
          JSON.stringify(row.params).includes("base64://"),
      ),
    )
    const post = onebotActions(socket).find(
      (row) => row.action === "send_group_msg" && JSON.stringify(row.params).includes("base64://"),
    )!
    const segs = (post.params as { message: Array<{ type: string; data: { file?: string } }> }).message
    expect(segs.some((seg) => seg.type === "image" && String(seg.data.file).startsWith("base64://"))).toBe(true)
    await handle.stop()
  })

  test("config locale wins over welcome.locale; omitted locale follows welcome", async () => {
    const iroh = createMockIroh()
    const socket = new AckSocket()
    const { handle, observerKey } = await startBridge(iroh, socket, { locale: "en" })
    const observer = iroh.joins.find((row) => row.key === observerKey)!
    observer.stream.push(`${JSON.stringify({ type: FrameType.Welcome, room: "arkham", you: { name: "o", role: "player" }, locale: "zh" })}\n`)
    observer.stream.push(`${JSON.stringify({ type: FrameType.TurnStatus, status: "idle" })}\n`)
    observer.stream.push(`${JSON.stringify({ type: FrameType.TurnStatus, status: "busy", actor: "Keeper" })}\n`)
    await waitFor(() =>
      onebotActions(socket).some((row) => JSON.stringify(row.params).includes(tt("en", "bridge.busy"))),
    )
    expect(onebotActions(socket).some((row) => JSON.stringify(row.params).includes(tt("zh", "bridge.busy")))).toBe(false)
    await handle.stop()

    const iroh2 = createMockIroh()
    const socket2 = new AckSocket()
    const second = await startBridge(iroh2, socket2)
    const obs2 = iroh2.joins.find((row) => row.key === second.observerKey)!
    obs2.stream.push(`${JSON.stringify({ type: FrameType.Welcome, room: "arkham", you: { name: "o", role: "player" }, locale: "zh" })}\n`)
    obs2.stream.push(`${JSON.stringify({ type: FrameType.TurnStatus, status: "idle" })}\n`)
    obs2.stream.push(`${JSON.stringify({ type: FrameType.TurnStatus, status: "busy", actor: "Keeper" })}\n`)
    await waitFor(() =>
      onebotActions(socket2).some((row) => JSON.stringify(row.params).includes(tt("zh", "bridge.busy"))),
    )
    await second.handle.stop()
  })

  test("runBridgeFromFile loads JSON and stop closes the OneBot socket", async () => {
    const iroh = createMockIroh()
    const socket = new AckSocket()
    const dir = await tmpState()
    const path = join(dir, "bridge.json")
    await writeFile(
      path,
      JSON.stringify({
        ticket: TICKET,
        keeper_key: KEEP,
        onebot: { mode: "forward", ws_url: "ws://127.0.0.1:3001", access_token: "tok" },
        groups: [{ group_id: 99, admins: [42] }],
        state_dir: dir,
      }),
    )
    const handle = await runBridgeFromFile(path, {
      loadIroh: iroh.loadIroh,
      connectFactory: async () => socket,
      installSignals: false,
      onLog: () => {},
    })
    await waitFor(() => iroh.joins.some((row) => row.key === KEEP))
    await handle.stop()
    expect(socket.closeArgs).toBeDefined()
    await waitFor(() => handle.stopped === handle.stopped)
  })

  test("isDroppedOneBotSender covers self and bot senders", () => {
    const self: OneBotInbound = {
      chatType: "group",
      chatId: "99",
      sender: { userId: "42" },
      text: "hi",
      atSelf: false,
      attachments: [],
      raw: { self_id: 42, sender: { user_id: 42 } },
    }
    expect(isDroppedOneBotSender(self)).toBe(true)
    const bot: OneBotInbound = {
      ...self,
      sender: { userId: "88" },
      raw: { self_id: 42, sender: { user_id: 88, bot: true } },
    }
    expect(isDroppedOneBotSender(bot)).toBe(true)
    const person: OneBotInbound = {
      ...self,
      sender: { userId: "7" },
      raw: { self_id: 42, sender: { user_id: 7 } },
    }
    expect(isDroppedOneBotSender(person)).toBe(false)
  })
})
