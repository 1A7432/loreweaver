import { describe, expect, test } from "bun:test"
import { FrameType, type ServerFrame } from "loreweaver-protocol"
import type { LoadIroh } from "../irohLink"
import { LinkPool, type LinkReadyReason } from "./linkPool"

const TICKET = "endpointaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const OTHER_TICKET = "endpointbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

const NARRATIVE = {
  type: FrameType.Narrative,
  id: "n1",
  speaker: "kp" as const,
  text: "The hinge shrieks.",
  format: "markdown" as const,
}

function createMockIroh(options: { hangFirstWrite?: boolean } = {}) {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const sent: string[] = []
  let bindCount = 0
  let connectCount = 0
  let openBiCount = 0
  let connectionCloses = 0

  function makeRecvStream() {
    const queue: Array<number[] | null> = []
    let waiter: ((value: number[] | null) => void) | undefined
    return {
      dead: false,
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
        const bytes = Array.from(enc.encode(text))
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
        bind: async () => {
          bindCount += 1
          return {
            online: async () => {},
            connect: async () => {
              connectCount += 1
              return {
                openBi: async () => {
                  const recv = makeRecvStream()
                  streams.push(recv)
                  const isDeadStream = options.hangFirstWrite && openBiCount++ === 0
                  return {
                    send: {
                      writeAll: async (buf: number[]) => {
                        if (isDeadStream && streams[0]?.dead) {
                          await new Promise(() => {})
                        }
                        sent.push(dec.decode(Uint8Array.from(buf)))
                      },
                    },
                    recv,
                  }
                },
                close: () => {
                  connectionCloses += 1
                },
              }
            },
            close: () => {},
          }
        },
      }),
    },
    presetN0: () => {},
    EndpointTicket: {
      fromString: (ticket: string) => {
        if (ticket.includes("bad")) throw new Error("invalid ticket")
        return { endpointAddr: () => ({}) }
      },
    },
  })

  return { loadIroh, sent, streams, counts: () => ({ bindCount, connectCount, connectionCloses }) }
}

