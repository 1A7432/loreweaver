import { describe, expect, test } from "bun:test"
import { OneBotForwardWebSocketTransport, OneBotTransport, MAX_TEXT_CHARS, type ConnectFactory, type OneBotRawTransport, type OneBotSocket } from "./index"

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
  private readonly queue: string[] = []
  private waiter?: (result: IteratorResult<string>) => void
  private closed = false
  send(data: string): void {
    this.sent.push(data)
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

/** A raw transport whose every call succeeds; records the actions it saw. */
function stubRaw(login?: { user_id: number; nickname: string }): OneBotRawTransport & { calls: Array<{ action: string; params: Record<string, unknown> }> } {
  const calls: Array<{ action: string; params: Record<string, unknown> }> = []
  return {
    kind: "reverse",
    connected: true,
    pendingCount: 0,
    pendingEvents: 0,
    requestTimeoutMs: 1000,
    calls,
    async start() {},
    async close() {},
    async call(action: string, params: Record<string, unknown>) {
      calls.push({ action, params })
      if (action === "get_login_info") return login ?? { user_id: 42, nickname: "Keeper" }
      if (action === "get_group_member_info") return { user_id: params.user_id, group_id: params.group_id }
      return { message_id: 77 }
    },
  }
}

describe("private replies carry the group for NapCat's temp session", () => {
  test("a group→private redirect sends user_id AND group_id; a plain private target sends user_id only", async () => {
    const raw = stubRaw()
    const bot = new OneBotTransport({ transport: raw })
    expect((await bot.sendText({ type: "group", id: 99, userId: 7 }, ".lore result", { private: true, replyTo: "10" })).ok).toBe(true)
    expect(raw.calls.at(-1)).toEqual({
      action: "send_private_msg",
      params: { user_id: 7, group_id: 99, message: [{ type: "text", data: { text: ".lore result" } }] },
    })
    expect((await bot.sendText({ type: "private", id: 7 }, "hi")).ok).toBe(true)
    expect(raw.calls.at(-1)).toEqual({ action: "send_private_msg", params: { user_id: 7, message: [{ type: "text", data: { text: "hi" } }] } })
  })
})

describe("long text goes out as one merged-forward card", () => {
  test("group: send_group_forward_msg with one node per chunk, signed as the bot, image on the last node", async () => {
    const raw = stubRaw({ user_id: 10001, nickname: "守秘人" })
    const bot = new OneBotTransport({ transport: raw })
    await bot.loginInfo()
    const paragraph = "夜色沉了下来。".repeat(120) // ~840 chars
    const text = Array.from({ length: 6 }, () => paragraph).join("\n\n") // > MAX_TEXT_CHARS
    expect(text.length).toBeGreaterThan(MAX_TEXT_CHARS)
    const result = await bot.sendImage({ type: "group", id: 99 }, { url: "https://cdn.example/a.png", mime: "image/png" }, { text, replyTo: "10" })
    expect(result).toEqual({ ok: true, messageId: "77" })
    const call = raw.calls.at(-1)!
    expect(call.action).toBe("send_group_forward_msg")
    expect(call.params.group_id).toBe(99)
    const nodes = call.params.messages as Array<{ type: string; data: Record<string, unknown> }>
    expect(nodes.length).toBeGreaterThan(1)
    for (const node of nodes) {
      expect(node.type).toBe("node")
      expect(node.data.user_id).toBe(10001)
      expect(node.data.nickname).toBe("守秘人")
    }
    const joined = nodes
      .flatMap((node) => node.data.content as Array<{ type: string; data: Record<string, unknown> }>)
      .filter((seg) => seg.type === "text")
      .map((seg) => seg.data.text as string)
      .join("")
    expect(joined).toBe(text)
    const lastContent = nodes.at(-1)!.data.content as Array<{ type: string }>
    expect(lastContent.at(-1)!.type).toBe("image")
    expect(JSON.stringify(nodes)).not.toContain('"reply"')
  })

  test("private redirect: send_private_forward_msg keeps user_id + group_id", async () => {
    const raw = stubRaw()
    const bot = new OneBotTransport({ transport: raw })
    const text = "x".repeat(MAX_TEXT_CHARS + 10)
    expect((await bot.sendText({ type: "group", id: 99, userId: 7 }, text, { private: true })).ok).toBe(true)
    const call = raw.calls.at(-1)!
    expect(call.action).toBe("send_private_forward_msg")
    expect(call.params.user_id).toBe(7)
    expect(call.params.group_id).toBe(99)
    expect((call.params.messages as unknown[]).length).toBe(2)
  })

  test("text within the cap is still a plain message", async () => {
    const raw = stubRaw()
    const bot = new OneBotTransport({ transport: raw })
    await bot.sendText({ type: "group", id: 99 }, "short")
    expect(raw.calls.at(-1)!.action).toBe("send_group_msg")
  })
})

describe("heartbeat watchdog", () => {
  test("a socket that goes silent after announcing heartbeats is closed and redialed", async () => {
    const sockets: FakeSocket[] = []
    const factory: ConnectFactory = async () => {
      const sock = new FakeSocket()
      sockets.push(sock)
      return sock
    }
    const transport = new OneBotForwardWebSocketTransport({ url: "ws://127.0.0.1:9/", requestTimeoutMs: 200, reconnectDelayMs: 5, connectFactory: factory })
    await transport.start(() => {})
    await waitFor(() => sockets.length === 1)
    const first = sockets[0]!
    first.push({ post_type: "meta_event", meta_event_type: "heartbeat", interval: 20, status: { online: true, good: true } })
    // Frames keep it alive…
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 15))
      first.push(groupEvent({ message_id: 100 + i }))
    }
    expect(first.closeArgs).toBeUndefined()
    // …silence past 2.5 × interval does not.
    await waitFor(() => first.closeArgs !== undefined, 500)
    expect(first.closeArgs?.code).toBe(1001)
    await waitFor(() => sockets.length === 2, 500)
    await transport.close()
  })

  test("no heartbeat announced → no watchdog", async () => {
    const sock = new FakeSocket()
    const transport = new OneBotForwardWebSocketTransport({ url: "ws://127.0.0.1:9/", requestTimeoutMs: 200, reconnectDelayMs: 5, connectFactory: async () => sock })
    await transport.start(() => {})
    await waitFor(() => transport.connected)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(sock.closeArgs).toBeUndefined()
    await transport.close()
  })
})
