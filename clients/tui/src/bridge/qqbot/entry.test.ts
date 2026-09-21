import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { FrameType } from "loreweaver-protocol"
import type { LoadIroh } from "../../irohLink"
import { tt } from "../../i18n"
import { parseBridgeConfig, qqbotTransportOptions } from "../config"
import { runBridge } from "../index"
import { QQBotApiError } from "./shared"
import { qqbotStartFailure } from "./entry"
import { GROUP_WINDOW_MS } from "./anchors"
import { WINDOW_MS } from "./coalescer"
import { startFakeQQBotGateway } from "./testing/fakeGateway"
import { startFakeQQBotRest } from "./testing/fakeRest"
import {
  SAMPLE_GROUP_OPENID,
  SAMPLE_MEMBER_OPENID,
  c2cMessageCreate,
  dispatch,
  friendAdd,
  groupAddRobot,
  groupAtMessageCreate,
  groupMsgReceive,
} from "./testing/fixtures"
import { QQBotTransport } from "./transport"

const TICKET = "endpointaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const KEEP = "KEEP-SECRET"
const APP_ID = "102000000"
const SECRET = "s3cret-value-never-log"
const ADMIN_USER_OPENID = "U-ADMIN-C2C-OPENID-0000000000001"

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

class ManualClock {
  nowMs = 1_000_000
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

function createMockIroh() {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const sent: string[] = []
  const joins: Array<{ key: string; name?: string; stream: ReturnType<typeof makeRecvStream> }> = []

  function makeRecvStream() {
    const queue: Array<number[] | null> = []
    let waiter: ((value: number[] | null) => void) | undefined
    return {
      end(): void {
        if (waiter) {
          const resolve = waiter
          waiter = undefined
          resolve(null)
        } else {
          queue.push(null)
        }
      },
      push(text: string): void {
        this.pushBytes(enc.encode(text))
      },
      pushBytes(data: Uint8Array | number[]): void {
        const bytes = Array.from(data)
        if (waiter) {
          const resolve = waiter
          waiter = undefined
          resolve(bytes)
        } else {
          queue.push(bytes)
        }
      },
      async read(): Promise<number[] | null> {
        if (queue.length > 0) return queue.shift()!
        return new Promise((resolve) => {
          waiter = resolve
        })
      },
    }
  }

  const mintCount = new Map<string, number>()

  const loadIroh: LoadIroh = async () => ({
    Endpoint: {
      builder: () => ({
        bind: async () => ({
          online: async () => {},
          connect: async () => ({
            openBi: async () => {
              const recv = makeRecvStream()
              return {
                send: {
                  writeAll: async (buf: number[]) => {
                    const text = dec.decode(Uint8Array.from(buf))
                    sent.push(text)
                    for (const line of text.split("\n").filter(Boolean)) {
                      let frame: Record<string, unknown>
                      try {
                        frame = JSON.parse(line) as Record<string, unknown>
                      } catch {
                        continue
                      }
                      if (frame.type === FrameType.Join) {
                        joins.push({
                          key: String(frame.key),
                          name: typeof frame.name === "string" ? frame.name : undefined,
                          stream: recv,
                        })
                      }
                      if (frame.type === FrameType.AdminDeleteKey) {
                        recv.push(`${JSON.stringify({ type: FrameType.AdminKeys, keys: [] })}\n`)
                      }
                      if (frame.type === FrameType.AdminMintKey) {
                        const name = String(frame.name)
                        const role = frame.role === "keeper" ? "keeper" : "player"
                        const n = (mintCount.get(name) ?? 0) + 1
                        mintCount.set(name, n)
                        const key = `k-${name}-${n}`
                        const id = `id-${name}-${n}`
                        recv.push(
                          `${JSON.stringify({
                            type: FrameType.AdminKeys,
                            keys: [
                              {
                                id,
                                key_masked: "xxxx",
                                room: "arkham",
                                name,
                                role,
                                purpose: "join",
                                expires_at: null,
                              },
                            ],
                            minted: { key, room: "arkham", name, role, purpose: "join", expires_at: null },
                          })}\n`,
                        )
                      }
                    }
                  },
                },
                recv,
              }
            },
          }),
          close: () => {},
        }),
      }),
    },
    presetN0: () => {},
    EndpointTicket: { fromString: () => ({ endpointAddr: () => ({}) }) },
  })

  return { loadIroh, sent, joins }
}

function framesOf(sent: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const chunk of sent) {
    for (const line of chunk.split("\n").filter(Boolean)) {
      try {
        out.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // ignore
      }
    }
  }
  return out
}

