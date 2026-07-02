import { useEffect, useState } from "react"

// A tiny animated liveness indicator. The Braille frames spin smoothly and read
// as "alive" in any monospace terminal; 10 frames × ~110ms ≈ a ~1.1s cycle.
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

// ~110ms per frame: fast enough to read as motion, slow enough not to thrash the
// terminal. Mirrors the flicker cadence CharacterScreen already uses for its roll.
const SPINNER_INTERVAL_MS = 110

// Advances a spinner glyph on a fixed cadence while `active`, returning the current
// frame. The interval is cleared on unmount AND whenever `active` flips false (the
// effect re-runs and its cleanup fires), so no timer leaks across screens — the same
// discipline as CharacterScreen's roll interval. When inactive it parks on the first
// frame, so a resumed spinner always starts clean.
export function useSpinner(active: boolean): string {
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => {
      setIndex((prev) => (prev + 1) % SPINNER_FRAMES.length)
    }, SPINNER_INTERVAL_MS)
    return () => clearInterval(id)
  }, [active])
  return SPINNER_FRAMES[active ? index : 0]
}

export interface SpinnerProps {
  active: boolean
  // Optional caption rendered beside the glyph. The glyph leads by default
  // (`⠋ label`); set `trailing` for the `label ⠋` form.
  label?: string
  color?: string
  trailing?: boolean
}

// A leaf component so its ~110ms re-render stays local and never re-renders a
// heavier parent (e.g. the narrative log). Renders nothing while inactive, so
// callers can drop it inline without a wrapping ternary.
export function Spinner({ active, label, color, trailing = false }: SpinnerProps) {
  const glyph = useSpinner(active)
  if (!active) return null
  const text = label == null ? glyph : trailing ? `${label} ${glyph}` : `${glyph} ${label}`
  return <text fg={color}>{text}</text>
}

export default Spinner
