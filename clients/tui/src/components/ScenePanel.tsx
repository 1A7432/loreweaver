import { stripControlChars, type ClockState, type SceneState } from "@loreweaver/protocol"
import { tt } from "../i18n"
import type { Palette } from "../themes"

export interface ScenePanelProps {
  scene?: SceneState
  clock?: ClockState
  theme: Palette
  locale?: string
}

export function ScenePanel({ scene, clock, theme, locale }: ScenePanelProps) {
  return (
    <box flexDirection="column" border borderColor={theme.border} paddingX={1} flexGrow={1}>
      <text fg={theme.accent} wrapMode="none" truncate>{tt(locale, "scene.title")}</text>
      <text fg={theme.kp} wrapMode="none" truncate>{stripControlChars(scene?.name ?? tt(locale, "scene.unframed"))}</text>
      {scene?.focus ? <text fg={theme.player} wrapMode="none" truncate>{stripControlChars(scene.focus)}</text> : null}
      <text fg={theme.fg} wrapMode="none" truncate>
        {tt(locale, "scene.clock")} {stripControlChars(clock?.time ?? "--:--")}
      </text>
      <text fg={theme.fg} wrapMode="none" truncate>
        {tt(locale, "scene.round")} {clock?.round ?? "-"}
      </text>
    </box>
  )
}
