import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { FrameType, type ClientFrame, type DiceFrame, type NarrativeFrame, type ServerFrame, type UiFrame } from "loreweaver-protocol"
import { CHOICES_TTL_MS } from "./choices"
import { PostedIds } from "./postedIds"
import { ADMIN_HOLD_MS, BridgeRouter, type BridgeLink, type OutboundIntent } from "./router"

class FakeLink implements BridgeLink {
  sent: ClientFrame[] = []
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

async function makeRouter(clock?: ManualClock): Promise<{
  router: BridgeRouter
  intents: OutboundIntent[]
  posted: PostedIds
  clock: ManualClock
}> {
  const dir = await mkdtemp(join(tmpdir(), "lw-router-"))
  const posted = await PostedIds.load(join(dir, "g.posted.json"))
  const intents: OutboundIntent[] = []
  const used = clock ?? new ManualClock()
  const router = new BridgeRouter({
    groupId: "99",
    locale: "en",
    postedIds: posted,
    admins: ["42"],
    onIntent: (intent) => intents.push(intent),
    now: used.now,
    setTimeoutFn: used.setTimeoutFn as typeof setTimeout,
    clearTimeoutFn: used.clearTimeoutFn as typeof clearTimeout,
    holdMs: ADMIN_HOLD_MS,
  })
  return { router, intents, posted, clock: used }
}

const KP: NarrativeFrame = {
  type: FrameType.Narrative,
  id: "n-kp",
  speaker: "kp",
  text: "The **hinge** shrieks.",
  format: "markdown",
}
const NPC: NarrativeFrame = {
  type: FrameType.Narrative,
  id: "n-npc",
  speaker: "npc",
  name: "Nora",
  text: "Stay back.",
  format: "plain",
}
const PLAYER_NAR: NarrativeFrame = {
  type: FrameType.Narrative,
  id: "n-pl",
  speaker: "player",
  name: "Ada",
  text: "I open the door.",
  format: "plain",
}
const DICE: DiceFrame = {
  type: FrameType.Dice,
  actor: "Ada",
  kind: "roll",
  expr: "3d6+2",
  rolls: [4, 4, 1],
  total: 11,
}
const UI: UiFrame = {
  type: FrameType.Ui,
  panel: "inline",
  blocks: [
    { kind: "stat", label: "HP", value: 8 },
    {
      kind: "choices",
      prompt: "Do you?",
      options: [
        { id: "a", label: "Open", input: "I open the door" },
        { id: "b", label: "Wait", input: "I wait" },
      ],
    },
  ],
}
const MANIFEST: ServerFrame = { type: FrameType.UiManifest, panels: [] }
const STATE: ServerFrame = { type: FrameType.State, party: [], initiative: [], online: 0 }

describe("router — observer / player / admin tables", () => {
  test("observer posts kp/npc/dice/ui once; player narrative is skipped; state/ui_manifest never render", async () => {
    const { router, intents } = await makeRouter()
    const observer = new FakeLink()
    router.attachLink("observer", "obs-key", observer)
    observer.push(MANIFEST)
    observer.push(KP)
    observer.push(NPC)
    observer.push(PLAYER_NAR)
    observer.push(DICE)
    observer.push(UI)
    observer.push(STATE)
    observer.push(MANIFEST)
    observer.push({ type: FrameType.Presence, players: [], online: 0 })
    observer.push({ type: FrameType.NarrativeDelta, id: "d", speaker: "kp", text: "stream" })
    observer.push({ type: FrameType.Pong, t: 1 })

    const group = intents.filter((item) => item.dest === "group")
    expect(group.map((item) => item.text)).toEqual([
      "The hinge shrieks.",
      "Nora: Stay back.",
      "Ada 3d6+2 11",
      "HP: 8\nDo you?\n1. Open\n2. Wait",
    ])
    expect(intents.every((item) => !item.text.includes("I open the door") || item.text.startsWith("HP:"))).toBe(true)
    expect(intents.some((item) => item.text.includes("stream"))).toBe(false)
  })

  test("player link drops broadcast kinds; system is reply-to in group, private when the input was private", async () => {
    const { router, intents } = await makeRouter()
    const player = new FakeLink()
    router.attachLink("player", "p-key", player, "111")
    player.push(MANIFEST)
    player.push(KP)
    player.push(DICE)
    player.push(UI)
    router.markChannel("111", "group")
    player.push({ type: FrameType.System, level: "info", text: "STR 60" })
    router.markChannel("111", "private")
    player.push({ type: FrameType.Error, code: "rate_limited", message: "slow down" })
    expect(intents).toEqual([
      { dest: "reply", userId: "111", text: "STR 60" },
      { dest: "private", userId: "111", text: "slow down" },
    ])
  })

  test("admin system is always private; admin-only narrative goes private; observer-seen id is dropped", async () => {
    const { router, intents, clock } = await makeRouter()
    const observer = new FakeLink()
    const admin = new FakeLink()
    router.attachLink("observer", "obs-key", observer)
    router.attachLink("admin", "adm-key", admin, "42")
    observer.push(MANIFEST)
    admin.push(MANIFEST)

    admin.push({ type: FrameType.System, level: "info", text: "reset done" })
    expect(intents).toEqual([{ dest: "private", userId: "42", text: "reset done" }])
    intents.length = 0

    const seen: NarrativeFrame = { ...KP, id: "shared" }
    observer.push(seen)
    admin.push(seen)
    clock.advance(ADMIN_HOLD_MS)
    expect(intents.filter((item) => item.dest === "private")).toEqual([])
    expect(intents.some((item) => item.dest === "group" && item.text.includes("hinge"))).toBe(true)
    intents.length = 0

    const secret: NarrativeFrame = { ...KP, id: "keeper-only", text: "The mayor is the cultist." }
    admin.push(secret)
    clock.advance(ADMIN_HOLD_MS)
    expect(intents).toEqual([{ dest: "private", userId: "42", text: "The mayor is the cultist." }])
  })
})

describe("router — replay gate", () => {
  test("swallows every frame until that link's first ui_manifest, and re-arms on every attach (open and redial)", async () => {
    const { router, intents } = await makeRouter()
    const observer = new FakeLink()
    router.attachLink("observer", "obs-key", observer)
    observer.push(KP)
    observer.push(DICE)
    observer.push(STATE)
    expect(intents).toEqual([])
    observer.push(MANIFEST)
    observer.push(KP)
    expect(intents).toHaveLength(1)

    const redial = new FakeLink()
    router.attachLink("observer", "obs-key", redial)
    redial.push({ ...KP, id: "after-redial-before-manifest" })
    expect(intents).toHaveLength(1)
    redial.push(MANIFEST)
    redial.push({ ...KP, id: "live-after-redial", text: "A new beat.", format: "plain" })
    expect(intents.map((item) => item.text)).toContain("A new beat.")
  })

  test("posted ids survive restart so history is not re-posted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-router-"))
    const path = join(dir, "g.posted.json")
    const firstPosted = await PostedIds.load(path)
    const intents1: OutboundIntent[] = []
    const router1 = new BridgeRouter({
      groupId: "99",
      postedIds: firstPosted,
      onIntent: (intent) => intents1.push(intent),
    })
    const link1 = new FakeLink()
    router1.attachLink("observer", "obs", link1)
    link1.push(MANIFEST)
    link1.push(KP)
    expect(intents1).toHaveLength(1)
    await firstPosted.flush()

    const secondPosted = await PostedIds.load(path)
    const intents2: OutboundIntent[] = []
    const router2 = new BridgeRouter({
      groupId: "99",
      postedIds: secondPosted,
      onIntent: (intent) => intents2.push(intent),
    })
    const link2 = new FakeLink()
    router2.attachLink("observer", "obs", link2)
    link2.push(MANIFEST)
    link2.push(KP)
    expect(intents2).toEqual([])
  })
})

