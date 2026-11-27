import { useRef, useState, type ReactNode } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent, SelectOption } from "@opentui/core"
import { stripControlChars, type AdminKeysView, type Role } from "loreweaver-protocol/v3"
import { outcomeOf, type Outcome } from "../adminResult"
import { usesAppClipboardCopy } from "../copy"
import { ScreenFrame } from "../components/ScreenFrame"
import { Spinner } from "../components/Spinner"
import type { Connection } from "../connection"
import { useSnapshot, useViews, viewData } from "../hooks"
import { tt } from "../i18n"
import type { Palette, ThemeName } from "../themes"

export interface AccessKeysScreenProps {
  connection: Connection
  theme: Palette
  themeName: ThemeName
  locale: string
  /** The app's confirmation of a Ctrl+C copy (`App.tsx` owns that key), shown on the new-key panel. */
  copyNotice?: string
  platform?: string
  onBack: () => void
}

type KeyRow = AdminKeysView["keys"][number]
type Mode = "list" | "actions" | "mint" | "rename" | "role" | "revoke" | "minted"

/** A key just minted, held by the panel that shows it and by nothing else. */
interface Minted {
  readonly name: string
  readonly role: Role
  readonly key: string
}

const CURSOR = "⚄"
const ROLES: readonly Role[] = ["player", "admin", "observer"]
const ROLE_KEYS = { player: "keys.role.player", admin: "keys.role.admin", observer: "keys.role.observer" } as const
const ACTIONS = ["rename", "role", "revoke", "back"] as const
const TARGET_MODES: ReadonlySet<Mode> = new Set(["actions", "rename", "role", "revoke"])
const SELECT_COLORS = (theme: Palette) => ({
  backgroundColor: theme.bg,
  textColor: theme.fg,
  focusedBackgroundColor: theme.bg,
  focusedTextColor: theme.accent,
  selectedBackgroundColor: theme.accent,
  selectedTextColor: theme.bg,
  descriptionColor: theme.dim,
  selectedDescriptionColor: theme.bg,
})

/** The new key out of a `key mint` answer's data (never its text: the text carries the key too). */
function mintedFrom(data: unknown, fallbackName: string, fallbackRole: Role): Minted | null {
  if (typeof data !== "object" || data === null) return null
  const record = data as Record<string, unknown>
  if (typeof record.key !== "string" || record.key === "") return null
  const role = record.role === "player" || record.role === "admin" || record.role === "observer" ? record.role : fallbackRole
  return { name: typeof record.name === "string" ? record.name : fallbackName, role, key: record.key }
}

/**
 * The admin's "Access keys": this room's keys (the `admin/keys` view, subscribed only while this
 * screen is open) and the `key` command with typed arguments for each change. A key minted comes
 * back in that one answer: it is shown on its own panel, once, and lives in this component's
 * state until the panel is left — never in the log lines, the snapshot or anything written out.
 */
