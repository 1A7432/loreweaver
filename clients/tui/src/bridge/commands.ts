import { tt, type MessageKey } from "../i18n"
import type { GroupMode } from "./config"
import { LastKeeperError, ObserverProtectedError } from "./keyring"

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
  return { name: "unknown" }
}

export interface BridgeCommandView {
  locale?: string
  groupId: string
  mode: GroupMode
  busyNotice: boolean
  admins: readonly string[]
  members: ReadonlyArray<{ userId: string; keyId: string; role: string; name?: string }>
  lateHolds?: number
}

export interface BridgeCommandEffects {
  setMode(mode: GroupMode): void
  setBusyNotice(on: boolean): void
  addAdmin(userId: string): void
  removeAdmin(userId: string): void
  kick(userId: string): Promise<void>
}

function msg(locale: string | undefined, key: MessageKey, vars?: Record<string, string | number>): string {
  return tt(locale, key, vars)
}

/**
 * Admin-only `.bridge` commands. Never forwarded to the engine: the caller must
 * intercept `isBridgeCommand` before `input`. Non-admins get `bridge.notAdmin`.
 */
export async function runBridgeCommand(
  text: string,
  isAdmin: boolean,
  view: BridgeCommandView,
  effects: BridgeCommandEffects,
): Promise<string | undefined> {
  const parsed = parseBridgeCommand(text)
  if (!parsed) return undefined
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
      effects.removeAdmin(parsed.userId)
      return msg(view.locale, "bridge.adminRemoved", { qq: parsed.userId })
    }
    case "mode":
      effects.setMode(parsed.mode)
      return msg(view.locale, "bridge.modeSet", { mode: parsed.mode })
    case "notice":
      effects.setBusyNotice(parsed.on)
      return msg(view.locale, "bridge.noticeSet", { state: parsed.on ? "on" : "off" })
  }
}
