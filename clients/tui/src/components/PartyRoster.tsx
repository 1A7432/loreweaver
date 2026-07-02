import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { stripControlChars, type CharacterState, type InitiativeEntry, type PartyMember } from "@trpg-kp/protocol"
import type { Palette } from "../themes"
import { bar, CharacterPanel, statColor } from "./CharacterPanel"

export interface PartyRosterProps {
  character?: CharacterState
  party: PartyMember[]
  initiative: InitiativeEntry[]
  theme: Palette
  // Whether THIS panel (vs the chat input) currently owns Enter. `<box>` has no
  // native per-element key routing in OpenTUI (only `input`/`select`/`textarea`
  // do), so — mirroring the local field-focus convention `screens/KeeperKeys.tsx`
  // already uses — GameView tracks one shared boolean and flips the chat
  // `<input>`'s own `focused` prop off in lockstep, so a bare Enter is never
  // handled twice.
  focused: boolean
  onFocus: () => void
}

function keyName(event: KeyEvent): string {
  return typeof event.name === "string" ? event.name.toLowerCase() : ""
}

function initiativeValue(member: PartyMember, initiative: InitiativeEntry[]): string {
  const value = member.initiative ?? initiative.find((entry) => entry.name === member.name)?.value
  return typeof value === "number" ? ` ${value}` : ""
}

// The compact bar width used inline in the collapsed own-character row — narrower
// than CharacterPanel's own default (10) so HP/MP/SAN + numbers all fit this
// panel's column width alongside the roster rows below.
const COMPACT_BAR_WIDTH = 6

/** The merged "队伍 / PARTY" roster: every member from `party` in one list, with
 * the player's own character (`character`) rendered inline as an expandable
 * status row instead of a plain name line — collapsed shows a compact HP/MP/SAN
 * bar summary (reusing CharacterPanel's `bar`/`statColor` glyphs), expanded
 * embeds the full `CharacterPanel` (attributes + status effects). Toggle via a
 * mouse click on the row, or Enter while this panel is focused (see `focused`). */
export function PartyRoster({ character, party, initiative, theme, focused, onFocus }: PartyRosterProps) {
  const [expanded, setExpanded] = useState(false)

  const toggle = () => {
    if (!character) return
    onFocus()
    setExpanded((value) => !value)
  }

  useKeyboard((event) => {
    if (!focused || !character) return
    if (keyName(event) === "return") setExpanded((value) => !value)
  })

  // The roster (`party`) and the caller's own sheet (`character`) are both keyed
  // by character name (see core.character_manager.sync_party_roster), so the
  // player's own roster row is whichever entry shares that name; it's rendered
  // specially below instead of as a plain name line.
  const ownName = character?.name
  const ownMember = ownName ? party.find((member) => member.name === ownName) : undefined
  const otherMembers = ownName ? party.filter((member) => member.name !== ownName) : party

  return (
    <box flexDirection="column" border borderColor={focused ? theme.accent : theme.border} paddingX={1}>
      <text fg={theme.accent}>队伍 / PARTY</text>

      {character ? (
        <box flexDirection="column" onMouseDown={toggle}>
          <text fg={focused ? theme.accent : theme.player}>
            {expanded ? "▾" : "▸"} {(ownMember?.online ?? true) ? "●" : "○"} {stripControlChars(character.name)} (你)
          </text>
          {expanded ? (
            <CharacterPanel character={character} theme={theme} />
          ) : (
            <>
              <text fg={statColor(character.hp, character.hpmax, theme.hpFull, theme.hpLow)}>
                HP {bar(character.hp, character.hpmax, COMPACT_BAR_WIDTH)} {character.hp}/{character.hpmax}
              </text>
              <text fg={theme.success}>
                MP {bar(character.mp, character.mpmax, COMPACT_BAR_WIDTH)} {character.mp}/{character.mpmax}
              </text>
              <text fg={statColor(character.san, character.sanmax, theme.sanFull, theme.sanLow)}>
                SAN {bar(character.san, character.sanmax, COMPACT_BAR_WIDTH)} {character.san}/{character.sanmax}
              </text>
            </>
          )}
        </box>
      ) : (
        <text fg={theme.dim}>尚未创建角色</text>
      )}

      {/* TODO(protocol): other members only carry name/online/ai on the wire today
          (`PartyMember` has no per-member HP/SAN/status) — showing more than a name
          row for a companion or another player's character needs a new field on
          `state.party[]` first. */}
      {otherMembers.length === 0 && !character ? (
        <text fg={theme.dim}>No roster</text>
      ) : (
        otherMembers.map((member) => (
          <text key={member.name} fg={member.online ? theme.player : theme.dim}>
            {member.active ? "▶" : " "} {member.online ? "●" : "○"} {stripControlChars(member.name)}
            {member.ai ? " [AI]" : ""}
            {initiativeValue(member, initiative)}
          </text>
        ))
      )}

      {initiative.length > 0 ? <text fg={theme.dim}>INIT</text> : null}
      {initiative.map((entry) => (
        <text key={`${entry.name}-${entry.value}`} fg={entry.current ? theme.accent : theme.fg}>
          {entry.current ? "▶" : " "} {stripControlChars(entry.name)} {entry.value}
        </text>
      ))}
    </box>
  )
}
