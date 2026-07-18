import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { stripControlChars, type CharacterState, type InitiativeEntry, type MediaRef, type PartyMember } from "@loreweaver/protocol"
import type { AppClient } from "../client"
import { tt } from "../i18n"
import { getCachedMedia, renderHalfBlockPreview, type HalfBlockLine } from "../media"
import type { Palette } from "../themes"
import { bar, CharacterPanel, statColor } from "./CharacterPanel"

export interface PartyRosterProps {
  character?: CharacterState
  party: PartyMember[]
  initiative: InitiativeEntry[]
  theme: Palette
  locale?: string
  client?: AppClient
  // Whether THIS panel (vs the chat input) currently owns Enter. `<box>` has no
  // native per-element key routing in OpenTUI (only `input`/`select`/`textarea`
  // do), so — mirroring the local field-focus convention `screens/KeeperKeys.tsx`
  // already uses — GameView tracks one shared boolean and flips the chat
  // `<input>`'s own `focused` prop off in lockstep, so a bare Enter is never
  // handled twice.
  focused: boolean
  onFocus: () => void
  initiativeFirst?: boolean
}

function keyName(event: KeyEvent): string {
  return typeof event.name === "string" ? event.name.toLowerCase() : ""
}

function initiativeValue(member: PartyMember, initiative: InitiativeEntry[]): string {
  const value = member.initiative ?? initiative.find((entry) => entry.name === member.name)?.value
  return typeof value === "number" ? ` ${value}` : ""
}

interface VitalLine {
  label: "HP" | "MP" | "SAN"
  value: number
  max: number
  color: string
}

function partyVitals(member: PartyMember, theme: Palette): VitalLine[] {
  const stats: VitalLine[] = []
  const { hp, hpMax, mp, mpMax, san, sanMax } = member
  if (typeof hp === "number" && typeof hpMax === "number") {
    stats.push({
      label: "HP",
      value: hp,
      max: hpMax,
      color: statColor(hp, hpMax, theme.hpFull, theme.hpLow),
    })
  }
  if (typeof mp === "number" && typeof mpMax === "number") {
    stats.push({ label: "MP", value: mp, max: mpMax, color: theme.success })
  }
  if (typeof san === "number" && typeof sanMax === "number") {
    stats.push({
      label: "SAN",
      value: san,
      max: sanMax,
      color: statColor(san, sanMax, theme.sanFull, theme.sanLow),
    })
  }
  return stats
}

// The compact bar width used inline in the collapsed own-character row — narrower
// than CharacterPanel's own default (10) so HP/MP/SAN + numbers all fit this
// panel's column width alongside the roster rows below.
const COMPACT_BAR_WIDTH = 6
const DETAIL_BAR_WIDTH = 10

/** The merged "队伍 / PARTY" roster: every member from `party` in one list, with
 * the player's own character (`character`) rendered inline as an expandable
 * status row instead of a plain name line — collapsed shows a compact HP/MP/SAN
 * bar summary (reusing CharacterPanel's `bar`/`statColor` glyphs), expanded
 * embeds the full `CharacterPanel` (attributes + status effects). Toggle via a
 * mouse click on the row, or Enter while this panel is focused (see `focused`). */
