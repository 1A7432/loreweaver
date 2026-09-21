import { describe, expect, test } from "bun:test"
import {
  GROUP_AND_C2C_EVENT,
  RECONNECT_BACKOFF_CAP_MS,
  RECONNECT_BACKOFF_MS,
  TOKEN_REFRESH_FLOOR_MS,
  TOKEN_REFRESH_MARGIN_S,
  containsSecret,
  nextBackoffMs,
  tokenRefreshDelayMs,
} from "./index"
import { QQBotApiError } from "./shared"
import { FakeClock } from "./testing/clock"
import { startFakeQQBotGateway } from "./testing/fakeGateway"
import { startFakeQQBotRest } from "./testing/fakeRest"
import {
  dispatch,
  groupAtMessageCreate,
  groupAddRobot,
} from "./testing/fixtures"
import { QQBotTransport, sessionPolicyForClose, type QQBotEvent, type QQBotStatus } from "./transport"

const APP_ID = "102000000"
const SECRET = "s3cret-value-never-log"

class ScriptedSocket extends EventTarget {
  readyState = WebSocket.OPEN
  readonly frames: Array<Record<string, unknown>> = []
  send(data: string): void {
    const parsed = JSON.parse(data) as Record<string, unknown>
    this.frames.push(parsed)
    if (Number(parsed.op) === 2) {
      queueMicrotask(() =>
        this.push({
          op: 0,
          s: 1,
          t: "READY",
          d: {
            session_id: "sess-scripted",
            user: { id: "bot-1", username: "bot", bot: true },
          },
        }),
      )
    }
  }
  close(code = 1000, reason = ""): void {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new CloseEvent("close", { code, reason }))
  }
  /** Flip readyState without a close event (half-open / dropped client). */
  silenceClose(): void {
    this.readyState = WebSocket.CLOSED
  }
  push(payload: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }))
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const orig = console.warn
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((item) => String(item)).join(" "))
  }
  return {
    lines,
    restore: () => {
      console.warn = orig
    },
  }
}

function harness(opts: { heartbeatIntervalMs?: number; expiresIn?: number; stickyToken?: boolean; receiveAll?: boolean; clock?: FakeClock; requestTimeoutMs?: number } = {}) {
  const gw = startFakeQQBotGateway({ heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 3_600_000 })
  const rest = startFakeQQBotRest({
    appId: APP_ID,
    clientSecret: SECRET,
    gatewayUrl: gw.url,
    expiresIn: opts.expiresIn ?? 7200,
    stickyToken: opts.stickyToken,
    now: opts.clock ? () => opts.clock!.now() : undefined,
  })
  const transport = new QQBotTransport({
    appId: APP_ID,
    clientSecret: SECRET,
    transport: "websocket",
    receiveAll: opts.receiveAll ?? false,
    apiBase: rest.apiBase,
    authBase: rest.authBase,
    requestTimeoutMs: opts.requestTimeoutMs ?? 2000,
    invalidSessionJitterMs: () => 0,
    ...(opts.clock ? { clock: opts.clock } : {}),
  })
  return { gw, rest, transport }
}

describe("tokenRefreshDelayMs", () => {
  test("refreshes 30 s before expires_in, floored at 30 s", () => {
    expect(tokenRefreshDelayMs(7200, TOKEN_REFRESH_MARGIN_S, TOKEN_REFRESH_FLOOR_MS)).toBe(7_170_000)
    expect(tokenRefreshDelayMs(20, TOKEN_REFRESH_MARGIN_S, TOKEN_REFRESH_FLOOR_MS)).toBe(30_000)
    expect(tokenRefreshDelayMs(31, TOKEN_REFRESH_MARGIN_S, TOKEN_REFRESH_FLOOR_MS)).toBe(30_000)
    expect(tokenRefreshDelayMs(61, TOKEN_REFRESH_MARGIN_S, TOKEN_REFRESH_FLOOR_MS)).toBe(31_000)
  })
})

