import { describe, expect, test } from "bun:test"
import { PROTOCOL_VERSION } from "./types"
import { protocolMajor, protocolMismatch, protocolMismatchMessage } from "./version"
import { WsClient, type WebSocketLike } from "./client"

// Derived, never hardcoded: the repo pins the protocol version in exactly one place
// per runtime (tests/architecture/test_protocol_version_sync.py), and a literal here
// would quietly become a sixth statement of it.
const CLIENT_MAJOR = PROTOCOL_VERSION.split(".")[0]
const SAME_MAJOR_NEWER_MINOR = `${CLIENT_MAJOR}.999`
const OTHER_MAJOR = `${Number(CLIENT_MAJOR) + 1}.0`

type Listener = (event: any) => void

class MockWebSocket implements WebSocketLike {
  readyState = 0
  sent: Array<string | Uint8Array | ArrayBuffer> = []
  private listeners = new Map<string, Set<Listener>>()

  constructor(_url: string) {
    queueMicrotask(() => {
      this.readyState = 1
      this.emit("open", {})
    })
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  send(data: string | Uint8Array | ArrayBuffer): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit("close", {})
  }

  serverSend(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) })
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function welcome(protocol?: unknown): Record<string, unknown> {
  return {
    type: "welcome",
    ...(protocol === undefined ? {} : { protocol }),
    room: "table",
    you: { id: "p1", name: "Ada", role: "player" },
    locale: "en",
    server: "loreweaver",
  }
}

/** A client whose mismatch warnings land in a captured array instead of the console. */
async function connectedClient(): Promise<{ socket: MockWebSocket; warnings: string[] }> {
  const warnings: string[] = []
  let socket: MockWebSocket | undefined
  const client = new WsClient({
    reconnect: false,
    onProtocolMismatch: (message) => warnings.push(message),
    webSocketFactory: (url) => {
      socket = new MockWebSocket(url)
      return socket
    },
  })
  await client.connect("ws://example.test")
  return { socket: socket!, warnings }
}

describe("protocol version helpers", () => {
  test("protocolMajor reads the major, or nothing at all from garbage", () => {
    expect(protocolMajor("2.1")).toBe("2")
    expect(protocolMajor("10.4")).toBe("10")
    expect(protocolMajor("3")).toBe("3")
    // Leading zeros are the same major, not a different one.
    expect(protocolMajor("02.1")).toBe("2")
    for (const junk of [undefined, null, "", "   ", "x.1", "v2.1", {}, 2.1, []]) {
      expect(protocolMajor(junk)).toBeUndefined()
    }
  })

  test("protocolMismatch fires on a different major only", () => {
    expect(protocolMismatch(PROTOCOL_VERSION)).toBeUndefined()
    expect(protocolMismatch(SAME_MAJOR_NEWER_MINOR)).toBeUndefined()
    // Unreadable versions announce no major, so there is nothing to contradict.
    expect(protocolMismatch(undefined)).toBeUndefined()
    expect(protocolMismatch("nonsense")).toBeUndefined()

    const mismatch = protocolMismatch(OTHER_MAJOR)
    expect(mismatch).toEqual({ client: PROTOCOL_VERSION, server: OTHER_MAJOR })
    expect(protocolMismatchMessage(mismatch!)).toContain(PROTOCOL_VERSION)
    expect(protocolMismatchMessage(mismatch!)).toContain(OTHER_MAJOR)
  })
})

describe("WsClient major-mismatch warning", () => {
  test("a same-major welcome warns nothing", async () => {
    const { socket, warnings } = await connectedClient()

    socket.serverSend(welcome(PROTOCOL_VERSION))
    socket.serverSend(welcome(SAME_MAJOR_NEWER_MINOR))
    expect(warnings).toEqual([])

    // Positive control: the channel IS wired — a real mismatch on the same client warns.
    socket.serverSend(welcome(OTHER_MAJOR))
    expect(warnings).toHaveLength(1)
  })

  test("a different-major welcome warns once and names both versions", async () => {
    const { socket, warnings } = await connectedClient()

    socket.serverSend(welcome(OTHER_MAJOR))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(PROTOCOL_VERSION)
    expect(warnings[0]).toContain(OTHER_MAJOR)

    // Re-announced on every reconnect; the operator is told once, not per redial.
    socket.serverSend(welcome(OTHER_MAJOR))
    socket.serverSend(welcome(OTHER_MAJOR))
    expect(warnings).toHaveLength(1)
  })

  test("a missing or garbage welcome.protocol does not throw and does not warn", async () => {
    const { socket, warnings } = await connectedClient()

    for (const junk of [undefined, null, "", "banana", 21, { major: 2 }, ["2", "1"]]) {
      expect(() => socket.serverSend(welcome(junk))).not.toThrow()
    }
    expect(warnings).toEqual([])

    // Positive control: the client survived the garbage and still warns on a real mismatch.
    socket.serverSend(welcome(OTHER_MAJOR))
    expect(warnings).toHaveLength(1)
  })

  test("the warning still reaches the welcome subscribers", async () => {
    const warnings: string[] = []
    let socket: MockWebSocket | undefined
    const client = new WsClient({
      reconnect: false,
      onProtocolMismatch: (message) => warnings.push(message),
      webSocketFactory: (url) => {
        socket = new MockWebSocket(url)
        return socket
      },
    })
    const seen: string[] = []
    client.on("welcome", (frame) => seen.push(frame.room))
    await client.connect("ws://example.test")

    socket!.serverSend(welcome(OTHER_MAJOR))
    // A warning, not a refusal: the frame is delivered exactly as before.
    expect(seen).toEqual(["table"])
    expect(warnings).toHaveLength(1)
  })

  test("console.warn is the default channel", async () => {
    const original = console.warn
    const seen: unknown[] = []
    console.warn = (...args: unknown[]) => seen.push(args.join(" "))
    try {
      let socket: MockWebSocket | undefined
      const client = new WsClient({
        reconnect: false,
        webSocketFactory: (url) => {
          socket = new MockWebSocket(url)
          return socket
        },
      })
      await client.connect("ws://example.test")

      // Positive control: a same-major banner must not reach the console either.
      socket!.serverSend(welcome(PROTOCOL_VERSION))
      expect(seen).toEqual([])

      socket!.serverSend(welcome(OTHER_MAJOR))
      expect(seen).toHaveLength(1)
      expect(String(seen[0])).toContain(OTHER_MAJOR)
      expect(String(seen[0])).toContain(PROTOCOL_VERSION)
    } finally {
      console.warn = original
    }
  })
})
