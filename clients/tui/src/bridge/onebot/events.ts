import { MAX_ATTACHMENT_BYTES, RECENT_MESSAGE_LIMIT } from "./constants"
import { asInteger, stringId } from "./shared"

const CQ_CODE_RE = /\[CQ:([A-Za-z0-9_.-]+)(?:,([^\]]*))?\]/g
const ATTACHMENT_TYPES = new Set(["image", "record", "video", "file"])

export interface OneBotSender {
  userId: string
  name?: string
}

export interface OneBotAttachment {
  id: string
  name: string
  mime: string
  size: number
  url?: string
  data?: Uint8Array
}

export interface OneBotInbound {
  chatType: "group" | "private"
  chatId: string
  groupId?: string
  sender: OneBotSender
  text: string
  atSelf: boolean
  replyToId?: string
  messageId?: string
  attachments: OneBotAttachment[]
  raw: Record<string, unknown>
}

export interface OneBotSegment {
  type: string
  data: Record<string, unknown>
}

export class RecentMessageWindow {
  private readonly seen = new Map<string, null>()

  constructor(private readonly limit = RECENT_MESSAGE_LIMIT) {}

  /** True when this key was already observed (duplicate). Missing ids are never recorded. */
  remember(selfId: string, chatType: string, chatId: string, messageId: string): boolean {
    const key = `${selfId}\0${chatType}\0${chatId}\0${messageId}`
    if (this.seen.has(key)) {
      this.seen.delete(key)
      this.seen.set(key, null)
      return true
    }
    this.seen.set(key, null)
    while (this.seen.size > this.limit) {
      const first = this.seen.keys().next().value
      if (first === undefined) break
      this.seen.delete(first)
    }
    return false
  }

  get size(): number {
    return this.seen.size
  }
}

export function parseOneBotEvent(event: Record<string, unknown>): OneBotInbound | null {
  if (event.post_type !== "message") return null
  const messageType = String(event.message_type ?? "").toLowerCase()
  if (messageType !== "group" && messageType !== "private") return null

  const selfId = stringId(event.self_id)
  const userId = stringId(event.user_id)
  if (userId === undefined || (selfId !== undefined && userId === selfId)) return null

  let chatId: string | undefined
  let chatType: "group" | "private"
  let groupId: string | undefined
  if (messageType === "group") {
    chatId = stringId(event.group_id)
    chatType = "group"
    groupId = chatId
  } else {
    chatId = userId
    chatType = "private"
  }
  if (chatId === undefined) return null

  let rawMessage: unknown = event.message
  if (typeof rawMessage !== "string" && !Array.isArray(rawMessage)) {
    rawMessage = event.raw_message
  }
  const decoded = decodeMessage(rawMessage, selfId)
  if (!decoded.text && decoded.attachments.length === 0) return null

  const senderRaw = event.sender && typeof event.sender === "object" ? (event.sender as Record<string, unknown>) : {}
  return {
    chatType,
    chatId,
    ...(groupId !== undefined ? { groupId } : {}),
    sender: { userId, ...(senderName(senderRaw) ? { name: senderName(senderRaw) } : {}) },
    text: decoded.text,
    atSelf: decoded.atSelf,
    ...(decoded.replyToId !== undefined ? { replyToId: decoded.replyToId } : {}),
    ...(stringId(event.message_id) !== undefined ? { messageId: stringId(event.message_id) } : {}),
    attachments: decoded.attachments,
    raw: event,
  }
}

export function ingestEvent(event: Record<string, unknown>, window: RecentMessageWindow): OneBotInbound | null {
  const inbound = parseOneBotEvent(event)
  if (inbound === null) return null
  if (inbound.messageId !== undefined) {
    const selfId = String(event.self_id ?? "")
    if (window.remember(selfId, inbound.chatType, inbound.chatId, inbound.messageId)) return null
  }
  return inbound
}

