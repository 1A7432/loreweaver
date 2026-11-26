import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { stripControlChars, type ViewCommand } from "loreweaver-protocol/v3"
import { StatusBar } from "../components/StatusBar"
import type { Connection } from "../connection"
import { useSnapshot, viewData } from "../hooks"
import { tt } from "../i18n"
import type { Palette, ThemeName } from "../themes"

export interface CommandsScreenProps {
  connection: Connection
  theme: Palette
  themeName: ThemeName
  locale: string
  onBack: () => void
}

/** Whether `entry` matches what was typed into the filter: its id, title, usage or a text form. */
export function commandMatches(entry: ViewCommand, filter: string): boolean {
  const wanted = filter.trim().toLowerCase().replace(/^[.。/]/u, "")
  if (!wanted) return true
  const haystack = [entry.id, entry.title, entry.text?.usage ?? "", ...(entry.text?.forms ?? [])].join(" ").toLowerCase()
  return haystack.includes(wanted)
}

/** The command's head line: id, usage (the text form to type) and title. */
export function commandLine(entry: ViewCommand): string {
  const usage = entry.text?.usage ? `  ${stripControlChars(entry.text.usage)}` : ""
  return `${stripControlChars(entry.id)}${usage} — ${stripControlChars(entry.title)}`
}

// The command list, rendered from the `commands` view: what this person can type, and what they
// cannot (and why). Every admin operation the server has is a command, so this is also where an
// admin finds them.
export function CommandsScreen({ connection, theme, themeName, locale, onBack }: CommandsScreenProps) {
  const snapshot = useSnapshot(connection)
  const view = viewData(snapshot, "commands")
  const problem = snapshot.viewProblems.get("commands")
  const [filter, setFilter] = useState("")
  const online = (viewData(snapshot, "party")?.members ?? []).filter((member) => member.online).length
  const entries = (view?.commands ?? []).filter((entry) => commandMatches(entry, filter))
  const available = entries.filter((entry) => entry.available)
  const unavailable = entries.filter((entry) => !entry.available)

  useKeyboard((event: KeyEvent) => {
    if (typeof event.name === "string" && event.name.toLowerCase() === "escape") onBack()
  })

  const row = (entry: ViewCommand) => (
    <box key={entry.id} flexDirection="column" flexShrink={0}>
      <text fg={entry.available ? (entry.danger ? theme.fail : theme.accent) : theme.dim}>
        {entry.available ? "✓ " : "✗ "}
        {commandLine(entry)}
        {entry.role === "admin" ? ` [${tt(locale, "commands.adminOnly")}]` : ""}
        {entry.danger ? ` [${tt(locale, "commands.danger")}]` : ""}
      </text>
      {entry.description ? <text fg={entry.available ? theme.fg : theme.dim}>{`   ${stripControlChars(entry.description)}`}</text> : null}
      {!entry.available && entry.reason ? <text fg={theme.dim}>{`   ${tt(locale, "commands.reason", { reason: stripControlChars(entry.reason) })}`}</text> : null}
    </box>
  )

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg}>
      <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
        <box flexDirection="row" marginLeft={2}>
          <text fg={theme.accent}>{tt(locale, "commands.title")}</text>
        </box>
      </box>

      <box height={3} flexDirection="row" border borderColor={theme.border} paddingX={1}>
        <text fg={theme.accent}>{tt(locale, "commands.filter")} </text>
        <input flexGrow={1} value={filter} focused placeholder={tt(locale, "commands.filterPlaceholder")} onInput={(value: string) => setFilter(value)} />
      </box>

      <scrollbox flexGrow={1} viewportCulling={false} paddingX={2}>
        <box flexDirection="column" width="100%" flexShrink={0}>
          {view === null ? (
            <text fg={theme.dim}>{problem ? tt(locale, "commands.refused", { code: problem }) : tt(locale, "commands.loading")}</text>
          ) : entries.length === 0 ? (
            <text fg={theme.dim}>{tt(locale, "commands.none")}</text>
          ) : (
            <>
              {available.map(row)}
              {unavailable.length > 0 ? (
                <box marginTop={1} flexShrink={0}>
                  <text fg={theme.dim}>{tt(locale, "commands.unavailable")}</text>
                </box>
              ) : null}
              {unavailable.map(row)}
            </>
          )}
        </box>
      </scrollbox>

      <box height={1} paddingX={2}>
        <text fg={theme.dim} wrapMode="none" truncate>
          {tt(locale, "commands.help")}
        </text>
      </box>
      <StatusBar room={snapshot.welcome?.room.id} online={online} locale={locale} theme={theme} themeName={themeName} />
    </box>
  )
}

export default CommandsScreen
