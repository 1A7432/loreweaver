import { describe, expect, test } from "bun:test"
import { FrameType, type ServerFrame } from "loreweaver-protocol"
import { IrohLink, MAX_IROH_MEDIA_BYTES, bindIrohEndpoint, ticketAddr, type LoadIroh } from "./irohLink"

const TICKET = "endpointaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

const NARRATIVE = {
  type: FrameType.Narrative,
  id: "n1",
  speaker: "kp" as const,
  text: "The hinge shrieks.",
  format: "markdown" as const,
}

function createMockIroh(options: { failConnectTimes?: number; hangFirstWrite?: boolean } = {}) {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const sent: string[] = []
  let bindCount = 0
  let connectCount = 0
  let connectFailuresLeft = options.failConnectTimes ?? 0
  let openBiCount = 0
  let writeAllEntries = 0

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
        bind: async () => {
          bindCount += 1
          return {
            online: async () => {},
            connect: async () => {
              connectCount += 1
              if (connectFailuresLeft > 0) {
                connectFailuresLeft -= 1
                throw new Error("relay warmup")
              }
              return {
                openBi: async () => {
                  const recv = makeRecvStream()
                  streams.push(recv)
                  const isDeadStream = options.hangFirstWrite && openBiCount++ === 0
                  return {
                    send: {
                      writeAll: async (buf: number[]) => {
                        writeAllEntries += 1
                        if (isDeadStream && streams[0]?.dead) {
                          await new Promise(() => {}) // never settles
                        }
                        sent.push(dec.decode(Uint8Array.from(buf)))
                      },
                    },
                    recv,
                  }
                },
                close: () => {},
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

  return { loadIroh, sent, streams, counts: () => ({ bindCount, connectCount, writeAllEntries }) }
}

async function openLink(loadIroh: LoadIroh): Promise<IrohLink> {
  const { iroh, endpoint } = await bindIrohEndpoint(loadIroh)
  return await IrohLink.open(endpoint, ticketAddr(iroh, TICKET))
}

describe("IrohLink framing", () => {
  test("newline JSON frames dispatch; a split line is reassembled; non-JSON is ignored", async () => {
    const { loadIroh, streams } = createMockIroh()
    const link = await openLink(loadIroh)
    const frames: ServerFrame[] = []
    link.onMessage((frame) => frames.push(frame))
    link.start()

    const line = JSON.stringify(NARRATIVE)
    streams[0]!.push(line.slice(0, 20))
    await settle(0)
    expect(frames).toEqual([])
    streams[0]!.push(`${line.slice(20)}\nnot json\n${JSON.stringify({ ...NARRATIVE, id: "n2" })}\n`)
    await settle(0)

    expect(frames.map((frame) => frame.type === FrameType.Narrative ? frame.id : frame.type)).toEqual(["n1", "n2"])
  })

  test("a ping on the control stream is answered with a pong and is not dispatched", async () => {
    const { loadIroh, sent, streams } = createMockIroh()
    const link = await openLink(loadIroh)
    const frames: ServerFrame[] = []
    link.onMessage((frame) => frames.push(frame))
    link.start()

    streams[0]!.push(`${JSON.stringify({ type: FrameType.Ping, t: 42 })}\n`)
    await settle(0)

    expect(frames).toEqual([])
    expect(JSON.parse(sent[0]!)).toEqual({ type: FrameType.Pong, t: 42 })
  })

  test("connect retries once on a first-connect flake", async () => {
    const { loadIroh, counts } = createMockIroh({ failConnectTimes: 1 })
    const link = await openLink(loadIroh)
    expect(link.isClosed).toBe(false)
    expect(counts().connectCount).toBe(2)
  })
})

describe("IrohLink write chain (F13)", () => {
  test("a write hung on one link never blocks a later link on the same endpoint", async () => {
    const { loadIroh, sent, streams, counts } = createMockIroh({ hangFirstWrite: true })
    const { iroh, endpoint } = await bindIrohEndpoint(loadIroh)
    const addr = ticketAddr(iroh, TICKET)

    const dead = await IrohLink.open(endpoint, addr)
    dead.sendInput("swallowed by the dying stream")
    await settle(0)
    streams[0]!.dead = true
    dead.sendInput("still on the dead chain")
    await settle(0)
    expect(counts().writeAllEntries).toBe(2)
    dead.close()

    const live = await IrohLink.open(endpoint, addr)
    live.sendInput("I open the door")
    await settle(10)

    expect(sent.some((line) => line.includes("I open the door"))).toBe(true)
    expect(sent.some((line) => line.includes("swallowed by the dying stream"))).toBe(true)
    expect(sent.some((line) => line.includes("still on the dead chain"))).toBe(false)
  })

  test("close() is manual — a late stream end does not fire onUnexpectedEnd", async () => {
    const { loadIroh, streams } = createMockIroh()
    const link = await openLink(loadIroh)
    let unexpected = 0
    link.onUnexpectedEnd(() => {
      unexpected += 1
    })
    link.start()
    link.close()
    streams[0]!.end()
    await settle()
    expect(unexpected).toBe(0)
    expect(link.isClosed).toBe(true)
  })

  test("an unexpected stream end fires onUnexpectedEnd once", async () => {
    const { loadIroh, streams } = createMockIroh()
    const link = await openLink(loadIroh)
    let unexpected = 0
    link.onUnexpectedEnd(() => {
      unexpected += 1
    })
    link.start()
    streams[0]!.end()
    await settle()
    expect(unexpected).toBe(1)
    expect(link.isClosed).toBe(false)
    expect(link.isAlive).toBe(false)
  })

  test("a throwing onUnexpectedEnd subscriber does not block the others", async () => {
    const { loadIroh, streams } = createMockIroh()
    const link = await openLink(loadIroh)
    let second = 0
    link.onUnexpectedEnd(() => {
      throw new Error("subscriber boom")
    })
    link.onUnexpectedEnd(() => {
      second += 1
    })
    link.start()
    streams[0]!.end()
    await settle()
    expect(second).toBe(1)
    expect(link.isAlive).toBe(false)
  })
})

describe("IrohLink media channel", () => {
  const UPLOAD = { name: "a.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]), sha256: "ab".repeat(32) }

  async function startUpload(link: IrohLink, streams: Array<{ push(text: string): void }>) {
    const promise = link.uploadMedia(UPLOAD)
    promise.catch(() => {})
    await settle(0)
    streams[0]!.push(`${JSON.stringify({ type: FrameType.MediaAccept, upload_id: "u1" })}\n`)
    await settle(0)
    return { promise }
  }

  test("uploadMedia resolves once the server acknowledges with put_ok", async () => {
    const { loadIroh, sent, streams } = createMockIroh()
    const link = await openLink(loadIroh)
    link.start()

    const { promise } = await startUpload(link, streams)
    expect(streams.length).toBe(2)
    streams[1]!.push(`${JSON.stringify({ op: "put_ok", hash: UPLOAD.sha256 })}\n`)
    await expect(promise).resolves.toBeUndefined()
    expect(sent.some((line) => line.includes('"op":"put"') && line.includes('"upload_id":"u1"'))).toBe(true)
  })

  test("uploadMedia surfaces a server error line instead of pretending success", async () => {
    const { loadIroh, streams } = createMockIroh()
    const link = await openLink(loadIroh)
    link.start()

    const { promise } = await startUpload(link, streams)
    streams[1]!.push(`${JSON.stringify({ type: "error", code: "media_hash_mismatch", message: "hash mismatch" })}\n`)
    await expect(promise).rejects.toThrow("hash mismatch")
  })

  test("getMedia refuses a header size above the media cap before reading the body", async () => {
    const { loadIroh, streams } = createMockIroh()
    const link = await openLink(loadIroh)
    link.start()
    const promise = link.getMedia(UPLOAD.sha256)
    promise.catch(() => {})
    await settle(0)
    streams[1]!.push(
      `${JSON.stringify({ op: "get", hash: UPLOAD.sha256, size: MAX_IROH_MEDIA_BYTES + 1, mime: "image/png", name: "a.png" })}\n`,
    )
    await expect(promise).rejects.toThrow(/size cap/)
  })

  test("getMedia returns the header fields plus the exact body bytes", async () => {
    const { loadIroh, sent, streams } = createMockIroh()
    const link = await openLink(loadIroh)
    link.start()

    const promise = link.getMedia(UPLOAD.sha256)
    promise.catch(() => {})
    await settle(0)
    expect(streams.length).toBe(2)
    expect(sent.some((line) => line.includes('"op":"get"') && line.includes(UPLOAD.sha256))).toBe(true)
    const headerLine = `${JSON.stringify({ op: "get", hash: UPLOAD.sha256, size: 3, mime: "image/png", name: "a.png" })}\n`
    const headerBytes = new TextEncoder().encode(headerLine)
    const combined = new Uint8Array(headerBytes.length + UPLOAD.bytes.length)
    combined.set(headerBytes, 0)
    combined.set(UPLOAD.bytes, headerBytes.length)
    streams[1]!.pushBytes(combined)
    await expect(promise).resolves.toEqual({
      hash: UPLOAD.sha256,
      mime: "image/png",
      name: "a.png",
      bytes: UPLOAD.bytes,
    })
  })

  test("getMedia reads a body that arrives after the header chunk", async () => {
    const { loadIroh, streams } = createMockIroh()
    const link = await openLink(loadIroh)
    link.start()

    const promise = link.getMedia(UPLOAD.sha256)
    promise.catch(() => {})
    await settle(0)
    streams[1]!.push(`${JSON.stringify({ op: "get", hash: UPLOAD.sha256, size: 3, mime: "image/png", name: "a.png" })}\n`)
    await settle(0)
    streams[1]!.pushBytes(UPLOAD.bytes)
    await expect(promise).resolves.toEqual({
      hash: UPLOAD.sha256,
      mime: "image/png",
      name: "a.png",
      bytes: UPLOAD.bytes,
    })
  })

  test("getMedia throws on an error reply header instead of returning empty bytes", async () => {
    const { loadIroh, streams } = createMockIroh()
    const link = await openLink(loadIroh)
    link.start()

    const promise = link.getMedia(UPLOAD.sha256)
    promise.catch(() => {})
    await settle(0)
    streams[1]!.push(`${JSON.stringify({ type: "error", code: "media_not_found", message: "not found" })}\n`)
    await expect(promise).rejects.toThrow("not found")
  })
})
