import { describe, expect, test } from "bun:test"
import { FILE_TYPE } from "./constants"
import { SAMPLE_FILE_INFO, SAMPLE_GROUP_OPENID, SAMPLE_MSG_ID, SAMPLE_USER_OPENID } from "./testing"
import { startFakeQQBotGateway } from "./testing/fakeGateway"
import { startFakeQQBotRest } from "./testing/fakeRest"
import { sendSuccess } from "./testing/fixtures"
import { MIN_REQUEST_TIMEOUT_MS, uploadPartTimeoutMs } from "./index"
import { FakeClock } from "./testing/clock"
import { QQBotTransport, buildSendBody, mapSendPlatformCode } from "./transport"

const APP_ID = "102000000"
const SECRET = "s3cret-value-never-log"

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function started() {
  const gw = startFakeQQBotGateway({ heartbeatIntervalMs: 3_600_000 })
  const rest = startFakeQQBotRest({ appId: APP_ID, clientSecret: SECRET, gatewayUrl: gw.url })
  const transport = new QQBotTransport({
    appId: APP_ID,
    clientSecret: SECRET,
    transport: "websocket",
    receiveAll: false,
    apiBase: rest.apiBase,
    authBase: rest.authBase,
    requestTimeoutMs: 500,
    invalidSessionJitterMs: () => 0,
  })
  await transport.start()
  return { gw, rest, transport }
}

async function stop(ctx: { gw: { close(): void }; rest: { close(): void }; transport: QQBotTransport }): Promise<void> {
  await ctx.transport.close()
  ctx.rest.close()
  ctx.gw.close()
}

describe("buildSendBody — official autogen request shapes", () => {
  test("text, markdown, and media bodies pass msg_seq through and omit the other content fields", () => {
    expect(
      buildSendBody({ target: SAMPLE_GROUP_OPENID, msgType: 0, content: "欢迎使用本群助手，有什么可以帮你的吗？", msgId: SAMPLE_MSG_ID, msgSeq: 1 }),
    ).toEqual({
      msg_type: 0,
      content: "欢迎使用本群助手，有什么可以帮你的吗？",
      msg_id: SAMPLE_MSG_ID,
      msg_seq: 1,
    })
    expect(
      buildSendBody({
        target: SAMPLE_GROUP_OPENID,
        msgType: 2,
        markdown: { content: "## 每日签到" },
        msgId: SAMPLE_MSG_ID,
        msgSeq: 1,
      }),
    ).toEqual({
      msg_type: 2,
      markdown: { content: "## 每日签到" },
      msg_id: SAMPLE_MSG_ID,
      msg_seq: 1,
    })
    expect(
      buildSendBody({
        target: SAMPLE_GROUP_OPENID,
        msgType: 7,
        content: "a caption on the image",
        media: { fileInfo: SAMPLE_FILE_INFO },
        msgId: SAMPLE_MSG_ID,
        eventId: "evt-1",
        msgSeq: 2,
      }),
    ).toEqual({
      msg_type: 7,
      content: "a caption on the image",
      media: { file_info: SAMPLE_FILE_INFO },
      msg_id: SAMPLE_MSG_ID,
      event_id: "evt-1",
      msg_seq: 2,
    })
  })
})

describe("mapSendPlatformCode — §4.3 failure table", () => {
  test("every documented platform answer maps to a stable qqbot.send.* code", () => {
    const rows: Array<[number, string]> = [
      [40034128, "qqbot.send.anchor_dead"],
      [40034005, "qqbot.send.anchor_dead"],
      [304027, "qqbot.send.anchor_dead"],
      [304103, "qqbot.send.anchor_dead"],
      [40034024, "qqbot.send.anchor_dead"],
      [40034025, "qqbot.send.anchor_dead"],
      [40034026, "qqbot.send.anchor_dead"],
      [40034027, "qqbot.send.anchor_dead"],
      [40054005, "qqbot.send.deduplicated"],
      [40054007, "qqbot.send.too_long"],
      [40054018, "qqbot.send.too_long"],
      [304036, "qqbot.send.markdown_refused"],
      [40034127, "qqbot.send.markdown_refused"],
      [40034011, "qqbot.send.markdown_refused"],
      [40054010, "qqbot.send.url_not_allowed"],
      [40034100, "qqbot.send.active_rate_limited"],
      [40034105, "qqbot.send.active_off"],
      [40034102, "qqbot.send.active_unpermitted"],
      [40034006, "qqbot.send.audit_rejected"],
      [40054002, "qqbot.send.muted"],
      [40054003, "qqbot.send.not_in_group"],
      [40034101, "qqbot.send.not_in_group"],
      [40054013, "qqbot.send.c2c_refused"],
      [40054004, "qqbot.send.not_friend"],
    ]
    for (const [platform, code] of rows) {
      expect(mapSendPlatformCode(platform)).toBe(code)
    }
  })
})

