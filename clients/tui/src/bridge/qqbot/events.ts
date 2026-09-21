import { RECENT_EVENT_LIMIT } from "./constants"
import { asInteger, stringId } from "./shared"

export interface QQBotAttachment {
  url: string
  contentType: string
  filename: string
  size: number
  width?: number
  height?: number
}

export type QQBotMessageType = "groupAtMessage" | "groupMessage" | "c2cMessage"

export interface QQBotMessageEvent {
  type: QQBotMessageType
  id: string
  eventId: string
  timestamp: string
  groupOpenid?: string
  memberOpenid?: string
  userOpenid?: string
  unionOpenid?: string
  username?: string
  content: string
  attachments: QQBotAttachment[]
}

export type QQBotGroupRobotType = "groupAddRobot" | "groupDelRobot" | "groupMsgReceive" | "groupMsgReject"

export interface QQBotGroupRobotEvent {
  type: QQBotGroupRobotType
  eventId: string
  timestamp: string
  groupOpenid: string
  opMemberOpenid?: string
}

export type QQBotFriendType = "friendAdd" | "friendDel" | "c2cMsgReceive" | "c2cMsgReject"

export interface QQBotFriendEvent {
  type: QQBotFriendType
  eventId: string
  timestamp: string
  userOpenid: string
}

export type QQBotEvent = QQBotMessageEvent | QQBotGroupRobotEvent | QQBotFriendEvent

const MESSAGE_TYPES: Record<string, QQBotMessageType> = {
  GROUP_AT_MESSAGE_CREATE: "groupAtMessage",
  GROUP_MESSAGE_CREATE: "groupMessage",
  C2C_MESSAGE_CREATE: "c2cMessage",
}

const GROUP_ROBOT_TYPES: Record<string, QQBotGroupRobotType> = {
  GROUP_ADD_ROBOT: "groupAddRobot",
  GROUP_DEL_ROBOT: "groupDelRobot",
  GROUP_MSG_RECEIVE: "groupMsgReceive",
  GROUP_MSG_REJECT: "groupMsgReject",
}

const FRIEND_TYPES: Record<string, QQBotFriendType> = {
  FRIEND_ADD: "friendAdd",
  FRIEND_DEL: "friendDel",
  C2C_MSG_RECEIVE: "c2cMsgReceive",
  C2C_MSG_REJECT: "c2cMsgReject",
}

export class RecentEventWindow {
  private readonly seen = new Map<string, null>()

  constructor(private readonly limit = RECENT_EVENT_LIMIT) {}

