import { stripControlChars, type SceneView } from "loreweaver-protocol/v3"
import { tt } from "../i18n"
import type { Palette } from "../themes"

export interface ScenePanelProps {
  scene?: SceneView | null
  theme: Palette
  locale?: string
}

/** The scene's name, or the "unframed" word while the Keeper has not named one. */
export function sceneName(scene: SceneView | null | undefined, locale?: string): string {
  const name = scene ? stripControlChars(scene.name).trim() : ""
  return name || tt(locale, "scene.unframed")
}

export function ScenePanel({ scene, theme, locale }: ScenePanelProps) {
  const focus = scene ? stripControlChars(scene.focus).trim() : ""
  return (
    <box flexDirection="column" border borderColor={theme.border} paddingX={1} flexGrow={1}>
      <text fg={theme.accent} wrapMode="none" truncate>{tt(locale, "scene.title")}</text>
      <text fg={theme.kp} wrapMode="none" truncate>{sceneName(scene, locale)}</text>
      {focus ? <text fg={theme.player} wrapMode="none" truncate>{focus}</text> : null}
      <text fg={theme.fg} wrapMode="none" truncate>
        {tt(locale, "scene.clock")} {stripControlChars(scene?.time ?? "--:--")}
      </text>
      <text fg={theme.fg} wrapMode="none" truncate>
        {tt(locale, "scene.round")} {scene?.round ?? "-"}
      </text>
    </box>
  )
}
