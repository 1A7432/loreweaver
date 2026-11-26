import { describe, expect, test } from "bun:test"
import { ALPN, ControlStream, dialIroh, looksLikeTicket, MAX_LINE_BYTES, type IrohModuleLike, type IrohRecvStreamLike } from "./irohLink"
import { createHash } from "node:crypto"
import { ByteError, byteGet, bytePut, StreamGate } from "./irohLink"
import { memoryStream, waitFor } from "./testkit"

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

// --- the byte channel ---------------------------------------------------------------------------

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const jsonLine = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`)

/** Serve one stream: read the client's side to its end, then answer with `chunks`. */
function answer(stream: ReturnType<typeof memoryStream>, chunks: (request: string) => Uint8Array[]): Promise<string> {
  return stream.toServer.all().then((received) => {
    const text = decoder.decode(received)
    for (const chunk of chunks(text)) stream.toClient.push(chunk)
    stream.toClient.end()
    return text
  })
}

describe("byte channel", () => {
  const body = encoder.encode("a picture's bytes ".repeat(5000))
  const hash = sha(body)
  const header = { op: "get", ok: true, hash, size: body.length, mime: "image/png", name: "map.png" }

  test("a GET sends one header line and reads exactly the declared bytes, split however they arrive", async () => {
    const stream = memoryStream()
    const served = answer(stream, () => {
      const all = new Uint8Array([...jsonLine(header), ...body])
      const parts: Uint8Array[] = []
      for (let at = 0; at < all.length; at += 777) parts.push(all.subarray(at, at + 777))
      return parts
    })
    const file = await byteGet(stream.client, hash)
    expect(await served).toBe(`{"op":"get","hash":"${hash}"}\n`)
    expect(file).toMatchObject({ hash, size: body.length, mime: "image/png", name: "map.png" })
    expect(Buffer.from(file.bytes).equals(Buffer.from(body))).toBe(true)
  })

  test("a server that sends more than it declared is refused", async () => {
    const stream = memoryStream()
    void answer(stream, () => [jsonLine(header), body, encoder.encode("x")])
    await expect(byteGet(stream.client, hash)).rejects.toMatchObject({ code: "too_much", server: false })
  })

  test("a header promising more than the client accepts is refused before anything is kept", async () => {
    const stream = memoryStream()
    void answer(stream, () => [jsonLine({ ...header, size: 10_000 })])
    await expect(byteGet(stream.client, hash, { maxBytes: 9_999 })).rejects.toMatchObject({ code: "too_large" })
  })

  test("bytes that do not match the hash asked for are dropped", async () => {
    const other = encoder.encode("something else")
    const stream = memoryStream()
    void answer(stream, () => [jsonLine({ ...header, size: other.length }), other])
    await expect(byteGet(stream.client, hash)).rejects.toMatchObject({ code: "hash_mismatch" })
  })

  test("a coded error line becomes a ByteError carrying the server's words", async () => {
    const stream = memoryStream()
    void answer(stream, () => [jsonLine({ ok: false, code: "media_not_found", message: "没有这个文件。" })])
    const error = await byteGet(stream.client, hash).catch((caught) => caught)
    expect(error).toBeInstanceOf(ByteError)
    expect(error).toMatchObject({ code: "media_not_found", message: "没有这个文件。", server: true })
  })

  test("a header line that never ends is refused at the protocol's header limit", async () => {
    const stream = memoryStream()
    void answer(stream, () => [encoder.encode("{".repeat(4096))])
    await expect(byteGet(stream.client, hash)).rejects.toMatchObject({ code: "bad_reply" })
  })

  test("a PUT sends the header, exactly the bytes, finishes its side, and reads the receipt", async () => {
    const stream = memoryStream()
    const progress: number[] = []
    const served = answer(stream, () => [jsonLine({ op: "put", ok: true, hash, size: body.length, mime: "image/png", name: "map.png" })])
    const receipt = await bytePut(stream.client, "u1", body, { onProgress: (sent) => progress.push(sent) })
    const received = await served
    expect(received.startsWith(`{"op":"put","upload_id":"u1"}\n`)).toBe(true)
    expect(encoder.encode(received).length).toBe(jsonLine({ op: "put", upload_id: "u1" }).length + body.length)
    expect(receipt).toEqual({ hash, size: body.length, mime: "image/png", name: "map.png" })
    expect(progress.at(-1)).toBe(body.length)
  })

  test("a PUT the server refuses reports the server's code", async () => {
    const stream = memoryStream()
    void answer(stream, () => [jsonLine({ ok: false, code: "media_disabled", message: "Uploads are off." })])
    await expect(bytePut(stream.client, "u1", body)).rejects.toMatchObject({ code: "media_disabled", server: true })
  })

  test("at most four operations run at once; the rest wait their turn", async () => {
    const gate = new StreamGate(4)
    const releases: (() => void)[] = []
    let peak = 0
    const runs = Array.from({ length: 7 }, () =>
      gate.run(async () => {
        peak = Math.max(peak, gate.open)
        await new Promise<void>((resolve) => releases.push(resolve))
      }),
    )
    await waitFor("four running", () => releases.length === 4)
    while (releases.length > 0) {
      releases.shift()?.()
      await new Promise((resolve) => setImmediate(resolve))
    }
    await waitFor("all done", () => releases.length === 0 && gate.open <= 4, undefined, async () => {
      releases.shift()?.()
      await new Promise((resolve) => setImmediate(resolve))
    })
    await Promise.all(runs)
    expect(peak).toBe(4)
    expect(gate.open).toBe(0)
  })
})
