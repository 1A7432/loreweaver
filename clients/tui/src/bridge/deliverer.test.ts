import { describe, expect, test } from "bun:test"
import { OneBotDeliverer } from "./deliverer"
import type { OneBotSendResult, OneBotStatus, OneBotTransport } from "./onebot"

/** Just the surface the deliverer touches; offline sends fail the way the real one does. */
class FakeTransport {
  online = true
  sent: string[] = []
  private readonly handlers = new Set<(status: OneBotStatus) => void>()
  onStatus(handler: (status: OneBotStatus) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }
  setStatus(status: OneBotStatus): void {
    this.online = status === "online"
    for (const handler of this.handlers) handler(status)
  }
  private async deliver(text: string): Promise<OneBotSendResult> {
    if (!this.online) return { ok: false, error: "onebot.websocket.disconnected" }
    this.sent.push(text)
    return { ok: true }
  }
  sendText(_target: unknown, text: string): Promise<OneBotSendResult> {
    return this.deliver(text)
  }
  sendReply(_target: unknown, _replyTo: string, text: string): Promise<OneBotSendResult> {
    return this.deliver(`reply:${text}`)
  }
  async memberStatus(): Promise<"member"> {
    return "member"
  }
}

function make(transport: FakeTransport, holdMs: number, logs: string[]) {
  return new OneBotDeliverer({
    groupId: "99",
    transport: transport as unknown as OneBotTransport,
    getObserver: () => undefined,
    getLastReplyId: () => "m1",
    getLocale: () => "en",
    holdMs,
    onLog: (text) => logs.push(text),
  })
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("OneBot outbox across a dropped connection", () => {
  test("a turn published while the implementation is away goes out, in order, once it is back", async () => {
    const transport = new FakeTransport()
    const logs: string[] = []
    const deliverer = make(transport, 5_000, logs)
    transport.setStatus("reconnecting")
    deliverer.enqueue({ dest: "group", text: "The Keeper is thinking…" })
    deliverer.enqueue({ dest: "group", text: "The gate opens." })
    deliverer.enqueue({ dest: "reply", userId: "7", text: "queued" })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(transport.sent).toEqual([])
    expect(logs.filter((line) => line.includes("held"))).toHaveLength(1)
    transport.setStatus("online")
    await until(() => transport.sent.length === 3)
    expect(transport.sent).toEqual(["The Keeper is thinking…", "The gate opens.", "reply:queued"])
  })

  test("a send that fails mid-flight on a disconnect is held and retried, not dropped", async () => {
    const transport = new FakeTransport()
    const logs: string[] = []
    const deliverer = make(transport, 5_000, logs)
    transport.online = false // the socket died before the status event arrived
    deliverer.enqueue({ dest: "group", text: "late line" })
    await until(() => logs.length === 1)
    expect(transport.sent).toEqual([])
    transport.setStatus("online")
    await until(() => transport.sent.length === 1)
    expect(transport.sent).toEqual(["late line"])
    expect(logs.length).toBe(2)
  })

  test("past the hold bound a message is dropped and the operator is told", async () => {
    const transport = new FakeTransport()
    const logs: string[] = []
    const deliverer = make(transport, 40, logs)
    transport.setStatus("offline")
    deliverer.enqueue({ dest: "group", text: "lost" })
    await deliverer.close()
    expect(transport.sent).toEqual([])
    expect(logs.some((line) => line.includes("dropped"))).toBe(true)
  })
})
