import { stripControlChars, type ClockState, type SceneState } from "@trpg-kp/protocol"
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
      <text fg={theme.accent}>{tt(locale, "scene.title")}</text>
      <text fg={theme.kp}>{stripControlChars(scene?.name ?? tt(locale, "scene.unframed"))}</text>
      {scene?.focus ? <text fg={theme.player}>{stripControlChars(scene.focus)}</text> : null}
      <text fg={theme.fg}>
        {tt(locale, "scene.clock")} {stripControlChars(clock?.time ?? "--:--")}
      </text>
      <text fg={theme.fg}>
        {tt(locale, "scene.round")} {clock?.round ?? "-"}
      </text>
    </box>
  )
}