async function ungate(
  iroh: ReturnType<typeof createMockIroh>,
  key: string,
  role: "player" | "keeper" = "player",
): Promise<void> {
  await waitFor(() => iroh.joins.some((row) => row.key === key))
  const row = iroh.joins.find((item) => item.key === key)!
  row.stream.push(
    `${JSON.stringify({
      type: FrameType.Welcome,
      room: "arkham",
      you: { name: row.name || "n", role },
      locale: "en",
    })}\n`,
  )
  row.stream.push(`${JSON.stringify({ type: FrameType.UiManifest, panels: [] })}\n`)
  await settle(0)
}

function messageCalls(rest: ReturnType<typeof startFakeQQBotRest>): Array<{ path: string; body: Record<string, unknown> }> {
  return rest.calls
    .filter((call) => call.method === "POST" && call.path.includes("/messages"))
    .map((call) => ({
      path: call.path,
      body: call.body && typeof call.body === "object" ? (call.body as Record<string, unknown>) : {},
    }))
}

async function startHarness(
  extra: { busyNotice?: boolean; admins?: string[]; receiveAll?: boolean } = {},
) {
  const stateDir = await mkdtemp(join(tmpdir(), "lw-qqbot-entry-"))
  const clock = new ManualClock()
  const gw = startFakeQQBotGateway({ heartbeatIntervalMs: 3_600_000 })
  const rest = startFakeQQBotRest({ appId: APP_ID, clientSecret: SECRET, gatewayUrl: gw.url })
  const transport = new QQBotTransport({
    appId: APP_ID,
    clientSecret: SECRET,
    transport: "websocket",
    receiveAll: extra.receiveAll ?? false,
    apiBase: rest.apiBase,
    authBase: rest.authBase,
    requestTimeoutMs: 2000,
    invalidSessionJitterMs: () => 0,
  })
  const iroh = createMockIroh()
  const logs: string[] = []
  const config = parseBridgeConfig({
    platform: "qqbot",
    ticket: TICKET,
    keeper_key: KEEP,
    locale: "en",
    qqbot: { app_id: APP_ID, client_secret: SECRET, receive_all: extra.receiveAll ?? false },
    groups: [{ group_openid: SAMPLE_GROUP_OPENID, admins: extra.admins ?? [] }],
    busy_notice: extra.busyNotice ?? false,
    idle_close_minutes: 30,
    state_dir: stateDir,
  })
  const handle = await runBridge(config, {
    loadIroh: iroh.loadIroh,
    qqbotTransport: transport,
    installSignals: false,
    onLog: (text) => logs.push(text),
    now: clock.now,
  })
  await waitFor(() => iroh.joins.some((row) => row.key === KEEP))
  await waitFor(() => iroh.joins.some((row) => row.key.startsWith("k-qq:observer:")))
  const observerKey = iroh.joins.find((row) => row.key.startsWith("k-qq:observer:"))!.key
  await ungate(iroh, KEEP, "keeper")
  await ungate(iroh, observerKey, "player")
  return { handle, iroh, gw, rest, transport, clock, logs, observerKey, stateDir }
}