describe("nextBackoffMs", () => {
  test("attempts 1..7 keep doubling after the last step and clamp at 30 s", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) =>
      nextBackoffMs(attempt, RECONNECT_BACKOFF_MS, RECONNECT_BACKOFF_CAP_MS),
    )
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
  })
})

describe("QQBotTransport — auth + identify", () => {
  test("token POST, QQBot headers, Identify intents/shard, Ready identity; secret never leaks", async () => {
    const warn = captureWarn()
    const { gw, rest, transport } = harness()
    const statuses: QQBotStatus[] = []
    transport.onStatus((status) => statuses.push(status))
    try {
      await transport.start()
      expect(statuses[0]).toBe("connecting")
      expect(statuses).toContain("online")
      expect(rest.tokenCalls).toHaveLength(1)
      const tokenCall = rest.tokenCalls[0]!
      expect(tokenCall.body).toEqual({ appId: APP_ID, clientSecret: SECRET })
      expect(tokenCall.headers.authorization).toBeUndefined()

      const gatewayCall = rest.calls.find((call) => call.path === "/gateway/bot")
      expect(gatewayCall?.headers.authorization).toBe("QQBot ACCESS_TOKEN")
      expect(gatewayCall?.headers["x-union-appid"]).toBe(APP_ID)

      expect(gw.identifies).toHaveLength(1)
      expect(gw.identifies[0]).toMatchObject({
        token: "QQBot ACCESS_TOKEN",
        intents: GROUP_AND_C2C_EVENT,
        shard: [0, 1],
      })
      expect(transport.lastLogin).toMatchObject({
        appId: APP_ID,
        botOpenid: "6158788878435714165",
        username: "群pro测试机器人",
      })
      expect(containsSecret(JSON.stringify(transport), SECRET)).toBe(false)
      expect(containsSecret(JSON.stringify(transport), "ACCESS_TOKEN")).toBe(false)
      expect(containsSecret(warn.lines.join("\n"), SECRET)).toBe(false)
      expect(containsSecret(warn.lines.join("\n"), "ACCESS_TOKEN")).toBe(false)
    } finally {
      await transport.close()
      rest.close()
      gw.close()
      warn.restore()
    }
    expect(statuses.at(-1)).toBe("offline")
  })

  test("a refresh answered with the same token keeps the old deadline; a new token is used", async () => {
    const clock = new FakeClock(0)
    const same = harness({ clock, expiresIn: 100, stickyToken: true, heartbeatIntervalMs: 3_600_000 })
    try {
      await same.transport.start()
      expect(same.rest.tokenCalls).toHaveLength(1)
      await clock.advance(tokenRefreshDelayMs(100, TOKEN_REFRESH_MARGIN_S, TOKEN_REFRESH_FLOOR_MS) + 1)
      await waitFor(() => same.rest.tokenCalls.length >= 2)
      expect(same.rest.tokenCalls[1]!.body).toEqual({ appId: APP_ID, clientSecret: SECRET })
      const afterSame = same.rest.tokenCalls.length
      await clock.advance(5_000)
      expect(same.rest.tokenCalls.length).toBe(afterSame)
    } finally {
      await same.transport.close()
      same.rest.close()
      same.gw.close()
    }

    const clock2 = new FakeClock(0)
    const rotated = harness({ clock: clock2, expiresIn: 100, heartbeatIntervalMs: 3_600_000 })
    try {
      await rotated.transport.start()
      await clock2.advance(tokenRefreshDelayMs(100, TOKEN_REFRESH_MARGIN_S, TOKEN_REFRESH_FLOOR_MS) + 1)
      await waitFor(() => rotated.rest.tokenCalls.length >= 2)
      expect(rotated.rest.tokenCalls[1]!.body).toEqual({ appId: APP_ID, clientSecret: SECRET })
      expect(rotated.rest.accessToken).not.toBe("ACCESS_TOKEN")
    } finally {
      await rotated.transport.close()
      rotated.rest.close()
      rotated.gw.close()
    }
  })

  test("wrong credentials throw qqbot.auth.* without the secret in the error", async () => {
    const gw = startFakeQQBotGateway()
    const rest = startFakeQQBotRest({ appId: APP_ID, clientSecret: SECRET, gatewayUrl: gw.url })
    const transport = new QQBotTransport({
      appId: APP_ID,
      clientSecret: "wrong-secret",
      transport: "websocket",
      receiveAll: false,
      apiBase: rest.apiBase,
      authBase: rest.authBase,
      requestTimeoutMs: 1000,
    })
    try {
      try {
        await transport.start()
        throw new Error("expected start to fail")
      } catch (err) {
        expect(err).toBeInstanceOf(QQBotApiError)
        expect((err as QQBotApiError).code.startsWith("qqbot.auth.")).toBe(true)
        expect(String(err)).not.toContain("wrong-secret")
        expect(JSON.stringify(err)).not.toContain("wrong-secret")
      }
    } finally {
      await transport.close()
      rest.close()
      gw.close()
    }
  })
})

