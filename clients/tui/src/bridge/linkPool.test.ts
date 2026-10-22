import { describe, expect, test } from "bun:test"
import { FrameType, type ServerFrame } from "loreweaver-protocol"
import type { LoadIroh } from "../irohLink"
import { ManualClock, settle, waitFor } from "../testkit"
import { LinkPool, type LinkPoolOptions, type LinkReadyReason } from "./linkPool"

const TICKET = "endpointaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const OTHER_TICKET = "endpointbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
// Every pool runs on a ManualClock: a redial backoff or an idle close fires only when the test
// advances the clock, and each step waits for the state it depends on (a dead link, a connect
// count), never for wall-clock time.
const BASE_MS = 5
const MAX_MS = 20

function makePool(loadIroh: LinkPoolOptions["loadIroh"], extra: Omit<LinkPoolOptions, "loadIroh"> = {}) {
  const clock = new ManualClock()
  const pool = new LinkPool({ loadIroh, reconnectBaseMs: BASE_MS, reconnectMaxMs: MAX_MS, ...clock.options, ...extra })
  return { pool, clock }
}

/** End `key`'s control stream and wait until the pool has seen the drop (link dead, redial armed). */
async function dropStream(pool: LinkPool, stream: { end(): void }, key: string): Promise<void> {
  stream.end()
  await waitFor(`${key}'s link to go down`, () => pool.get(key) === undefined)
}

/** Drop "k"'s stream and let the redial backoff elapse, so its (held) connect is parked in flight. */
async function parkRedial(pool: LinkPool, clock: ManualClock, stream: { end(): void }, counts: () => { connectCount: number }): Promise<void> {
  const before = counts().connectCount
  await dropStream(pool, stream, "k")
  clock.advance(BASE_MS)
  await waitFor("the redial connect to start", () => counts().connectCount > before)
}

/** A late timer (redial, idle close) gets every chance to fire before a negative assertion. */
async function runOutTheClock(clock: ManualClock): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    clock.advance(60 * 60 * 1000)
    await settle()
  }
}

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
  let holdNext = false
  let releaseHeldConnect: (() => void) | undefined

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
              if (holdNext) {
                holdNext = false
                await new Promise<void>((resolve) => {
                  releaseHeldConnect = resolve
                })
              }
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

  return {
    loadIroh,
    sent,
    streams,
    counts: () => ({ bindCount, connectCount, connectionCloses }),
    holdNextConnect: () => {
      holdNext = true
    },
    releaseHeld: () => {
      const release = releaseHeldConnect
      releaseHeldConnect = undefined
      release?.()
    },
  }
}

