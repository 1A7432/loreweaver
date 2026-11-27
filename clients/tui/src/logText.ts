// The words for log entries, shared by the on-screen log and the transcript export so the file
// reads like what the player saw. Server text is control-stripped here, once.
import { stripControlChars, type Block, type DiceData, type EventFrame, type MediaData, type NarrativeData } from "loreweaver-protocol/v3"
import { badgeLine, clippingLines, imageLine, letterLines, mapPinLine, meterLine, statLine, titleCardLines } from "./components/UiBlocks"
import type { LocalLine } from "./connection"
import { tt } from "./i18n"

export function speakerLabel(data: NarrativeData, locale?: string): string {
  if (data.speaker === "kp") return tt(locale, "log.speaker.kp")
  if (data.speaker === "npc") return data.name ? `[${stripControlChars(data.name)}]` : tt(locale, "log.speaker.npc")
  if (data.name) return stripControlChars(data.name)
  return tt(locale, data.speaker === "player" ? "log.speaker.player" : "log.speaker.system")
}

/**
 * One roll as a line. `rolling` shows the die still tumbling (the reveal animation). The
 * server's own line (`text`) when it sent one — an opposed roll, a roll with a consequence, a
 * plain roll; otherwise what was rolled for (`label`) before the numbers.
 */
export function diceText(dice: DiceData, rolling = false): string {
  const subsystem = dice.subsystemLabel ? `${dice.subsystemLabel} · ` : ""
  const prefix = rolling ? "⚄ ..." : "⚄"
  if (dice.text) return stripControlChars(`${prefix} ${subsystem}${dice.actor}: ${dice.text}`)
  const target = typeof dice.effectiveTarget === "number" ? ` vs ${dice.effectiveTarget}` : typeof dice.target === "number" ? ` vs ${dice.target}` : ""
  const outcome = dice.outcome?.label ? ` -> ${dice.outcome.label}` : ""
  const label = dice.label ? `${dice.label} ` : ""
  return stripControlChars(`${prefix} ${subsystem}${dice.actor} ${label}${dice.expr} ${dice.total}${target}${outcome}`)
}

/** A local line's text: the server's words, or — for a request that got no answer — ours. */
export function localText(line: LocalLine, locale?: string): string {
  if (line.kind === "failed") {
    const offline = line.code === "not_connected" || line.code === "link_closed" || line.code === "session_ended"
    return offline ? tt(locale, "log.notConnected") : tt(locale, "log.requestFailed", { code: line.code ?? "" })
  }
  const text = stripControlChars(line.text)
  if (line.kind === "notice") return `[${tt(locale, line.level === "warn" ? "log.warn" : "log.info")}] ${text}`
  if (line.kind === "refusal") return `✖ ${text}`
  return text
}

/** Blocks as plain lines (the transcript; the screen draws them with colour). */
export function blockLines(blocks: readonly Block[], locale?: string): string[] {
  return blocks.flatMap((block): string[] => {
    switch (block.kind) {
      case "divider":
        return ["─".repeat(24)]
      case "meter":
        return [meterLine(block, 10)]
      case "stat":
        return [statLine(block, locale)]
      case "badge":
        return [badgeLine(block)]
      case "text":
        return [stripControlChars(block.text)]
      case "image":
        return [imageLine(block, locale)]
      case "map_pin":
        return [mapPinLine(block)]
      case "letter":
        return letterLines(block)
      case "clipping":
        return clippingLines(block)
      case "title_card":
        return titleCardLines(block)
      case "choices":
        return [...(block.prompt ? [stripControlChars(block.prompt)] : []), ...block.options.map((option) => `▫ ${stripControlChars(option.label)}`)]
    }
  })
}

/** Who shared a file: the member's name from the `party` view, "the server", or the id as a last resort. */
export function sharerName(from: string, names: ReadonlyMap<string, string> | undefined, locale?: string): string {
  if (from === "server") return tt(locale, "log.fromServer")
  return stripControlChars(names?.get(from) ?? from)
}

/** A shared file as one line: a picture or another file, its name, who shared it. */
export function mediaText(data: MediaData, names: ReadonlyMap<string, string> | undefined, locale?: string): string {
  const vars = { name: stripControlChars(data.name), from: sharerName(data.from, names, locale) }
  return tt(locale, data.mime.startsWith("image/") ? "log.picture" : "log.file", vars)
}

/** An event that is not a narrative, dice or blocks entry, as one line. */
export function markerText(event: EventFrame, locale?: string, names?: ReadonlyMap<string, string>): string | null {
  if (event.kind === "media") return mediaText(event.data, names, locale)
  if (event.kind === "rewind") return tt(locale, "log.rewind")
  if (event.kind === "reset") return tt(locale, "log.reset", { scope: tt(locale, `log.resetScope.${event.data.scope}`) })
  return null
}
