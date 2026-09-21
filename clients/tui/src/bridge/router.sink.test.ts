import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { FrameType, type ClientFrame, type ServerFrame } from "loreweaver-protocol"
import { PostedIds } from "./postedIds"
import {
  ADMIN_HOLD_MS,
  BridgeRouter,
  type BridgeLink,
  type OutboundIntent,
  type SinkEvent,
} from "./router"

class FakeLink implements BridgeLink {
  sent: ClientFrame[] = []
  isAlive = true
  private readonly handlers = new Set<(frame: ServerFrame) => void>()
  send(frame: ClientFrame): void {
    this.sent.push(frame)
  }
  sendInput(text: string): void {
    this.send({ type: FrameType.Input, text })
  }
  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.handlers.add(cb)
    return () => this.handlers.delete(cb)
  }
  push(frame: ServerFrame): void {
    for (const handler of this.handlers) handler(frame)
  }
}

class ManualClock {
  nowMs = 0
  private seq = 0
  private readonly timers = new Map<number, { at: number; fn: () => void }>()
  now = () => this.nowMs
  setTimeoutFn = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = ++this.seq
    this.timers.set(id, { at: this.nowMs + ms, fn })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  clearTimeoutFn = (id: ReturnType<typeof setTimeout>) => {
    this.timers.delete(id as unknown as number)
  }
  advance(ms: number): void {
    this.nowMs += ms
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.nowMs) {
        this.timers.delete(id)
        timer.fn()
      }
    }
  }
}

const MANIFEST: ServerFrame = { type: FrameType.UiManifest, panels: [] }
const KP: ServerFrame = {
  type: FrameType.Narrative,
  id: "n-kp",
  speaker: "kp",
  text: "The hinge shrieks.",
  format: "markdown",
}