export function decodeMessage(
  message: unknown,
  selfId: string | undefined,
): { text: string; atSelf: boolean; attachments: OneBotAttachment[]; replyToId?: string } {
  const segments: unknown[] = Array.isArray(message) ? message : cqSegments(String(message ?? ""))
  const textParts: string[] = []
  const attachments: OneBotAttachment[] = []
  let atSelf = false
  let stripNext = false
  let replyToId: string | undefined
  for (const item of segments) {
    if (typeof item !== "object" || item === null) continue
    const rec = item as Record<string, unknown>
    const segmentType = String(rec.type ?? "").toLowerCase()
    const data = rec.data && typeof rec.data === "object" ? (rec.data as Record<string, unknown>) : {}
    if (segmentType === "text") {
      let value = String(data.text ?? "")
      if (stripNext) {
        value = value.replace(/^\s+/, "")
        stripNext = false
      }
      textParts.push(value)
    } else if (segmentType === "at") {
      const target = stringId(data.qq)
      if (selfId !== undefined && target === selfId) {
        atSelf = true
        stripNext = true
      } else if (target) {
        textParts.push(`@${target}`)
      }
    } else if (segmentType === "reply") {
      replyToId = stringId(data.id ?? data.message_id) ?? replyToId
    } else if (ATTACHMENT_TYPES.has(segmentType)) {
      const attachment = attachmentFromSegment(segmentType, data)
      if (attachment) attachments.push(attachment)
    }
  }
  return { text: textParts.join("").trim(), atSelf, attachments, ...(replyToId !== undefined ? { replyToId } : {}) }
}

export function cqSegments(message: string): OneBotSegment[] {
  const segments: OneBotSegment[] = []
  let position = 0
  CQ_CODE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CQ_CODE_RE.exec(message)) !== null) {
    if (match.index > position) {
      segments.push({ type: "text", data: { text: cqUnescape(message.slice(position, match.index)) } })
    }
    const data: Record<string, unknown> = {}
    for (const rawParameter of (match[2] ?? "").split(",")) {
      if (!rawParameter) continue
      const eq = rawParameter.indexOf("=")
      if (eq >= 0) data[rawParameter.slice(0, eq)] = cqUnescape(rawParameter.slice(eq + 1))
    }
    segments.push({ type: match[1] ?? "", data })
    position = match.index + match[0].length
  }
  if (position < message.length) {
    segments.push({ type: "text", data: { text: cqUnescape(message.slice(position)) } })
  }
  return segments
}

export function cqUnescape(value: string): string {
  return value.replace(/&#44;/g, ",").replace(/&#91;/g, "[").replace(/&#93;/g, "]").replace(/&amp;/g, "&")
}

export function eventPartition(payload: Record<string, unknown>): string {
  const selfId = String(payload.self_id ?? "")
  const postType = String(payload.post_type ?? "event").toLowerCase()
  const messageType = String(payload.message_type ?? "").toLowerCase()
  let target = ""
  if (postType === "message" && messageType === "group") target = String(payload.group_id ?? "")
  else if (postType === "message" && messageType === "private") target = String(payload.user_id ?? "")
  else target = String(payload.group_id ?? payload.user_id ?? "")
  return `${selfId}:${postType}:${messageType}:${target}`
}

function senderName(sender: Record<string, unknown>): string | undefined {
  for (const key of ["card", "nickname"] as const) {
    const value = sender[key]
    if (value) return String(value)
  }
  return undefined
}

function attachmentFromSegment(segmentType: string, data: Record<string, unknown>): OneBotAttachment | null {
  const fileValue = String(data.file ?? "")
  const urlValue = String(data.url ?? "")
  let url: string | undefined
  if (httpUrl(urlValue)) url = urlValue
  else if (httpUrl(fileValue)) url = fileValue

  let rawData: Uint8Array | undefined
  if (fileValue.startsWith("base64://")) {
    const encoded = fileValue.slice("base64://".length)
    if (encoded.length > (MAX_ATTACHMENT_BYTES * 4) / 3 + 4) return null
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null
    try {
      const decoded = Buffer.from(encoded, "base64")
      if (decoded.byteLength > MAX_ATTACHMENT_BYTES) return null
      rawData = new Uint8Array(decoded)
    } catch {
      return null
    }
  }

  const name = String(data.name ?? "") || attachmentName(url || fileValue, segmentType)
  const mime = attachmentMime(segmentType, name)
  const size = asInteger(data.file_size ?? data.size, 0)
  return {
    id: fileValue || urlValue || name,
    name,
    mime,
    size: size >= 0 ? size : 0,
    ...(url ? { url } : {}),
    ...(rawData ? { data: rawData } : {}),
  }
}

function httpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase()
    return scheme === "http" || scheme === "https"
  } catch {
    return false
  }
}

function attachmentName(value: string, segmentType: string): string {
  try {
    const path = value.includes("://") ? new URL(value).pathname : value
    const name = path.split("/").filter(Boolean).pop() ?? ""
    return name || segmentType
  } catch {
    return segmentType
  }
}

function attachmentMime(segmentType: string, name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : ""
  const guessed: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
  }
  if (ext && guessed[ext]) return guessed[ext]
  return (
    {
      image: "image/jpeg",
      record: "audio/ogg",
      video: "video/mp4",
      file: "application/octet-stream",
    }[segmentType] ?? "application/octet-stream"
  )
}
