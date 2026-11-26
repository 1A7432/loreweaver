import { stripControlChars, type SceneView } from "loreweaver-protocol/v3"
import { tt } from "../i18n"
import type { Palette } from "../themes"

export interface ScenePanelProps {
  scene?: SceneView | null
  theme: Palette
  locale?: string
  /**
   * How many of the facts the table has established to show, newest last (0: none). Where the
   * panel has room — a scrolling sidebar — the caller asks for more.
   */
  established?: number
}

/** The scene's name, or the "unframed" word while the Keeper has not named one. */
export function sceneName(scene: SceneView | null | undefined, locale?: string): string {
  const name = scene ? stripControlChars(scene.name).trim() : ""
  return name || tt(locale, "scene.unframed")
}

export function ScenePanel({ scene, theme, locale, established = 0 }: ScenePanelProps) {
  const focus = scene ? stripControlChars(scene.focus).trim() : ""
  const facts = established > 0 ? (scene?.established ?? []).slice(-established) : []
  const hidden = established > 0 ? Math.max(0, (scene?.established.length ?? 0) - facts.length) : 0
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
      {facts.length > 0 ? (
        <box flexDirection="column" marginTop={1} width="100%" minWidth={0} flexShrink={0}>
          <text fg={theme.accent} wrapMode="none" truncate>
            {tt(locale, "scene.established")}
            {hidden > 0 ? ` ${tt(locale, "scene.establishedMore", { count: hidden })}` : ""}
          </text>
          {facts.map((fact, index) => (
            <text key={index} fg={theme.fg}>
              · {stripControlChars(fact.text)}
              {fact.at ? <span fg={theme.dim}> ({stripControlChars(fact.at)})</span> : null}
            </text>
          ))}
        </box>
      ) : null}
    </box>
  )
}
