import { FILE_TYPE } from "./constants"
import {
  type QQBotSendPort,
  type QQBotSendRequest,
  type QQBotSendResult,
  type QQBotSwitchEvent,
} from "./port"
import {
  QQBotTransport,
  type QQBotSendRequest as QQBotTransportSendRequest,
  type QQBotSendResult as QQBotTransportSendResult,
  type QQBotUploadResult,
} from "./transport"

function fileTypeFor(mime?: string): number {
  if (!mime) return FILE_TYPE.IMAGE
  const lower = mime.toLowerCase()
  if (lower.startsWith("image/")) return FILE_TYPE.IMAGE
  if (lower.startsWith("video/")) return FILE_TYPE.VIDEO
  if (lower.startsWith("audio/")) return FILE_TYPE.VOICE
  return FILE_TYPE.FILE
}

export function toTransportSendRequest(target: string, req: QQBotSendRequest): QQBotTransportSendRequest {
  const out: QQBotTransportSendRequest = {
    target,
    msgType: req.msg_type,
    msgSeq: req.msg_seq ?? 0,
  }
  if (req.content !== undefined) out.content = req.content
  if (req.markdown) out.markdown = req.markdown
  if (req.media) out.media = { fileInfo: req.media.file_info }
  if (req.msg_id) out.msgId = req.msg_id
  if (req.event_id) out.eventId = req.event_id
  return out
}

function withRetryAfter(fail: QQBotSendResult, retryAfterMs: number | undefined): QQBotSendResult {
  if (fail.ok || retryAfterMs === undefined) return fail
  return { ...fail, retryAfterMs }
}

export function toPortSendResult(result: QQBotTransportSendResult): QQBotSendResult {
  if (result.ok) {
    const ok: QQBotSendResult = { ok: true }
    if (result.id) ok.messageId = result.id
    if (result.auditId) ok.auditId = result.auditId
    return ok
  }
  if (result.code === "qqbot.send.timeout") {
    return { ok: false, code: "timeout", message: result.message }
  }
  if (result.code === "qqbot.send.markdown_refused") {
    return { ok: false, code: "markdown_refused", message: result.message }
  }
  if (result.platformCode !== undefined) {
    return withRetryAfter(
      { ok: false, code: result.platformCode, message: result.message },
      result.retryAfterMs,
    )
  }
  if (result.httpStatus === 429) {
    return withRetryAfter({ ok: false, code: 429, message: result.message }, result.retryAfterMs)
  }
  return withRetryAfter({ ok: false, code: result.code, message: result.message }, result.retryAfterMs)
}

function toPortUpload(result: QQBotUploadResult | undefined): { file_info: string } | undefined {
  const fileInfo = result?.fileInfo
  return fileInfo ? { file_info: fileInfo } : undefined
}

/**
 * Snake_case `QQBotSendPort` (deliverer) → camelCase `QQBotTransport` (WS1).
 * Switch events are pushed in by the entry (`emitSwitch`); they are not
 * subscribed from the transport here so the inbound router stays the single
 * event consumer.
 */
export class QQBotTransportPort implements QQBotSendPort {
  private readonly handlers = new Set<(event: QQBotSwitchEvent) => void>()

  constructor(private readonly transport: QQBotTransport) {}

  async sendGroup(groupOpenid: string, req: QQBotSendRequest): Promise<QQBotSendResult> {
    return toPortSendResult(await this.transport.sendGroup(toTransportSendRequest(groupOpenid, req)))
  }

  async sendC2C(userOpenid: string, req: QQBotSendRequest): Promise<QQBotSendResult> {
    return toPortSendResult(await this.transport.sendC2C(toTransportSendRequest(userOpenid, req)))
  }

  async uploadGroupMedia(
    groupOpenid: string,
    bytes: Uint8Array,
    mime?: string,
    name?: string,
  ): Promise<{ file_info: string } | undefined> {
    try {
      return toPortUpload(
        await this.transport.uploadGroupMedia({
          groupOpenid,
          fileType: fileTypeFor(mime),
          bytes,
          ...(name ? { fileName: name } : {}),
        }),
      )
    } catch {
      return undefined
    }
  }

  async uploadC2CMedia(
    userOpenid: string,
    bytes: Uint8Array,
    mime?: string,
    name?: string,
  ): Promise<{ file_info: string } | undefined> {
    try {
      return toPortUpload(
        await this.transport.uploadC2CMedia({
          userOpenid,
          fileType: fileTypeFor(mime),
          bytes,
          ...(name ? { fileName: name } : {}),
        }),
      )
    } catch {
      return undefined
    }
  }

  onEvent(handler: (event: QQBotSwitchEvent) => void): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  emitSwitch(event: QQBotSwitchEvent): void {
    for (const handler of this.handlers) handler(event)
  }
}
