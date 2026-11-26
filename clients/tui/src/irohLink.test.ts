import { describe, expect, test } from "bun:test"
import { ALPN, ControlStream, dialIroh, looksLikeTicket, MAX_LINE_BYTES, type IrohModuleLike, type IrohRecvStreamLike } from "./irohLink"
import { waitFor } from "./testkit"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** A receive stream the test feeds chunk by chunk; `end()` is EOF. */
class FeedStream implements IrohRecvStreamLike {
  #chunks: (number[] | null)[] = []
  #waiting: ((chunk: number[] | null) => void) | null = null
  push(text: string | Uint8Array): void {
    this.#give(Array.from(typeof text === "string" ? encoder.encode(text) : text))
  }
  end(): void {
    this.#give(null)
  }
  #give(chunk: number[] | null): void {
    if (this.#waiting) {
      const resolve = this.#waiting
      this.#waiting = null
      resolve(chunk)
    } else this.#chunks.push(chunk)
  }
  read(): Promise<number[] | null> {
    if (this.#chunks.length > 0) return Promise.resolve(this.#chunks.shift() ?? null)
    return new Promise((resolve) => (this.#waiting = resolve))
  }
}

/** A send stream that records lines and lets the test hold a write. */
class RecordSend {
  readonly written: string[] = []
  finished = false
  hold: Promise<void> | null = null
  async writeAll(buf: number[]): Promise<void> {
    if (this.hold) await this.hold
    this.written.push(decoder.decode(Uint8Array.from(buf)))
  }
  async finish(): Promise<void> {
    this.finished = true
  }
}

function stream() {
  const recv = new FeedStream()
  const send = new RecordSend()
  const closes: string[] = []
  const connection = { openBi: async () => ({ send, recv }), close: (_code: bigint, reason: number[]) => closes.push(decoder.decode(Uint8Array.from(reason))) }
  const control = new ControlStream(undefined, connection, send, recv)
  return { recv, send, closes, control }
}

describe("ControlStream", () => {
  test("parses newline-delimited JSON across arbitrary chunk boundaries, skipping blank and unreadable lines", async () => {
    const { recv, control } = stream()
    const values: unknown[] = []
    control.start((value) => values.push(value), () => {})
    const text = `{"type":"pong","t":1}\n\n{"type":"signal","kind":"draft","data":{"id":"x","text":"雨"}}\nnot json\n{"type":"pong","t":2}\n`
    const bytes = encoder.encode(text)
    // Split inside a multi-byte character too.
    for (let at = 0; at < bytes.length; at += 7) recv.push(bytes.subarray(at, at + 7))
    await waitFor("three frames", () => values.length === 3)
    expect(values).toEqual([{ type: "pong", t: 1 }, { type: "signal", kind: "draft", data: { id: "x", text: "雨" } }, { type: "pong", t: 2 }])
  })

  test("writes one line per frame, in order, even when a write is slow", async () => {
    const { send, control } = stream()
    let release: () => void = () => {}
    send.hold = new Promise((resolve) => (release = resolve))
    control.send({ type: "ping", t: 1 })
    control.send({ type: "input", rid: "r1", text: "hi" })
    send.hold = null
    release()
    await waitFor("two lines", () => send.written.length === 2)
    expect(send.written).toEqual([`{"type":"ping","t":1}\n`, `{"type":"input","rid":"r1","text":"hi"}\n`])
  })

  test("the end of the stream is reported once; a close asked for is not", async () => {
    const first = stream()
    const ends: string[] = []
    first.control.start(() => {}, (reason) => ends.push(reason))
    first.recv.end()
    await waitFor("the end", () => ends.length === 1)
    expect(ends).toEqual(["stream ended"])

    const second = stream()
    const none: string[] = []
    second.control.start(() => {}, (reason) => none.push(reason))
    second.control.send({ type: "ping", t: 1 })
    second.control.close()
    second.recv.end()
    await waitFor("the hang-up", () => second.closes.length === 1)
    expect(second.send.written).toEqual([`{"type":"ping","t":1}\n`])
    expect(second.send.finished).toBe(true)
    expect(none).toEqual([])
    second.control.send({ type: "ping", t: 2 })
    expect(second.send.written).toHaveLength(1)
  })

  test("a line past the cap drops the connection instead of buffering it", async () => {
    const { recv, control } = stream()
    const ends: string[] = []
    control.start(() => {}, (reason) => ends.push(reason))
    recv.push(new Uint8Array(MAX_LINE_BYTES + 1).fill(120))
    await waitFor("the drop", () => ends.length === 1)
    expect(ends).toEqual(["line too long"])
  })
})

describe("dialIroh", () => {
  function fakeIroh(calls: string[]): IrohModuleLike {
    const recv = new FeedStream()
    const send = new RecordSend()
    const endpoint = {
      online: async () => void calls.push("online"),
      connect: async (addr: unknown, alpn: number[]) => {
        calls.push(`connect ${String(addr)} ${decoder.decode(Uint8Array.from(alpn))}`)
        return { openBi: async () => ({ send, recv }) }
      },
      close: async () => void calls.push("endpoint closed"),
    }
    const builder = {
      bind: async () => endpoint,
      bindAddr: (addr: string) => void calls.push(`bind ${addr}`),
      relayMode: () => void calls.push("relay off"),
    }
    return {
      Endpoint: { builder: () => builder },
      presetN0: () => void calls.push("preset n0"),
      presetMinimal: () => void calls.push("preset minimal"),
      RelayMode: { disabled: () => "disabled" },
      EndpointTicket: { fromString: (ticket: string) => ({ endpointAddr: () => `addr(${ticket})` }) },
    }
  }

  test("speaks the 3.0 ALPN; the public preset waits to be online, the local one binds loopback with no relay", async () => {
    expect(ALPN).toBe("loreweaver/3")
    const remote: string[] = []
    await dialIroh(" endpointremote ", { loadIroh: async () => fakeIroh(remote) })
    expect(remote).toEqual(["preset n0", "online", "connect addr(endpointremote) loreweaver/3"])
    const local: string[] = []
    await dialIroh("endpointlocal", { mode: "local", loadIroh: async () => fakeIroh(local) })
    expect(local).toEqual(["preset minimal", "relay off", "bind 127.0.0.1:0", "connect addr(endpointlocal) loreweaver/3"])
  })

  test("a failed connect closes the endpoint it bound", async () => {
    const calls: string[] = []
    const iroh = fakeIroh(calls)
    const builder = iroh.Endpoint.builder()
    const endpoint = await builder.bind()
    endpoint.connect = async () => {
      throw new Error("unreachable")
    }
    await expect(dialIroh("endpointx", { loadIroh: async () => iroh })).rejects.toThrow("unreachable")
    expect(calls).toContain("endpoint closed")
  })

  test("a ticket is recognised by its shape", () => {
    expect(looksLikeTicket(" endpointabcdefghijklmnopqrstuvwxyz234567 ")).toBe(true)
    expect(looksLikeTicket("ws://127.0.0.1:8787")).toBe(false)
    expect(looksLikeTicket("endpointshort")).toBe(false)
  })
})
