/** Minimal send/upload/switch-event surface. WS1 owns the real transport; WS4 wires it. */

export type QQBotMsgType = 0 | 2 | 7

export interface QQBotMarkdown {
  content: string
}

export interface QQBotSendRequest {
  content?: string
  markdown?: QQBotMarkdown
  msg_type: QQBotMsgType
  msg_id?: string
  event_id?: string
  msg_seq?: number
  media?: { file_info: string }
}

export interface QQBotSendOk {
  ok: true
  messageId?: string
  auditId?: string
}

export type QQBotSendFailCode =
  | number
  | "timeout"
  | "markdown_refused"
  | string

export interface QQBotSendFail {
  ok: false
  code: QQBotSendFailCode
  message?: string
}

export type QQBotSendResult = QQBotSendOk | QQBotSendFail

export type QQBotSwitchEvent =
  | { type: "groupMsgReceive"; groupOpenid: string }
  | { type: "groupMsgReject"; groupOpenid: string }
  | { type: "c2cMsgReceive"; userOpenid: string }
  | { type: "c2cMsgReject"; userOpenid: string }

export interface QQBotMediaUpload {
  file_info: string
}

export interface QQBotSendPort {
  sendGroup(groupOpenid: string, req: QQBotSendRequest): Promise<QQBotSendResult>
  sendC2C(userOpenid: string, req: QQBotSendRequest): Promise<QQBotSendResult>
  uploadGroupMedia(
    groupOpenid: string,
    bytes: Uint8Array,
    mime?: string,
    name?: string,
  ): Promise<QQBotMediaUpload | undefined>
  uploadC2CMedia(
    userOpenid: string,
    bytes: Uint8Array,
    mime?: string,
    name?: string,
  ): Promise<QQBotMediaUpload | undefined>
  onEvent(handler: (event: QQBotSwitchEvent) => void): () => void
}

export function isSendOk(result: QQBotSendResult): result is QQBotSendOk {
  return result.ok === true
}

export function numericCode(result: QQBotSendFail): number | undefined {
  return typeof result.code === "number" ? result.code : undefined
}
