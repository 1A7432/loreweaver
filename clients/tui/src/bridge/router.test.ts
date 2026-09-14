import { mkdtemp, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  FrameType,
  type ClientFrame,
  type DiceFrame,
  type MediaFrame,
  type NarrativeFrame,
  type ServerFrame,
  type UiFrame,
} from "loreweaver-protocol"
import { CHOICES_TTL_MS } from "./choices"
import { Keyring } from "./keyring"
import { PostedIds } from "./postedIds"
import { ADMIN_HOLD_MS, BridgeRouter, STATE_UNGATE_MS, type BridgeLink, type OutboundIntent } from "./router"
import { loadGroupSettings, settingsPath } from "./settings"

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

class FakeControl {
  sent: ClientFrame[] = []
  private readonly handlers = new Set<(frame: ServerFrame) => void>()
  send(frame: ClientFrame): void {
    this.sent.push(frame)
  }
  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.handlers.add(cb)
    return () => this.handlers.delete(cb)
  }
  push(frame: ServerFrame): void {
    for (const handler of this.handlers) handler(frame)
  }
}

async function makeRouter(clock?: ManualClock, extra: Partial<ConstructorParameters<typeof BridgeRouter>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "lw-router-"))
  const posted = await PostedIds.load(join(dir, "g.posted.json"))
  const intents: OutboundIntent[] = []
  const used = clock ?? new ManualClock()
  const router = new BridgeRouter({
    groupId: "99",
    locale: extra.locale === undefined && !("locale" in extra) ? "en" : extra.locale,
    postedIds: posted,
    admins: ["42"],
    onIntent: (intent) => intents.push(intent),
    now: used.now,
    setTimeoutFn: used.setTimeoutFn as typeof setTimeout,
    clearTimeoutFn: used.clearTimeoutFn as typeof clearTimeout,
    holdMs: ADMIN_HOLD_MS,
    ...extra,
    postedIds: extra.postedIds ?? posted,
  })
  return { router, intents, posted, clock: used, dir }
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
const MEDIA: MediaFrame = {
  type: FrameType.Media,
  id: "m1",
  hash: "hash-img",
  mime: "image/png",
  size: 12,
  name: "handout.png",
  from: "kp",
  ts: 1,
}

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
    observer.push({ type: FrameType.System, level: "info", text: "secret sheet" })
    observer.push({ type: FrameType.Error, code: "rate_limited", message: "slow" })

    const group = intents.filter((item) => item.dest === "group")
    expect(group.map((item) => item.text)).toEqual([
      "The hinge shrieks.",
      "Nora: Stay back.",
      "Ada 3d6+2 11",
      "HP: 8\nDo you?\n1. Open\n2. Wait",
    ])
    expect(intents.some((item) => item.text.includes("secret sheet"))).toBe(false)
    expect(intents.some((item) => item.text.includes("stream"))).toBe(false)
  })

  test("two identical consecutive dice frames both post", async () => {
    const { router, intents } = await makeRouter()
    const observer = new FakeLink()
    router.attachLink("observer", "obs-key", observer)
    observer.push(MANIFEST)
    observer.push(DICE)
    observer.push(DICE)
    expect(intents.filter((item) => item.dest === "group")).toHaveLength(2)
  })

  test("empty-text narrative is dropped; media posts once; busy notice once per turn", async () => {
    const { router, intents } = await makeRouter()
    const observer = new FakeLink()
    router.attachLink("observer", "obs-key", observer)
    observer.push(MANIFEST)
    observer.push({ ...KP, id: "empty", text: "" })
    observer.push(MEDIA)
    observer.push({ type: FrameType.TurnStatus, status: "busy", actor: "Nora" })
    observer.push({ type: FrameType.TurnStatus, status: "busy", actor: "Nora", activity: "dice", round: 2 })
    observer.push({ type: FrameType.TurnStatus, status: "idle" })
    observer.push({ type: FrameType.TurnStatus, status: "busy", actor: "Nora" })
    expect(intents.some((item) => item.text === "")).toBe(false)
    expect(intents.filter((item) => item.media?.hash === "hash-img")).toHaveLength(1)
    expect(intents.filter((item) => item.text.includes("thinking"))).toHaveLength(2)
  })

  test("a private .st show is answered privately even if the user then typed in the group", async () => {
    const { router, intents } = await makeRouter()
    const player = new FakeLink()
    router.attachLink("player", "p-key", player, "111")
    player.push(MANIFEST)
    await router.handleInbound({
      userId: "111",
      memberKey: "p-key",
      text: ".st show",
      channel: "private",
      isAdmin: false,
    })
    await router.handleInbound({
      userId: "111",
      memberKey: "p-key",
      text: ".r 1d4",
      channel: "group",
      isAdmin: false,
    })
    player.push({ type: FrameType.System, level: "info", text: "STR 60" })
    player.push({ type: FrameType.System, level: "info", text: "queued" })
    expect(intents).toEqual([
      { dest: "private", userId: "111", text: "STR 60" },
      { dest: "reply", userId: "111", text: "queued" },
    ])
  })

  test("a settings write failure is logged and does not reject", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-router-"))
    const blocked = join(dir, "blocked")
    await writeFile(blocked, "not-a-dir")
    const logs: string[] = []
    const { router } = await makeRouter(undefined, {
      settingsPath: join(blocked, "g.settings.json"),
      onLog: (text) => logs.push(text),
    })
    const admin = new FakeLink()
    router.attachLink("admin", "adm-key", admin, "42")
    admin.push(MANIFEST)
    await router.handleInbound({
      userId: "42",
      memberKey: "adm-key",
      text: ".bridge mode all",
      channel: "private",
      isAdmin: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(logs.some((line) => line.startsWith("bridge.settings_save_failed"))).toBe(true)
    expect(router.groupMode).toBe("all")
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

  test("group dice/ui/media are not re-sent privately; admin-only ui with a reused region id is", async () => {
    const { router, intents, clock } = await makeRouter()
    const observer = new FakeLink()
    const admin = new FakeLink()
    router.attachLink("observer", "obs-key", observer)
    router.attachLink("admin", "adm-key", admin, "42")
    observer.push(MANIFEST)
    admin.push(MANIFEST)

    observer.push(DICE)
    admin.push(DICE)
    observer.push(UI)
    admin.push(UI)
    observer.push(MEDIA)
    admin.push(MEDIA)
    clock.advance(ADMIN_HOLD_MS)
    expect(intents.filter((item) => item.dest === "private")).toEqual([])

    const publicUi: UiFrame = { type: FrameType.Ui, id: "hud", panel: "sidebar", blocks: [{ kind: "stat", label: "HP", value: 8 }] }
    const secretUi: UiFrame = { type: FrameType.Ui, id: "hud", panel: "sidebar", blocks: [{ kind: "stat", label: "SAN", value: 12 }] }
    observer.push(publicUi)
    admin.push(secretUi)
    clock.advance(ADMIN_HOLD_MS)
    expect(intents.some((item) => item.dest === "private" && item.text.includes("SAN: 12"))).toBe(true)
  })

  test("a keeper-keyed link mislabeled player still gets system frames privately", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-router-"))
    const control = new FakeControl()
    const keyring = await Keyring.load({
      path: join(dir, "g.keyring.json"),
      groupId: "99",
      control,
      admins: () => ["111"],
    })
    const pending = keyring.ensure("111")
    await Promise.resolve()
    control.push({
      type: FrameType.AdminKeys,
      keys: [{ id: "k1", key_masked: "xxxx", room: "r", name: "qq:111", role: "keeper", purpose: "join", expires_at: null }],
      minted: { key: "keeper-link", room: "r", name: "qq:111", role: "keeper", purpose: "join", expires_at: null },
    })
    await pending

    const { router, intents } = await makeRouter(undefined, { keyring })
    const link = new FakeLink()
    router.attachLink("player", "keeper-link", link, "111")
    link.push(MANIFEST)
    link.push({ type: FrameType.System, level: "info", text: "lore dump" })
    expect(intents).toEqual([{ dest: "private", userId: "111", text: "lore dump" }])
    keyring.close()
  })
})

