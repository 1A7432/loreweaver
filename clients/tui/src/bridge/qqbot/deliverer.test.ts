import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { FrameType, type ClientFrame, type ServerFrame } from "loreweaver-protocol"
import { tt } from "../../i18n"
import { PostedIds } from "../postedIds"
import { BridgeRouter, type BridgeLink, type OutboundIntent } from "../router"
import { WINDOW_MS } from "./coalescer"
import { QQBotDeliverer } from "./deliverer"
import type { QQBotSendPort, QQBotSendRequest, QQBotSendResult, QQBotSwitchEvent } from "./port"
import { URL_PLACEHOLDER } from "./render"

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

class FakePort implements QQBotSendPort {
  sends: Array<{ channel: "group" | "c2c"; target: string; req: QQBotSendRequest }> = []
  uploads: Array<{ channel: "group" | "c2c"; hash?: string }> = []
  results: QQBotSendResult[] = []
  defaultResult: QQBotSendResult = { ok: true }
  private readonly handlers = new Set<(event: QQBotSwitchEvent) => void>()

  sendGroup = async (target: string, req: QQBotSendRequest): Promise<QQBotSendResult> => {
    this.sends.push({ channel: "group", target, req })
    return this.results.shift() ?? this.defaultResult
  }
  sendC2C = async (target: string, req: QQBotSendRequest): Promise<QQBotSendResult> => {
    this.sends.push({ channel: "c2c", target, req })
    return this.results.shift() ?? this.defaultResult
  }
  uploadGroupMedia = async (): Promise<{ file_info: string }> => {
    this.uploads.push({ channel: "group" })
    return { file_info: "fi-group" }
  }
  uploadC2CMedia = async (): Promise<{ file_info: string }> => {
    this.uploads.push({ channel: "c2c" })
    return { file_info: "fi-c2c" }
  }
  onEvent = (handler: (event: QQBotSwitchEvent) => void): (() => void) => {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }
  emit(event: QQBotSwitchEvent): void {
    for (const handler of this.handlers) handler(event)
  }
}

const MANIFEST: ServerFrame = { type: FrameType.UiManifest, panels: [] }
const KP = (id: string, text: string): ServerFrame => ({
  type: FrameType.Narrative,
  id,
  speaker: "kp",
  text,
  format: "markdown",
})
const NPC: ServerFrame = {
  type: FrameType.Narrative,
  id: "n-npc",
  speaker: "npc",
  name: "Nora",
  text: "Stay back.",
  format: "plain",
}

async function setup(opts: { locale?: string; busyNotice?: boolean; media?: Record<string, Uint8Array>; backoffMs?: number[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "lw-qq-"))
  const posted = await PostedIds.load(join(dir, "g.posted.json"))
  const clock = new ManualClock()
  const port = new FakePort()
  const intents: OutboundIntent[] = []
  const logs: string[] = []
  const router = new BridgeRouter({
    groupId: "G1",
    locale: opts.locale ?? "zh",
    postedIds: posted,
    busyNotice: false,
    admins: ["42"],
    onIntent: (intent) => intents.push(intent),
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn as typeof setTimeout,
    clearTimeoutFn: clock.clearTimeoutFn as typeof clearTimeout,
  })
  const media = opts.media ?? {}
  const deliverer = await QQBotDeliverer.load({
    groupOpenid: "G1",
    port,
    stateDir: dir,
    locale: opts.locale ?? "zh",
    busyNotice: opts.busyNotice ?? true,
    backoffMs: opts.backoffMs,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn as typeof setTimeout,
    clearTimeoutFn: clock.clearTimeoutFn as typeof clearTimeout,
    onLog: (line) => logs.push(line),
    getMedia: async (hash) => {
      const bytes = media[hash]
      return bytes ? { bytes, mime: "image/png" } : undefined
    },
  })
  deliverer.attach(router)
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
  return { dir, clock, port, router, deliverer, observer, ada, bao, admin, intents, logs, posted }
}

