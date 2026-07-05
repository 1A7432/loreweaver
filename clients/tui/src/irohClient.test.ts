import { describe, expect, test } from "bun:test"
import { FrameType } from "@loreweaver/protocol"
import { IrohClient, isIrohTicket, type LoadIroh } from "./irohClient"

// The transport picker (clients/tui/src/client.ts) routes on this: a ws(s):// URL keeps the
// zero-dep WebSocket path; anything else is treated as an Iroh ticket. Getting this wrong
// sends a ticket to WsClient (or a URL to iroh), so it is worth pinning.
describe("isIrohTicket", () => {
  test("ws/wss URLs are NOT tickets — route to WebSocket", () => {
    expect(isIrohTicket("ws://127.0.0.1:8787")).toBe(false)
    expect(isIrohTicket("wss://1a7432.site/ws")).toBe(false)
    expect(isIrohTicket("WSS://Host/ws")).toBe(false) // scheme match is case-insensitive
    expect(isIrohTicket("  ws://host  ")).toBe(false) // leading/trailing space is trimmed
  })

  test("a base32 endpoint ticket IS a ticket — route to Iroh", () => {
    expect(isIrohTicket("endpointaagjr2rmbvc2sxr5rvnp45ul2iiqi26wzuvmi767mfihikiqjnqvwba")).toBe(true)
  })
})

// A minimal mock of `@number0/iroh`'s surface — just enough for `IrohClient.dial()` to drive
// end to end without loading the native module. Each `connect()` call opens a fresh mock
// bi-stream; `streams[n].end()` simulates that connection's read side hitting EOF (a server
// restart / laptop sleep / network flap), which is exactly what an unexpected redial reacts to.
function createMockIroh() {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const sent: string[] = []

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

  // One entry per `openBi()` call: streams[0] is the first connection's long-lived control
  // stream; media PUT/GET each open the next fresh stream, exactly like the real transport.
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
                    sent.push(dec.decode(Uint8Array.from(buf)))
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

  return { loadIroh, sent, streams }
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

describe("IrohClient reconnect", () => {
  test("an unexpected stream end schedules a redial and re-sends the last join", async () => {
    const { loadIroh, sent, streams } = createMockIroh()
    const client = new IrohClient({ loadIroh, reconnectBaseMs: 5, reconnectMaxMs: 20 })

    await client.connect("endpointaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    client.join("room-key", "Ada")
    await settle(0)
    expect(sent.length).toBe(1)
    expect(JSON.parse(sent[0])).toEqual({ type: FrameType.Join, key: "room-key", name: "Ada" })

    // Simulate the p2p stream ending unexpectedly.
    streams[0].end()
    await settle()

    expect(streams.length).toBe(2) // a fresh dial happened
    expect(sent.length).toBe(2)
    expect(JSON.parse(sent[1])).toEqual({ type: FrameType.Join, key: "room-key", name: "Ada" })
  })

  test("close() is manual — a late stream end after close() does not redial", async () => {
    const { loadIroh, streams } = createMockIroh()
    const client = new IrohClient({ loadIroh, reconnectBaseMs: 5, reconnectMaxMs: 20 })

    await client.connect("endpointaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    client.close()
    streams[0].end() // the read loop was still awaiting this stream when close() ran

    await settle()
    expect(streams.length).toBe(1) // no redial
  })

  test("onStatus goes online -> reconnecting -> online across an unexpected drop", async () => {
    const { loadIroh, streams } = createMockIroh()
    const client = new IrohClient({ loadIroh, reconnectBaseMs: 5, reconnectMaxMs: 20 })
    const statuses: string[] = []
    client.onStatus((status) => statuses.push(status))

    await client.connect("endpointaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    expect(statuses).toEqual(["connecting", "online"])

    streams[0].end()
    await settle()

    expect(statuses).toEqual(["connecting", "online", "reconnecting", "connecting", "online"])
  })

  test("onStatus goes offline on a manual close, with no redial afterwards", async () => {
    const { loadIroh, streams } = createMockIroh()
    const client = new IrohClient({ loadIroh, reconnectBaseMs: 5, reconnectMaxMs: 20 })
    const statuses: string[] = []
    client.onStatus((status) => statuses.push(status))

    await client.connect("endpointaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    client.close()
    expect(statuses).toEqual(["connecting", "online", "offline"])

    streams[0].end()
    await settle()
    expect(streams.length).toBe(1)
    expect(statuses).toEqual(["connecting", "online", "offline"])
  })
})

// The media byte channel opens a fresh bi-stream per transfer. The server ends a PUT stream
// with a `put_ok` (or localized error) line and answers a GET with a header line + body —
// these pin that the client actually reads those replies instead of assuming success.
describe("IrohClient media channel", () => {
  const TICKET = "endpointaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  const UPLOAD = { name: "a.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]), sha256: "ab".repeat(32) }

  // Wrapped in an object: returning the bare promise from an async helper would make
  // `await startUpload(...)` flatten and await the upload itself — before the test had a
  // chance to push the server's reply, deadlocking the test.
  async function startUpload(client: IrohClient, streams: Array<{ push(text: string): void }>) {
    const promise = client.uploadMedia(UPLOAD)
    promise.catch(() => {}) // inspected via expect() below; avoid an unhandled-rejection warning
    await settle(0)
    streams[0].push(`${JSON.stringify({ type: FrameType.MediaAccept, upload_id: "u1" })}\n`)
    await settle(0) // let the client open the PUT stream and write header + body
    return { promise }
  }

  test("uploadMedia resolves once the server acknowledges with put_ok", async () => {
    const { loadIroh, sent, streams } = createMockIroh()
    const client = new IrohClient({ loadIroh, reconnectBaseMs: 5, reconnectMaxMs: 20 })
    await client.connect(TICKET)

    const { promise } = await startUpload(client, streams)
    expect(streams.length).toBe(2)
    streams[1].push(`${JSON.stringify({ op: "put_ok", hash: UPLOAD.sha256 })}\n`)
    await expect(promise).resolves.toBeUndefined()
    expect(sent.some((line) => line.includes('"op":"put"') && line.includes('"upload_id":"u1"'))).toBe(true)
  })

  test("uploadMedia surfaces a server error line instead of pretending success", async () => {
    const { loadIroh, streams } = createMockIroh()
    const client = new IrohClient({ loadIroh, reconnectBaseMs: 5, reconnectMaxMs: 20 })
    await client.connect(TICKET)

    const { promise } = await startUpload(client, streams)
    streams[1].push(`${JSON.stringify({ type: "error", code: "media_hash_mismatch", message: "hash mismatch" })}\n`)
    await expect(promise).rejects.toThrow("hash mismatch")
  })

  test("getMedia throws on an error reply header instead of returning empty bytes", async () => {
    const { loadIroh, streams } = createMockIroh()
    const client = new IrohClient({ loadIroh, reconnectBaseMs: 5, reconnectMaxMs: 20 })
    await client.connect(TICKET)

    const promise = client.getMedia("ab".repeat(32))
    promise.catch(() => {})
    await settle(0)
    expect(streams.length).toBe(2)
    streams[1].push(`${JSON.stringify({ type: "error", code: "media_not_found", message: "not found" })}\n`)
    await expect(promise).rejects.toThrow("not found")
  })
})
