import { describe, expect, test } from "bun:test"
import { FrameType, type NarrativeFrame, type StateFrame } from "./types"
import { WsClient, type WebSocketLike } from "./client"

type Listener = (event: any) => void

class MockWebSocket implements WebSocketLike {
  readonly url: string
  readyState = 0
  sent: string[] = []
  private listeners = new Map<string, Set<Listener>>()

  constructor(url: string) {
    this.url = url
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

  send(data: string): void {
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
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

function createClient(): { client: WsClient; sockets: MockWebSocket[] } {
  const sockets: MockWebSocket[] = []
  const client = new WsClient({
    reconnect: false,
    webSocketFactory: (url) => {
      const socket = new MockWebSocket(url)
      sockets.push(socket)
      return socket
    },
  })
  return { client, sockets }
}

describe("WsClient", () => {
  test("connect -> join sends the join frame", async () => {
    const { client, sockets } = createClient()

    await client.connect("ws://example.test")
    client.join("room-key", "Ada")

    expect(sockets[0].url).toBe("ws://example.test")
    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      type: FrameType.Join,
      key: "room-key",
      name: "Ada",
    })
  })

  test("incoming frames are parsed and dispatched by type", async () => {
    const { client, sockets } = createClient()
    const narrativeFrames: NarrativeFrame[] = []
    const allFrames: string[] = []

    client.on(FrameType.Narrative, (frame) => narrativeFrames.push(frame))
    client.onMessage((frame) => allFrames.push(frame.type))

    await client.connect("ws://example.test")
    sockets[0].serverSend({
      type: FrameType.Narrative,
      id: "n1",
      speaker: "kp",
      text: "The door opens.",
      format: "markdown",
    })
    sockets[0].serverSend({
      type: FrameType.State,
      party: [],
      initiative: [],
      online: 1,
    } satisfies StateFrame)

    expect(narrativeFrames).toHaveLength(1)
    expect(narrativeFrames[0].text).toBe("The door opens.")
    expect(allFrames).toEqual([FrameType.Narrative, FrameType.State])
  })

  test("incoming ping auto-sends pong", async () => {
    const { client, sockets } = createClient()

    await client.connect("ws://example.test")
    sockets[0].serverSend({ type: FrameType.Ping, t: 123 })

    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      type: FrameType.Pong,
      t: 123,
    })
  })

  test("admin request helpers send the v1.1 admin frames", async () => {
    const { client, sockets } = createClient()
    await client.connect("ws://example.test")

    client.adminGetConfig()
    client.adminSetModel("deepseek", "deepseek-chat")
    client.adminSetModel("openai")
    client.adminListKeys()
    client.adminMintKey("arkham", "Ada", "keeper")

    expect(sockets[0].sent.map((raw) => JSON.parse(raw))).toEqual([
      { type: FrameType.AdminGetConfig },
      { type: FrameType.AdminSetModel, provider: "deepseek", chat_model: "deepseek-chat" },
      { type: FrameType.AdminSetModel, provider: "openai" },
      { type: FrameType.AdminListKeys },
      { type: FrameType.AdminMintKey, room: "arkham", name: "Ada", role: "keeper" },
    ])
  })

  test("incoming admin_config / admin_keys / admin_error frames are dispatched", async () => {
    const { client, sockets } = createClient()
    const seen: string[] = []
    client.on(FrameType.AdminConfig, () => seen.push(FrameType.AdminConfig))
    client.on(FrameType.AdminKeys, () => seen.push(FrameType.AdminKeys))
    client.on(FrameType.AdminError, () => seen.push(FrameType.AdminError))

    await client.connect("ws://example.test")
    sockets[0].serverSend({
      type: FrameType.AdminConfig,
      provider: "openai",
      chat_model: "gpt-4o",
      base_url: "",
      api_key_masked: "",
      providers: ["openai", "deepseek"],
      override_active: false,
    })
    sockets[0].serverSend({ type: FrameType.AdminKeys, keys: [] })
    sockets[0].serverSend({ type: FrameType.AdminError, code: "forbidden" })

    expect(seen).toEqual([FrameType.AdminConfig, FrameType.AdminKeys, FrameType.AdminError])
  })
})

