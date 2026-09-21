import { describe, expect, test } from "bun:test"
import { toPortSendResult, toTransportSendRequest } from "./adapter"

describe("QQBotTransportPort mapping", () => {
  test("snake_case port request becomes camelCase transport request including file_info", () => {
    expect(
      toTransportSendRequest("G1", {
        msg_type: 7,
        msg_seq: 3,
        content: "caption",
        markdown: { content: "**hi**" },
        media: { file_info: "FI-1" },
        msg_id: "MID",
        event_id: "EID",
      }),
    ).toEqual({
      target: "G1",
      msgType: 7,
      msgSeq: 3,
      content: "caption",
      markdown: { content: "**hi**" },
      media: { fileInfo: "FI-1" },
      msgId: "MID",
      eventId: "EID",
    })
  })

  test("transport success/failure map onto the port result, with timeout and markdown as strings", () => {
    expect(toPortSendResult({ ok: true, id: "m1", auditId: "a1" })).toEqual({
      ok: true,
      messageId: "m1",
      auditId: "a1",
    })
    expect(toPortSendResult({ ok: false, code: "qqbot.send.timeout", message: "t", httpStatus: 0 })).toEqual({
      ok: false,
      code: "timeout",
      message: "t",
    })
    expect(
      toPortSendResult({
        ok: false,
        code: "qqbot.send.markdown_refused",
        message: "md",
        httpStatus: 400,
        platformCode: 304036,
      }),
    ).toEqual({ ok: false, code: "markdown_refused", message: "md" })
    expect(
      toPortSendResult({
        ok: false,
        code: "qqbot.send.active_off",
        message: "off",
        httpStatus: 400,
        platformCode: 40034105,
      }),
    ).toEqual({ ok: false, code: 40034105, message: "off" })
  })
})