describe("router — replay gate", () => {
  test("swallows every frame until that link's first ui_manifest on open", async () => {
    const { router, intents } = await makeRouter()
    const observer = new FakeLink()
    router.attachLink("observer", "obs-key", observer, undefined, "open")
    observer.push(KP)
    observer.push(DICE)
    observer.push(STATE)
    expect(intents).toEqual([])
    observer.push(MANIFEST)
    observer.push(KP)
    expect(intents).toHaveLength(1)
  })

  test("observer redial: missed narrative passes the gate and is deduped; dice stays gated", async () => {
    const { router, intents } = await makeRouter()
    const observer = new FakeLink()
    router.attachLink("observer", "obs-key", observer, undefined, "open")
    observer.push(MANIFEST)
    observer.push({ ...KP, id: "n1", text: "First beat.", format: "plain" })
    expect(intents.map((item) => item.text)).toEqual(["First beat."])

    router.onLinkDown("obs-key")
    const redial = new FakeLink()
    router.attachLink("observer", "obs-key", redial, undefined, "redial")
    redial.push({ ...KP, id: "n1", text: "First beat.", format: "plain" })
    redial.push({ ...KP, id: "n2", text: "Second beat.", format: "plain" })
    redial.push(DICE)
    expect(intents.filter((item) => item.dest === "group").map((item) => item.text)).toEqual(["First beat.", "Second beat."])
    redial.push(MANIFEST)
    expect(intents.filter((item) => item.text.includes("Ada 3d6"))).toHaveLength(0)
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

  test("a link that never gets ui_manifest ungates 2s after the first state frame", async () => {
    const { router, clock } = await makeRouter()
    const player = new FakeLink()
    router.attachLink("player", "p-key", player, "111")
    router.queueInput("p-key", "hello")
    expect(player.sent).toEqual([])
    player.push(STATE)
    expect(player.sent).toEqual([])
    clock.advance(STATE_UNGATE_MS)
    expect(player.sent).toEqual([{ type: FrameType.Input, text: "hello" }])
  })
})

describe("router — choices, commands, queued input", () => {
  test("digits-only reply becomes that option's input on the right user's link; expired follows mention mode", async () => {
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

    clock.advance(CHOICES_TTL_MS)
    await router.handleInbound({ userId: "222", memberKey: "bao-key", text: "6666", channel: "group", mentioned: false, isAdmin: false })
    expect(bao.sent).toEqual([])
    await router.handleInbound({ userId: "222", memberKey: "bao-key", text: "6666", channel: "group", mentioned: true, isAdmin: false })
    expect(bao.sent).toEqual([{ type: FrameType.Input, text: "6666" }])
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
    await router.handleInbound({ userId: "111", memberKey: "p-key", text: ".bridge status", channel: "group", isAdmin: false })
    expect(intents).toEqual([])

    await router.handleInbound({ userId: "42", memberKey: "adm-key", text: ".bridge mode all", channel: "private", isAdmin: true })
    expect(admin.sent).toEqual([])
    expect(router.groupMode).toBe("all")
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

  test("idle-closed (not alive) link queues input and flushes once when reopened", async () => {
    const { router } = await makeRouter()
    const player = new FakeLink()
    router.attachLink("player", "p-key", player, "111")
    player.push(MANIFEST)
    player.isAlive = false
    router.queueInput("p-key", "after idle")
    expect(player.sent).toEqual([])
    const next = new FakeLink()
    router.attachLink("player", "p-key", next, "111", "open")
    next.push(MANIFEST)
    expect(next.sent).toEqual([{ type: FrameType.Input, text: "after idle" }])
  })

  test("welcome.locale is used when config locale is omitted", async () => {
    const { router, intents } = await makeRouter(undefined, { locale: undefined })
    const observer = new FakeLink()
    router.attachLink("observer", "obs", observer)
    observer.push({
      type: FrameType.Welcome,
      protocol: "2.3",
      room: "r",
      you: { id: "o", name: "obs", role: "player" },
      locale: "zh",
      server: "tui",
    })
    observer.push(MANIFEST)
    observer.push({ type: FrameType.TurnStatus, status: "busy", actor: "Nora" })
    expect(intents[0]?.text).toContain("思考")
  })

  test("a 400-block ui frame is split, not emitted as one giant intent", async () => {
    const { router, intents } = await makeRouter()
    const observer = new FakeLink()
    router.attachLink("observer", "obs", observer)
    observer.push(MANIFEST)
    const blocks = Array.from({ length: 400 }, (_, i) => ({ kind: "text" as const, text: `block-${i}-${"x".repeat(20)}` }))
    observer.push({ type: FrameType.Ui, panel: "inline", blocks })
    expect(intents.length).toBeGreaterThan(1)
    expect(intents.every((item) => item.text.length <= 4000)).toBe(true)
    expect(intents.map((item) => item.text).join("")).toContain("block-0")
    expect(intents.map((item) => item.text).join("")).toContain("block-399")
  })

  test("admin add/remove and mode persist in the settings file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-router-"))
    const path = settingsPath(dir, "99")
    const { router } = await makeRouter(undefined, { settingsPath: path })
    const admin = new FakeLink()
    router.attachLink("admin", "adm-key", admin, "42")
    admin.push(MANIFEST)
    await router.handleInbound({ userId: "42", memberKey: "adm-key", text: ".bridge admin add 7", channel: "private", isAdmin: true })
    await router.handleInbound({ userId: "42", memberKey: "adm-key", text: ".bridge mode all", channel: "private", isAdmin: true })
    await new Promise((resolve) => setTimeout(resolve, 40))
    const info = await stat(path)
    expect(info.mode & 0o777).toBe(0o600)
    const loaded = await loadGroupSettings(path, { admins: [], mode: "mention", busyNotice: true })
    expect(loaded.admins).toContain("7")
    expect(loaded.mode).toBe("all")
  })
})