describe("router — choices, commands, queued input", () => {
  test("digits-only reply becomes that option's input on the right user's link; expired is plain text", async () => {
    const { router, clock } = await makeRouter()
    const observer = new FakeLink()
    const ada = new FakeLink()
    const bao = new FakeLink()
    router.attachLink("observer", "obs", observer)
    router.attachLink("player", "ada-key", ada, "111")
    router.attachLink("player", "bao-key", bao, "222")
    observer.push(MANIFEST)
    ada.push(MANIFEST)
    bao.push(MANIFEST)
    observer.push(UI)

    await router.handleInbound({ userId: "111", memberKey: "ada-key", text: "1", channel: "group", isAdmin: false })
    expect(ada.sent).toEqual([{ type: FrameType.Input, text: "I open the door" }])
    expect(bao.sent).toEqual([])

    await router.handleInbound({ userId: "111", memberKey: "ada-key", text: "I wait", channel: "group", mentioned: true, isAdmin: false })
    expect(ada.sent.at(-1)).toEqual({ type: FrameType.Input, text: "I wait" })

    clock.advance(CHOICES_TTL_MS)
    await router.handleInbound({ userId: "222", memberKey: "bao-key", text: "2", channel: "group", mentioned: true, isAdmin: false })
    expect(bao.sent).toEqual([{ type: FrameType.Input, text: "2" }])
  })

  test(".bridge commands are admin-only and never forwarded to the engine", async () => {
    const { router, intents } = await makeRouter()
    const admin = new FakeLink()
    const player = new FakeLink()
    router.attachLink("admin", "adm-key", admin, "42")
    router.attachLink("player", "p-key", player, "111")
    admin.push(MANIFEST)
    player.push(MANIFEST)

    await router.handleInbound({ userId: "111", memberKey: "p-key", text: ".bridge status", channel: "group", isAdmin: false })
    expect(player.sent).toEqual([])
    expect(intents.some((item) => item.text.includes("Only a room admin"))).toBe(true)

    intents.length = 0
    await router.handleInbound({ userId: "42", memberKey: "adm-key", text: ".bridge mode all", channel: "private", isAdmin: true })
    expect(admin.sent).toEqual([])
    expect(router.groupMode).toBe("all")
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({ dest: "private", userId: "42" })
    expect(intents[0]!.text).toContain("all")
  })

  test("input queued while a member link is down is flushed after onLinkReady + ui_manifest", async () => {
    const { router } = await makeRouter()
    const player = new FakeLink()
    router.attachLink("player", "p-key", player, "111")
    player.push(MANIFEST)
    router.onLinkDown("p-key")
    router.queueInput("p-key", "I search the desk")
    expect(player.sent).toEqual([])

    const redial = new FakeLink()
    router.attachLink("player", "p-key", redial, "111")
    expect(redial.sent).toEqual([])
    redial.push(MANIFEST)
    expect(redial.sent).toEqual([{ type: FrameType.Input, text: "I search the desk" }])
  })
})
