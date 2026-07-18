import { stripControlChars, type InitiativeEntry, type PartyMember } from "@loreweaver/protocol"
import { tt } from "../i18n"
import type { Palette } from "../themes"

export interface PartyPanelProps {
  party: PartyMember[]
  initiative: InitiativeEntry[]
  theme: Palette
  locale?: string
}

function initiativeValue(member: PartyMember, initiative: InitiativeEntry[]): string {
  const value = member.initiative ?? initiative.find((entry) => entry.name === member.name)?.value
  return typeof value === "number" ? ` ${value}` : ""
}

export function PartyPanel({ party, initiative, theme, locale }: PartyPanelProps) {
  return (
    <box flexDirection="column" border borderColor={theme.border} paddingX={1} flexShrink={0}>
      <text fg={theme.accent} wrapMode="none" truncate>{tt(locale, "party.legacyTitle")}</text>
      {party.length === 0 ? (
        <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "party.noRoster")}</text>
      ) : (
        party.map((member) => (
          <text key={member.name} fg={member.online ? theme.player : theme.dim} wrapMode="none" truncate>
            {member.active ? "▶" : " "} {member.online ? "●" : "○"} {stripControlChars(member.name)}
            {initiativeValue(member, initiative)}
          </text>
        ))
      )}
      {initiative.length > 0 ? <text fg={theme.dim} wrapMode="none" truncate>INIT</text> : null}
      {initiative.map((entry) => (
        <text key={`${entry.name}-${entry.value}`} fg={entry.current ? theme.accent : theme.fg} wrapMode="none" truncate>
          {entry.current ? "▶" : " "} {stripControlChars(entry.name)} {entry.value}
        </text>
      ))}
    </box>
  )
}
