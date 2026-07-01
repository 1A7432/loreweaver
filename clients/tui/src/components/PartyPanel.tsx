import type { InitiativeEntry, PartyMember } from "@trpg-kp/protocol"
import type { Palette } from "../themes"

export interface PartyPanelProps {
  party: PartyMember[]
  initiative: InitiativeEntry[]
  theme: Palette
}

function initiativeValue(member: PartyMember, initiative: InitiativeEntry[]): string {
  const value = member.initiative ?? initiative.find((entry) => entry.name === member.name)?.value
  return typeof value === "number" ? ` ${value}` : ""
}

export function PartyPanel({ party, initiative, theme }: PartyPanelProps) {
  return (
    <box flexDirection="column" border borderColor={theme.border} paddingX={1}>
      <text fg={theme.accent}>PARTY</text>
      {party.length === 0 ? (
        <text fg={theme.dim}>No roster</text>
      ) : (
        party.map((member) => (
          <text key={member.name} fg={member.online ? theme.player : theme.dim}>
            {member.active ? "▶" : " "} {member.online ? "●" : "○"} {member.name}
            {initiativeValue(member, initiative)}
          </text>
        ))
      )}
      {initiative.length > 0 ? <text fg={theme.dim}>INIT</text> : null}
      {initiative.map((entry) => (
        <text key={`${entry.name}-${entry.value}`} fg={entry.current ? theme.accent : theme.fg}>
          {entry.current ? "▶" : " "} {entry.name} {entry.value}
        </text>
      ))}
    </box>
  )
}