function groupTexts(port: FakePort): string[] {
  return port.sends.filter((row) => row.channel === "group").map((row) => row.req.markdown?.content ?? row.req.content ?? "")
}

function c2cTexts(port: FakePort): string[] {
  return port.sends.filter((row) => row.channel === "c2c").map((row) => row.req.markdown?.content ?? row.req.content ?? "")
}

describe("qqbot deliverer — scope sentinel", () => {
  test("admin system after a group input never rides a group anchor or group active send", async () => {
    const { port, admin, deliverer, clock } = await setup()
    await deliverer.openAnchor({ id: "m-admin", scope: "group", target: "G1", seat: "42", receivedAt: 0 })
    admin.push({ type: FrameType.System, level: "info", text: "the mayor is the cultist" })
    await deliverer.whenIdle()
    expect(groupTexts(port).some((text) => text.includes("cultist"))).toBe(false)
    expect(c2cTexts(port).some((text) => text.includes("cultist"))).toBe(false)
    expect(deliverer.deferred.privateCount("42")).toBe(1)
    clock.advance(WINDOW_MS)
    await deliverer.whenIdle()
    expect(groupTexts(port).some((text) => text.includes("cultist"))).toBe(false)
  })

  test("a player-scope frame never reaches another player's anchor", async () => {
    const { port, ada, bao, deliverer } = await setup()
    await deliverer.openAnchor({ id: "m-ada", scope: "group", target: "G1", seat: "111", receivedAt: 0 })
    await deliverer.openAnchor({ id: "m-bao", scope: "group", target: "G1", seat: "222", receivedAt: 1 })
    ada.push({ type: FrameType.System, level: "info", text: "STR 60" })
    await deliverer.whenIdle()
    const adaSends = port.sends.filter((row) => row.req.msg_id === "m-ada")
    const baoSends = port.sends.filter((row) => row.req.msg_id === "m-bao")
    expect(adaSends.some((row) => (row.req.markdown?.content ?? row.req.content ?? "").includes("STR 60"))).toBe(true)
    expect(baoSends.some((row) => (row.req.markdown?.content ?? row.req.content ?? "").includes("STR 60"))).toBe(false)
  })
})