describe("LinkPool", () => {
  test("one endpoint serves N member links", async () => {
    const { loadIroh, sent, counts } = createMockIroh()
    const { pool } = makePool(loadIroh)
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
    const { pool, clock } = makePool(loadIroh, {
      onLinkReady: (key, _link, reason) => ready.push({ key, reason }),
    })
    await pool.connect(TICKET)
    await pool.open("key-ada", { name: "Ada" })
    expect(ready).toEqual([{ key: "key-ada", reason: "open" }])
    expect(counts().bindCount).toBe(1)
    expect(counts().connectCount).toBe(1)

    await dropStream(pool, streams[0]!, "key-ada")
    clock.advance(BASE_MS) // the first redial backoff
    await waitFor("the redialed link", () => pool.get("key-ada") !== undefined)

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
    const { pool, clock } = makePool(loadIroh)
    await pool.connect(TICKET)
    const link = await pool.open("key-ada", { name: "Ada" })
    await waitFor("the join write", () => sent.length >= 1)
    expect(sent.length).toBe(1)

    streams[0]!.dead = true
    link.sendInput("this one is swallowed by the dying stream")
    await dropStream(pool, streams[0]!, "key-ada")
    clock.advance(BASE_MS)
    await waitFor("the redialed link", () => pool.get("key-ada") !== undefined)

    pool.get("key-ada")!.sendInput("I open the door")
    await waitFor("the input on the redialed link", () => sent.some((line) => line.includes("I open the door")))

    expect(sent.some((line) => line.includes("I open the door"))).toBe(true)
    expect(sent.filter((line) => JSON.parse(line).type === FrameType.Join).length).toBe(2)
    expect(sent.some((line) => line.includes("swallowed by the dying stream"))).toBe(false)
    pool.close()
  })

  test("idle close drops the link without redialing; touch postpones it", async () => {
    const { loadIroh, streams, counts } = createMockIroh()
    const { pool, clock } = makePool(loadIroh, { idleCloseMs: 40 })
    await pool.connect(TICKET)
    await pool.open("key-ada", { name: "Ada" })
    clock.advance(25)
    expect(pool.get("key-ada")).toBeDefined()
    pool.touch("key-ada")
    clock.advance(25)
    expect(pool.get("key-ada")).toBeDefined()
    expect(counts().connectCount).toBe(1)

    clock.advance(30)
    expect(pool.get("key-ada")).toBeUndefined()
    expect(counts().connectCount).toBe(1)
    expect(counts().connectionCloses).toBe(1)
    expect(streams.length).toBe(1)

    streams[0]!.end()
    await runOutTheClock(clock)
    expect(counts().connectCount).toBe(1)
    pool.close()
  })

  test("a persistent link is not idle-closed", async () => {
    const { loadIroh, counts } = createMockIroh()
    const { pool, clock } = makePool(loadIroh, { idleCloseMs: 20 })
    await pool.connect(TICKET)
    await pool.open("qq:observer:1", { name: "observer", idleClose: false })
    clock.advance(50)
    await settle()
    expect(pool.get("qq:observer:1")).toBeDefined()
    expect(counts().connectCount).toBe(1)
    pool.close()
  })

  test("close() is manual — a late stream end after close() does not redial", async () => {
    const { loadIroh, streams, counts } = createMockIroh()
    const { pool, clock } = makePool(loadIroh)
    await pool.connect(TICKET)
    await pool.open("key-ada", { name: "Ada" })
    pool.close()
    streams[0]!.end()
    await runOutTheClock(clock)
    expect(counts().connectCount).toBe(1)
    expect(pool.get("key-ada")).toBeUndefined()
  })

  test("closeLink drops one member and leaves the others", async () => {
    const { loadIroh, counts } = createMockIroh()
    const { pool } = makePool(loadIroh)
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
    const { pool, clock } = makePool(loadIroh, {
      reconnectBaseMs: 40,
      reconnectMaxMs: 40,
      onLinkDown: (key) => down.push(key),
    })
    await pool.connect(TICKET)
    await pool.open("key-ada", { name: "Ada" })
    expect(counts().connectCount).toBe(1)

    await dropStream(pool, streams[0]!, "key-ada")
    expect(pool.get("key-ada")).toBeUndefined()
    expect(down).toEqual(["key-ada"])
    expect(counts().connectCount).toBe(1)

    // open() joins the redial that is waiting out its backoff; the backoff then elapses.
    const reopening = pool.open("key-ada", { name: "Ada" })
    clock.advance(40)
    const reopened = await reopening
    expect(reopened.isAlive).toBe(true)
    expect(pool.get("key-ada")).toBe(reopened)
    expect(counts().connectCount).toBe(2)
    expect(sent.filter((line) => JSON.parse(line).type === FrameType.Join).length).toBe(2)
    pool.close()
  })

  test("with reconnect: false the dead link is never handed out and open() dials afresh", async () => {
    const { loadIroh, sent, streams, counts } = createMockIroh()
    const { pool } = makePool(loadIroh, { reconnect: false })
    await pool.connect(TICKET)
    const first = await pool.open("key-ada", { name: "Ada" })
    streams[0]!.end()
    await waitFor("the first link to die", () => !first.isAlive)
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
    const { pool, clock } = makePool(loadIroh, {
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

    await dropStream(pool, streams[0]!, "key-ada")
    clock.advance(BASE_MS)
    await waitFor("the redialed link", () => pool.get("key-ada") !== undefined)
    expect(counts().connectCount).toBe(2)
    expect(readyCalls).toBe(2)
    expect(sent.filter((line) => JSON.parse(line).type === FrameType.Join).length).toBe(2)
    pool.close()
  })

  test("two concurrent opens resolve to the same link with one connect and one join", async () => {
    const { loadIroh, sent, counts } = createMockIroh()
    const { pool } = makePool(loadIroh)
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
    const { pool } = makePool(loadIroh, {
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
    await waitFor("the narrative frame", () => frames.length >= 1)
    expect(frames).toEqual([NARRATIVE])
    pool.close()
  })

  test("clientInfo reaches the join frame sent by LinkPool", async () => {
    const { loadIroh, sent } = createMockIroh()
    const { pool } = makePool(loadIroh, { clientInfo: { name: "loreweaver-bridge", version: "0.6.0" } })
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
    const { pool } = makePool(loadIroh)
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

  test("kick during a redial's in-flight connect leaves no zombie", async () => {
    const { loadIroh, sent, streams, counts, holdNextConnect, releaseHeld } = createMockIroh()
    const { pool, clock } = makePool(loadIroh)
    await pool.connect(TICKET)
    await pool.open("k", { name: "K" })
    expect(counts().connectCount).toBe(1)
    expect(sent.filter((line) => JSON.parse(line).type === FrameType.Join).length).toBe(1)

    holdNextConnect()
    await parkRedial(pool, clock, streams[0]!, counts)
    expect(counts().connectCount).toBe(2)

    pool.closeLink("k")
    releaseHeld()
    // The released dial finds its slot gone and closes the fresh connection (the 2nd close).
    await waitFor("the released dial to be discarded", () => counts().connectionCloses >= 2)
    expect(counts().connectCount).toBe(2)
    expect(sent.filter((line) => JSON.parse(line).type === FrameType.Join).length).toBe(1)
    expect(pool.get("k")).toBeUndefined()

    await runOutTheClock(clock)
    expect(counts().connectCount).toBe(2)
    pool.close()
  })

  test("reopen after a drop during in-flight dial does not orphan the new slot", async () => {
    const { loadIroh, sent, streams, counts, holdNextConnect, releaseHeld } = createMockIroh()
    const { pool, clock } = makePool(loadIroh)
    await pool.connect(TICKET)
    await pool.open("k", { name: "K" })
    const joinsBefore = sent.filter((line) => JSON.parse(line).type === FrameType.Join).length

    holdNextConnect()
    await parkRedial(pool, clock, streams[0]!, counts)
    pool.closeLink("k")
    const p = pool.open("k", { name: "K" })
    releaseHeld()
    const link = await p
    expect(pool.get("k")).toBe(link)
    expect(link.isAlive).toBe(true)
    const joins = sent.filter((line) => JSON.parse(line).type === FrameType.Join)
    expect(joins.length).toBe(joinsBefore + 1)
    expect(JSON.parse(joins.at(-1)!)).toEqual({ type: FrameType.Join, key: "k", name: "K" })
    expect(counts().connectCount).toBe(3)
    pool.close()
  })

  test("idle close while a redial connect is parked", async () => {
    const { loadIroh, sent, streams, counts, holdNextConnect, releaseHeld } = createMockIroh()
    const { pool, clock } = makePool(loadIroh, { idleCloseMs: 50 })
    await pool.connect(TICKET)
    await pool.open("k", { name: "K" })
    expect(sent.filter((line) => JSON.parse(line).type === FrameType.Join).length).toBe(1)

    holdNextConnect()
    await parkRedial(pool, clock, streams[0]!, counts)
    expect(counts().connectCount).toBe(2)

    clock.advance(50) // past the idle deadline while the redial connect is parked
    expect(pool.get("k")).toBeUndefined()
    releaseHeld()
    await waitFor("the released dial to be discarded", () => counts().connectionCloses >= 2)
    await runOutTheClock(clock)
    expect(counts().connectCount).toBe(2)
    expect(sent.filter((line) => JSON.parse(line).type === FrameType.Join).length).toBe(1)
    expect(pool.get("k")).toBeUndefined()
    pool.close()
  })

  test("open() awaiting a shared redial rejects when the slot is kicked mid-connect", async () => {
    const { loadIroh, streams, counts, holdNextConnect, releaseHeld } = createMockIroh()
    const { pool, clock } = makePool(loadIroh)
    await pool.connect(TICKET)
    await pool.open("k", { name: "K" })
    holdNextConnect()
    await parkRedial(pool, clock, streams[0]!, counts)
    const p = pool.open("k")
    setTimeout(() => {
      pool.closeLink("k")
      releaseHeld()
    }, 0)
    await expect(p).rejects.toThrow("Iroh connection is not open.")
    expect(pool.get("k")).toBeUndefined()
    await waitFor("the released dial to be discarded", () => counts().connectionCloses >= 2)
    await runOutTheClock(clock)
    expect(counts().connectCount).toBe(2)
    pool.close()
  })

  test("open() awaiting a shared redial rejects when the pool is closed mid-connect", async () => {
    const { loadIroh, streams, counts, holdNextConnect, releaseHeld } = createMockIroh()
    const { pool, clock } = makePool(loadIroh)
    await pool.connect(TICKET)
    await pool.open("k", { name: "K" })
    holdNextConnect()
    await parkRedial(pool, clock, streams[0]!, counts)
    const p = pool.open("k")
    setTimeout(() => {
      pool.close()
      releaseHeld()
    }, 0)
    await expect(p).rejects.toThrow("Iroh connection is not open.")
    expect(pool.get("k")).toBeUndefined()
    await waitFor("the released dial to be discarded", () => counts().connectionCloses >= 2)
    await runOutTheClock(clock)
    expect(counts().connectCount).toBe(2)
  })

  test("open() during a parked redial resolves to the live link", async () => {
    const { loadIroh, streams, counts, holdNextConnect, releaseHeld } = createMockIroh()
    const { pool, clock } = makePool(loadIroh)
    await pool.connect(TICKET)
    await pool.open("k", { name: "K" })
    holdNextConnect()
    await parkRedial(pool, clock, streams[0]!, counts)
    expect(counts().connectCount).toBe(2)
    const p = pool.open("k")
    releaseHeld()
    const link = await p
    expect(link.isAlive).toBe(true)
    expect(pool.get("k")).toBe(link)
    expect(counts().connectCount).toBe(2)
    pool.close()
  })
})