async function claimKeeper(h: Awaited<ReturnType<typeof startHarness>>) {
  const claim = h.logs.find((line) => /claim code: [A-Z2-9]{8}/.test(line))!.match(/claim code: ([A-Z2-9]{8})/)![1]!
  h.gw.sendDispatch(
    dispatch(
      "C2C_MESSAGE_CREATE",
      c2cMessageCreate({
        id: `c2c-claim-${Date.now()}`,
        content: `.bridge claim ${claim}`,
        timestamp: "",
        author: { id: ADMIN_USER_OPENID, user_openid: ADMIN_USER_OPENID, username: "Keeper", bot: false },
      }),
      { id: "evt-claim-h", s: 2 },
    ),
  )
  await waitFor(() => messageCalls(h.rest).some((call) => call.path.includes(`/users/${ADMIN_USER_OPENID}/messages`)))
  const link = JSON.stringify(
    messageCalls(h.rest).find((call) => call.path.includes(`/users/${ADMIN_USER_OPENID}/messages`))!.body,
  ).match(/\.bridge claim ([A-Z2-9]{6})/)![1]!
  h.gw.sendDispatch(
    dispatch(
      "GROUP_AT_MESSAGE_CREATE",
      groupAtMessageCreate({
        id: "msg-link-h",
        content: `.bridge claim ${link}`,
        timestamp: "",
        author: {
          id: SAMPLE_MEMBER_OPENID,
          member_openid: SAMPLE_MEMBER_OPENID,
          username: "Keeper",
          bot: false,
        },
      }),
      { id: "evt-link-h", s: 3 },
    ),
  )
  await waitFor(() =>
    messageCalls(h.rest).some((call) => JSON.stringify(call.body).includes("You are now a room admin")),
  )
  await waitFor(() => h.iroh.joins.filter((row) => row.key.startsWith("k-Keeper")).length >= 2)
  const keeperJoin = [...h.iroh.joins].reverse().find((row) => row.key.startsWith("k-Keeper"))!
  await ungate(h.iroh, keeperJoin.key, "keeper")
  return keeperJoin
}

