import { SyntaxStyle } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useEffect, useMemo } from "react"
import { stripControlChars, type DiceData } from "loreweaver-protocol/v3"
import { tt } from "../i18n"
import { blockPictureKey, itemBlocks, lastChoicesIndex, type LogItem, type Picture } from "../log"
import { diceText, localText, markerText, mediaText, speakerLabel } from "../logText"
import type { Palette } from "../themes"
import { Spinner } from "./Spinner"
import { UiBlocksView, type UiChoice } from "./UiBlocks"

// Narrative markdown only needs basic emphasis styling. The SyntaxStyle itself is a native
// resource owned by a renderer, so the log builds one per renderer (see below).
const NARRATIVE_STYLES = {
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.strikethrough": { dim: true },
}

export interface NarrativeLogProps {
  items: readonly LogItem[]
  theme: Palette
  /** The dice event being revealed (the newest live roll) and how far its reveal has got (0..3). */
  revealSeq?: number
  revealTicks?: number
  critFlash?: boolean
  // While a turn is in flight a trailing animated spinner rides the bottom of the log.
  working?: boolean
  workingLabel?: string
  /** A line at the top: older history can be loaded, or earlier lines were hidden. */
  topHint?: string
  /** Ids of narratives that replaced a draft streamed in front of this player: those take the
   * styled (asynchronous) markdown path. Every other line keeps the synchronous fallback, which
   * draws in the same render pass — history replayed on join included. */
  styledIds?: ReadonlySet<string>
  locale?: string
  // Whether the latest choices select owns the keyboard (GameView's Tab cycle), and what a
  // picked option is acted on with.
  choicesFocused?: boolean
  onChoicePick?: (option: UiChoice) => void
  /** Member names by id (the `party` view), for who shared a file. */
  names?: ReadonlyMap<string, string>
  /** The picture the arrows have selected (its `Picture.key`), drawn highlighted. */
  selectedPicture?: string
  /** A picture was clicked. */
  onPictureOpen?: (key: string) => void
}

function diceColor(dice: DiceData, theme: Palette): string {
  // Colour by the outcome's semantic flags — never by a rank id.
  const outcome = dice.outcome
  if (!outcome) return theme.system
  if (outcome.critical) return theme.crit
  if (outcome.fumble) return theme.fumble
  if (outcome.success) return theme.success
  return theme.fail
}