describe("router sink", () => {
  test("classified frames go to the sink before rendering; onIntent stays silent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-sink-"))
    const posted = await PostedIds.load(join(dir, "g.posted.json"))
    const intents: OutboundIntent[] = []
    const sunk: SinkEvent[] = []
    const router = new BridgeRouter({
      groupId: "99",
      locale: "en",
      postedIds: posted,
      busyNotice: false,
      onIntent: (intent) => intents.push(intent),
      sink: (event) => sunk.push(event),
    })
    const observer = new FakeLink()
    router.attachLink("observer", "obs", observer)
    observer.push(MANIFEST)
    observer.push(KP)
    observer.push({ type: FrameType.TurnStatus, status: "busy", actor: "Nora" })
    observer.push({ type: FrameType.Dice, actor: "Ada", kind: "roll", expr: "1d4", rolls: [2], total: 2 })

    expect(intents).toEqual([])
    expect(sunk.map((item) => ({ scope: item.scope, type: item.frame.type }))).toEqual([
      { scope: "group", type: FrameType.Narrative },
      { scope: "group", type: FrameType.TurnStatus },
      { scope: "group", type: FrameType.Dice },
    ])
  })

  test("busyNotice: false emits no thinking line on the OneBot intent path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-sink-"))
    const posted = await PostedIds.load(join(dir, "g.posted.json"))
    const intents: OutboundIntent[] = []
    const router = new BridgeRouter({
      groupId: "99",
      locale: "en",
      postedIds: posted,
      busyNotice: false,
      onIntent: (intent) => intents.push(intent),
    })
    const observer = new FakeLink()
    router.attachLink("observer", "obs", observer)
    observer.push(MANIFEST)
    observer.push({ type: FrameType.TurnStatus, status: "busy", actor: "Nora" })
    expect(intents).toEqual([])
  })

  test("without a sink the OneBot render path is unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-sink-"))
    const posted = await PostedIds.load(join(dir, "g.posted.json"))
    const intents: OutboundIntent[] = []
    const router = new BridgeRouter({
      groupId: "99",
      locale: "en",
      postedIds: posted,
      onIntent: (intent) => intents.push(intent),
    })
    const observer = new FakeLink()
    router.attachLink("observer", "obs", observer)
    observer.push(MANIFEST)
    observer.push(KP)
    expect(intents).toEqual([{ dest: "group", text: "The hinge shrieks." }])
  })

  test("player system is player-scoped with that seat; admin system is admin-scoped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-sink-"))
    const posted = await PostedIds.load(join(dir, "g.posted.json"))
    const sunk: SinkEvent[] = []
    const router = new BridgeRouter({
      groupId: "99",
      locale: "en",
      postedIds: posted,
      busyNotice: false,
      admins: ["42"],
      onIntent: () => {},
      sink: (event) => sunk.push(event),
    })
    const observer = new FakeLink()
    const ada = new FakeLink()
    const bao = new FakeLink()
    const admin = new FakeLink()
    router.attachLink("observer", "obs", observer)
    router.attachLink("player", "ada", ada, "111")
    router.attachLink("player", "bao", bao, "222")
    router.attachLink("admin", "adm", admin, "42")
    observer.push(MANIFEST)
    ada.push(MANIFEST)
    bao.push(MANIFEST)
    admin.push(MANIFEST)

    ada.push({ type: FrameType.System, level: "info", text: "STR 60" })
    admin.push({ type: FrameType.System, level: "info", text: "lore dump" })

    expect(sunk.filter((item) => item.scope === "player")).toEqual([
      { scope: "player", seat: "111", frame: { type: FrameType.System, level: "info", text: "STR 60" } },
    ])
    expect(sunk.filter((item) => item.scope === "admin")).toEqual([
      { scope: "admin", seat: "42", frame: { type: FrameType.System, level: "info", text: "lore dump" } },
    ])
    expect(sunk.some((item) => item.scope === "player" && item.seat === "222")).toBe(false)
  })

  test("observer redial still swallows turn_status (not sunk, not intented)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-sink-"))
    const posted = await PostedIds.load(join(dir, "g.posted.json"))
    const sunk: SinkEvent[] = []
    const intents: OutboundIntent[] = []
    const router = new BridgeRouter({
      groupId: "99",
      locale: "en",
      postedIds: posted,
      busyNotice: true,
      onIntent: (intent) => intents.push(intent),
      sink: (event) => sunk.push(event),
    })
    const observer = new FakeLink()
    router.attachLink("observer", "obs", observer, undefined, "open")
    observer.push(MANIFEST)
    observer.push({ type: FrameType.TurnStatus, status: "busy", actor: "Nora" })
    expect(sunk.filter((item) => item.frame.type === FrameType.TurnStatus)).toHaveLength(1)

    router.onLinkDown("obs")
    const redial = new FakeLink()
    router.attachLink("observer", "obs", redial, undefined, "redial")
    redial.push({ type: FrameType.TurnStatus, status: "busy", actor: "Nora" })
    redial.push({ type: FrameType.TurnStatus, status: "idle" })
    expect(sunk.filter((item) => item.frame.type === FrameType.TurnStatus)).toHaveLength(1)
    expect(intents).toEqual([])
  })

  test("admin hold still drops observer-seen broadcasts before the sink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-sink-"))
    const posted = await PostedIds.load(join(dir, "g.posted.json"))
    const clock = new ManualClock()
    const sunk: SinkEvent[] = []
    const router = new BridgeRouter({
      groupId: "99",
      locale: "en",
      postedIds: posted,
      busyNotice: false,
      onIntent: () => {},
      sink: (event) => sunk.push(event),
      now: clock.now,
      setTimeoutFn: clock.setTimeoutFn as typeof setTimeout,
      clearTimeoutFn: clock.clearTimeoutFn as typeof clearTimeout,
      holdMs: ADMIN_HOLD_MS,
    })
    const observer = new FakeLink()
    const admin = new FakeLink()
    router.attachLink("observer", "obs", observer)
    router.attachLink("admin", "adm", admin, "42")
    observer.push(MANIFEST)
    admin.push(MANIFEST)
    observer.push(KP)
    admin.push(KP)
    clock.advance(ADMIN_HOLD_MS)
    expect(sunk.filter((item) => item.scope === "admin" && item.frame.type === FrameType.Narrative)).toEqual([])
  })

  test("setSink can be registered after construction (Deliverer.attach)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-sink-"))
    const posted = await PostedIds.load(join(dir, "g.posted.json"))
    const sunk: SinkEvent[] = []
    const intents: OutboundIntent[] = []
    const router = new BridgeRouter({
      groupId: "99",
      locale: "en",
      postedIds: posted,
      onIntent: (intent) => intents.push(intent),
    })
    router.setSink((event) => sunk.push(event))
    const observer = new FakeLink()
    router.attachLink("observer", "obs", observer)
    observer.push(MANIFEST)
    observer.push(KP)
    expect(sunk).toHaveLength(1)
    expect(intents).toEqual([])
  })
})
