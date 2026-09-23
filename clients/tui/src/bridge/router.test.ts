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
import { ADMIN_HOLD_MS, BridgeRouter, DICE_MERGE_MS, NOT_ADMIN_COOLDOWN_MS, STATE_UNGATE_MS, type BridgeLink, type OutboundIntent } from "./router"
import { loadGroupSettings, settingsPath } from "./settings"
import { IdentityStore } from "./qqbot/identity"
import { Keyring, keyIdFromSecret } from "./keyring"
import { tt } from "../i18n"

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
      "🎲 Ada 3d6+2 = 11",
      "HP: 8\nDo you?\n1. Open\n2. Wait",
    ])
    expect(intents.some((item) => item.text.includes("secret sheet"))).toBe(false)
    expect(intents.some((item) => item.text.includes("stream"))).toBe(false)
  })

  test("two identical consecutive dice frames both post", async () => {
    const { router, intents, clock } = await makeRouter()
    const observer = new FakeLink()
    router.attachLink("observer", "obs-key", observer)
    observer.push(MANIFEST)
    observer.push(DICE)
    observer.push(DICE)
    clock.advance(DICE_MERGE_MS)
    expect(intents.filter((item) => item.dest === "group")).toHaveLength(2)
  })

  test("a typed roll's dice line and its reply are one group message; a Keeper roll goes out alone, in order", async () => {
    const { router, intents, clock } = await makeRouter()
    const observer = new FakeLink()
    router.attachLink("observer", "obs-key", observer)
    observer.push(MANIFEST)
    observer.push(DICE)
    observer.push({ type: FrameType.Narrative, id: "r1", speaker: "system", text: "Rolled 3d6+2: 11", format: "plain" })
    expect(intents).toEqual([{ dest: "group", text: "🎲 Ada 3d6+2 = 11\nRolled 3d6+2: 11" }])
    intents.length = 0

    observer.push(DICE)
    observer.push(NPC)
    expect(intents.map((item) => item.text)).toEqual(["🎲 Ada 3d6+2 = 11", "Nora: Stay back."])
    intents.length = 0

    observer.push(DICE)
    expect(intents).toEqual([])
    clock.advance(DICE_MERGE_MS)
    expect(intents.map((item) => item.text)).toEqual(["🎲 Ada 3d6+2 = 11"])
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

// Real engine shapes (net/session.render_frame + gateway/turn.run_turn, probed live
// 2026-09-23): a command's echo is `narrative{speaker:"player"}` sent to its sender ONLY;
// its reply is `narrative{speaker:"system"}`, broadcast to the room unless the command is
// private-reply or failed, in which case only the sender gets it. Since the same fix, one
// broadcast carries ONE id on every link.
function echo(text: string, id = `echo-${text}`): NarrativeFrame {
  return { type: FrameType.Narrative, id, speaker: "player", name: "Dirac", text, format: "plain" }
}
function systemReply(text: string, id: string): NarrativeFrame {
  return { type: FrameType.Narrative, id, speaker: "system", text, format: "plain" }
}

describe("router — command echoes and replies (engine shapes)", () => {
  async function table() {
    const made = await makeRouter()
    const observer = new FakeLink()
    const admin = new FakeLink()
    const player = new FakeLink()
    made.router.attachLink("observer", "obs-key", observer)
    made.router.attachLink("admin", "adm-key", admin, "42")
    made.router.attachLink("player", "p-key", player, "111")
    for (const link of [observer, admin, player]) link.push(MANIFEST)
    return { ...made, observer, admin, player }
  }

  test("an admin command typed in private: echo never shown, broadcast reply in the group AND in private once", async () => {
    const { router, intents, clock, observer, admin } = await table()
    await router.handleInbound({ userId: "42", memberKey: "adm-key", text: ".pack install gh:a/b", channel: "private", isAdmin: true })
    admin.push(echo(".pack install gh:a/b"))
    const reply = systemReply("installed antu", "r1")
    observer.push(reply)
    admin.push(reply)
    clock.advance(ADMIN_HOLD_MS)
    expect(intents).toEqual([
      { dest: "group", text: "installed antu" },
      { dest: "private", userId: "42", text: "installed antu" },
    ])
  })

  test("an admin command typed in the group: the group post is the reply, nothing private", async () => {
    const { router, intents, clock, observer, admin } = await table()
    await router.handleInbound({ userId: "42", memberKey: "adm-key", text: ".panels enable antu", channel: "group", isAdmin: true })
    admin.push(echo(".panels enable antu"))
    const reply = systemReply("panels on", "r2")
    observer.push(reply)
    admin.push(reply)
    clock.advance(ADMIN_HOLD_MS)
    expect(intents).toEqual([{ dest: "group", text: "panels on" }])
  })

  test("a player's private-reply command typed in the group is answered in private, never in the group", async () => {
    const { router, intents, clock, player } = await table()
    await router.handleInbound({ userId: "111", memberKey: "p-key", text: ".help", channel: "group", isAdmin: false })
    player.push(echo(".help"))
    player.push(systemReply("commands: .r .st", "r3"))
    clock.advance(ADMIN_HOLD_MS)
    expect(intents).toEqual([{ dest: "private", userId: "111", text: "commands: .r .st" }])
  })

  test("a failed player command (origin-only reply) reaches the player instead of vanishing", async () => {
    const { router, intents, clock, player } = await table()
    await router.handleInbound({ userId: "111", memberKey: "p-key", text: ".pc claim Nobody", channel: "group", isAdmin: false })
    player.push(echo(".pc claim Nobody"))
    player.push(systemReply("no such pregen", "r4"))
    clock.advance(ADMIN_HOLD_MS)
    expect(intents).toEqual([{ dest: "private", userId: "111", text: "no such pregen" }])
  })

  test("someone else's broadcast reply and a prose echo never produce a private copy", async () => {
    const { router, intents, clock, observer, admin, player } = await table()
    await router.handleInbound({ userId: "111", memberKey: "p-key", text: "I look around", channel: "private", isAdmin: false })
    observer.push(echo("I look around", "prose"))
    player.push(echo("I look around", "prose"))
    admin.push(echo("I look around", "prose"))
    const other = systemReply("Ada claimed Pei", "r5")
    observer.push(other)
    player.push(other)
    admin.push(other)
    clock.advance(ADMIN_HOLD_MS)
    expect(intents).toEqual([{ dest: "group", text: "Ada claimed Pei" }])
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

  test("observer redial: a replayed line with a fresh id is not re-posted; a missed one is", async () => {
    const { router, intents } = await makeRouter()
    const live = new FakeLink()
    router.attachLink("observer", "obs-key", live)
    live.push(MANIFEST)
    live.push({ ...KP, id: "live-1", text: "The gate opens." })
    live.push({ ...NPC, id: "live-2" })
    intents.length = 0

    const redial = new FakeLink()
    router.attachLink("observer", "obs-key", redial, undefined, "redial")
    redial.push({ ...KP, id: "replay-1", text: "The gate opens." })
    redial.push({ ...NPC, id: "replay-2" })
    redial.push({ ...KP, id: "replay-3", text: "While you were away, the bell rang." })
    redial.push(MANIFEST)
    expect(intents).toEqual([{ dest: "group", text: "While you were away, the bell rang." }])
  })

  test("a restarted bridge posts only the lines after the last one the group saw", async () => {
    const first = await makeRouter()
    const live = new FakeLink()
    first.router.attachLink("observer", "obs-key", live)
    live.push(MANIFEST)
    live.push({ ...KP, id: "live-1", text: "The gate opens." })
    await first.posted.flush()

    const posted = await PostedIds.load(join(first.dir, "g.posted.json"))
    const { router, intents } = await makeRouter(undefined, { postedIds: posted })
    const fresh = new FakeLink()
    router.attachLink("observer", "obs-key", fresh)
    fresh.push({ ...PLAYER_NAR, id: "r0" })
    fresh.push({ ...KP, id: "r1", text: "The gate opens.\n" })
    fresh.push({ ...NPC, id: "r2" })
    fresh.push({ ...KP, id: "r3", text: "The bell rings while the bridge is down." })
    fresh.push(STATE)
    expect(intents).toEqual([])
    fresh.push(MANIFEST)
    expect(intents.map((item) => item.text)).toEqual(["Nora: Stay back.", "The bell rings while the bridge is down."])
  })

  test("a first run with no posted history posts none of the replay", async () => {
    const { router, intents } = await makeRouter()
    const fresh = new FakeLink()
    router.attachLink("observer", "obs-key", fresh)
    fresh.push({ ...KP, id: "r1", text: "Old story." })
    fresh.push({ ...NPC, id: "r2" })
    fresh.push(MANIFEST)
    expect(intents).toEqual([])
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

  test("with no text limit (the OneBot path) a long line reaches the transport whole", async () => {
    const { router, intents } = await makeRouter(undefined, { textLimit: Number.POSITIVE_INFINITY })
    const observer = new FakeLink()
    router.attachLink("observer", "obs", observer)
    observer.push(MANIFEST)
    observer.push({ ...KP, id: "long", text: "沙".repeat(9000) })
    expect(intents).toHaveLength(1)
    expect(intents[0]!.text.length).toBe(9000)
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

  test("claim bypasses the admin gate and cooldown; other verbs stay gated", async () => {
    const clock = new ManualClock()
    const dir = await mkdtemp(join(tmpdir(), "lw-router-claim-"))
    const identity = await IdentityStore.load(join(dir, "g.identity.json"), "99", { now: clock.now })
    const { router, intents } = await makeRouter(clock, { identity, locale: "en" })
    const player = new FakeLink()
    router.attachLink("player", "p-key", player, "M1")
    player.push(MANIFEST)

    const code = await identity.issueClaimCode()
    await router.handleInbound({
      userId: "U1",
      memberKey: "p-key",
      text: `.bridge claim ${code}`,
      channel: "private",
      isAdmin: false,
      userOpenid: "U1",
    })
    expect(player.sent).toEqual([])
    expect(intents.some((item) => item.dest === "c2c_direct" && item.text.includes(".bridge claim"))).toBe(true)
    const link = intents.find((item) => item.dest === "c2c_direct")?.text.match(/claim\s+([A-Z2-9]{6})/i)?.[1]
    expect(link).toBeTruthy()

    intents.length = 0
    await router.handleInbound({
      userId: "M1",
      memberKey: "p-key",
      text: `.bridge claim ${link}`,
      channel: "group",
      isAdmin: false,
      memberOpenid: "M1",
    })
    expect(intents).toEqual([
      { dest: "reply", userId: "M1", text: tt("en", "bridge.qqbot.claimDone") },
    ])
    expect(router.adminIds).toContain("M1")

    intents.length = 0
    await router.handleInbound({
      userId: "M-other",
      memberKey: "p-key",
      text: ".bridge status",
      channel: "group",
      isAdmin: false,
    })
    expect(intents.some((item) => item.text.includes("Only a room admin"))).toBe(true)
    intents.length = 0
    clock.advance(NOT_ADMIN_COOLDOWN_MS - 1)
    await router.handleInbound({
      userId: "M-other",
      memberKey: "p-key",
      text: ".bridge status",
      channel: "group",
      isAdmin: false,
    })
    expect(intents).toEqual([])

    intents.length = 0
    await router.handleInbound({
      userId: "U-wrong",
      memberKey: "p-key",
      text: ".bridge claim WRONGWRG",
      channel: "private",
      isAdmin: false,
      userOpenid: "U-wrong",
    })
    expect(intents[0]).toMatchObject({ dest: "c2c_direct", text: tt("en", "bridge.qqbot.claimRejected") })
    intents.length = 0
    await router.handleInbound({
      userId: "U-wrong",
      memberKey: "p-key",
      text: ".bridge claim WRONGWRG",
      channel: "private",
      isAdmin: false,
      userOpenid: "U-wrong",
    })
    expect(intents).toEqual([])
  })

  test("unbound C2C .r 1d6 never reaches the router: no seat, no forward, throttled log", async () => {
    const clock = new ManualClock()
    const dir = await mkdtemp(join(tmpdir(), "lw-router-c2c-"))
    const logs: string[] = []
    const identity = await IdentityStore.load(join(dir, "g.identity.json"), "99", {
      now: clock.now,
      onLog: (line) => logs.push(line),
    })
    const { router, intents } = await makeRouter(clock, { identity, locale: "en" })
    const player = new FakeLink()
    router.attachLink("player", "p-key", player, "M1")
    player.push(MANIFEST)

    await router.handleInbound({
      userId: "Ux",
      memberKey: "p-key",
      text: ".r 1d6",
      channel: "private",
      isAdmin: false,
      userOpenid: "Ux",
    })
    expect(player.sent).toEqual([])
    expect(intents).toEqual([])
    expect(logs.filter((line) => line === "qqbot.c2c.unbound")).toEqual(["qqbot.c2c.unbound"])
    await router.handleInbound({
      userId: "Ux",
      memberKey: "p-key",
      text: ".r 1d6",
      channel: "private",
      isAdmin: false,
      userOpenid: "Ux",
    })
    expect(logs.filter((line) => line === "qqbot.c2c.unbound")).toHaveLength(1)
  })

  test(".bridge name from a non-admin seat remints through the keyring", async () => {
    const clock = new ManualClock()
    const dir = await mkdtemp(join(tmpdir(), "lw-router-name-"))
    const identity = await IdentityStore.load(join(dir, "g.identity.json"), "99", { now: clock.now })
    const control = new FakeControl()
    const keyring = await Keyring.load({
      path: join(dir, "g.keyring.json"),
      groupId: "99",
      control,
      admins: () => [],
      keeperKey: "KEEP-SECRET",
    })
    const { router, intents } = await makeRouter(clock, {
      identity,
      keyring,
      locale: "zh",
      hasCharacter: () => false,
    })
    const player = new FakeLink()
    router.attachLink("player", "p-key", player, "M1")
    player.push(MANIFEST)
    const pending = router.handleInbound({
      userId: "M1",
      memberKey: "p-key",
      text: ".bridge name 阿绫",
      channel: "group",
      isAdmin: false,
      memberOpenid: "M1",
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(control.sent[0]).toMatchObject({ type: FrameType.AdminMintKey, name: "阿绫", role: "player" })
    control.push({
      type: FrameType.AdminKeys,
      keys: [],
      minted: { key: "key-name-1", room: "arkham", name: "阿绫", role: "player", purpose: "join", expires_at: null },
    } as ServerFrame)
    await pending
    expect(intents[0]?.text).toBe(tt("zh", "bridge.qqbot.nameChanged", { name: "阿绫" }))
    expect(identity.chosenName("M1")).toBe("阿绫")
    expect(keyring.get("M1")?.key).toBe("key-name-1")
    expect(keyring.get("M1")?.key_id).toBe(keyIdFromSecret("key-name-1"))
    keyring.close()
  })

  test("OneBot (no identity): non-admin .bridge claim still hits the 30s cooldown", async () => {
    const clock = new ManualClock()
    const { router, intents } = await makeRouter(clock, { locale: "en" })
    const player = new FakeLink()
    router.attachLink("player", "p-key", player, "111")
    player.push(MANIFEST)
    for (let i = 0; i < 4; i++) {
      await router.handleInbound({
        userId: "111",
        memberKey: "p-key",
        text: ".bridge claim foo",
        channel: "group",
        isAdmin: false,
      })
    }
    expect(intents.filter((item) => item.text.includes("Only a room admin"))).toHaveLength(1)
  })

  test("unbound stranger .bridge name privately does not mint", async () => {
    const clock = new ManualClock()
    const dir = await mkdtemp(join(tmpdir(), "lw-router-m3-"))
    const logs: string[] = []
    const identity = await IdentityStore.load(join(dir, "g.identity.json"), "99", {
      now: clock.now,
      onLog: (line) => logs.push(line),
    })
    const control = new FakeControl()
    const keyring = await Keyring.load({
      path: join(dir, "g.keyring.json"),
      groupId: "99",
      control,
      admins: () => [],
      keeperKey: "KEEP-SECRET",
    })
    const { router, intents } = await makeRouter(clock, { identity, keyring, locale: "en", hasCharacter: () => false })
    await router.handleInbound({
      userId: "Ux",
      memberKey: "p-key",
      text: ".bridge name X",
      channel: "private",
      isAdmin: false,
      userOpenid: "Ux",
    })
    expect(intents).toEqual([])
    expect(control.sent).toEqual([])
    expect(keyring.get("Ux")).toBeUndefined()
    expect(logs.filter((line) => line === "qqbot.c2c.unbound")).toEqual(["qqbot.c2c.unbound"])
    keyring.close()
  })

  test("union fast path promotes admin even when the first group message is .bridge status", async () => {
    const clock = new ManualClock()
    const dir = await mkdtemp(join(tmpdir(), "lw-router-union-"))
    const identity = await IdentityStore.load(join(dir, "g.identity.json"), "99", { now: clock.now })
    const { router } = await makeRouter(clock, { identity, locale: "en", admins: [] })
    const code = await identity.issueClaimCode()
    await identity.claim({ channel: "private", code, userOpenid: "U1", unionOpenid: "UNION-SAME" })
    await router.handleInbound({
      userId: "M1",
      memberKey: "p-key",
      text: ".bridge status",
      channel: "group",
      isAdmin: false,
      memberOpenid: "M1",
      unionOpenid: "UNION-SAME",
    })
    expect(identity.resolveC2C("M1")).toBe("U1")
    expect(router.adminIds).toContain("M1")
  })

  test("state.character on a player link locks .bridge name; the frame is never rendered", async () => {
    const clock = new ManualClock()
    const dir = await mkdtemp(join(tmpdir(), "lw-router-char-"))
    const identity = await IdentityStore.load(join(dir, "g.identity.json"), "99", { now: clock.now })
    const control = new FakeControl()
    const keyring = await Keyring.load({
      path: join(dir, "g.keyring.json"),
      groupId: "99",
      control,
      admins: () => [],
      keeperKey: "KEEP-SECRET",
    })
    const { router, intents } = await makeRouter(clock, { identity, keyring, locale: "en" })
    const player = new FakeLink()
    router.attachLink("player", "p-key", player, "M1")
    player.push(MANIFEST)

    await router.handleInbound({
      userId: "M1",
      memberKey: "p-key",
      text: ".bridge name Bao",
      channel: "group",
      isAdmin: false,
      memberOpenid: "M1",
    })
    expect(intents[0]?.text).toBe(tt("en", "bridge.qqbot.nameLocked"))
    expect(control.sent).toEqual([])

    player.push({
      type: FrameType.State,
      character: null,
      party: [],
      initiative: [],
      online: 1,
    } as ServerFrame)
    intents.length = 0
    clock.advance(NOT_ADMIN_COOLDOWN_MS + 1)
    const pendingUnlock = router.handleInbound({
      userId: "M1",
      memberKey: "p-key",
      text: ".bridge name Bao",
      channel: "group",
      isAdmin: false,
      memberOpenid: "M1",
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(control.sent[0]).toMatchObject({ type: FrameType.AdminMintKey, name: "Bao", role: "player" })
    control.push({
      type: FrameType.AdminKeys,
      keys: [],
      minted: { key: "key-bao", room: "arkham", name: "Bao", role: "player", purpose: "join", expires_at: null },
    } as ServerFrame)
    await pendingUnlock
    expect(intents[0]?.text).toBe(tt("en", "bridge.qqbot.nameChanged", { name: "Bao" }))

    player.push({
      type: FrameType.State,
      character: { name: "Bao", system: "coc7", resources: [], attributes: {}, status_effects: [] },
      party: [],
      initiative: [],
      online: 1,
    })
    expect(intents.slice(1)).toEqual([])
    intents.length = 0
    clock.advance(NOT_ADMIN_COOLDOWN_MS + 1)
    await router.handleInbound({
      userId: "M1",
      memberKey: "p-key",
      text: ".bridge name Ada",
      channel: "group",
      isAdmin: false,
      memberOpenid: "M1",
    })
    expect(intents[0]?.text).toBe(tt("en", "bridge.qqbot.nameLocked"))

    player.push({
      type: FrameType.State,
      party: [],
      initiative: [],
      online: 1,
    })
    intents.length = 0
    clock.advance(NOT_ADMIN_COOLDOWN_MS + 1)
    const pending = router.handleInbound({
      userId: "M1",
      memberKey: "p-key",
      text: ".bridge name Bao",
      channel: "group",
      isAdmin: false,
      memberOpenid: "M1",
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(control.sent.some((frame) => frame.type === FrameType.AdminMintKey && (frame as { name?: string }).name === "Bao")).toBe(true)
    control.push({
      type: FrameType.AdminKeys,
      keys: [],
      minted: { key: "key-bao", room: "arkham", name: "Bao", role: "player", purpose: "join", expires_at: null },
    } as ServerFrame)
    await pending
    expect(intents[0]?.text).toBe(tt("en", "bridge.qqbot.nameChanged", { name: "Bao" }))
    keyring.close()
  })
})
