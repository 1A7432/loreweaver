import { describe, expect, test } from "bun:test"
import { FrameType } from "loreweaver-protocol"
import type { LoadIroh } from "../irohLink"
import { LinkPool, type LinkReadyReason } from "./linkPool"

const TICKET = "endpointaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

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
    EndpointTicket: { fromString: () => ({ endpointAddr: () => ({}) }) },
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
})