describe("qqbot bridge entry", () => {
  test(
    "group @-message mints a seat; observer narrative is passive then active; unbound C2C is ignored; unknown GROUP_ADD_ROBOT is ignored; stop tears down",
    async () => {
    const { handle, iroh, gw, rest, clock, logs, observerKey } = await startHarness()
    try {
      expect(logs.some((line) => line.includes(SECRET))).toBe(false)
      expect(logs.some((line) => /claim code: [A-Z2-9]{8}/.test(line))).toBe(true)
      expect(logs.some((line) => line.includes("QQ Bot is up"))).toBe(true)

      gw.sendDispatch(
        dispatch(
          "GROUP_AT_MESSAGE_CREATE",
          groupAtMessageCreate({
            id: "msg-roll",
            content: ".r 3d6",
            timestamp: "",
            author: {
              id: SAMPLE_MEMBER_OPENID,
              member_openid: SAMPLE_MEMBER_OPENID,
              username: "Ada",
              bot: false,
            },
          }),
          { id: "evt-roll", s: 2 },
        ),
      )
      await waitFor(() => iroh.joins.some((row) => row.key.startsWith("k-Ada")))
      const adaKey = iroh.joins.find((row) => row.key.startsWith("k-Ada"))!.key
      await ungate(iroh, adaKey)
      await waitFor(() => framesOf(iroh.sent).some((frame) => frame.type === FrameType.Input && frame.text === ".r 3d6"))

      const observer = iroh.joins.find((row) => row.key === observerKey)!
      observer.stream.push(
        `${JSON.stringify({
          type: FrameType.Narrative,
          id: "n-passive",
          speaker: "kp",
          text: "The door opens.",
          format: "plain",
        })}\n`,
      )
      await settle(WINDOW_MS + 150)
      await waitFor(() => messageCalls(rest).some((call) => call.path.includes("/groups/")))
      const passive = messageCalls(rest).filter((call) => call.path.includes(`/groups/${SAMPLE_GROUP_OPENID}/messages`))
      expect(passive.length).toBeGreaterThanOrEqual(1)
      const first = passive[0]!.body
      expect(first.msg_seq).toBe(1)
      expect(first.msg_id).toBe("msg-roll")
      expect(JSON.stringify(first)).toContain("The door opens.")

      clock.advance(GROUP_WINDOW_MS + 1_000)
      gw.sendDispatch(dispatch("GROUP_MSG_RECEIVE", groupMsgReceive({ timestamp: "" }), { id: "evt-on", s: 3 }))
      await settle(20)
      observer.stream.push(
        `${JSON.stringify({
          type: FrameType.Narrative,
          id: "n-active",
          speaker: "kp",
          text: "A lantern flickers.",
          format: "plain",
        })}\n`,
      )
      await settle(WINDOW_MS + 150)
      await waitFor(() =>
        messageCalls(rest).some(
          (call) => call.path.includes("/groups/") && JSON.stringify(call.body).includes("A lantern flickers."),
        ),
      )
      const active = messageCalls(rest).find((call) => JSON.stringify(call.body).includes("A lantern flickers."))!
      expect(active.body.msg_id).toBeUndefined()
      expect(active.body.event_id).toBeUndefined()

      const joinsBefore = iroh.joins.length
      const messagesBefore = messageCalls(rest).length
      gw.sendDispatch(
        dispatch(
          "C2C_MESSAGE_CREATE",
          c2cMessageCreate({
            id: "c2c-unbound",
            content: ".r 1d6",
            timestamp: "",
            author: { id: "UNBOUND", user_openid: "UNBOUND", username: "Stranger", bot: false },
          }),
          { id: "evt-unbound", s: 4 },
        ),
      )
      await settle(80)
      expect(iroh.joins.length).toBe(joinsBefore)
      expect(messageCalls(rest).length).toBe(messagesBefore)
      expect(framesOf(iroh.sent).some((frame) => frame.type === FrameType.Input && frame.text === ".r 1d6")).toBe(false)

      gw.sendDispatch(
        dispatch("GROUP_ADD_ROBOT", groupAddRobot({ group_openid: "UNKNOWN-GROUP-OPENID", timestamp: "" }), {
          id: "evt-unknown",
          s: 5,
        }),
      )
      await settle(40)
      expect(logs.some((line) => line.includes("qqbot.group.unknown UNKNOWN-GROUP-OPENID"))).toBe(true)
      expect(logs.some((line) => line.includes(tt("en", "bridge.qqbot.unknownGroup", { group: "UNKNOWN-GROUP-OPENID" })))).toBe(
        true,
      )
      expect(iroh.joins.length).toBe(joinsBefore)

      await handle.stop()
      expect(gw.clientCount).toBe(0)
      expect(logs.some((line) => line.includes(tt("en", "bridge.cli.shutdown")))).toBe(true)
    } finally {
      try {
        await handle.stop()
      } catch {
        // already stopped
      }
      rest.close()
      gw.close()
    }
  },
  30_000,
  )

  test("claim flow: C2C claim → group link → keeper-role seat; system frame is C2C-only", async () => {
    const { handle, iroh, gw, rest, clock, logs, observerKey } = await startHarness()
    try {
      const claimLine = logs.find((line) => /claim code: [A-Z2-9]{8}/.test(line))
      expect(claimLine).toBeDefined()
      const claimCode = claimLine!.match(/claim code: ([A-Z2-9]{8})/)![1]!

      gw.sendDispatch(
        dispatch(
          "C2C_MESSAGE_CREATE",
          c2cMessageCreate({
            id: "c2c-claim",
            content: `.bridge claim ${claimCode}`,
            timestamp: "",
            author: {
              id: ADMIN_USER_OPENID,
              user_openid: ADMIN_USER_OPENID,
              username: "Keeper",
              bot: false,
            },
          }),
          { id: "evt-claim", s: 2 },
        ),
      )
      await waitFor(() =>
        messageCalls(rest).some((call) => call.path.includes(`/users/${ADMIN_USER_OPENID}/messages`)),
      )
      const c2cReply = messageCalls(rest).find((call) => call.path.includes(`/users/${ADMIN_USER_OPENID}/messages`))!
      const replyText = JSON.stringify(c2cReply.body)
      expect(replyText).toContain(".bridge claim")
      const link = replyText.match(/\.bridge claim ([A-Z2-9]{6})/)![1]!
      expect(c2cReply.body.msg_id).toBe("c2c-claim")

      gw.sendDispatch(
        dispatch(
          "GROUP_AT_MESSAGE_CREATE",
          groupAtMessageCreate({
            id: "msg-link",
            content: `.bridge claim ${link}`,
            timestamp: "",
            author: {
              id: SAMPLE_MEMBER_OPENID,
              member_openid: SAMPLE_MEMBER_OPENID,
              username: "Keeper",
              bot: false,
            },
          }),
          { id: "evt-link", s: 3 },
        ),
      )
      await waitFor(() =>
        messageCalls(rest).some((call) => JSON.stringify(call.body).includes("You are now a room admin")),
      )
      await waitFor(() =>
        framesOf(iroh.sent).some((frame) => frame.type === FrameType.AdminMintKey && frame.role === "keeper"),
      )
      await waitFor(() => iroh.joins.filter((row) => row.key.startsWith("k-Keeper")).length >= 2)
      const keeperJoin = [...iroh.joins].reverse().find((row) => row.key.startsWith("k-Keeper"))!
      await ungate(iroh, keeperJoin.key, "keeper")

      keeperJoin.stream.push(`${JSON.stringify({ type: FrameType.System, level: "info", text: "secret lore" })}\n`)
      await settle(200)
      await waitFor(() => messageCalls(rest).some((call) => JSON.stringify(call.body).includes("secret lore")))
      const loreCalls = messageCalls(rest).filter((call) => JSON.stringify(call.body).includes("secret lore"))
      expect(loreCalls.some((call) => call.path.includes(`/users/${ADMIN_USER_OPENID}/messages`))).toBe(true)
      expect(loreCalls.some((call) => call.path.includes("/groups/"))).toBe(false)
      expect(observerKey).toBeTruthy()
    } finally {
      await handle.stop()
      rest.close()
      gw.close()
    }
  }, 30_000)

  test("a second @ on the same seat is not re-gated; system and input still flow", async () => {
    const { handle, iroh, gw, rest, logs } = await startHarness()
    try {
      const claim = logs.find((line) => /claim code: [A-Z2-9]{8}/.test(line))!.match(/claim code: ([A-Z2-9]{8})/)![1]!
      gw.sendDispatch(
        dispatch(
          "C2C_MESSAGE_CREATE",
          c2cMessageCreate({
            id: "c2c-claim-b1",
            content: `.bridge claim ${claim}`,
            timestamp: "",
            author: { id: ADMIN_USER_OPENID, user_openid: ADMIN_USER_OPENID, username: "Keeper", bot: false },
          }),
          { id: "evt-claim-b1", s: 2 },
        ),
      )
      await waitFor(() => messageCalls(rest).some((call) => call.path.includes(`/users/${ADMIN_USER_OPENID}/messages`)))
      const link = JSON.stringify(
        messageCalls(rest).find((call) => call.path.includes(`/users/${ADMIN_USER_OPENID}/messages`))!.body,
      ).match(/\.bridge claim ([A-Z2-9]{6})/)![1]!
      gw.sendDispatch(
        dispatch(
          "GROUP_AT_MESSAGE_CREATE",
          groupAtMessageCreate({
            id: "msg-link-b1",
            content: `.bridge claim ${link}`,
            timestamp: "",
            author: {
              id: SAMPLE_MEMBER_OPENID,
              member_openid: SAMPLE_MEMBER_OPENID,
              username: "Keeper",
              bot: false,
            },
          }),
          { id: "evt-link-b1", s: 3 },
        ),
      )
      await waitFor(() =>
        messageCalls(rest).some((call) => JSON.stringify(call.body).includes("You are now a room admin")),
      )
      await waitFor(() => iroh.joins.filter((row) => row.key.startsWith("k-Keeper")).length >= 2)
      const keeperJoin = [...iroh.joins].reverse().find((row) => row.key.startsWith("k-Keeper"))!
      await ungate(iroh, keeperJoin.key, "keeper")

      const at = (id: string, content: string, s: number) =>
        gw.sendDispatch(
          dispatch(
            "GROUP_AT_MESSAGE_CREATE",
            groupAtMessageCreate({
              id,
              content,
              timestamp: "",
              author: {
                id: SAMPLE_MEMBER_OPENID,
                member_openid: SAMPLE_MEMBER_OPENID,
                username: "Keeper",
                bot: false,
              },
            }),
            { id: `evt-${id}`, s },
          ),
        )
      at("msg-roll-2", ".r 3d6", 4)
      await waitFor(() => framesOf(iroh.sent).some((frame) => frame.type === FrameType.Input && frame.text === ".r 3d6"))
      at("msg-roll-3", ".r 1d4", 5)
      await waitFor(() => framesOf(iroh.sent).some((frame) => frame.type === FrameType.Input && frame.text === ".r 1d4"))

      keeperJoin.stream.push(`${JSON.stringify({ type: FrameType.System, level: "info", text: "secret after two ats" })}\n`)
      await waitFor(() =>
        messageCalls(rest).some((call) => JSON.stringify(call.body).includes("secret after two ats")),
      )
      const secret = messageCalls(rest).filter((call) => JSON.stringify(call.body).includes("secret after two ats"))
      expect(secret.some((call) => call.path.includes(`/users/${ADMIN_USER_OPENID}/messages`))).toBe(true)
      expect(secret.some((call) => call.path.includes("/groups/"))).toBe(false)
    } finally {
      await handle.stop()
      rest.close()
      gw.close()
    }
  }, 30_000)

  test(".bridge status is one POST; a later forwarded input sends the thinking line", async () => {
    const { handle, iroh, gw, rest, observerKey } = await startHarness({ busyNotice: true })
    try {
      gw.sendDispatch(
        dispatch(
          "GROUP_AT_MESSAGE_CREATE",
          groupAtMessageCreate({
            id: "msg-status",
            content: ".bridge status",
            timestamp: "",
            author: {
              id: SAMPLE_MEMBER_OPENID,
              member_openid: SAMPLE_MEMBER_OPENID,
              username: "Ada",
              bot: false,
            },
          }),
          { id: "evt-status", s: 2 },
        ),
      )
      await waitFor(() => messageCalls(rest).some((call) => call.path.includes("/groups/")))
      const afterStatus = messageCalls(rest).filter((call) => call.path.includes("/groups/"))
      expect(afterStatus).toHaveLength(1)
      expect(JSON.stringify(afterStatus[0]!.body)).not.toContain(tt("en", "bridge.qqbot.thinking"))

      const adaKey = iroh.joins.find((row) => row.key.startsWith("k-Ada"))!.key
      await ungate(iroh, adaKey)
      gw.sendDispatch(
        dispatch(
          "GROUP_AT_MESSAGE_CREATE",
          groupAtMessageCreate({
            id: "msg-roll-busy",
            content: ".r 3d6",
            timestamp: "",
            author: {
              id: SAMPLE_MEMBER_OPENID,
              member_openid: SAMPLE_MEMBER_OPENID,
              username: "Ada",
              bot: false,
            },
          }),
          { id: "evt-roll-busy", s: 3 },
        ),
      )
      await waitFor(() =>
        messageCalls(rest).some((call) => JSON.stringify(call.body).includes(tt("en", "bridge.qqbot.thinking"))),
      )
      expect(observerKey).toBeTruthy()
    } finally {
      await handle.stop()
      rest.close()
      gw.close()
    }
  }, 30_000)

  test(".bridge notice off is live and status reports it; the next turn has no thinking POST", async () => {
    const h = await startHarness({ busyNotice: true })
    try {
      await claimKeeper(h)
      const at = (id: string, content: string, s: number) =>
        h.gw.sendDispatch(
          dispatch(
            "GROUP_AT_MESSAGE_CREATE",
            groupAtMessageCreate({
              id,
              content,
              timestamp: "",
              author: {
                id: SAMPLE_MEMBER_OPENID,
                member_openid: SAMPLE_MEMBER_OPENID,
                username: "Keeper",
                bot: false,
              },
            }),
            { id: `evt-${id}`, s },
          ),
        )
      at("msg-notice-off", ".bridge notice off", 4)
      await waitFor(() =>
        messageCalls(h.rest).some((call) => JSON.stringify(call.body).includes("Busy notice is now off")),
      )
      at("msg-status-off", ".bridge status", 5)
      await waitFor(() => messageCalls(h.rest).some((call) => JSON.stringify(call.body).includes("notice off")))
      const beforeRoll = messageCalls(h.rest).length
      at("msg-roll-silent", ".r 3d6", 6)
      await waitFor(() =>
        framesOf(h.iroh.sent).some((frame) => frame.type === FrameType.Input && frame.text === ".r 3d6"),
      )
      await settle(80)
      const after = messageCalls(h.rest).slice(beforeRoll)
      expect(after.some((call) => JSON.stringify(call.body).includes(tt("en", "bridge.qqbot.thinking")))).toBe(false)
    } finally {
      await h.handle.stop()
      h.rest.close()
      h.gw.close()
    }
  }, 30_000)

  test("plain groupMessage prose does not mint a seat even with receive_all", async () => {
    const { handle, iroh, gw, rest } = await startHarness({ receiveAll: true })
    try {
      const joinsBefore = iroh.joins.length
      gw.sendDispatch(
        dispatch(
          "GROUP_MESSAGE_CREATE",
          groupAtMessageCreate({
            id: "msg-chat",
            content: "hello bystander",
            timestamp: "",
            author: {
              id: SAMPLE_MEMBER_OPENID,
              member_openid: SAMPLE_MEMBER_OPENID,
              username: "Ada",
              bot: false,
            },
          }),
          { id: "evt-chat", s: 2 },
        ),
      )
      await settle(80)
      expect(iroh.joins.length).toBe(joinsBefore)
      expect(messageCalls(rest)).toEqual([])
    } finally {
      await handle.stop()
      rest.close()
      gw.close()
    }
  }, 15_000)

  test("GROUP_DEL_ROBOT and friend events are logged; start-failure codes map to distinct i18n", async () => {
    const { handle, gw, rest, logs } = await startHarness()
    try {
      gw.sendDispatch(dispatch("GROUP_DEL_ROBOT", groupAddRobot({ group_openid: "LEFT-GROUP" }), { id: "evt-left", s: 2 }))
      gw.sendDispatch(dispatch("FRIEND_ADD", friendAdd({ openid: "U-NEW" }), { id: "evt-friend", s: 3 }))
      await settle(40)
      expect(logs.some((line) => line.includes("qqbot.group.left LEFT-GROUP"))).toBe(true)
      expect(logs.some((line) => line.includes("qqbot.friend.add U-NEW"))).toBe(true)
    } finally {
      await handle.stop()
      rest.close()
      gw.close()
    }
    expect(qqbotStartFailure(new QQBotApiError("qqbot.auth.rejected"))).toEqual({
      log: "qqbot.start.failed qqbot.auth.rejected",
      key: "bridge.qqbot.authFailed",
    })
    expect(qqbotStartFailure(new QQBotApiError("qqbot.gateway.ready_timeout"))).toEqual({
      log: "qqbot.start.failed qqbot.gateway.ready_timeout",
      key: "bridge.qqbot.intentNotApproved",
    })
    expect(qqbotStartFailure(new QQBotApiError("qqbot.gateway.invalid_session"))).toEqual({
      log: "qqbot.start.failed qqbot.gateway.invalid_session",
      key: "bridge.qqbot.intentNotApproved",
    })
    expect(qqbotStartFailure(new Error("boom"))).toEqual({
      log: "qqbot.start.failed Error",
      key: "bridge.qqbot.connectFailed",
    })
    const cfg = parseBridgeConfig({
      platform: "qqbot",
      qqbot: { app_id: APP_ID, client_secret: SECRET, send_timeout: 5 },
      groups: [{ group_openid: SAMPLE_GROUP_OPENID }],
    })
    expect(qqbotTransportOptions(cfg.qqbot!)).toEqual({ requestTimeoutMs: 10_000 })
  }, 15_000)
})