describe("qqbot deliverer — two modes, anchors, attribution", () => {
  test("OFF mode: thinking + 5s window as one markdown passive reply; seq increments", async () => {
    const { port, observer, deliverer, clock } = await setup()
    deliverer.setGroupActive(false)
    await deliverer.openAnchor({ id: "m1", scope: "group", target: "G1", seat: "111", receivedAt: 0 })
    expect(groupTexts(port)).toEqual([tt("zh", "bridge.qqbot.thinking")])
    expect(port.sends[0]?.req.msg_id).toBe("m1")
    expect(port.sends[0]?.req.msg_seq).toBe(1)
    observer.push(KP("n1", "The **hinge** shrieks."))
    observer.push(NPC)
    clock.advance(WINDOW_MS)
    await deliverer.whenIdle()
    const body = groupTexts(port)[1] ?? ""
    expect(body).toContain("**hinge**")
    expect(body).toContain("**Nora**：Stay back.")
    expect(port.sends[1]?.req.msg_type).toBe(2)
    expect(port.sends[1]?.req.msg_seq).toBe(2)
  })

  test("ON mode uses passive while budget remains, then active through buckets", async () => {
    const { port, observer, deliverer, clock } = await setup()
    deliverer.setGroupActive(true)
    await deliverer.openAnchor({ id: "m1", scope: "group", target: "G1", seat: "111", receivedAt: 0 })
    expect(port.sends[0]?.req.msg_id).toBe("m1")
    for (let i = 0; i < 4; i++) {
      observer.push(KP(`n${i}`, `beat ${i}`))
      clock.advance(WINDOW_MS)
      await deliverer.whenIdle()
    }
    observer.push(KP("n-active", "after budget"))
    clock.advance(WINDOW_MS)
    await deliverer.whenIdle()
    const last = port.sends.at(-1)
    expect(last?.req.msg_id).toBeUndefined()
    expect(last?.req.markdown?.content).toContain("after budget")
    expect(deliverer.anchors.groupActive).toBe(true)
  })

  test("GROUP_MSG_RECEIVE / REJECT and 40034105 settle the active flag; activeOff once a day", async () => {
    const { port, observer, deliverer, clock } = await setup()
    port.emit({ type: "groupMsgReceive", groupOpenid: "G1" })
    expect(deliverer.anchors.groupActive).toBe(true)
    port.emit({ type: "groupMsgReject", groupOpenid: "G1" })
    expect(deliverer.anchors.groupActive).toBe(false)

    deliverer.setGroupActive(null)
    port.results.push({ ok: false, code: 40034105 })
    observer.push(KP("n1", "hello"))
    clock.advance(WINDOW_MS)
    await deliverer.whenIdle()
    expect(deliverer.anchors.groupActive).toBe(false)
    expect(deliverer.deferred.items.some((item) => item.text.includes("主动"))).toBe(true)
    await deliverer.openAnchor({ id: "m2", scope: "group", target: "G1", receivedAt: clock.nowMs })
    expect(groupTexts(port).some((text) => text.includes("主动") || text.includes(tt("zh", "bridge.qqbot.activeOff")))).toBe(true)
  })

  test("a frame with no QQ anchor (Studio turn) is deferred", async () => {
    const { observer, deliverer, clock, port } = await setup()
    deliverer.setGroupActive(false)
    observer.push(KP("n1", "studio beat"))
    clock.advance(WINDOW_MS)
    await deliverer.whenIdle()
    expect(port.sends.filter((row) => (row.req.markdown?.content ?? "").includes("studio"))).toEqual([])
    expect(deliverer.deferred.items.some((item) => item.text.includes("studio beat"))).toBe(true)
  })

  test("observer redial swallowing turn_status does not re-send thinking", async () => {
    const { port, observer, router, deliverer } = await setup()
    await deliverer.openAnchor({ id: "m1", scope: "group", target: "G1", receivedAt: 0 })
    observer.push({ type: FrameType.TurnStatus, status: "busy", actor: "Nora" })
    await deliverer.whenIdle()
    const thinking = groupTexts(port).filter((text) => text === tt("zh", "bridge.qqbot.thinking"))
    expect(thinking).toHaveLength(1)
    router.onLinkDown("obs")
    const redial = new FakeLink()
    router.attachLink("observer", "obs", redial, undefined, "redial")
    redial.push({ type: FrameType.TurnStatus, status: "busy", actor: "Nora" })
    await deliverer.whenIdle()
    expect(groupTexts(port).filter((text) => text === tt("zh", "bridge.qqbot.thinking"))).toHaveLength(1)
  })
})