describe("QQBotTransport — gateway", () => {
  test("heartbeat uses Hello heartbeat_interval, not a constant", async () => {
    const { gw, rest, transport } = harness({ heartbeatIntervalMs: 80 })
    try {
      await transport.start()
      await waitFor(() => gw.heartbeats.length >= 3, 1000)
      const gaps = [gw.heartbeats[1]!.at - gw.heartbeats[0]!.at, gw.heartbeats[2]!.at - gw.heartbeats[1]!.at]
      for (const gap of gaps) {
        expect(gap).toBeGreaterThanOrEqual(50)
        expect(gap).toBeLessThan(250)
      }
      expect(gw.heartbeats[0]!.d).toBe(1)
    } finally {
      await transport.close()
      rest.close()
      gw.close()
    }
  })

  test("a drop resumes with session_id + last s; op 7 also resumes", async () => {
    const { gw, rest, transport } = harness()
    try {
      await transport.start()
      gw.sendDispatch(dispatch("GROUP_AT_MESSAGE_CREATE", groupAtMessageCreate(), { s: 9, id: "e1" }))
      await waitFor(() => true)
      await new Promise((resolve) => setTimeout(resolve, 20))
      gw.closeClients(1001)
      await waitFor(() => gw.resumes.length >= 1, 3000)
      expect(gw.resumes[0]).toMatchObject({
        token: "QQBot ACCESS_TOKEN",
        session_id: "082ee18c-0be3-491b-9d8b-fbd95c51673a",
        seq: 9,
      })
      gw.sendOp(7)
      await waitFor(() => gw.resumes.length >= 2, 3000)
    } finally {
      await transport.close()
      rest.close()
      gw.close()
    }
  })

  test("invalid session (op 9) closes the socket and Identifies on the next backoff, not the same connection", async () => {
    const { gw, rest, transport } = harness()
    try {
      await transport.start()
      expect(gw.identifies).toHaveLength(1)
      gw.sendOp(9, false)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(gw.identifies).toHaveLength(1)
      await waitFor(() => gw.identifies.length >= 2, 3000)
      expect(gw.identifies[1]!.intents).toBe(GROUP_AND_C2C_EVENT)
    } finally {
      await transport.close()
      rest.close()
      gw.close()
    }
  })

  test("a gateway that always answers Identify with op 9 sends at most one Identify per backoff step and stays responsive", async () => {
    const gw = startFakeQQBotGateway({ heartbeatIntervalMs: 3_600_000, rejectIdentify: true })
    const rest = startFakeQQBotRest({ appId: APP_ID, clientSecret: SECRET, gatewayUrl: gw.url })
    const transport = new QQBotTransport({
      appId: APP_ID,
      clientSecret: SECRET,
      transport: "websocket",
      receiveAll: false,
      apiBase: rest.apiBase,
      authBase: rest.authBase,
      requestTimeoutMs: 15_000,
      invalidSessionJitterMs: () => 0,
    })
    try {
      void transport.start().catch(() => {})
      await waitFor(() => gw.identifies.length >= 1)
      let timerFired = false
      const timer = new Promise<void>((resolve) => {
        setTimeout(() => {
          timerFired = true
          resolve()
        }, 300)
      })
      await new Promise((resolve) => setTimeout(resolve, 700))
      expect(gw.identifies.length).toBe(1)
      await timer
      expect(timerFired).toBe(true)
      await waitFor(() => gw.identifies.length >= 2, 3000)
      expect(gw.identifies.length).toBe(2)
      await new Promise((resolve) => setTimeout(resolve, 700))
      expect(gw.identifies.length).toBe(2)
    } finally {
      await transport.close()
      rest.close()
      gw.close()
    }
  })

  test("a heartbeat write on a socket whose readyState is CLOSED without a close event is not an unhandled rejection", async () => {
    const rest = startFakeQQBotRest({ appId: APP_ID, clientSecret: SECRET, gatewayUrl: "ws://gateway.test/" })
    let socket: ScriptedSocket | undefined
    const transport = new QQBotTransport({
      appId: APP_ID,
      clientSecret: SECRET,
      transport: "websocket",
      receiveAll: false,
      apiBase: rest.apiBase,
      authBase: rest.authBase,
      requestTimeoutMs: 2000,
      invalidSessionJitterMs: () => 0,
      wsFactory: async () => {
        socket = new ScriptedSocket()
        setTimeout(() => socket!.push({ op: 10, d: { heartbeat_interval: 1 } }), 0)
        return socket as unknown as WebSocket
      },
    })
    const rejections: unknown[] = []
    const probe = (reason: unknown) => {
      rejections.push(reason)
    }
    process.on("unhandledRejection", probe)
    try {
      await transport.start()
      socket!.silenceClose()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(rejections).toEqual([])
    } finally {
      process.off("unhandledRejection", probe)
      await transport.close()
      rest.close()
    }
  })

  test("expires_in 20 schedules a ≥30 s wait; unparseable expires_in is invalid_response; sticky past deadline is ≤1 POST per 30 s", async () => {
    const clock = new FakeClock(0)
    const short = harness({ clock, expiresIn: 20, stickyToken: true, heartbeatIntervalMs: 3_600_000 })
    try {
      await short.transport.start()
      expect(short.rest.tokenCalls).toHaveLength(1)
      await clock.advance(29_000)
      expect(short.rest.tokenCalls).toHaveLength(1)
      await clock.advance(1_500)
      await waitFor(() => short.rest.tokenCalls.length >= 2)
      expect(short.rest.tokenCalls.length).toBe(2)
      await clock.advance(29_000)
      expect(short.rest.tokenCalls.length).toBe(2)
    } finally {
      await short.transport.close()
      short.rest.close()
      short.gw.close()
    }

    const bad = startFakeQQBotRest({
      appId: APP_ID,
      clientSecret: SECRET,
      gatewayUrl: "ws://127.0.0.1:9/",
    })
    bad.tokenBody = { access_token: "ACCESS_TOKEN", expires_in: "7200.0" }
    const badTransport = new QQBotTransport({
      appId: APP_ID,
      clientSecret: SECRET,
      transport: "websocket",
      receiveAll: false,
      apiBase: bad.apiBase,
      authBase: bad.authBase,
      requestTimeoutMs: 1000,
    })
    try {
      await expect(badTransport.start()).rejects.toMatchObject({ code: "qqbot.auth.invalid_response" })
    } finally {
      await badTransport.close()
      bad.close()
    }
  })

  test("sessionPolicyForClose: 4004 refreshes token; 9001/9005 drop the session; anything else may resume", () => {
    expect(sessionPolicyForClose(4004)).toBe("refresh-token")
    expect(sessionPolicyForClose(9001)).toBe("new-session")
    expect(sessionPolicyForClose(9005)).toBe("new-session")
    expect(sessionPolicyForClose(1001)).toBe("resume-if-possible")
    expect(sessionPolicyForClose(1006)).toBe("resume-if-possible")
  })

  test("close 9001 on a scripted socket Identifies instead of Resume", async () => {
    const rest = startFakeQQBotRest({ appId: APP_ID, clientSecret: SECRET, gatewayUrl: "ws://gateway.test/" })
    const sockets: ScriptedSocket[] = []
    const transport = new QQBotTransport({
      appId: APP_ID,
      clientSecret: SECRET,
      transport: "websocket",
      receiveAll: false,
      apiBase: rest.apiBase,
      authBase: rest.authBase,
      requestTimeoutMs: 2000,
      wsFactory: async () => {
        const socket = new ScriptedSocket()
        sockets.push(socket)
        setTimeout(() => socket.push({ op: 10, d: { heartbeat_interval: 3_600_000 } }), 0)
        return socket as unknown as WebSocket
      },
    })
    try {
      await transport.start()
      expect(sockets[0]?.frames.some((frame) => frame.op === 2)).toBe(true)
      sockets[0]!.close(9001)
      await waitFor(() => sockets.length >= 2 && sockets[1]!.frames.some((frame) => frame.op === 2), 3000)
      expect(sockets.some((socket) => socket.frames.some((frame) => frame.op === 6))).toBe(false)
    } finally {
      await transport.close()
      rest.close()
    }
  })

  test("close 4004 refreshes the token then Identifies", async () => {
    const { gw, rest, transport } = harness()
    try {
      await transport.start()
      rest.rotateToken("ACCESS_TOKEN_AFTER_4004")
      gw.closeClients(4004)
      await waitFor(() => gw.identifies.some((item) => item.token === "QQBot ACCESS_TOKEN_AFTER_4004"), 3000)
    } finally {
      await transport.close()
      rest.close()
      gw.close()
    }
  })

  test("reconnect backoff is 1s then 2s while Ready never arrives, until close()", async () => {
    const gw = startFakeQQBotGateway({ heartbeatIntervalMs: 3_600_000, closeAfterHello: 1001 })
    const rest = startFakeQQBotRest({ appId: APP_ID, clientSecret: SECRET, gatewayUrl: gw.url })
    const transport = new QQBotTransport({
      appId: APP_ID,
      clientSecret: SECRET,
      transport: "websocket",
      receiveAll: false,
      apiBase: rest.apiBase,
      authBase: rest.authBase,
      requestTimeoutMs: 15_000,
    })
    try {
      void transport.start().catch(() => {})
      await waitFor(() => gw.connects >= 1)
      const t1 = Date.now()
      await waitFor(() => gw.connects >= 2, 3000)
      expect(Date.now() - t1).toBeGreaterThanOrEqual(800)
      expect(Date.now() - t1).toBeLessThan(2500)
      const t2 = Date.now()
      await waitFor(() => gw.connects >= 3, 4000)
      expect(Date.now() - t2).toBeGreaterThanOrEqual(1600)
      expect(Date.now() - t2).toBeLessThan(3500)
    } finally {
      await transport.close()
      rest.close()
      gw.close()
    }
  })

  test("events dispatch, receiveAll gate, and close is idempotent", async () => {
    const { gw, rest, transport } = harness({ receiveAll: false })
    const events: QQBotEvent[] = []
    transport.onEvent((event) => {
      events.push(event)
    })
    try {
      await transport.start()
      gw.sendDispatch(dispatch("GROUP_AT_MESSAGE_CREATE", groupAtMessageCreate({ id: "dup-1" }), { id: "e-1", s: 2 }))
      gw.sendDispatch(dispatch("GROUP_AT_MESSAGE_CREATE", groupAtMessageCreate({ id: "dup-1" }), { id: "e-1", s: 3 }))
      gw.sendDispatch(dispatch("GROUP_MESSAGE_CREATE", groupAtMessageCreate({ id: "all-1" }), { id: "e-2", s: 4 }))
      gw.sendDispatch(dispatch("GROUP_ADD_ROBOT", groupAddRobot(), { id: "e-add", s: 5 }))
      await waitFor(() => events.length >= 2)
      expect(events.map((item) => item.type)).toEqual(["groupAtMessage", "groupAddRobot"])
      expect(events[0] && events[0].type === "groupAtMessage" ? events[0].content : "").toBe("/今日天气 ")
    } finally {
      await transport.close()
      await transport.close()
      rest.close()
      gw.close()
    }
  })
})
