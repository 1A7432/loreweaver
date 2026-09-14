import { describe, expect, test } from "bun:test"
import {
  ActionWebSocketTransport,
  OneBotForwardWebSocketTransport,
  OneBotReverseWebSocketTransport,
  OneBotTransport,
  defaultConnectFactory,
  reverseHandshakeResponse,
  EVENT_QUEUE_LIMIT,
  MAX_TEXT_CHARS,
  MAX_WEBSOCKET_FRAME_BYTES,
  type ConnectFactory,
  type OneBotRawTransport,
  type OneBotSocket,
} from "./index"
import { OneBotAPIError, OneBotError } from "./shared"

function groupEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    time: 1,
    self_id: 42,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: 10,
    group_id: 99,
    user_id: 7,
    message: [{ type: "text", data: { text: "hello" } }],
    sender: { nickname: "Ada", card: "Investigator" },
    ...overrides,
  }
}

const BunWebSocket = WebSocket as unknown as new (url: string, opts?: { headers?: Record<string, string> }) => WebSocket

function openWs(url: string, headers?: Record<string, string>): WebSocket {
  return headers ? new BunWebSocket(url, { headers }) : new WebSocket(url)
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

class FakeSocket implements OneBotSocket {
  sent: string[] = []
  closeArgs?: { code?: number; reason?: string }
  hangSend = false
  private readonly queue: string[] = []
  private waiter?: (result: IteratorResult<string>) => void
  private closed = false

  constructor(preloaded: unknown[] = []) {
    for (const item of preloaded) this.queue.push(typeof item === "string" ? item : JSON.stringify(item))
  }

  send(data: string): void | Promise<void> {
    this.sent.push(data)
    if (this.hangSend) return new Promise(() => {})
  }

  close(code?: number, reason?: string): void {
    this.closeArgs = { code, reason }
    this.end()
  }

  push(payload: unknown): void {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload)
    if (this.closed) return
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter({ value: raw, done: false })
    } else {
      this.queue.push(raw)
    }
  }

  end(): void {
    if (this.closed) return
    this.closed = true
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift()!, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiter = resolve
        })
      },
    }
  }
}

function stubRaw(overrides: Partial<OneBotRawTransport> = {}): OneBotRawTransport & {
  calls: Array<[string, Record<string, unknown>]>
  error?: unknown
  response: unknown
} {
  const stub = {
    kind: "reverse" as const,
    connected: true,
    pendingCount: 0,
    pendingEvents: 0,
    requestTimeoutMs: 1000,
    calls: [] as Array<[string, Record<string, unknown>]>,
    error: undefined as unknown,
    response: { message_id: 101 } as unknown,
    async start() {},
    async close() {},
    async call(action: string, params: Record<string, unknown>) {
      stub.calls.push([action, params])
      if (stub.error !== undefined) throw stub.error
      return stub.response
    },
    ...overrides,
  }
  return stub
}

describe("isGroupMember", () => {
  test("true on get_group_member_info success, false on any error, and caches positives", async () => {
    const stub = stubRaw()
    const transport = new OneBotTransport({ transport: stub })
    expect(await transport.isGroupMember(99, 8)).toBe(true)
    expect(stub.calls).toEqual([["get_group_member_info", { group_id: 99, user_id: 8 }]])
    expect(await transport.isGroupMember(99, 8)).toBe(true)
    expect(stub.calls).toHaveLength(1)
    stub.error = new Error("nope")
    expect(await transport.isGroupMember(99, 9)).toBe(false)
  })
})

