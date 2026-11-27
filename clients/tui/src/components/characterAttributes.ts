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

/** The attributes a panel lists; a sheet with more shows them on the character screen. */
export const MAX_PANEL_ATTRIBUTES = 12
/**
 * The cells a panel's attribute rows always have: the narrowest sidebar (24), inside the
 * roster's frame and the panel's own. Two attributes share a row when both fit in this.
 */
export const PANEL_ATTRIBUTE_CELLS = 16
const COLUMN_GAP = 2

/**
 * The rows of a compact panel: every attribute of the sheet (up to `MAX_PANEL_ATTRIBUTES`), two
 * to a row when the widest fits twice in `cells`, else one to a row. Listing only the first few
 * hid the rest of a sheet — CoC's POW, EDU and Luck come after its sixth.
 */
export function attributeRows(stats: readonly ViewStat[] | undefined, cells: number = PANEL_ATTRIBUTE_CELLS): string[] {
  const lines = attributeLines((stats ?? []).slice(0, MAX_PANEL_ATTRIBUTES)).map((entry) => entry.line)
  const widest = Math.max(0, ...lines.map((line) => Bun.stringWidth(line)))
  if (lines.length < 2 || widest * 2 + COLUMN_GAP > cells) return lines
  const rows: string[] = []
  for (let i = 0; i < lines.length; i += 2) {
    const right = lines[i + 1]
    rows.push(right === undefined ? (lines[i] as string) : `${padCells(lines[i] as string, widest + COLUMN_GAP)}${right}`)
  }
  return rows
}