export function PartyRoster({
  character,
  party,
  initiative,
  theme,
  locale,
  client,
  focused,
  onFocus,
  initiativeFirst = false,
}: PartyRosterProps) {
  const [expanded, setExpanded] = useState(false)
  const [expandedMembers, setExpandedMembers] = useState<Set<string>>(() => new Set())

  const toggle = () => {
    if (!character) return
    onFocus()
    setExpanded((value) => !value)
  }

  const toggleMember = (name: string) => {
    onFocus()
    setExpandedMembers((value) => {
      const next = new Set(value)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  useKeyboard((event) => {
    if (!focused) return
    if (keyName(event) !== "return") return
    if (character) {
      setExpanded((value) => !value)
      return
    }
    const expandableMember = party.find((member) => partyVitals(member, theme).length > 0)
    if (expandableMember) toggleMember(expandableMember.name)
  })

  // The roster (`party`) and the caller's own sheet (`character`) are both keyed
  // by character name (see core.character_manager.sync_party_roster), so the
  // player's own roster row is whichever entry shares that name; it's rendered
  // specially below instead of as a plain name line.
  const ownName = character?.name
  const ownMember = ownName ? party.find((member) => member.name === ownName) : undefined
  const otherMembers = ownName ? party.filter((member) => member.name !== ownName) : party
  const initiativeRows = initiative.length > 0 ? (
    <box flexDirection="column">
      <text fg={theme.dim} wrapMode="none" truncate>INIT</text>
      {initiative.map((entry) => (
        <text key={`${entry.name}-${entry.value}`} fg={entry.current ? theme.accent : theme.fg} wrapMode="none" truncate>
          {entry.current ? "▶" : " "} {stripControlChars(entry.name)} {entry.value}
        </text>
      ))}
    </box>
  ) : null

  return (
    <box flexDirection="column" border borderColor={focused ? theme.accent : theme.border} paddingX={1}>
      <text fg={theme.accent} wrapMode="none" truncate>{tt(locale, "party.title")}</text>
      {initiativeFirst ? initiativeRows : null}

      {character ? (
        <box flexDirection="column" onMouseDown={toggle}>
          <text fg={focused ? theme.accent : theme.player} wrapMode="none" truncate>
            {expanded ? "▾" : "▸"} {(ownMember?.online ?? true) ? "●" : "○"} {stripControlChars(character.name)} (
            {tt(locale, "party.you")})
          </text>
          <AvatarPreview avatar={character.avatar ?? ownMember?.avatar} client={client} />
          {expanded ? (
            <CharacterPanel character={character} theme={theme} locale={locale} />
          ) : (
            <>
              <text fg={statColor(character.hp, character.hpmax, theme.hpFull, theme.hpLow)} wrapMode="none" truncate>
                HP {bar(character.hp, character.hpmax, COMPACT_BAR_WIDTH)} {character.hp}/{character.hpmax}
              </text>
              <text fg={theme.success} wrapMode="none" truncate>
                MP {bar(character.mp, character.mpmax, COMPACT_BAR_WIDTH)} {character.mp}/{character.mpmax}
              </text>
              <text fg={statColor(character.san, character.sanmax, theme.sanFull, theme.sanLow)} wrapMode="none" truncate>
                SAN {bar(character.san, character.sanmax, COMPACT_BAR_WIDTH)} {character.san}/{character.sanmax}
              </text>
            </>
          )}
        </box>
      ) : otherMembers.length === 0 ? (
        // No own character AND no other members: one clear line, not two stacked
        // empty-state messages (used to show "尚未创建角色" AND "No roster" together).
        <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "party.empty")}</text>
      ) : (
        <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "party.noCharacter")}</text>
      )}

      {otherMembers.map((member) => {
        const vitals = partyVitals(member, theme)
        const canExpand = vitals.length > 0
        const memberExpanded = expandedMembers.has(member.name)
        const marker = canExpand ? (memberExpanded ? "▾" : "▸") : member.active ? "▶" : " "
        const activeMarker = canExpand && member.active ? " ▶" : ""
        const onlineMarker = member.online ? "●" : "○"
        const statWidth = memberExpanded ? DETAIL_BAR_WIDTH : COMPACT_BAR_WIDTH
        return (
          <box
            key={member.name}
            flexDirection="column"
            onMouseDown={canExpand ? () => toggleMember(member.name) : undefined}
          >
            <text fg={member.online ? theme.player : theme.dim} wrapMode="none" truncate>
              {`${marker}${activeMarker} ${onlineMarker} ${stripControlChars(member.name)}`}
              {member.ai ? " [AI]" : ""}
              {initiativeValue(member, initiative)}
            </text>
            <AvatarPreview avatar={member.avatar} client={client} />
            {vitals.map((stat) => (
              <text key={`${member.name}-${stat.label}`} fg={stat.color} wrapMode="none" truncate>
                {stat.label} {bar(stat.value, stat.max, statWidth)} {stat.value}/{stat.max}
              </text>
            ))}
          </box>
        )
      })}

      {initiativeFirst ? null : initiativeRows}
    </box>
  )
}

function AvatarPreview({ avatar, client }: { avatar?: MediaRef; client?: AppClient }) {
  const [lines, setLines] = useState<HalfBlockLine[]>([])
  useEffect(() => {
    let cancelled = false
    setLines([])
    if (!avatar || !client || avatar.mime === "image/gif" || avatar.mime === "image/webp") return
    void getCachedMedia(client, avatar)
      .then((payload) => renderHalfBlockPreview(payload.bytes, payload.mime, 8, 4))
      .then((preview) => {
        if (!cancelled) setLines(preview)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [avatar?.hash, avatar?.mime, client])
  if (!lines.length) return null
  return (
    <box flexDirection="column">
      {lines.map((line, row) => (
        <box key={`${avatar?.hash}-${row}`} flexDirection="row">
          {line.cells.map((cell, col) => (
            <text key={`${avatar?.hash}-${row}-${col}`} fg={cell.fg} bg={cell.bg}>
              {cell.char}
            </text>
          ))}
        </box>
      ))}
    </box>
  )
}