describe("QQBotTransport.send — platform answers never throw", () => {
  test("posts the autogen body to group and C2C, including msg_seq untouched", async () => {
    const ctx = await started()
    try {
      const ok = await ctx.transport.sendGroup({
        target: SAMPLE_GROUP_OPENID,
        msgType: 0,
        content: "欢迎使用本群助手，有什么可以帮你的吗？",
        msgId: SAMPLE_MSG_ID,
        msgSeq: 3,
      })
      expect(ok).toMatchObject({ ok: true, id: sendSuccess().id, timestamp: sendSuccess().timestamp })
      const call = ctx.rest.calls.find((item) => item.path.endsWith("/messages") && item.path.includes("/groups/"))
      expect(call?.body).toEqual({
        msg_type: 0,
        content: "欢迎使用本群助手，有什么可以帮你的吗？",
        msg_id: SAMPLE_MSG_ID,
        msg_seq: 3,
      })
      expect(call?.headers.authorization).toBe("QQBot ACCESS_TOKEN")
      expect(call?.headers["x-union-appid"]).toBe(APP_ID)

      await ctx.transport.sendC2C({
        target: SAMPLE_USER_OPENID,
        msgType: 2,
        markdown: { content: "hi" },
        eventId: "evt-9",
        msgSeq: 4,
      })
      const c2c = ctx.rest.calls.find((item) => item.path.includes("/users/") && item.path.endsWith("/messages"))
      expect(c2c?.body).toEqual({ msg_type: 2, markdown: { content: "hi" }, event_id: "evt-9", msg_seq: 4 })
    } finally {
      await stop(ctx)
    }
  })

  test("maps each §4.3 answer, does not retry, and 429 carries retryAfterMs", async () => {
    const ctx = await started()
    try {
      const cases: Array<{ status: number; body: unknown; headers?: Record<string, string>; code: string; retryAfterMs?: number }> = [
        { status: 200, body: { code: 40034128, message: "被动回复时间或次数超限" }, code: "qqbot.send.anchor_dead" },
        { status: 200, body: { code: 40034005, message: "回复消息msg_id已过期" }, code: "qqbot.send.anchor_dead" },
        { status: 200, body: { code: 304027, message: "MSG_EXPIRE" }, code: "qqbot.send.anchor_dead" },
        { status: 200, body: { code: 40034024, message: "msg_id无效或越权" }, code: "qqbot.send.anchor_dead" },
        { status: 200, body: { code: 40054005, message: "消息被去重" }, code: "qqbot.send.deduplicated" },
        { status: 200, body: { code: 40054007, message: "消息长度超限" }, code: "qqbot.send.too_long" },
        { status: 200, body: { code: 40054018, message: "消息过长或异常" }, code: "qqbot.send.too_long" },
        { status: 200, body: { code: 304036, message: "无Markdown模板权限" }, code: "qqbot.send.markdown_refused" },
        { status: 200, body: { code: 40054010, message: "不允许发送URL" }, code: "qqbot.send.url_not_allowed" },
        { status: 200, body: { code: 40034100, message: "主动消息发送超过频控限制" }, code: "qqbot.send.active_rate_limited" },
        { status: 429, body: { message: "rate" }, headers: { "Retry-After": "2" }, code: "qqbot.send.rate_limited", retryAfterMs: 2000 },
        { status: 200, body: { code: 40034105, message: "主动消息发送失败，无权限" }, code: "qqbot.send.active_off" },
        { status: 200, body: { code: 40034102, message: "主动消息失败, 无权限" }, code: "qqbot.send.active_unpermitted" },
        { status: 200, body: { code: 40034006, message: "消息内容违规" }, code: "qqbot.send.audit_rejected" },
        { status: 200, body: { code: 40054002, message: "机器人被禁言" }, code: "qqbot.send.muted" },
        { status: 200, body: { code: 40054003, message: "机器人不是群成员" }, code: "qqbot.send.not_in_group" },
        { status: 200, body: { code: 40034101, message: "机器人非群成员" }, code: "qqbot.send.not_in_group" },
        { status: 200, body: { code: 40054013, message: "用户拒收消息" }, code: "qqbot.send.c2c_refused" },
      ]
      for (const row of cases) {
        ctx.rest.sendAnswer = { status: row.status, body: row.body, headers: row.headers }
        const before = ctx.rest.calls.length
        const result = await ctx.transport.sendGroup({
          target: SAMPLE_GROUP_OPENID,
          msgType: 0,
          content: "x",
          msgId: SAMPLE_MSG_ID,
          msgSeq: 1,
        })
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.code).toBe(row.code)
          expect(result.httpStatus).toBe(row.status)
          if (row.retryAfterMs !== undefined) expect(result.retryAfterMs).toBe(row.retryAfterMs)
        }
        expect(ctx.rest.calls.length - before).toBe(1)
      }

      ctx.rest.sendAnswer = {
        status: 200,
        body: { id: "mid", timestamp: "2026-07-21T10:00:00+08:00", message_audit: { audit_id: "aud-1" } },
      }
      const audited = await ctx.transport.sendGroup({
        target: SAMPLE_GROUP_OPENID,
        msgType: 0,
        content: "x",
        msgId: SAMPLE_MSG_ID,
        msgSeq: 1,
      })
      expect(audited).toMatchObject({ ok: true, id: "mid", auditId: "aud-1" })
    } finally {
      await stop(ctx)
    }
  })

  test("a hung send is qqbot.send.timeout and is not retried", async () => {
    const ctx = await started()
    ctx.rest.hangSend = true
    try {
      const result = await ctx.transport.sendGroup({
        target: SAMPLE_GROUP_OPENID,
        msgType: 0,
        content: "x",
        msgSeq: 1,
      })
      expect(result).toMatchObject({ ok: false, code: "qqbot.send.timeout", httpStatus: 0 })
    } finally {
      ctx.rest.hangSend = false
      await stop(ctx)
    }
  })

  test("304023 without audit_id is audit_pending; 2xx code 0 with no id is possibly delivered", async () => {
    const ctx = await started()
    try {
      ctx.rest.sendAnswer = { status: 200, body: { code: 304023, message: "push message is waiting for audit now" } }
      const pending = await ctx.transport.sendGroup({
        target: SAMPLE_GROUP_OPENID,
        msgType: 0,
        content: "x",
        msgSeq: 1,
      })
      expect(pending).toMatchObject({ ok: false, code: "qqbot.send.audit_pending", platformCode: 304023 })

      ctx.rest.sendAnswer = { status: 200, body: { code: 0 } }
      const delivered = await ctx.transport.sendGroup({
        target: SAMPLE_GROUP_OPENID,
        msgType: 0,
        content: "x",
        msgSeq: 2,
      })
      expect(delivered.ok).toBe(true)
      if (delivered.ok) expect(delivered.id).toBeUndefined()
    } finally {
      await stop(ctx)
    }
  })

  test("auth failure on send surfaces qqbot.auth.* rather than qqbot.send.failed", async () => {
    const clock = new FakeClock(0)
    const gw = startFakeQQBotGateway({ heartbeatIntervalMs: 3_600_000 })
    const rest = startFakeQQBotRest({
      appId: APP_ID,
      clientSecret: SECRET,
      gatewayUrl: gw.url,
      expiresIn: 40,
      stickyToken: true,
      now: () => clock.now(),
    })
    const transport = new QQBotTransport({
      appId: APP_ID,
      clientSecret: SECRET,
      transport: "websocket",
      receiveAll: false,
      apiBase: rest.apiBase,
      authBase: rest.authBase,
      requestTimeoutMs: 1000,
      clock,
      invalidSessionJitterMs: () => 0,
    })
    try {
      await transport.start()
      await clock.advance(40_000 + 1)
      await waitFor(() => rest.tokenCalls.length >= 2)
      rest.tokenStatus = 401
      const result = await transport.sendGroup({
        target: SAMPLE_GROUP_OPENID,
        msgType: 0,
        content: "x",
        msgSeq: 1,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code.startsWith("qqbot.auth.")).toBe(true)
        expect(result.code).not.toBe("qqbot.send.failed")
      }
    } finally {
      await transport.close()
      rest.close()
      gw.close()
    }
  })

  test("concurrent sends after expiry share one token POST", async () => {
    const clock = new FakeClock(0)
    const gw = startFakeQQBotGateway({ heartbeatIntervalMs: 3_600_000 })
    const rest = startFakeQQBotRest({
      appId: APP_ID,
      clientSecret: SECRET,
      gatewayUrl: gw.url,
      expiresIn: 40,
      stickyToken: true,
      now: () => clock.now(),
    })
    const transport = new QQBotTransport({
      appId: APP_ID,
      clientSecret: SECRET,
      transport: "websocket",
      receiveAll: false,
      apiBase: rest.apiBase,
      authBase: rest.authBase,
      requestTimeoutMs: 1000,
      clock,
      invalidSessionJitterMs: () => 0,
    })
    try {
      await transport.start()
      await clock.advance(40_000 + 1)
      await waitFor(() => rest.tokenCalls.length >= 2)
      const before = rest.tokenCalls.length
      await Promise.all([
        transport.sendGroup({ target: SAMPLE_GROUP_OPENID, msgType: 0, content: "a", msgSeq: 1 }),
        transport.sendGroup({ target: SAMPLE_GROUP_OPENID, msgType: 0, content: "b", msgSeq: 2 }),
        transport.sendGroup({ target: SAMPLE_GROUP_OPENID, msgType: 0, content: "c", msgSeq: 3 }),
      ])
      expect(rest.tokenCalls.length - before).toBe(1)
    } finally {
      await transport.close()
      rest.close()
      gw.close()
    }
  })
})

