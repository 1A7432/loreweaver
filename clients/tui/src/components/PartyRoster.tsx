import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import { stripControlChars, type CharactersView, type PartyView, type ViewResource } from "loreweaver-protocol/v3"
import { tt } from "../i18n"
import type { Palette } from "../themes"
import { bar, CharacterPanel, statColor, type SheetCharacter } from "./CharacterPanel"
import { FitText } from "./FitText"

type Claimable = CharactersView["claimable"][number]
type PartyCharacter = PartyView["characters"][number]

/** A claimable character's one-line concept on a single line — newlines collapse to spaces so
 * the sidebar row stays one row — or "" when there is none. Untrusted server text. */
export function claimableBlurb(entry: Claimable): string {
  return stripControlChars(entry.blurb.replace(/\s+/g, " ")).trim()
}

/** The characters still on offer: claimable and held by nobody. */
export function freeClaimables(characters: CharactersView | null | undefined): Claimable[] {
  return (characters?.claimable ?? []).filter((entry) => entry.player === null)
}

export interface PartyRosterProps {
  /** The viewer's own character (`me` view). */
  character?: SheetCharacter | null
  party?: PartyView | null
  characters?: CharactersView | null
  theme: Palette
  locale?: string
  // Whether THIS panel (vs the chat input) currently owns Enter. `<box>` has no native
  // per-element key routing in OpenTUI, so GameView tracks one shared boolean and flips the
  // chat `<input>`'s own `focused` prop off in lockstep: a bare Enter is never handled twice.
  focused: boolean
  onFocus: () => void
  /** Claim a character on offer (`pc claim` with its id). */
  onClaim?: (id: string) => void
  initiativeFirst?: boolean
}

function keyName(event: KeyEvent): string {
  return typeof event.name === "string" ? event.name.toLowerCase() : ""
}

// The compact bar width in a collapsed row — narrower than CharacterPanel's own default (10)
// so the label, bar and numbers fit the sidebar column.
const COMPACT_BAR_WIDTH = 6
const DETAIL_BAR_WIDTH = 10

function resourceLine(res: ViewResource, width: number): string {
  return `${stripControlChars(res.label || res.id)} ${bar(res.value, res.max, width)} ${res.value}/${res.max}`
}

/** The "PARTY" roster from the `party` view: the viewer's own character as an expandable status
 * row (collapsed: compact resource bars; expanded: the full CharacterPanel), the other characters
 * in play with who plays them and whether that member is online, members seated without a
 * character, the characters still on offer (`characters` view) and the fight's order. Toggle a
 * row with a click, or Enter while this panel is focused. */