// Markdown image syntax, e.g. `![alt](https://host/path.png)`. Alt text stops at the
// first `]`, the target at the first `)` — enough for the `![alt](url)` an imported
// card's CG line emits, and it degrades to "leave the text alone" on anything odder.
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\([^)]*\)/g
const FENCE = /^\s*(?:```|~~~)/

/** Rewrite markdown images to a labelled text placeholder before the renderer sees
 * them. A terminal cannot fetch a remote CG, and OpenTUI's markdown renderer drops
 * the URL and prints the BARE alt text — so a card's illustration line reads as a stray
 * sentence of narration. `[image] alt` keeps it honest. Fenced code is left untouched. */
export function imagePlaceholders(text: string, locale?: string): string {
  if (!text.includes("![")) return text
  const tag = tt(locale, "log.image")
  let fenced = false
  return text
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced
        return line
      }
      if (fenced) return line
      return line.replace(MARKDOWN_IMAGE, (_match, alt: string) => {
        const label = alt.trim()
        return label ? `[${tag}] ${label}` : `[${tag}]`
      })
    })
    .join("\n")
}

export function NarrativeLog({
  items,
  theme,
  revealSeq,
  revealTicks = 3,
  critFlash = false,
  working = false,
  workingLabel,
  topHint,
  styledIds,
  locale,
  choicesFocused = false,
  onChoicePick,
  names,
  selectedPicture,
  onPictureOpen,
}: NarrativeLogProps) {
  const renderer = useRenderer()
  const narrativeSyntaxStyle = useMemo(() => SyntaxStyle.fromStyles(NARRATIVE_STYLES, renderer.nativeScene), [renderer])
  useEffect(() => () => narrativeSyntaxStyle.destroy(), [narrativeSyntaxStyle])
  const activeChoices = lastChoicesIndex(items)
  const label = workingLabel ?? tt(locale, "log.working")
  return (
    <box flexDirection="column" width="100%" paddingX={1}>
      {topHint ? <text fg={theme.dim}>{topHint}</text> : null}
      {items.length === 0 ? (
        working ? (
          // A turn is in flight: animate, so this reads as "alive, awaiting the Keeper" rather
          // than a hung connection.
          <Spinner active label={label} color={theme.accent} />
        ) : (
          // Idle: a STATIC hint — an animated spinner with nothing happening reads as frozen.
          <text fg={theme.dim}>{tt(locale, "log.ready")}</text>
        )
      ) : (
        items.map((item, index) => {
          if (item.kind === "draft") {
            // A bubble being streamed: drawn as the Keeper's, replaced by its `narrative` event.
            // `streaming` makes the markdown renderer draw its synchronous fallback.
            return (
              <box key={item.key} flexDirection="column" width="100%">
                <text fg={theme.dim}>{tt(locale, "log.speaker.kp")}</text>
                <markdown content={imagePlaceholders(stripControlChars(item.draft.text), locale)} fg={theme.kp} syntaxStyle={narrativeSyntaxStyle} streaming />
              </box>
            )
          }
          if (item.kind === "local") {
            const line = item.line
            if (line.spinner) return <Spinner key={item.key} active label={localText(line, locale)} color={theme.accent} />
            if (line.kind === "notice") {
              // An out-of-band line for the table — a turn that failed, a long operation — set
              // apart from the story by a bar in the margin and its own colour, never in a story voice.
              const tone = line.level === "warn" ? theme.fumble : theme.accent
              return (
                <box key={item.key} border={["left"]} borderColor={tone} paddingLeft={1} width="100%" flexShrink={0}>
                  <text fg={tone}>{localText(line, locale)}</text>
                </box>
              )
            }
            const color = line.kind === "result" ? theme.system : line.level === "warn" ? theme.fail : theme.system
            return (
              <text key={item.key} fg={color}>
                {localText(line, locale)}
              </text>
            )
          }
          const event = item.event
          if (event.kind === "dice") {
            const flash = critFlash && event.seq === revealSeq && event.data.outcome?.critical === true
            const rolling = event.seq === revealSeq && revealTicks < 2
            return (
              <text key={item.key} fg={flash ? theme.bg : diceColor(event.data, theme)} bg={flash ? theme.crit : theme.bg}>
                {diceText(event.data, rolling)}
              </text>
            )
          }
          if (event.kind === "blocks") {
            const blocks = itemBlocks(item)
            if (!blocks) return null
            return (
              <UiBlocksView
                key={item.key}
                blocks={blocks.blocks}
                theme={theme}
                locale={locale}
                meterWidth={10}
                interactive={onChoicePick && index === activeChoices ? { focused: choicesFocused, onPick: onChoicePick } : undefined}
                images={{ key: (at) => blockPictureKey(item.key, at), selected: selectedPicture, ...(onPictureOpen ? { onOpen: onPictureOpen } : {}) }}
              />
            )
          }
          if (event.kind === "narrative") {
            const data = event.data
            if (data.speaker === "kp" && data.format === "markdown") {
              return (
                <box key={item.key} flexDirection="column" width="100%">
                  <text fg={theme.dim}>{speakerLabel(data, locale)}</text>
                  <markdown
                    content={imagePlaceholders(stripControlChars(data.text), locale)}
                    fg={theme.kp}
                    syntaxStyle={narrativeSyntaxStyle}
                    streaming={!(styledIds?.has(event.id) ?? false)}
                  />
                </box>
              )
            }
            const color = data.speaker === "player" ? theme.player : data.speaker === "npc" ? theme.npc : theme.system
            return (
              <text key={item.key} fg={color}>
                {speakerLabel(data, locale)}: {stripControlChars(data.text)}
              </text>
            )
          }
          if (event.kind === "media") {
            const picture = event.data.mime.startsWith("image/")
            const selected = picture && selectedPicture === item.key
            return (
              <box
                key={item.key}
                width="100%"
                flexShrink={0}
                backgroundColor={selected ? theme.accent : undefined}
                onMouseDown={picture && onPictureOpen ? () => onPictureOpen(item.key) : undefined}
              >
                <text fg={selected ? theme.bg : theme.system}>
                  {mediaText(event.data, names, locale)}
                  {selected ? `  ${tt(locale, "log.pictureOpen")}` : ""}
                </text>
              </box>
            )
          }
          const marker = markerText(event, locale, names)
          return marker ? (
            <text key={item.key} fg={theme.dim}>
              {marker}
            </text>
          ) : null
        })
      )}
      {items.length > 0 && working ? <Spinner active label={label} trailing color={theme.accent} /> : null}
    </box>
  )
}