describe("LinkPool", () => {
  test("one endpoint serves N member links", async () => {
    const { loadIroh, sent, counts } = createMockIroh()
    const pool = new LinkPool({ loadIroh, reconnectBaseMs: 5, reconnectMaxMs: 20 })
    await pool.connect(TICKET)
    const a = await pool.open("key-ada", { name: "Ada" })
    const b = await pool.open("key-bao", { name: "Bao" })

    expect(counts().bindCount).toBe(1)
    expect(counts().connectCount).toBe(2)
    expect(pool.get("key-ada")).toBe(a)
    expect(pool.get("key-bao")).toBe(b)
    expect(a).not.toBe(b)
    expect(JSON.parse(sent[0]!)).toEqual({ type: FrameType.Join, key: "key-ada", name: "Ada" })
    expect(JSON.parse(sent[1]!)).toEqual({ type: FrameType.Join, key: "key-bao", name: "Bao" })

    const again = await pool.open("key-ada", { name: "Ada" })
    expect(again).toBe(a)
    expect(counts().connectCount).toBe(2)
    pool.close()
  })

  test("an unexpected drop redials that member on the same endpoint and re-joins", async () => {
    const { loadIroh, sent, streams, counts } = createMockIroh()
    const ready: Array<{ key: string; reason: LinkReadyReason }> = []
    const pool = new LinkPool({
      loadIroh,
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      onLinkReady: (key, _link, reason) => ready.push({ key, reason }),
    })
    await pool.connect(TICKET)
    await pool.open("key-ada", { name: "Ada" })
    expect(ready).toEqual([{ key: "key-ada", reason: "open" }])
    expect(counts().bindCount).toBe(1)
    expect(counts().connectCount).toBe(1)

    streams[0]!.end()
    await settle()

    expect(counts().bindCount).toBe(1)
    expect(counts().connectCount).toBe(2)
    expect(ready).toEqual([
      { key: "key-ada", reason: "open" },
      { key: "key-ada", reason: "redial" },
    ])
    expect(sent.filter((line) => JSON.parse(line).type === FrameType.Join).length).toBe(2)
    expect(JSON.parse(sent[1]!)).toEqual({ type: FrameType.Join, key: "key-ada", name: "Ada" })
    expect(pool.get("key-ada")).toBeDefined()
    pool.close()
  })

  test("a write hung on the dead stream never blocks the redialed link (F13)", async () => {
    const { loadIroh, sent, streams } = createMockIroh({ hangFirstWrite: true })
    const pool = new LinkPool({ loadIroh, reconnectBaseMs: 5, reconnectMaxMs: 20 })
    await pool.connect(TICKET)
    const link = await pool.open("key-ada", { name: "Ada" })
    await settle(0)
    expect(sent.length).toBe(1)

    streams[0]!.dead = true
    link.sendInput("this one is swallowed by the dying stream")
    streams[0]!.end()
    await settle(60)

    pool.get("key-ada")!.sendInput("I open the door")
    await settle(10)

    expect(sent.some((line) => line.includes("I open the door"))).toBe(true)
    expect(sent.filter((line) => JSON.parse(line).type === FrameType.Join).length).toBe(2)
    expect(sent.some((line) => line.includes("swallowed by the dying stream"))).toBe(false)
    pool.close()
  })

  test("idle close drops the link without redialing; touch postpones it", async () => {
    const { loadIroh, streams, counts } = createMockIroh()
    const pool = new LinkPool({
      loadIroh,
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      idleCloseMs: 40,
    })
    await pool.connect(TICKET)
    await pool.open("key-ada", { name: "Ada" })
    await settle(25)
    expect(pool.get("key-ada")).toBeDefined()
    pool.touch("key-ada")
    await settle(25)
    expect(pool.get("key-ada")).toBeDefined()
    expect(counts().connectCount).toBe(1)

    await settle(30)
    expect(pool.get("key-ada")).toBeUndefined()
    expect(counts().connectCount).toBe(1)
    expect(counts().connectionCloses).toBe(1)
    expect(streams.length).toBe(1)

    streams[0]!.end()
    await settle()
    expect(counts().connectCount).toBe(1)
    pool.close()
  })

  test("a persistent link is not idle-closed", async () => {
    const { loadIroh, counts } = createMockIroh()
    const pool = new LinkPool({
      loadIroh,
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      idleCloseMs: 20,
    })
    await pool.connect(TICKET)
    await pool.open("qq:observer:1", { name: "observer", idleClose: false })
    await settle(50)
    expect(pool.get("qq:observer:1")).toBeDefined()
    expect(counts().connectCount).toBe(1)
    pool.close()
  })

  test("close() is manual — a late stream end after close() does not redial", async () => {
    const { loadIroh, streams, counts } = createMockIroh()
    const pool = new LinkPool({ loadIroh, reconnectBaseMs: 5, reconnectMaxMs: 20 })
    await pool.connect(TICKET)
    await pool.open("key-ada", { name: "Ada" })
    pool.close()
    streams[0]!.end()
    await settle()
    expect(counts().connectCount).toBe(1)
    expect(pool.get("key-ada")).toBeUndefined()
  })

  test("closeLink drops one member and leaves the others", async () => {
    const { loadIroh, counts } = createMockIroh()
    const pool = new LinkPool({ loadIroh, reconnectBaseMs: 5, reconnectMaxMs: 20 })
    await pool.connect(TICKET)
    await pool.open("key-ada", { name: "Ada" })
    await pool.open("key-bao", { name: "Bao" })
    pool.closeLink("key-ada")
    expect(pool.get("key-ada")).toBeUndefined()
    expect(pool.get("key-bao")).toBeDefined()
    expect(counts().connectionCloses).toBe(1)
    pool.close()
  })

  test("get() is undefined during the disconnect window; open() shares the in-flight redial", async () => {
    const { loadIroh, sent, streams, counts } = createMockIroh()
    const down: string[] = []
    const pool = new LinkPool({
      loadIroh,
      reconnectBaseMs: 40,
      reconnectMaxMs: 40,
      onLinkDown: (key) => down.push(key),
    })
    await pool.connect(TICKET)
    await pool.open("key-ada", { name: "Ada" })
    expect(counts().connectCount).toBe(1)

    streams[0]!.end()
    await settle(0)
    expect(pool.get("key-ada")).toBeUndefined()
    expect(down).toEqual(["key-ada"])
    expect(counts().connectCount).toBe(1)

    const reopened = await pool.open("key-ada", { name: "Ada" })
    expect(reopened.isAlive).toBe(true)
    expect(pool.get("key-ada")).toBe(reopened)
    expect(counts().connectCount).toBe(2)
    expect(sent.filter((line) => JSON.parse(line).type === FrameType.Join).length).toBe(2)
    pool.close()
  })

  test("with reconnect: false the dead link is never handed out and open() dials afresh", async () => {
    const { loadIroh, sent, streams, counts } = createMockIroh()
    const pool = new LinkPool({ loadIroh, reconnect: false, reconnectBaseMs: 5, reconnectMaxMs: 20 })
    await pool.connect(TICKET)
    const first = await pool.open("key-ada", { name: "Ada" })
    streams[0]!.end()
    await settle(0)
    expect(first.isAlive).toBe(false)
    expect(pool.get("key-ada")).toBeUndefined()
    expect(counts().connectCount).toBe(1)

    const second = await pool.open("key-ada", { name: "Ada" })
    expect(second).not.toBe(first)
    expect(second.isAlive).toBe(true)
    expect(counts().connectCount).toBe(2)
    expect(sent.filter((line) => JSON.parse(line).type === FrameType.Join).length).toBe(2)
    pool.close()
  })

  test("a throwing onLinkReady does not skip join or the read loop", async () => {
    const { loadIroh, sent, streams, counts } = createMockIroh()
    let readyCalls = 0
    const pool = new LinkPool({
      loadIroh,
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      onLinkReady: () => {
        readyCalls += 1
        throw new Error("hook boom")
      },
    })
    await pool.connect(TICKET)
    const link = await pool.open("key-ada", { name: "Ada" })
    expect(link.isAlive).toBe(true)
    expect(JSON.parse(sent[0]!)).toEqual({ type: FrameType.Join, key: "key-ada", name: "Ada" })
    expect(readyCalls).toBe(1)

    streams[0]!.end()
    await settle()
    expect(counts().connectCount).toBe(2)
    expect(readyCalls).toBe(2)
    expect(sent.filter((line) => JSON.parse(line).type === FrameType.Join).length).toBe(2)
    pool.close()
  })

  test("two concurrent opens resolve to the same link with one connect and one join", async () => {
    const { loadIroh, sent, counts } = createMockIroh()
    const pool = new LinkPool({ loadIroh, reconnectBaseMs: 5, reconnectMaxMs: 20 })
    await pool.connect(TICKET)
    const [a, b] = await Promise.all([
      pool.open("key-ada", { name: "Ada" }),
      pool.open("key-ada", { name: "Ada" }),
    ])
    expect(a).toBe(b)
    expect(a.isAlive).toBe(true)
    expect(counts().connectCount).toBe(1)
    expect(sent.filter((line) => JSON.parse(line).type === FrameType.Join).length).toBe(1)
    pool.close()
  })

  test("onLinkReady runs before join is sent and before the read loop starts", async () => {
    const { loadIroh, sent, streams } = createMockIroh()
    const frames: ServerFrame[] = []
    let sentAtHook = -1
    const pool = new LinkPool({
      loadIroh,
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      onLinkReady: (_key, link) => {
        sentAtHook = sent.length
        link.onMessage((frame) => frames.push(frame))
      },
    })
    await pool.connect(TICKET)
    await pool.open("key-ada", { name: "Ada" })
    expect(sentAtHook).toBe(0)
    expect(sent.length).toBe(1)
    expect(JSON.parse(sent[0]!).type).toBe(FrameType.Join)

    streams[0]!.push(`${JSON.stringify(NARRATIVE)}\n`)
    await settle(0)
    expect(frames).toEqual([NARRATIVE])
    pool.close()
  })

  test("clientInfo reaches the join frame sent by LinkPool", async () => {
    const { loadIroh, sent } = createMockIroh()
    const pool = new LinkPool({
      loadIroh,
      clientInfo: { name: "loreweaver-bridge", version: "0.6.0" },
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
    })
    await pool.connect(TICKET)
    await pool.open("key-ada", { name: "Ada" })
    expect(JSON.parse(sent[0]!)).toEqual({
      type: FrameType.Join,
      key: "key-ada",
      name: "Ada",
      client: { name: "loreweaver-bridge", version: "0.6.0" },
    })
    pool.close()
  })

  test("connect() with a different ticket throws; a bad ticket leaves the pool unconnected", async () => {
    const { loadIroh, counts } = createMockIroh()
    const pool = new LinkPool({ loadIroh, reconnectBaseMs: 5, reconnectMaxMs: 20 })
    await expect(pool.connect("endpointbadticket")).rejects.toThrow("invalid ticket")
    expect(counts().bindCount).toBe(1)
    await pool.connect(TICKET)
    expect(counts().bindCount).toBe(2)
    await pool.connect(TICKET)
    expect(counts().bindCount).toBe(2)
    await expect(pool.connect(OTHER_TICKET)).rejects.toThrow("already connected to a different ticket")
    await pool.open("key-ada", { name: "Ada" })
    expect(counts().connectCount).toBe(1)
    pool.close()
  })
})
