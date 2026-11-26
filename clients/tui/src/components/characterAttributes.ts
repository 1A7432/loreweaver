import { stripControlChars, type ViewStat } from "loreweaver-protocol/v3"

export interface AttributeLine {
  key: string
  /** The label the `me` view gave the stat, in this viewer's language; the key when it is empty. */
  label: string
  value: number | string
  line: string
}

/** The name a line shows: the view's label, else the storage key. Untrusted server text:
 * control characters are stripped. */
export function attributeLabel(stat: ViewStat): string {
  const cleaned = stripControlChars(stat.label).trim()
  return cleaned || stripControlChars(stat.key)
}

/** `text` padded with spaces to `width` terminal CELLS. A CJK character is two cells
 * wide, so `String.padEnd` (which counts UTF-16 units) would misalign 外貌 against STR. */
function padCells(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - Bun.stringWidth(text)))
}

/** The stats exactly as the view sent them, in the pack's order, as aligned lines. The client
 * knows no rule system: names and order are the server's. */
export function attributeLines(stats: readonly ViewStat[] | undefined): AttributeLine[] {
  const entries = (stats ?? []).map((stat) => [stat, attributeLabel(stat)] as const)
  const width = Math.max(3, ...entries.map(([, label]) => Bun.stringWidth(label)))
  return entries.map(([stat, label]) => ({
    key: stat.key,
    label,
    value: stat.value,
    line: `${padCells(label, width)} ${stripControlChars(String(stat.value))}`,
  }))
}