export function PartyRoster({ character, party, characters, theme, locale, focused, onFocus, onClaim, initiativeFirst = false }: PartyRosterProps) {
  const [expanded, setExpanded] = useState(false)
  const [expandedOthers, setExpandedOthers] = useState<Set<string>>(() => new Set())
  const members = party?.members ?? []
  const online = new Map(members.map((member) => [member.id, member.online]))
  const others: PartyCharacter[] = (party?.characters ?? []).filter((entry) => entry.id !== character?.id)
  const seatedIds = new Set((party?.characters ?? []).map((entry) => entry.id))
  const loose = members.filter((member) => member.character === null || !seatedIds.has(member.character))
  const offered = characters?.claimable ?? []
  const free = freeClaimables(characters)

  const toggleOwn = () => {
    if (!character) return
    onFocus()
    setExpanded((value) => !value)
  }

  const toggleOther = (id: string) => {
    onFocus()
    setExpandedOthers((value) => {
      const next = new Set(value)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  useKeyboard((event) => {
    if (!focused || keyName(event) !== "return") return
    if (character) {
      setExpanded((value) => !value)
      return
    }
    // No own character yet: claiming one IS this player's next action.
    const first = free[0]
    if (first && onClaim) {
      onClaim(first.id)
      return
    }
    const expandable = others.find((entry) => entry.resources.length > 0)
    if (expandable) toggleOther(expandable.id)
  })

  const fight = party?.initiative ?? null
  const initiativeRows =
    fight && fight.order.length > 0 ? (
      <box flexDirection="column">
        <text fg={theme.dim} wrapMode="none" truncate>
          {tt(locale, "party.initiative", { round: fight.round })}
        </text>
        {fight.order.map((entry, index) => {
          const acting = fight.acting !== null && entry.name === fight.acting
          return (
            <text key={`${entry.name}-${index}`} fg={acting ? theme.accent : theme.fg} wrapMode="none" truncate>
              {acting ? "▶" : " "} {stripControlChars(entry.name)} {entry.value}
            </text>
          )
        })}
      </box>
    ) : null

  return (
    <box flexDirection="column" border borderColor={focused ? theme.accent : theme.border} paddingX={1}>
      <text fg={theme.accent} wrapMode="none" truncate>{tt(locale, "party.title")}</text>
      {initiativeFirst ? initiativeRows : null}

      {character ? (
        <box flexDirection="column" onMouseDown={toggleOwn}>
          <text fg={focused ? theme.accent : theme.player} wrapMode="none" truncate>
            {expanded ? "▾" : "▸"} ● {stripControlChars(character.name)} ({tt(locale, "party.you")})
          </text>
          {expanded ? (
            <CharacterPanel character={character} theme={theme} locale={locale} />
          ) : (
            character.resources.map((res) => (
              <text key={res.id} fg={statColor(res.value, res.max, theme.hpFull, theme.hpLow)} wrapMode="none" truncate>
                {resourceLine(res, COMPACT_BAR_WIDTH)}
              </text>
            ))
          )}
        </box>
      ) : others.length === 0 && loose.length === 0 ? (
        <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "party.empty")}</text>
      ) : (
        <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "party.noCharacter")}</text>
      )}

      {others.map((entry) => {
        const canExpand = entry.resources.length > 0
        const open = expandedOthers.has(entry.id)
        const isOnline = entry.player ? (online.get(entry.player.id) ?? false) : false
        const who = entry.player ? ` · ${stripControlChars(entry.player.name)}` : ` · ${tt(locale, "party.companion")}`
        return (
          <box key={entry.id} flexDirection="column" onMouseDown={canExpand ? () => toggleOther(entry.id) : undefined}>
            <text fg={isOnline || !entry.player ? theme.player : theme.dim} wrapMode="none" truncate>
              {`${canExpand ? (open ? "▾" : "▸") : " "} ${isOnline ? "●" : "○"} ${stripControlChars(entry.name)}${who}`}
            </text>
            {entry.resources.map((res) => (
              <text key={`${entry.id}-${res.id}`} fg={statColor(res.value, res.max, theme.hpFull, theme.hpLow)} wrapMode="none" truncate>
                {resourceLine(res, open ? DETAIL_BAR_WIDTH : COMPACT_BAR_WIDTH)}
              </text>
            ))}
          </box>
        )
      })}

      {loose.map((member) => (
        <text key={`m-${member.id}`} fg={member.online ? theme.fg : theme.dim} wrapMode="none" truncate>
          {`  ${member.online ? "●" : "○"} ${stripControlChars(member.name)}`}
        </text>
      ))}

      {offered.length > 0 ? (
        <box flexDirection="column">
          <text fg={theme.dim} wrapMode="none" truncate>{tt(locale, "party.pregens")}</text>
          {offered.map((entry) =>
            entry.player ? (
              <FitText key={entry.id} fg={theme.dim}>
                {`✓ ${stripControlChars(entry.name)} · ${tt(locale, "party.pregenClaimed", { who: stripControlChars(entry.player.name) })}`}
              </FitText>
            ) : (
              <box key={entry.id} flexDirection="column" onMouseDown={() => onClaim?.(entry.id)}>
                <text fg={theme.player} wrapMode="none" truncate>
                  {"▸ "}
                  {stripControlChars(entry.name)}
                </text>
                {claimableBlurb(entry) ? <FitText fg={theme.dim}>{`  ${claimableBlurb(entry)}`}</FitText> : null}
              </box>
            ),
          )}
        </box>
      ) : null}

      {initiativeFirst ? null : initiativeRows}
    </box>
  )
}
