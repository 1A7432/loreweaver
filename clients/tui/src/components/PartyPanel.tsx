import { stripControlChars, type PartyView } from "loreweaver-protocol/v3"
import { tt } from "../i18n"
import type { Palette } from "../themes"

export interface PartyPanelProps {
  party?: PartyView | null
  theme: Palette
  locale?: string
}

/** The menu's compact table list: who is here, online or not, and what they play. */
export function PartyPanel({ party, theme, locale }: PartyPanelProps) {
  const members = party?.members ?? []
  const names = new Map((party?.characters ?? []).map((entry) => [entry.id, entry.name]))
  return (
    <box flexDirection="column" border borderColor={theme.border} paddingX={1} flexShrink={0}>
      <text fg={theme.accent} wrapMode="none" truncate>{tt(locale, "party.legacyTitle")}</text>
      {members.length === 0 ? (
        <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "party.noRoster")}</text>
      ) : (
        members.map((member) => {
          const playing = member.character ? names.get(member.character) : undefined
          return (
            <text key={member.id} fg={member.online ? theme.player : theme.dim} wrapMode="none" truncate>
              {member.online ? "●" : "○"} {stripControlChars(member.name)}
              {playing ? ` · ${stripControlChars(playing)}` : ""}
            </text>
          )
        })
      )}
    </box>
  )
}
