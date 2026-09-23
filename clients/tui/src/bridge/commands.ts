import { tt, type MessageKey } from "../i18n"
import type { GroupMode } from "./config"
import { LastKeeperError, ObserverProtectedError, keyNameFromDisplay } from "./keyring"
import type { IdentityStore } from "./qqbot/identity"

const BRIDGE_RE = /^\s*[./。]bridge(?:\s+(.*))?$/i

export function isBridgeCommand(text: string): boolean {
  return BRIDGE_RE.test(text)
}

/** Engine command prefixes the spec names: `.` `/` `。`, plus a bare `r `/`rd `. */
export function looksLikeCommand(text: string): boolean {
  const trimmed = text.trim()
  if (/^[./。]/.test(trimmed)) return true
  if (/^rd?\s/i.test(trimmed)) return true
  return false
}

export function shouldForwardInbound(options: {
  text: string
  channel: "group" | "private"
  mode: GroupMode
  mentioned: boolean
}): boolean {
  if (isBridgeCommand(options.text)) return false
  if (options.channel === "private") return true
  if (looksLikeCommand(options.text)) return true
  if (options.mode === "all") return true
  return options.mentioned
}

export type ParsedBridgeCommand =
  | { name: "status" }
  | { name: "members" }
  | { name: "kick"; userId: string }
  | { name: "admin"; op: "add" | "remove"; userId: string }
  | { name: "mode"; mode: GroupMode }
  | { name: "notice"; on: boolean }
  | { name: "claim"; code: string }
  | { name: "name"; display: string }
  | { name: "deferred" }
  | { name: "usage"; key: MessageKey }
  | { name: "unknown" }

export function parseBridgeCommand(text: string): ParsedBridgeCommand | undefined {
  const match = text.trim().match(BRIDGE_RE)
  if (!match) return undefined
  const args = (match[1] ?? "").trim()
  if (!args) return { name: "unknown" }
  const [head, ...rest] = args.split(/\s+/)
  const verb = (head ?? "").toLowerCase()
  if (verb === "status") return { name: "status" }
  if (verb === "members") return { name: "members" }
  if (verb === "kick") {
    const userId = rest[0]?.trim()
    if (!userId) return { name: "usage", key: "bridge.usage.kick" }
    return { name: "kick", userId }
  }
  if (verb === "admin") {
    const op = rest[0]?.toLowerCase()
    const userId = rest[1]?.trim()
    if ((op !== "add" && op !== "remove") || !userId) return { name: "usage", key: "bridge.usage.admin" }
    return { name: "admin", op, userId }
  }
  if (verb === "mode") {
    const mode = rest[0]?.toLowerCase()
    if (mode !== "all" && mode !== "mention") return { name: "usage", key: "bridge.usage.mode" }
    return { name: "mode", mode }
  }
  if (verb === "notice") {
    const flag = rest[0]?.toLowerCase()
    if (flag !== "on" && flag !== "off") return { name: "usage", key: "bridge.usage.notice" }
    return { name: "notice", on: flag === "on" }
  }
  if (verb === "claim") return { name: "claim", code: rest.join("").trim() }
  if (verb === "name") return { name: "name", display: args.slice(head.length).trim() }
  if (verb === "deferred") return { name: "deferred" }
  return { name: "unknown" }
}

export interface DeferredSummary {
  length: number
  oldestAgeMs?: number
}

export interface BridgeCommandView {
  locale?: string
  groupId: string
  mode: GroupMode
  busyNotice: boolean
  admins: readonly string[]
  members: ReadonlyArray<{ userId: string; keyId: string; role: string; name?: string }>
  lateHolds?: number
  deferredSummary?: DeferredSummary
  channel?: "group" | "private"
  seat?: string
  userOpenid?: string
  memberOpenid?: string
  unionOpenid?: string
  username?: string
}

export interface BridgeCommandEffects {
  setMode(mode: GroupMode): void
  setBusyNotice(on: boolean): void
  addAdmin(userId: string): void
  removeAdmin(userId: string): void
  kick(userId: string): Promise<void>
  identity?: IdentityStore
  hasCharacter?: (seat: string) => boolean
  remintSeat?: (userId: string, displayName: string) => Promise<{ previousKey?: string; name: string }>
  onSeatReminted?: (userId: string, previousKey: string) => void
  onLog?: (line: string) => void
}

function msg(locale: string | undefined, key: MessageKey, vars?: Record<string, string | number>): string {
  return tt(locale, key, vars)
}

/**
 * Admin-only `.bridge` commands, plus qqbot `claim` (gate-exempt) and `name`
 * (any seat, only when an IdentityStore is wired). Never forwarded to the
 * engine: the caller must intercept `isBridgeCommand` before `input`.
 */