describe("qqbot deliverer — coalescing, zero-output, images, two players", () => {
  test("queued-input notice is not forwarded", async () => {
    const { ada, deliverer, port } = await setup()
    await deliverer.openAnchor({ id: "m1", scope: "group", target: "G1", seat: "111", receivedAt: 0 })
    ada.push({
      type: FrameType.System,
      level: "info",
      text: "⏳ 桌上正有一个回合在进行。你的输入已入队，轮到时会自动执行。",
    })
    await deliverer.whenIdle()
    expect(groupTexts(port).some((text) => text.includes("入队"))).toBe(false)
  })

  test("zero-output turn sends nothingToShow only if thinking was sent", async () => {
    const withBusy = await setup({ busyNotice: true })
    await withBusy.deliverer.openAnchor({ id: "m1", scope: "group", target: "G1", receivedAt: 0 })
    withBusy.observer.push({ type: FrameType.TurnStatus, status: "idle" })
    await withBusy.deliverer.whenIdle()
    expect(groupTexts(withBusy.port).some((text) => text === tt("zh", "bridge.qqbot.nothingToShow"))).toBe(true)

    const silent = await setup({ busyNotice: false })
    await silent.deliverer.openAnchor({ id: "m2", scope: "group", target: "G1", receivedAt: 0 })
    silent.observer.push({ type: FrameType.TurnStatus, status: "idle" })
    await silent.deliverer.whenIdle()
    expect(groupTexts(silent.port)).toEqual([])
  })

  test("image-only turn uploads and sends msg_type 7 with caption, no extra text slot", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const { observer, deliverer, port, clock } = await setup({ media: { "hash-img": bytes } })
    await deliverer.openAnchor({ id: "m1", scope: "group", target: "G1", receivedAt: 0 })
    observer.push({
      type: FrameType.Media,
      id: "m-img",
      hash: "hash-img",
      mime: "image/png",
      size: 3,
      name: "handout.png",
      from: "kp",
      ts: 1,
    })
    clock.advance(WINDOW_MS)
    await deliverer.whenIdle()
    const mediaSend = port.sends.find((row) => row.req.msg_type === 7)
    expect(mediaSend?.req.media?.file_info).toBe("fi-group")
    expect(mediaSend?.req.content).toBe("handout.png")
    expect(port.uploads).toHaveLength(1)
  })

  test("two players in one minute: newest group anchor takes group frames; thinking once", async () => {
    const { observer, deliverer, port, clock } = await setup()
    await deliverer.openAnchor({ id: "m-ada", scope: "group", target: "G1", seat: "111", receivedAt: 0 })
    await deliverer.openAnchor({ id: "m-bao", scope: "group", target: "G1", seat: "222", receivedAt: 1 })
    expect(groupTexts(port).filter((text) => text === tt("zh", "bridge.qqbot.thinking"))).toHaveLength(1)
    observer.push(KP("n1", "shared beat"))
    clock.advance(WINDOW_MS)
    await deliverer.whenIdle()
    const body = port.sends.find((row) => (row.req.markdown?.content ?? "").includes("shared beat"))
    expect(body?.req.msg_id).toBe("m-bao")
  })
})

