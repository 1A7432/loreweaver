import { useLayoutEffect, useRef, type ReactNode } from "react"

const ELLIPSIS = "…"

function graphemes(text: string): string[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment)
}

/** The longest run of `parts` (taken from the front, or from the back when `fromEnd`)
 * that fits in `budget` terminal cells. */
function takeCells(parts: string[], budget: number, fromEnd = false): string {
  const picked: string[] = []
  let used = 0
  for (const part of fromEnd ? [...parts].reverse() : parts) {
    const cells = Bun.stringWidth(part)
    if (used + cells > budget) break
    picked.push(part)
    used += cells
  }
  return (fromEnd ? picked.reverse() : picked).join("")
}

/** `text` cut to at most `width` terminal CELLS with an ellipsis where something was
 * cut: at the end (`"end"`, the default) or in the middle keeping both ends (`"middle"`,
 * for rows whose tail is the value). A CJK character is two cells wide, so this counts
 * with `Bun.stringWidth` per grapheme instead of UTF-16 units.
 *
 * Why not leave it to `<text truncate>`: OpenTUI's own middle truncation miscounts CJK
 * width and can hand back a line ONE cell wider than its box, which pushes the panel
 * border out of line. Untrusted server text (blurbs, labels) is exactly where long
 * unbroken CJK shows up, so every such row cuts itself first. */
export function fitCells(text: string, width: number, mode: "end" | "middle" = "end"): string {
  if (!Number.isFinite(width)) return text
  const limit = Math.max(0, Math.floor(width))
  if (Bun.stringWidth(text) <= limit) return text
  const budget = limit - Bun.stringWidth(ELLIPSIS)
  if (budget < 0) return ""
  const parts = graphemes(text)
  if (mode === "end") return takeCells(parts, budget) + ELLIPSIS
  const tail = Math.floor(budget / 2)
  return takeCells(parts, budget - tail) + ELLIPSIS + takeCells(parts, tail, true)
}

export interface FitTextProps {
  children: string
  fg?: string
  /** Where the ellipsis goes when the row is too long (default `"end"`). */
  cut?: "end" | "middle"
}

/** A one-line `<text>` that fits itself to the width its box was actually given (measured
 * after layout), so the sidebar never depends on OpenTUI's CJK-blind truncation. Until the
 * first layout it holds the whole string under `truncate`, as every other row does.
 *
 * The fit is written straight onto the renderable rather than through React state: a
 * layout callback is not a React event, and a state update from it would warn under test. */
export function FitText({ children, fg, cut = "end" }: FitTextProps): ReactNode {
  const box = useRef<{ width: number } | null>(null)
  const text = useRef<{ content: unknown } | null>(null)
  const fit = () => {
    const width = box.current?.width
    if (text.current && typeof width === "number" && width > 0) text.current.content = fitCells(children, width, cut)
  }
  // After every commit: a new string re-asserts the full content, so refit it.
  useLayoutEffect(fit)
  return (
    <box ref={box as never} flexDirection="column" onSizeChange={fit}>
      <text ref={text as never} fg={fg} wrapMode="none" truncate content={children} />
    </box>
  )
}