describe("forward mode", () => {
  test("sends Bearer when a token is configured and reconnects with backoff after a drop", async () => {
    const sockets: FakeSocket[] = []
    const headersSeen: Array<Record<string, string> | undefined> = []
    const factory: ConnectFactory = async (_url, opts) => {
      headersSeen.push(opts.headers)
      const sock = new FakeSocket()
      sockets.push(sock)
      return sock
    }
    const transport = new OneBotForwardWebSocketTransport({
      url: "ws://127.0.0.1:9/",
      accessToken: "token",
      requestTimeoutMs: 200,
      reconnectDelayMs: 15,
      connectFactory: factory,
    })
    const received: Array<Record<string, unknown>> = []
    try {
      await transport.start((payload) => {
        received.push(payload)
      })
      await transport.waitConnected(200)
      expect(headersSeen[0]).toEqual({ Authorization: "Bearer token" })
      sockets[0]!.push(groupEvent({ message_id: 30 }))
      await waitFor(() => received.length === 1)

      sockets[0]!.end()
      await waitFor(() => sockets.length === 2)
      await transport.waitConnected(200)
      expect(headersSeen[1]).toEqual({ Authorization: "Bearer token" })
      expect(transport.connected).toBe(true)
    } finally {
      await transport.close()
    }
    expect(transport.connected).toBe(false)
  })

  test("a hung write on the dead socket never lands on the reconnect (F13)", async () => {
    const sockets: FakeSocket[] = []
    const factory: ConnectFactory = async () => {
      const sock = new FakeSocket()
      sock.hangSend = sockets.length === 0
      sockets.push(sock)
      return sock
    }
    const transport = new OneBotForwardWebSocketTransport({
      url: "ws://127.0.0.1:9/",
      requestTimeoutMs: 300,
      reconnectDelayMs: 10,
      connectFactory: factory,
    })
    try {
      await transport.start(() => {})
      await transport.waitConnected(200)
      const hung = transport.call("send_group_msg", { n: 1 })
      await waitFor(() => sockets[0]!.sent.length === 1)
      sockets[0]!.end()
      await expect(hung).rejects.toMatchObject({ code: "onebot.websocket.disconnected" })
      await transport.waitConnected(200)
      const live = transport.call("send_group_msg", { n: 2 })
      await waitFor(() => sockets[1]!.sent.length === 1)
      const echo = JSON.parse(sockets[1]!.sent[0]!).echo as string
      sockets[1]!.push({ status: "ok", retcode: 0, data: { message_id: 2 }, echo })
      expect(await live).toEqual({ message_id: 2 })
      expect(sockets[1]!.sent.some((line) => line.includes('"n":1'))).toBe(false)
    } finally {
      await transport.close()
    }
  })

  test("a throwing status subscriber does not kill the reconnect loop", async () => {
    const sockets: FakeSocket[] = []
    const factory: ConnectFactory = async () => {
      const sock = new FakeSocket()
      sockets.push(sock)
      return sock
    }
    const transport = new OneBotForwardWebSocketTransport({
      url: "ws://127.0.0.1:9/",
      requestTimeoutMs: 200,
      reconnectDelayMs: 15,
      connectFactory: factory,
    })
    transport.onStatus((status) => {
      if (status === "reconnecting") throw new Error("subscriber boom")
    })
    try {
      await transport.start(() => {})
      await transport.waitConnected(200)
      sockets[0]!.end()
      await waitFor(() => sockets.length === 2)
      await transport.waitConnected(200)
      expect(transport.connected).toBe(true)
    } finally {
      await transport.close()
    }
  })

  test("connect() returns false when the first dial never comes up", async () => {
    const factory: ConnectFactory = async () => {
      throw new Error("unreachable")
    }
    const transport = new OneBotForwardWebSocketTransport({
      url: "ws://127.0.0.1:1/",
      requestTimeoutMs: 40,
      reconnectDelayMs: 10,
      connectFactory: factory,
    })
    const adapter = new OneBotTransport({ transport })
    expect(await adapter.connect()).toBe(false)
  })
})