describe("qqbot deliverer — failure table", () => {
  async function sendOnce(result: QQBotSendResult, text = "hello https://evil.example/x") {
    const ctx = await setup()
    ctx.deliverer.setGroupActive(false)
    await ctx.deliverer.openAnchor({ id: "m1", scope: "group", target: "G1", receivedAt: 0 })
    ctx.port.results.push(result)
    ctx.observer.push(KP("n1", text))
    ctx.clock.advance(WINDOW_MS)
    await ctx.deliverer.whenIdle()
    return ctx
  }

  test("retry bumps seq (40054005)", async () => {
    const { port } = await sendOnce({ ok: false, code: 40054005 })
    const seqs = port.sends.filter((row) => row.req.msg_id === "m1").map((row) => row.req.msg_seq)
    expect(seqs.length).toBeGreaterThanOrEqual(3) // thinking + failed + retry
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  test("markdown refused → plain text with a new seq", async () => {
    const { port } = await sendOnce({ ok: false, code: "markdown_refused" })
    const after = port.sends.filter((row) => row.req.msg_id === "m1")
    expect(after.some((row) => row.req.msg_type === 0)).toBe(true)
  })

  test("40054010 strips URLs to [链接] and retries", async () => {
    const { port } = await sendOnce({ ok: false, code: 40054010 })
    const retried = port.sends.filter((row) => row.req.msg_type === 2).at(-1)
    expect(retried?.req.markdown?.content ?? retried?.req.content ?? "").toContain(URL_PLACEHOLDER)
    expect(retried?.req.markdown?.content ?? "").not.toContain("https://evil.example")
  })

  test("length error re-cuts at half and retries once", async () => {
    const { port } = await sendOnce({ ok: false, code: 40054007 }, `${"a".repeat(2000)}\n\n${"b".repeat(2000)}`)
    const last = port.sends.at(-1)
    const content = last?.req.markdown?.content ?? last?.req.content ?? ""
    expect(content.length).toBeLessThan(4000)
  })

  test("audit_id spends the slot, marks pending, and is not resent", async () => {
    const ctx = await setup()
    await ctx.deliverer.openAnchor({ id: "m1", scope: "group", target: "G1", receivedAt: 0 })
    ctx.port.results.push({ ok: true, auditId: "aud-1" })
    ctx.observer.push(KP("n1", "horror paragraph"))
    ctx.clock.advance(WINDOW_MS)
    await ctx.deliverer.whenIdle()
    expect(ctx.deliverer.pendingReview.some((row) => row.auditId === "aud-1")).toBe(true)
    const bodies = groupTexts(ctx.port).filter((text) => text.includes("horror"))
    expect(bodies).toHaveLength(1)
    expect(ctx.deliverer.anchors.get("m1")!.budget).toBeLessThan(5)
  })

  test("40034006 drops the item and sends one auditRejected line (D9)", async () => {
    const { port } = await sendOnce({ ok: false, code: 40034006 })
    expect(groupTexts(port).some((text) => text === tt("zh", "bridge.qqbot.auditRejected"))).toBe(true)
    const helloAttempts = port.sends.filter((row) => (row.req.markdown?.content ?? row.req.content ?? "").includes("hello"))
    expect(helloAttempts).toHaveLength(1)
  })

  test("window/count 40034128 marks the anchor dead and defers the rest", async () => {
    const { deliverer } = await sendOnce({ ok: false, code: 40034128 })
    expect(deliverer.anchors.get("m1")?.dead).toBe(true)
    expect(deliverer.deferred.length).toBeGreaterThan(0)
  })

  test("timeout is possibly delivered: seq bumped, no resend of the same window", async () => {
    const { port, logs } = await sendOnce({ ok: false, code: "timeout" })
    expect(logs.some((line) => line.includes("timeout"))).toBe(true)
    const bodies = port.sends.filter((row) => (row.req.markdown?.content ?? "").includes("hello"))
    expect(bodies).toHaveLength(1)
  })

  test("429 backs off then retries the same content (seq bumped)", async () => {
    const ctx = await setup({ backoffMs: [0, 0, 0] })
    await ctx.deliverer.openAnchor({ id: "m1", scope: "group", target: "G1", receivedAt: 0 })
    ctx.port.results.push({ ok: false, code: 429 })
    ctx.observer.push(KP("n1", "retry me"))
    ctx.clock.advance(WINDOW_MS)
    await ctx.deliverer.whenIdle()
    const bodies = ctx.port.sends.filter((row) => (row.req.markdown?.content ?? "").includes("retry me"))
    expect(bodies.length).toBeGreaterThanOrEqual(2)
    const seqs = bodies.map((row) => row.req.msg_seq)
    expect(seqs[1]).toBeGreaterThan(seqs[0] ?? 0)
  })

  test("40054002 stops the target and keeps the deferred queue", async () => {
    const { deliverer } = await sendOnce({ ok: false, code: 40054002 })
    expect(deliverer.deferred.length).toBeGreaterThan(0)
  })

  test("40034102 clears the flag, logs unpermitted, and never retries active", async () => {
    const { deliverer, logs } = await sendOnce({ ok: false, code: 40034102 })
    expect(deliverer.anchors.activeUnpermitted).toBe(true)
    expect(deliverer.anchors.groupActive).toBe(false)
    expect(deliverer.deferred.length).toBeGreaterThan(0)
    expect(logs.some((line) => line.includes("qqbot.active.unpermitted"))).toBe(true)
  })
})

describe("qqbot deliverer — deferred, private, restart, close", () => {
  test("a group anchor flushes at most 2 late items before its own plan (D2)", async () => {
    const { deliverer, port, observer, clock } = await setup()
    deliverer.setGroupActive(false)
    for (const [id, text] of [["a", "late-a"], ["b", "late-b"], ["c", "late-c"]] as const) {
      observer.push(KP(id, text))
      clock.advance(WINDOW_MS)
      await deliverer.whenIdle()
    }
    expect(deliverer.deferred.length).toBe(3)
    port.sends.length = 0
    await deliverer.openAnchor({ id: "m-next", scope: "group", target: "G1", receivedAt: clock.nowMs })
    const late = groupTexts(port).filter((text) => text.includes(tt("zh", "bridge.qqbot.lateDelivery")))
    expect(late.length).toBe(2)
    expect(deliverer.deferred.length).toBe(1)
  })

  test("choices open at delivery; a stale deferred choices block carries choiceExpired", async () => {
    const { observer, deliverer, clock, router, port } = await setup()
    deliverer.setGroupActive(false)
    const choicesFrame: ServerFrame = {
      type: FrameType.Ui,
      panel: "inline",
      blocks: [
        {
          kind: "choices",
          prompt: "Do you?",
          options: [
            { id: "a", label: "Open", input: "I open" },
            { id: "b", label: "Wait", input: "I wait" },
          ],
        },
      ],
    }
    observer.push(choicesFrame)
    clock.advance(WINDOW_MS)
    await deliverer.whenIdle()
    expect(router.choices.isOpen).toBe(false)
    expect(deliverer.deferred.length).toBe(1)

    await deliverer.openAnchor({ id: "m1", scope: "group", target: "G1", receivedAt: clock.nowMs })
    expect(router.choices.isOpen).toBe(true)

    observer.push(KP("later", "The door slams."))
    clock.advance(WINDOW_MS)
    await deliverer.whenIdle()
    expect(router.choices.isOpen).toBe(false)

    deliverer.deferred.pushGroup({
      id: "stale-choices",
      scope: "group",
      target: "G1",
      text: "Again?\n1. Run",
      media: [],
      createdAt: clock.nowMs,
      late: true,
      queuedGeneration: 0,
      choices: { kind: "choices", prompt: "Again?", options: [{ id: "c", label: "Run", input: "I run" }] },
    })
    port.sends.length = 0
    await deliverer.openAnchor({ id: "m2", scope: "group", target: "G1", receivedAt: clock.nowMs })
    expect(groupTexts(port).some((text) => text.includes(tt("zh", "bridge.qqbot.choiceExpired")))).toBe(true)
  })

  test("private outbox flushes inside a C2C anchor as at most budget-1; privateHeld once per 10 minutes", async () => {
    const { admin, deliverer, port, clock } = await setup()
    await deliverer.openAnchor({ id: "m-g", scope: "group", target: "G1", seat: "111", receivedAt: 0 })
    admin.push({ type: FrameType.System, level: "info", text: "secret-1" })
    admin.push({ type: FrameType.System, level: "info", text: "secret-2" })
    admin.push({ type: FrameType.System, level: "info", text: "secret-3" })
    admin.push({ type: FrameType.System, level: "info", text: "secret-4" })
    await deliverer.whenIdle()
    expect(groupTexts(port).some((text) => text === tt("zh", "bridge.qqbot.privateHeld"))).toBe(true)
    const heldAt = groupTexts(port).filter((text) => text === tt("zh", "bridge.qqbot.privateHeld"))
    expect(heldAt).toHaveLength(1)
    clock.advance(9 * 60 * 1000)
    admin.push({ type: FrameType.System, level: "info", text: "secret-5" })
    await deliverer.whenIdle()
    expect(groupTexts(port).filter((text) => text === tt("zh", "bridge.qqbot.privateHeld"))).toHaveLength(1)

    port.sends.length = 0
    await deliverer.openAnchor({ id: "c2c-1", scope: "c2c", target: "42", seat: "42", receivedAt: clock.nowMs })
    const flushed = c2cTexts(port).filter((text) => text.startsWith("secret-"))
    expect(flushed.length).toBeLessThanOrEqual(3) // budget 4, keep 1
    expect(deliverer.deferred.privateCount("42")).toBeGreaterThan(0)
  })

  test("C2C active flag pushes private replies as active C2C", async () => {
    const { admin, deliverer, port } = await setup()
    deliverer.setC2CActive("42", true)
    await deliverer.whenIdle()
    admin.push({ type: FrameType.System, level: "info", text: "pushed secret" })
    await deliverer.whenIdle()
    expect(c2cTexts(port).some((text) => text.includes("pushed secret"))).toBe(true)
    expect(port.sends.find((row) => row.channel === "c2c" && (row.req.content ?? row.req.markdown?.content ?? "").includes("pushed secret"))?.req.msg_id).toBeUndefined()
  })

  test("bridge restart mid-turn restores anchors with seq intact; buffered frames are lost", async () => {
    const { dir, port, observer, deliverer, clock } = await setup()
    await deliverer.openAnchor({ id: "m1", scope: "group", target: "G1", seat: "111", receivedAt: 0 })
    observer.push(KP("n1", "in flight"))
    await deliverer.close()
    const port2 = new FakePort()
    const clock2 = new ManualClock()
    clock2.nowMs = clock.nowMs
    const posted = await PostedIds.load(join(dir, "g.posted.json"))
    const router = new BridgeRouter({
      groupId: "G1",
      locale: "zh",
      postedIds: posted,
      busyNotice: false,
      onIntent: () => {},
      now: clock2.now,
      setTimeoutFn: clock2.setTimeoutFn as typeof setTimeout,
      clearTimeoutFn: clock2.clearTimeoutFn as typeof clearTimeout,
    })
    const second = await QQBotDeliverer.load({
      groupOpenid: "G1",
      port: port2,
      stateDir: dir,
      locale: "zh",
      busyNotice: true,
      now: clock2.now,
      setTimeoutFn: clock2.setTimeoutFn as typeof setTimeout,
      clearTimeoutFn: clock2.clearTimeoutFn as typeof clearTimeout,
    })
    second.attach(router)
    expect(second.anchors.get("m1")?.seq).toBe(port.sends.filter((row) => row.req.msg_id === "m1").length)
    const observer2 = new FakeLink()
    router.attachLink("observer", "obs", observer2)
    observer2.push(MANIFEST)
    observer2.push(KP("n2", "after restart"))
    clock2.advance(WINDOW_MS)
    await second.whenIdle()
    expect(port2.sends.some((row) => (row.req.markdown?.content ?? "").includes("after restart"))).toBe(true)
    expect(port2.sends.some((row) => (row.req.markdown?.content ?? "").includes("in flight"))).toBe(false)
    await second.close()
  })

  test("close never hangs on an open window or a pending backoff", async () => {
    const { observer, deliverer, clock, port } = await setup()
    await deliverer.openAnchor({ id: "m1", scope: "group", target: "G1", receivedAt: 0 })
    observer.push(KP("n1", "buffered"))
    port.results.push({ ok: false, code: 429 })
    clock.advance(WINDOW_MS)
    const closed = deliverer.close()
    clock.advance(1)
    await closed
    clock.advance(WINDOW_MS + 4000)
    const after = port.sends.length
    clock.advance(60_000)
    expect(port.sends.length).toBe(after)
  })

  test("dailyCap line once at 100%", async () => {
    const ctx = await setup()
    ctx.deliverer.setGroupActive(true)
    ctx.deliverer.quota.groupDay.used = 999
    ctx.deliverer.quota.groupDay.day = "1970-01-01"
    await ctx.deliverer.openAnchor({ id: "m1", scope: "group", target: "G1", receivedAt: 0 })
    for (let i = 0; i < 4; i++) {
      ctx.observer.push(KP(`n${i}`, `beat ${i}`))
      ctx.clock.advance(WINDOW_MS)
      await ctx.deliverer.whenIdle()
    }
    ctx.observer.push(KP("n-cap", "the 1000th"))
    ctx.clock.advance(WINDOW_MS)
    await ctx.deliverer.whenIdle()
    const told =
      groupTexts(ctx.port).some((text) => text === tt("zh", "bridge.qqbot.dailyCap") || text.includes("额度")) ||
      ctx.deliverer.deferred.items.some((item) => item.text.includes("额度") || item.text === tt("zh", "bridge.qqbot.dailyCap")) ||
      ctx.logs.some((line) => line.includes("qqbot.daily"))
    expect(told).toBe(true)
    expect(ctx.deliverer.quota.groupDay.told100).toBe(true)
  })
})
