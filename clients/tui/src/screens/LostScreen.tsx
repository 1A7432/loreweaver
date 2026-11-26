import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { KeyEvent } from "@opentui/core"
import type { LostReason } from "../connection"
import { tt } from "../i18n"
import type { Palette } from "../themes"

export interface LostScreenProps {
  reason: LostReason
  theme: Palette
  locale: string
  /** Back to the connect screen. */
  onBack: () => void
  onQuit?: () => void
}

const CURSOR = "⚄"

// The client stopped redialling: the server it started has exited (its ticket died with it), or
// the redials ran out. Say which, and offer the way back to the connect screen.
export function LostScreen({ reason, theme, locale, onBack, onQuit }: LostScreenProps) {
  const [selected, setSelected] = useState(0)
  const items = [{ label: tt(locale, "lost.back"), run: onBack }, ...(onQuit ? [{ label: tt(locale, "menu.quit"), run: onQuit }] : [])]
  const clamp = (index: number) => Math.max(0, Math.min(items.length - 1, index))

  useKeyboard((event: KeyEvent) => {
    const name = typeof event.name === "string" ? event.name.toLowerCase() : ""
    if (name === "up") setSelected((prev) => clamp(prev - 1))
    if (name === "down") setSelected((prev) => clamp(prev + 1))
    if (name === "return" || name === "enter") items[clamp(selected)]?.run()
  })

  return (
    <box flexDirection="column" height="100%" width="100%" backgroundColor={theme.bg} paddingX={2} paddingY={1}>
      <text fg={theme.fumble}>{tt(locale, reason === "server_exited" ? "lost.serverExited" : "lost.redials")}</text>
      <box flexDirection="column" marginTop={1}>
        {items.map((item, index) => (
          <box
            key={item.label}
            height={1}
            backgroundColor={selected === index ? theme.accent : theme.bg}
            // The pointer MOVING onto a row selects it — never a row that appears under a still pointer.
            onMouseMove={() => setSelected(index)}
            onMouseDown={() => item.run()}
          >
            <text fg={selected === index ? theme.bg : theme.fg}>
              {selected === index ? `${CURSOR} ` : "  "}
              {item.label}
            </text>
          </box>
        ))}
      </box>
    </box>
  )
}

export default LostScreen