describe("reverse mode", () => {
  test("handshake rejects a missing or wrong Bearer and a non-Universal role", () => {
    const opts = { path: "/onebot/v11/ws", accessToken: "token" }
    const url = "http://127.0.0.1/onebot/v11/ws"
    expect(reverseHandshakeResponse({ url, headers: new Headers({ Authorization: "Bearer wrong" }) }, opts)?.status).toBe(401)
    expect(reverseHandshakeResponse({ url, headers: new Headers() }, opts)?.status).toBe(401)
    expect(
      reverseHandshakeResponse(
        { url, headers: new Headers({ Authorization: "Bearer token", "X-Client-Role": "Event" }) },
        opts,
      )?.status,
    ).toBe(400)
    expect(
      reverseHandshakeResponse(
        { url, headers: new Headers({ Authorization: "Bearer token", "X-Client-Role": "Universal" }) },
        opts,
      ),
    ).toBeNull()
    expect(reverseHandshakeResponse({ url: "http://127.0.0.1/other", headers: new Headers() }, opts)?.status).toBe(404)
  })

  test("refuses to listen off loopback without a token", () => {
    expect(() => new OneBotReverseWebSocketTransport({ host: "0.0.0.0", port: 6700 })).toThrow(
      /onebot\.reverse\.public_auth_required/,
    )
    expect(new OneBotTransport({ mode: "reverse", listenHost: "0.0.0.0", listenPort: 6700 }).raw).toBeUndefined()
    expect(
      new OneBotTransport({
        mode: "reverse",
        listenHost: "0.0.0.0",
        listenPort: 6700,
        accessToken: "secret",
      }).raw,
    ).toBeInstanceOf(OneBotReverseWebSocketTransport)
  })

  test("accepts the implementation reconnect and requires Universal when the header is sent", async () => {
    const received: Array<Record<string, unknown>> = []
    const transport = new OneBotReverseWebSocketTransport({
      host: "127.0.0.1",
      port: 0,
      accessToken: "token",
      requestTimeoutMs: 500,
    })
    await transport.start((payload) => {
      received.push(payload)
    })
    const port = transport.boundPort
    expect(port).toBeGreaterThan(0)
    const http = `http://127.0.0.1:${port}/onebot/v11/ws`
    const wsUrl = `ws://127.0.0.1:${port}/onebot/v11/ws`
    try {
      expect((await fetch(http, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401)
      expect((await fetch(http)).status).toBe(401)
      expect(
        (await fetch(http, { headers: { Authorization: "Bearer token", "X-Client-Role": "API" } })).status,
      ).toBe(400)

      const first = openWs(wsUrl, { Authorization: "Bearer token", "X-Client-Role": "Universal" })
      await waitFor(() => first.readyState === WebSocket.OPEN)
      first.send(JSON.stringify(groupEvent({ message_id: 50 })))
      await waitFor(() => received.length === 1)
      first.close()
      await waitFor(() => first.readyState === WebSocket.CLOSED)

      const second = openWs(wsUrl, { Authorization: "Bearer token", "X-Client-Role": "Universal" })
      await waitFor(() => second.readyState === WebSocket.OPEN)
      second.send(JSON.stringify(groupEvent({ message_id: 51 })))
      await waitFor(() => received.length === 2)
      expect(received[1]!.message_id).toBe(51)
      second.close()
    } finally {
      await transport.close()
    }
  })
})

describe("actions — echo matching", () => {
  test("each call gets a unique echo and a reply resolves only its own request", async () => {
    const sock = new FakeSocket()
    const transport = new ActionWebSocketTransport(300)
    transport.startDispatcher(() => {})
    transport.adopt(sock)
    const consuming = transport.consume(sock)
    try {
      const first = transport.call("a", { n: 1 })
      const second = transport.call("b", { n: 2 })
      await waitFor(() => sock.sent.length === 2)
      const echo1 = JSON.parse(sock.sent[0]!).echo as string
      const echo2 = JSON.parse(sock.sent[1]!).echo as string
      expect(echo1).toBe("loreweaver-1")
      expect(echo2).toBe("loreweaver-2")
      sock.push({ status: "ok", retcode: 0, data: { n: 2 }, echo: echo2 })
      expect(await second).toEqual({ n: 2 })
      sock.push({ status: "ok", retcode: 0, data: { n: 1 }, echo: echo1 })
      expect(await first).toEqual({ n: 1 })
    } finally {
      sock.end()
      await consuming
    }
  })

  test("a late echo after timeout is dropped and never dispatched as an event", async () => {
    const sock = new FakeSocket()
    const received: Array<Record<string, unknown>> = []
    const transport = new ActionWebSocketTransport(20)
    transport.startDispatcher((payload) => {
      received.push(payload)
    })
    transport.adopt(sock)
    const consuming = transport.consume(sock)
    try {
      await expect(transport.call("send_group_msg", {})).rejects.toMatchObject({ name: "TimeoutError" })
      const echo = JSON.parse(sock.sent[0]!).echo as string
      sock.push({ status: "ok", retcode: 0, data: { message_id: 41 }, echo })
      const event = groupEvent({ message_id: 40 })
      sock.push(event)
      await waitFor(() => received.length === 1)
      expect(received).toEqual([event])
      expect(transport.pendingCount).toBe(0)
    } finally {
      sock.end()
      await consuming
    }
  })

  test("a pending call fails cleanly on disconnect and is not re-issued", async () => {
    let actionCount = 0
    const sockets: FakeSocket[] = []
    const factory: ConnectFactory = async () => {
      const sock = new FakeSocket()
      sockets.push(sock)
      return sock
    }
    const transport = new OneBotForwardWebSocketTransport({
      url: "ws://127.0.0.1:9/",
      requestTimeoutMs: 300,
      reconnectDelayMs: 10,
      connectFactory: factory,
    })
    try {
      await transport.start(() => {})
      await transport.waitConnected(200)
      const pending = transport.call("send_group_msg", { group_id: 99, message: "hello" })
      await waitFor(() => sockets[0]!.sent.length === 1)
      actionCount += 1
      sockets[0]!.end()
      await expect(pending).rejects.toMatchObject({ code: "onebot.websocket.disconnected" })
      await waitFor(() => sockets.length === 2)
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(actionCount).toBe(1)
      expect(sockets[1]!.sent).toEqual([])
      expect(transport.pendingCount).toBe(0)
    } finally {
      await transport.close()
    }
  })
})

describe("events — dispatch, backlog, frame size", () => {
  test("dispatch is ordered per chat and concurrent across chats", async () => {
    const transport = new ActionWebSocketTransport()
    let releaseFirst!: () => void
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let resolveFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve
    })
    let resolveOther!: () => void
    const otherDone = new Promise<void>((resolve) => {
      resolveOther = resolve
    })
    const seen: Array<[number, number]> = []
    transport.startDispatcher(async (payload) => {
      const pair: [number, number] = [Number(payload.group_id), Number(payload.message_id)]
      seen.push(pair)
      if (pair[0] === 99 && pair[1] === 1) {
        resolveFirstStarted()
        await release
      }
      if (pair[0] === 100 && pair[1] === 1) resolveOther()
    })
    expect(transport.queueEvent(groupEvent({ group_id: 99, message_id: 1 }))).toBe(true)
    expect(transport.queueEvent(groupEvent({ group_id: 99, message_id: 2 }))).toBe(true)
    expect(transport.queueEvent(groupEvent({ group_id: 100, message_id: 1 }))).toBe(true)
    await firstStarted
    await otherDone
    expect(seen.some((pair) => pair[0] === 99 && pair[1] === 2)).toBe(false)
    releaseFirst()
    await waitFor(() => transport.pendingEvents === 0)
    expect(seen.findIndex((pair) => pair[0] === 99 && pair[1] === 1)).toBeLessThan(
      seen.findIndex((pair) => pair[0] === 99 && pair[1] === 2),
    )
    await transport.stopDispatcher()
  })

  test("backlog exhaustion closes the socket instead of dropping silently", async () => {
    const payloads = Array.from({ length: EVENT_QUEUE_LIMIT + 1 }, (_, index) =>
      JSON.stringify(groupEvent({ group_id: 99, message_id: index })),
    )
    const sock = new FakeSocket(payloads)
    const transport = new ActionWebSocketTransport()
    transport.startDispatcher(async () => {
      await new Promise(() => {})
    })
    await transport.consume(sock)
    expect(sock.closeArgs).toEqual({ code: 1013, reason: "event backlog exhausted" })
    expect(transport.pendingEvents).toBe(EVENT_QUEUE_LIMIT)
    await transport.stopDispatcher()
    expect(transport.pendingEvents).toBe(0)
  })

  test("an inbound frame above the cap is closed with 1009 and treated as a drop", async () => {
    const huge = "x".repeat(MAX_WEBSOCKET_FRAME_BYTES + 1)
    const sock = new FakeSocket([huge])
    const received: Array<Record<string, unknown>> = []
    const transport = new ActionWebSocketTransport()
    transport.startDispatcher((payload) => {
      received.push(payload)
    })
    transport.adopt(sock)
    await transport.consume(sock)
    expect(sock.closeArgs).toEqual({ code: 1009, reason: "frame too large" })
    expect(received).toEqual([])
    await transport.stopDispatcher()
  })

  test("reverse accepts a frame above the 1 MiB library default", async () => {
    const raw = Buffer.alloc(800_000, 120)
    const event = groupEvent({
      message_id: 55,
      message: [{ type: "image", data: { file: `base64://${raw.toString("base64")}` } }],
    })
    const encoded = JSON.stringify(event)
    expect(encoded.length).toBeGreaterThan(1024 * 1024)
    expect(encoded.length).toBeLessThan(MAX_WEBSOCKET_FRAME_BYTES)
    const received: Array<Record<string, unknown>> = []
    const transport = new OneBotReverseWebSocketTransport({ host: "127.0.0.1", port: 0 })
    await transport.start((payload) => {
      received.push(payload)
    })
    const port = transport.boundPort!
    try {
      const client = openWs(`ws://127.0.0.1:${port}/onebot/v11/ws`, { "X-Client-Role": "Universal" })
      await waitFor(() => client.readyState === WebSocket.OPEN)
      client.send(encoded)
      await waitFor(() => received.length === 1, 3000)
      expect(received[0]!.message_id).toBe(55)
      client.close()
    } finally {
      await transport.close()
    }
  })
})