describe("uploadPartTimeoutMs", () => {
  test("is 30 s plus 10 s per MiB, never below the 5 s docs floor", () => {
    expect(uploadPartTimeoutMs(0, 30_000, 10_000)).toBe(30_000)
    expect(uploadPartTimeoutMs(1024 * 1024, 30_000, 10_000)).toBe(40_000)
    expect(uploadPartTimeoutMs(1024 * 1024 + 1, 30_000, 10_000)).toBe(50_000)
    expect(MIN_REQUEST_TIMEOUT_MS).toBe(5_000)
    expect(30_000).toBeGreaterThan(MIN_REQUEST_TIMEOUT_MS)
  })
})

describe("QQBotTransport — media upload", () => {
  test("URL path posts /files with srv_send_msg false and returns ttl", async () => {
    const ctx = await started()
    try {
      const result = await ctx.transport.uploadGroupMedia({
        groupOpenid: SAMPLE_GROUP_OPENID,
        url: "https://example.com/image.png",
        fileType: FILE_TYPE.IMAGE,
      })
      expect(result).toMatchObject({ fileInfo: SAMPLE_FILE_INFO, ttl: 300 })
      const call = ctx.rest.calls.find((item) => item.path.endsWith("/files"))
      expect(call?.body).toEqual({
        file_type: 1,
        url: "https://example.com/image.png",
        srv_send_msg: false,
      })
    } finally {
      await stop(ctx)
    }
  })

  test("bytes take the 4-step chunked session then /files with upload_id", async () => {
    const ctx = await started()
    try {
      const bytes = new Uint8Array(12).map((_, i) => i + 1)
      const result = await ctx.transport.uploadC2CMedia({
        userOpenid: SAMPLE_USER_OPENID,
        bytes,
        fileType: FILE_TYPE.IMAGE,
        fileName: "still.png",
      })
      expect(result.fileInfo).toBe(SAMPLE_FILE_INFO)
      expect(result.ttl).toBe(300)
      const prepare = ctx.rest.calls.find((item) => item.path.endsWith("/upload_prepare"))
      const prepareBody = prepare?.body as Record<string, unknown>
      expect(prepareBody.file_type).toBe(1)
      expect(prepareBody.file_size).toBe("12")
      expect(prepareBody.file_name).toBe("still.png")
      expect(typeof prepareBody.md5).toBe("string")
      expect(typeof prepareBody.sha1).toBe("string")
      expect(typeof prepareBody.md5_10m).toBe("string")
      expect(ctx.rest.uploadedParts.size).toBeGreaterThanOrEqual(1)
      expect(ctx.rest.finishedParts.length).toBeGreaterThanOrEqual(1)
      const files = ctx.rest.calls.filter((item) => item.path.endsWith("/files")).at(-1)
      expect(files?.body).toMatchObject({
        file_type: 1,
        srv_send_msg: false,
        file_name: "still.png",
        upload_id: "upload_a1b2c3d4e5f6",
      })
      expect((files?.body as { url?: string }).url).toBeUndefined()
    } finally {
      await stop(ctx)
    }
  })
})
