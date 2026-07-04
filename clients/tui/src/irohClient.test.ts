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
          connect: async () => {
            const recv = makeRecvStream()
            streams.push(recv)
            return {
              openBi: async () => ({
                send: {
                  writeAll: async (buf: number[]) => {
                    sent.push(dec.decode(Uint8Array.from(buf)))
                  },
                },
                recv,
              }),
            }
          },
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