export function AccessKeysScreen({ connection, theme, themeName, locale, copyNotice, platform = process.platform, onBack }: AccessKeysScreenProps) {
  const snapshot = useSnapshot(connection)
  const isAdmin = snapshot.welcome?.you.role === "admin"
  useViews(connection, isAdmin ? ["admin/keys"] : [])
  const view = isAdmin ? viewData(snapshot, "admin/keys") : null
  const problem = snapshot.viewProblems.get("admin/keys")
  const keys = view?.keys ?? []
  const room = snapshot.welcome?.room.id ?? ""
  const online = (viewData(snapshot, "party")?.members ?? []).filter((member) => member.online).length

  const [mode, setMode] = useState<Mode>("list")
  const [selected, setSelected] = useState(0)
  const [actionIndex, setActionIndex] = useState(0)
  const [targetId, setTargetId] = useState<string>()
  const [outcome, setOutcome] = useState<Outcome>()
  const [busy, setBusy] = useState(false)
  // Mint form.
  const [name, setName] = useState("")
  const nameRef = useRef("")
  const [mintRole, setMintRole] = useState<Role>("player")
  const [mintFocus, setMintFocus] = useState<"name" | "role">("name")
  // The key just minted: this panel's, once.
  const [minted, setMinted] = useState<Minted | null>(null)
  // Rename and role.
  const [renameText, setRenameText] = useState("")
  const renameRef = useRef("")
  const [roleIndex, setRoleIndex] = useState(0)

  const target = keys.find((key) => key.id === targetId)
  // A key that went away under us (revoked from another client): back to the list.
  const shown: Mode = TARGET_MODES.has(mode) && target === undefined ? "list" : mode
  const rowCount = 1 + keys.length
  const clamp = (index: number, count: number) => Math.max(0, Math.min(count - 1, index))
  const roleLabel = (role: Role) => tt(locale, ROLE_KEYS[role])

  const toList = (next?: Outcome) => {
    setOutcome(next)
    setMode("list")
  }

  /** Leave the minted-key panel: the key is dropped here and now. */
  const leaveMinted = () => {
    setMinted(null)
    setName("")
    nameRef.current = ""
    toList()
  }

  const run = async (args: Record<string, unknown>) => {
    setBusy(true)
    try {
      // `quiet`: the answer to a mint carries the key, and no answer here belongs in the game's log.
      return await connection.runCommand("key", args, { quiet: true })
    } finally {
      setBusy(false)
    }
  }

  const enter = (next: Mode) => {
    setOutcome(undefined)
    if (next === "mint") {
      setName("")
      nameRef.current = ""
      setMintRole("player")
      setMintFocus("name")
    }
    if (next === "rename") {
      const current = target ? stripControlChars(target.name) : ""
      setRenameText(current)
      renameRef.current = current
    }
    if (next === "role") setRoleIndex(Math.max(0, ROLES.indexOf(target?.role ?? "player")))
    setMode(next)
  }

  const submitMint = async () => {
    if (busy) return
    const typed = nameRef.current.trim()
    if (typed === "") {
      setOutcome({ ok: false, text: tt(locale, "keys.mint.needName") })
      return
    }
    setOutcome(undefined)
    const result = await run({ op: "mint", name: typed, role: mintRole })
    if (result !== null && result.ok) {
      const made = mintedFrom(result.data, typed, mintRole)
      if (made === null) {
        setOutcome({ ok: false, text: tt(locale, "keys.mint.noKey") })
        setMode("list")
        return
      }
      setMinted(made)
      setMode("minted")
      return
    }
    setOutcome(outcomeOf(result, locale))
  }

  const submitRename = async () => {
    const typed = renameRef.current.trim()
    if (busy || target === undefined || typed === "") return
    const result = await run({ op: "rename", id: target.id, name: typed })
    const answer = outcomeOf(result, locale)
    if (answer.ok) toList(answer)
    else setOutcome(answer)
  }

  const submitRole = async (index: number) => {
    const role = ROLES[clamp(index, ROLES.length)] as Role
    if (busy || target === undefined) return
    const result = await run({ op: "role", id: target.id, role })
    const answer = outcomeOf(result, locale)
    if (answer.ok) toList(answer)
    else setOutcome(answer)
  }

  const submitRevoke = async () => {
    if (busy || target === undefined) return
    const result = await run({ op: "revoke", id: target.id })
    const answer = outcomeOf(result, locale)
    if (answer.ok) toList(answer)
    else {
      setOutcome(answer)
      setMode("actions")
    }
  }

  const activateAction = (index: number) => {
    const action = ACTIONS[clamp(index, ACTIONS.length)]
    setActionIndex(clamp(index, ACTIONS.length))
    if (action === "rename") enter("rename")
    else if (action === "role") enter("role")
    else if (action === "revoke") enter("revoke")
    else {
      setOutcome(undefined)
      setMode("list")
    }
  }

  const activateRow = (index: number) => {
    const at = clamp(index, rowCount)
    setSelected(at)
    if (at === 0) {
      enter("mint")
      return
    }
    const key = keys[at - 1]
    if (key === undefined) return
    setTargetId(key.id)
    setActionIndex(0)
    setOutcome(undefined)
    setMode("actions")
  }

  useKeyboard((event: KeyEvent) => {
    const key = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (!isAdmin) {
      if (key === "escape") onBack()
      return
    }
    if (shown === "list") {
      if (key === "up") setSelected((prev) => clamp(prev - 1, rowCount))
      if (key === "down") setSelected((prev) => clamp(prev + 1, rowCount))
      if (key === "return" || key === "enter") activateRow(selected)
      if (key === "n" && !event.ctrl && !event.meta) enter("mint")
      if (key === "escape") onBack()
      return
    }
    if (shown === "actions") {
      if (key === "up") setActionIndex((prev) => clamp(prev - 1, ACTIONS.length))
      if (key === "down") setActionIndex((prev) => clamp(prev + 1, ACTIONS.length))
      if (key === "return" || key === "enter") activateAction(actionIndex)
      if (key === "escape") toList()
      return
    }
    if (shown === "minted") {
      if (key === "escape" || key === "return" || key === "enter") leaveMinted()
      return
    }
    if (shown === "revoke") {
      if (key === "return" || key === "enter") void submitRevoke()
      if (key === "escape") {
        setOutcome(undefined)
        setMode("actions")
      }
      return
    }
    if (key === "escape") {
      // A mint in flight is waited for: leaving now would lose the key it is about to bring back.
      if (shown === "mint" && busy) return
      if (shown === "mint") toList()
      else {
        setOutcome(undefined)
        setMode("actions")
      }
      return
    }
    if (key === "tab" && shown === "mint") setMintFocus((prev) => (prev === "name" ? "role" : "name"))
  })

  const roleOptions: SelectOption[] = ROLES.map((role) => ({ name: roleLabel(role), description: "", value: role }))
  const actionLabels = {
    rename: tt(locale, "keys.action.rename"),
    role: tt(locale, "keys.action.role"),
    revoke: tt(locale, "keys.action.revoke"),
    back: tt(locale, "keys.action.back"),
  }

  const panel = (children: ReactNode) => (
    <box flexDirection="column" border borderColor={theme.border} paddingX={2} paddingY={1} width="100%" maxWidth={76} minWidth={0} flexShrink={0}>
      {children}
    </box>
  )

  const row = (selectedRow: boolean, label: string, onClick: () => void, onMove?: () => void) => (
    <box key={label} height={1} backgroundColor={selectedRow ? theme.accent : theme.bg} onMouseMove={onMove} onMouseDown={onClick}>
      <text fg={selectedRow ? theme.bg : theme.fg} wrapMode="none" truncate>
        {selectedRow ? `${CURSOR} ` : "  "}
        {label}
      </text>
    </box>
  )

  const keyLine = (entry: KeyRow) => `${stripControlChars(entry.name)} · ${roleLabel(entry.role)} · ${stripControlChars(entry.masked)}${entry.online ? ` · ● ${tt(locale, "keys.online")}` : ""}`

  let body: ReactNode
  if (!isAdmin) {
    body = <text fg={theme.fumble}>{tt(locale, "admin.onlyAdmins")}</text>
  } else if (shown === "minted" && minted !== null) {
    body = panel(
      <>
        <text fg={theme.accent}>{tt(locale, "keys.minted.title", { name: stripControlChars(minted.name), role: roleLabel(minted.role) })}</text>
        <box flexDirection="column" marginTop={1}>
          <text fg={theme.dim}>{tt(locale, "keys.minted.ticket")}</text>
          <text fg={theme.fg} selectable>
            {connection.ticket}
          </text>
        </box>
        <box flexDirection="column" marginTop={1}>
          <text fg={theme.dim}>{tt(locale, "keys.minted.key")}</text>
          <text fg={theme.success} selectable>
            {minted.key}
          </text>
        </box>
        <box marginTop={1}>
          <text fg={theme.fg}>{tt(locale, "keys.minted.how")}</text>
        </box>
        <box marginTop={1}>
          <text fg={theme.fumble}>{tt(locale, "keys.minted.once")}</text>
        </box>
        <box marginTop={1}>
          <text fg={theme.dim}>{tt(locale, usesAppClipboardCopy(platform) ? "game.helpCopy" : "game.helpCopyMac")}</text>
        </box>
        {copyNotice ? <text fg={theme.success}>{copyNotice}</text> : null}
        <box marginTop={1}>
          <text fg={theme.dim}>{tt(locale, "keys.minted.help")}</text>
        </box>
      </>,
    )
  } else if (shown === "mint") {
    body = panel(
      <>
        <text fg={theme.accent}>{tt(locale, "keys.mint.title")}</text>
        <box flexDirection="column" marginTop={1} onMouseDown={() => setMintFocus("name")}>
          <text fg={mintFocus === "name" ? theme.accent : theme.dim}>{tt(locale, "keys.mint.name")}</text>
          <input
            flexGrow={1}
            value={name}
            focused={mintFocus === "name" && !busy}
            placeholder={tt(locale, "keys.mint.namePlaceholder")}
            onInput={(value: string) => {
              nameRef.current = value
              setName(value)
            }}
            onSubmit={() => void submitMint()}
          />
        </box>
        <box flexDirection="column" marginTop={1} onMouseDown={() => setMintFocus("role")}>
          <text fg={mintFocus === "role" ? theme.accent : theme.dim}>{tt(locale, "keys.mint.role")}</text>
          <select
            flexGrow={1}
            height={ROLES.length}
            focused={mintFocus === "role" && !busy}
            options={roleOptions}
            selectedIndex={ROLES.indexOf(mintRole)}
            showDescription={false}
            {...SELECT_COLORS(theme)}
            onChange={(index: number) => setMintRole(ROLES[clamp(index, ROLES.length)] as Role)}
            onSelect={() => void submitMint()}
          />
        </box>
        <box marginTop={1} onMouseDown={() => void submitMint()} backgroundColor={theme.accent} paddingX={1}>
          <text fg={theme.bg}>{tt(locale, "keys.mint.button")}</text>
        </box>
        <box marginTop={1}>
          <text fg={theme.dim}>{tt(locale, "keys.mint.help")}</text>
        </box>
      </>,
    )
  } else if (shown === "rename" && target !== undefined) {
    body = panel(
      <>
        <text fg={theme.accent}>{tt(locale, "keys.rename.title", { name: stripControlChars(target.name) })}</text>
        <input
          flexGrow={1}
          value={renameText}
          focused={!busy}
          placeholder={tt(locale, "keys.mint.namePlaceholder")}
          onInput={(value: string) => {
            renameRef.current = value
            setRenameText(value)
          }}
          onSubmit={() => void submitRename()}
        />
        <box marginTop={1}>
          <text fg={theme.dim}>{tt(locale, "keys.rename.help")}</text>
        </box>
      </>,
    )
  } else if (shown === "role" && target !== undefined) {
    body = panel(
      <>
        <text fg={theme.accent}>{tt(locale, "keys.role.title", { name: stripControlChars(target.name) })}</text>
        <select
          flexGrow={1}
          height={ROLES.length}
          focused={!busy}
          options={roleOptions}
          selectedIndex={roleIndex}
          showDescription={false}
          {...SELECT_COLORS(theme)}
          onChange={(index: number) => setRoleIndex(clamp(index, ROLES.length))}
          onSelect={(index: number) => void submitRole(index)}
        />
        <box marginTop={1}>
          <text fg={theme.dim}>{tt(locale, "keys.role.help")}</text>
        </box>
      </>,
    )
  } else if (shown === "revoke" && target !== undefined) {
    body = panel(
      <>
        <text fg={theme.fumble}>{tt(locale, "keys.revoke.confirm", { name: stripControlChars(target.name) })}</text>
        <box marginTop={1}>
          <text fg={theme.dim}>{tt(locale, "keys.revoke.help")}</text>
        </box>
      </>,
    )
  } else if (shown === "actions" && target !== undefined) {
    body = (
      <>
        <text fg={theme.accent} wrapMode="none" truncate>
          {tt(locale, "keys.actionsTitle", { name: stripControlChars(target.name), role: roleLabel(target.role), masked: stripControlChars(target.masked) })}
        </text>
        <box flexDirection="column" marginTop={1}>
          {ACTIONS.map((action, index) => row(actionIndex === index, actionLabels[action], () => activateAction(index), () => setActionIndex(index)))}
        </box>
        <box marginTop={1}>
          <text fg={theme.dim}>{tt(locale, "keys.actionsHelp")}</text>
        </box>
      </>
    )
  } else {
    body = (
      <>
        <text fg={theme.dim}>{tt(locale, "keys.intro")}</text>
        <box flexDirection="column" marginTop={1}>
          {view === null ? (
            <text fg={theme.dim}>{problem ? tt(locale, "commands.refused", { code: problem }) : tt(locale, "commands.loading")}</text>
          ) : (
            <>
              {row(selected === 0, tt(locale, "keys.new"), () => activateRow(0), () => setSelected(0))}
              {keys.length === 0 ? <text fg={theme.dim}>{tt(locale, "keys.empty")}</text> : null}
              {keys.map((entry, index) => {
                const at = index + 1
                return (
                  <box key={entry.id} height={1} backgroundColor={selected === at ? theme.accent : theme.bg} onMouseMove={() => setSelected(at)} onMouseDown={() => activateRow(at)}>
                    <text fg={selected === at ? theme.bg : entry.online ? theme.success : theme.fg} wrapMode="none" truncate>
                      {selected === at ? `${CURSOR} ` : "  "}
                      {keyLine(entry)}
                    </text>
                  </box>
                )
              })}
            </>
          )}
        </box>
        <box marginTop={1}>
          <text fg={theme.dim}>{tt(locale, "keys.listHelp")}</text>
        </box>
      </>
    )
  }

  return (
    <ScreenFrame title={tt(locale, "keys.title")} room={room} online={online} locale={locale} theme={theme} themeName={themeName}>
      {body}
      {outcome && shown !== "minted" ? (
        <box marginTop={1} minWidth={0}>
          <text fg={outcome.ok ? theme.success : theme.fumble}>{outcome.text}</text>
        </box>
      ) : null}
      {busy ? (
        <box marginTop={1}>
          <Spinner active label={tt(locale, "admin.working")} color={theme.accent} />
        </box>
      ) : null}
    </ScreenFrame>
  )
}

export default AccessKeysScreen