export async function runBridgeCommand(
  text: string,
  isAdmin: boolean,
  view: BridgeCommandView,
  effects: BridgeCommandEffects,
): Promise<string | undefined> {
  const parsed = parseBridgeCommand(text)
  if (!parsed) return undefined
  if (parsed.name === "claim" && effects.identity) return runClaim(parsed, view, effects)
  if (parsed.name === "name") {
    if (!effects.identity) {
      if (!isAdmin) return msg(view.locale, "bridge.notAdmin")
      return msg(view.locale, "bridge.unknown")
    }
    return runName(parsed, view, effects)
  }
  if (!isAdmin) return msg(view.locale, "bridge.notAdmin")
  switch (parsed.name) {
    case "unknown":
      return msg(view.locale, "bridge.unknown")
    case "usage":
      return msg(view.locale, parsed.key)
    case "status":
      return msg(view.locale, "bridge.status", {
        group: view.groupId,
        mode: view.mode,
        notice: view.busyNotice ? "on" : "off",
        members: view.members.length,
        dupes: view.lateHolds ?? 0,
      })
    case "members": {
      if (view.members.length === 0) return msg(view.locale, "bridge.members.empty")
      return view.members
        .map((row) => msg(view.locale, "bridge.members.line", { qq: row.userId, name: row.name || row.userId, keyId: row.keyId, role: row.role }))
        .join("\n")
    }
    case "kick":
      try {
        await effects.kick(parsed.userId)
        return msg(view.locale, "bridge.kicked", { qq: parsed.userId })
      } catch (error) {
        if (error instanceof LastKeeperError) return msg(view.locale, "bridge.lastKeeper")
        if (error instanceof ObserverProtectedError) return msg(view.locale, "bridge.kickObserver")
        return msg(view.locale, "bridge.kickFailed")
      }
    case "admin": {
      if (parsed.op === "add") {
        if (view.admins.map(String).includes(parsed.userId)) {
          return msg(view.locale, "bridge.adminAlready", { qq: parsed.userId })
        }
        effects.addAdmin(parsed.userId)
        return msg(view.locale, "bridge.adminAdded", { qq: parsed.userId })
      }
      if (!view.admins.map(String).includes(parsed.userId)) {
        return msg(view.locale, "bridge.adminMissing", { qq: parsed.userId })
      }
      // OneBot has no claim code to fall back on: the runtime list is persisted and
      // outranks the config file's `admins`, so an empty one could only be undone by
      // hand-editing the 0600 settings file. (The official-bot path mints a claim code.)
      if (!effects.identity && view.admins.length <= 1) {
        return msg(view.locale, "bridge.lastAdmin", { qq: parsed.userId })
      }
      effects.removeAdmin(parsed.userId)
      return msg(view.locale, "bridge.adminRemoved", { qq: parsed.userId })
    }
    case "mode":
      effects.setMode(parsed.mode)
      return msg(view.locale, "bridge.modeSet", { mode: parsed.mode })
    case "notice":
      effects.setBusyNotice(parsed.on)
      return msg(view.locale, "bridge.noticeSet", { state: parsed.on ? "on" : "off" })
    case "deferred":
      return formatDeferred(view)
    case "claim":
    case "name":
      return msg(view.locale, "bridge.unknown")
  }
}

async function runClaim(
  parsed: Extract<ParsedBridgeCommand, { name: "claim" }>,
  view: BridgeCommandView,
  effects: BridgeCommandEffects,
): Promise<string | undefined> {
  if (!effects.identity) return msg(view.locale, "bridge.unknown")
  if (!parsed.code) return msg(view.locale, "bridge.usage.claim")
  const channel = view.channel ?? "group"
  const result = await effects.identity.claim({
    channel,
    code: parsed.code,
    userOpenid: view.userOpenid,
    memberOpenid: view.memberOpenid,
    unionOpenid: view.unionOpenid,
  })
  if (result.outcome === "usage") return msg(view.locale, "bridge.usage.claim")
  if (result.outcome === "cooldown") return undefined
  if (result.outcome === "rejected") return msg(view.locale, "bridge.qqbot.claimRejected")
  if (result.outcome === "link_issued") {
    return msg(view.locale, "bridge.qqbot.claimLinkIssued", { code: result.linkCode })
  }
  if (result.outcome === "already") {
    return msg(view.locale, "bridge.qqbot.claimDone")
  }
  const display = effects.identity.displayNameFor(result.memberOpenid, { username: view.username }, view.locale)
  if (effects.remintSeat) {
    try {
      const reminted = await effects.remintSeat(result.memberOpenid, display)
      if (reminted.previousKey) effects.onSeatReminted?.(result.memberOpenid, reminted.previousKey)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      effects.onLog?.(`qqbot.claim.mint_failed ${detail}`)
      return msg(view.locale, "bridge.seatFailed")
    }
  }
  effects.addAdmin(result.memberOpenid)
  return msg(view.locale, "bridge.qqbot.claimDone")
}

async function runName(
  parsed: Extract<ParsedBridgeCommand, { name: "name" }>,
  view: BridgeCommandView,
  effects: BridgeCommandEffects,
): Promise<string | undefined> {
  const identity = effects.identity
  if (!parsed.display) return msg(view.locale, "bridge.usage.name")
  if (!identity) return msg(view.locale, "bridge.unknown")
  const seat = view.memberOpenid || view.seat
  if (!seat) return msg(view.locale, "bridge.usage.name")
  if (effects.hasCharacter === undefined || effects.hasCharacter(seat)) {
    return msg(view.locale, "bridge.qqbot.nameLocked")
  }
  const cleaned = keyNameFromDisplay(parsed.display)
  if (!cleaned) return msg(view.locale, "bridge.usage.name")
  await identity.setChosenName(seat, cleaned)
  if (effects.remintSeat) {
    try {
      const reminted = await effects.remintSeat(seat, cleaned)
      if (reminted.previousKey) effects.onSeatReminted?.(seat, reminted.previousKey)
      return msg(view.locale, "bridge.qqbot.nameChanged", { name: reminted.name })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      effects.onLog?.(`qqbot.claim.mint_failed ${detail}`)
      return msg(view.locale, "bridge.seatFailed")
    }
  }
  return msg(view.locale, "bridge.qqbot.nameChanged", { name: cleaned })
}

function formatDeferred(view: BridgeCommandView): string {
  const summary = view.deferredSummary
  if (!summary) return msg(view.locale, "bridge.unknown")
  if (summary.length <= 0) return msg(view.locale, "bridge.qqbot.deferredEmpty")
  const seconds = Math.max(0, Math.floor((summary.oldestAgeMs ?? 0) / 1000))
  return msg(view.locale, "bridge.qqbot.deferred", { count: summary.length, seconds })
}