describe("outbound", () => {
  test("text is split to OneBot limits without loss; reply and image are segments", async () => {
    const stub = stubRaw()
    const bot = new OneBotTransport({ transport: stub })
    const rendered = `prefix\n${"x".repeat(5000)}\n1. Help — .help`
    const png = new Uint8Array([9, 8, 7])
    const result = await bot.send(
      { type: "group", id: 99 },
      { text: rendered, replyTo: "10", image: { data: png, mime: "image/png" } },
    )
    expect(result.ok).toBe(true)
    expect(result.messageId).toBe("101")
    expect(stub.calls.length).toBe(2)
    const texts = stub.calls.map(([, params]) => {
      const message = params.message as Array<{ type: string; data: { text?: string } }>
      return message.find((segment) => segment.type === "text")!.data.text!
    })
    expect(texts.every((part) => part.length <= MAX_TEXT_CHARS)).toBe(true)
    expect(texts.join("")).toBe(rendered)
    expect(stub.calls[0]![0]).toBe("send_group_msg")
    const firstMessage = stub.calls[0]![1].message as Array<{ type: string; data: Record<string, unknown> }>
    expect(firstMessage[0]).toEqual({ type: "reply", data: { id: "10" } })
    const lastMessage = stub.calls[1]![1].message as Array<{ type: string; data: Record<string, unknown> }>
    expect(lastMessage.some((segment) => segment.type === "image")).toBe(true)
    const image = lastMessage.find((segment) => segment.type === "image")!
    expect(image.data.file).toBe(`base64://${Buffer.from(png).toString("base64")}`)
  })

  test("a group message redirected to private drops the reply segment; a native private reply keeps it", async () => {
    const stub = stubRaw()
    const bot = new OneBotTransport({ transport: stub })
    const redirected = await bot.send(
      { type: "group", id: 99, userId: 7 },
      { text: "private sheet", private: true, replyTo: "group-message-10" },
    )
    expect(redirected.ok).toBe(true)
    expect(stub.calls).toEqual([
      [
        "send_private_msg",
        { user_id: 7, message: [{ type: "text", data: { text: "private sheet" } }] },
      ],
    ])
    const native = await bot.send(
      { type: "private", id: 7 },
      { text: "dm reply", replyTo: "private-message-3" },
    )
    expect(native.ok).toBe(true)
    expect(stub.calls[1]).toEqual([
      "send_private_msg",
      {
        user_id: 7,
        message: [
          { type: "reply", data: { id: "private-message-3" } },
          { type: "text", data: { text: "dm reply" } },
        ],
      },
    ])
    const unavailable = await bot.send({ type: "group", id: 99 }, { text: "secret", private: true })
    expect(unavailable.ok).toBe(false)
    expect(unavailable.error).toBe("onebot.private_target.unavailable")
    expect(stub.calls).toHaveLength(2)
  })

  test("send failures are stable errors that never leak the token", async () => {
    const stub = stubRaw()
    const secret = "super-secret-token"
    stub.error = new Error(`wss://host/?access_token=${secret}`)
    const bot = new OneBotTransport({ transport: stub })
    const warnings: unknown[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    try {
      const result = await bot.sendText({ type: "group", id: 99 }, "hello")
      expect(result.ok).toBe(false)
      expect(result.error).toBe("onebot.send.failed")
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(JSON.stringify(warnings)).not.toContain(secret)
    } finally {
      console.warn = original
    }
    stub.error = new OneBotAPIError(1403, secret)
    const api = await bot.sendText({ type: "group", id: 99 }, "hello")
    expect(api.error).toBe("onebot.api.1403")
    expect(JSON.stringify(api)).not.toContain(secret)
  })

  test("oversize outbound image is a stable failure and does not send", async () => {
    const stub = stubRaw()
    const bot = new OneBotTransport({ transport: stub })
    const result = await bot.sendImage(
      { type: "group", id: 99 },
      { data: new Uint8Array(20 * 1024 * 1024 + 1), mime: "image/png" },
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe("onebot.send.failed")
    expect(stub.calls).toEqual([])
  })
})

describe("OneBotTransport event stream", () => {
  test("connect fans parsed inbound messages out of the raw socket", async () => {
    const sock = new FakeSocket()
    const factory: ConnectFactory = async () => sock
    const bot = new OneBotTransport({
      mode: "forward",
      wsUrl: "ws://127.0.0.1:9/",
      requestTimeoutMs: 200,
      reconnectDelayMs: 20,
      connectFactory: factory,
    })
    const seen: string[] = []
    bot.onMessage((msg) => {
      seen.push(msg.text)
    })
    try {
      expect(await bot.connect()).toBe(true)
      sock.push(groupEvent({ message: [{ type: "text", data: { text: "hello" } }] }))
      await waitFor(() => seen[0] === "hello")
      sock.push(groupEvent({ user_id: 42 }))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(seen).toEqual(["hello"])
    } finally {
      await bot.close()
    }
  })
})

describe("defaultConnectFactory", () => {
  test("sends Bearer when a token is configured", async () => {
    const auths: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, bunServer) {
        auths.push(req.headers.get("Authorization") ?? "")
        if (bunServer.upgrade(req)) return undefined as unknown as Response
        return new Response("", { status: 500 })
      },
      websocket: {
        message() {},
      },
    })
    try {
      const sock = await defaultConnectFactory(`ws://127.0.0.1:${server.port}/`, {
        headers: { Authorization: "Bearer token" },
        timeoutMs: 500,
        maxSize: MAX_WEBSOCKET_FRAME_BYTES,
      })
      expect(auths[0]).toBe("Bearer token")
      sock.close()
    } finally {
      server.stop(true)
    }
  })
})

describe("factory config", () => {
  test("invalid forward configuration yields no transport", () => {
    const bad = [
      { mode: "forward" as const, wsUrl: "not-a-url" },
      { mode: "forward" as const, wsUrl: "https://example.test/ws" },
      { mode: "forward" as const, wsUrl: "ws://" },
      { mode: "forward" as const, wsUrl: "ws://example.test/path#fragment" },
      { mode: "forward" as const, wsUrl: "ws://localhost:6700", requestTimeoutMs: 0 },
      { mode: "forward" as const, wsUrl: "ws://localhost:6700", reconnectDelayMs: -1 },
    ]
    for (const options of bad) {
      expect(new OneBotTransport(options).raw).toBeUndefined()
    }
  })
})