  /** True when this key was already observed. Empty keys are never recorded. */
  remember(key: string): boolean {
    if (!key) return false
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

export interface GatewayPayload {
  op: number
  d: unknown
  s?: number | null
  t?: string
  id?: string
}

export function parseGatewayPayload(raw: unknown): GatewayPayload | undefined {
  const rec = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
  if (!rec || rec.op === undefined) return undefined
  const op = asInteger(rec.op, Number.NaN)
  if (!Number.isFinite(op)) return undefined
  const payload: GatewayPayload = { op, d: rec.d }
  if (rec.s !== undefined && rec.s !== null) payload.s = asInteger(rec.s, 0)
  else if (rec.s === null) payload.s = null
  if (typeof rec.t === "string") payload.t = rec.t
  if (rec.id !== undefined && rec.id !== null) payload.id = String(rec.id)
  return payload
}

/**
 * Map a Dispatch (op 0) to a typed event. READY / RESUMED / unknown types return null.
 * `receiveAll` only gates GROUP_MESSAGE_CREATE — the platform still delivers it when
 * the bot has that capability; the transport drops it unless the option is on.
 */
export function parseDispatch(payload: GatewayPayload, receiveAll: boolean): QQBotEvent | null {
  if (payload.op !== 0) return null
  const t = payload.t ?? ""
  if (t === "READY" || t === "RESUMED") return null
  const eventId = payload.id ?? ""
  const data =
    payload.d && typeof payload.d === "object" && !Array.isArray(payload.d)
      ? (payload.d as Record<string, unknown>)
      : {}

  const messageType = MESSAGE_TYPES[t]
  if (messageType) {
    if (messageType === "groupMessage" && !receiveAll) return null
    return parseMessageEvent(messageType, eventId, data)
  }
  const groupType = GROUP_ROBOT_TYPES[t]
  if (groupType) return parseGroupRobotEvent(groupType, eventId, data)
  const friendType = FRIEND_TYPES[t]
  if (friendType) return parseFriendEvent(friendType, eventId, data)
  return null
}

export function ingestDispatch(
  payload: GatewayPayload,
  window: RecentEventWindow,
  receiveAll: boolean,
): QQBotEvent | null {
  const event = parseDispatch(payload, receiveAll)
  if (event === null) return null
  const key = dedupeKey(event)
  if (window.remember(key)) return null
  return event
}

function dedupeKey(event: QQBotEvent): string {
  if (event.type === "groupAtMessage" || event.type === "groupMessage" || event.type === "c2cMessage") {
    return event.id ? `message:${event.id}` : ""
  }
  return event.eventId ? `event:${event.eventId}` : ""
}

function parseMessageEvent(
  type: QQBotMessageType,
  eventId: string,
  data: Record<string, unknown>,
): QQBotMessageEvent | null {
  const id = stringId(data.id)
  if (id === undefined) return null
  const author =
    data.author && typeof data.author === "object" && !Array.isArray(data.author)
      ? (data.author as Record<string, unknown>)
      : {}
  const content = trimLeadingAtSpace(String(data.content ?? ""))
  const event: QQBotMessageEvent = {
    type,
    id,
    eventId,
    timestamp: stringifyTimestamp(data.timestamp),
    content,
    attachments: parseAttachments(data.attachments),
  }
  const groupOpenid = stringId(data.group_openid)
  if (groupOpenid) event.groupOpenid = groupOpenid
  const memberOpenid = stringId(author.member_openid)
  if (memberOpenid) event.memberOpenid = memberOpenid
  const userOpenid = stringId(author.user_openid)
  if (userOpenid) event.userOpenid = userOpenid
  const unionOpenid = stringId(author.union_openid)
  if (unionOpenid) event.unionOpenid = unionOpenid
  const username = stringId(author.username)
  if (username) event.username = username
  return event
}

function parseGroupRobotEvent(
  type: QQBotGroupRobotType,
  eventId: string,
  data: Record<string, unknown>,
): QQBotGroupRobotEvent | null {
  const groupOpenid = stringId(data.group_openid)
  if (!groupOpenid) return null
  const event: QQBotGroupRobotEvent = {
    type,
    eventId,
    timestamp: stringifyTimestamp(data.timestamp),
    groupOpenid,
  }
  const op = stringId(data.op_member_openid)
  if (op) event.opMemberOpenid = op
  return event
}

function parseFriendEvent(
  type: QQBotFriendType,
  eventId: string,
  data: Record<string, unknown>,
): QQBotFriendEvent | null {
  const userOpenid = stringId(data.openid) ?? stringId(data.user_openid)
  if (!userOpenid) return null
  return {
    type,
    eventId,
    timestamp: stringifyTimestamp(data.timestamp),
    userOpenid,
  }
}

function parseAttachments(raw: unknown): QQBotAttachment[] {
  if (!Array.isArray(raw)) return []
  const out: QQBotAttachment[] = []
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue
    const rec = item as Record<string, unknown>
    const url = stringId(rec.url)
    if (!url) continue
    const attachment: QQBotAttachment = {
      url,
      contentType: String(rec.content_type ?? ""),
      filename: String(rec.filename ?? ""),
      size: Math.max(0, asInteger(rec.size, 0)),
    }
    const width = asInteger(rec.width, Number.NaN)
    if (Number.isFinite(width) && width > 0) attachment.width = width
    const height = asInteger(rec.height, Number.NaN)
    if (Number.isFinite(height) && height > 0) attachment.height = height
    out.push(attachment)
  }
  return out
}

/** The platform leaves a leading space after stripping the @-bot prefix. */
export function trimLeadingAtSpace(content: string): string {
  return content.replace(/^[ \t]+/, "")
}

function stringifyTimestamp(value: unknown): string {
  if (value === undefined || value === null) return ""
  return String(value)
}
