import type { ClockState, SceneState } from "@trpg-kp/protocol"
import type { Palette } from "../themes"

export interface ScenePanelProps {
  scene?: SceneState
  clock?: ClockState
  theme: Palette
}

export function ScenePanel({ scene, clock, theme }: ScenePanelProps) {
  return (
    <box flexDirection="column" border borderColor={theme.border} paddingX={1} flexGrow={1}>
      <text fg={theme.accent}>SCENE</text>
      <text fg={theme.kp}>{scene?.name ?? "Unframed"}</text>
      {scene?.focus ? <text fg={theme.player}>{scene.focus}</text> : null}
      <text fg={theme.fg}>CLOCK {clock?.time ?? "--:--"}</text>
      <text fg={theme.fg}>ROUND {clock?.round ?? "-"}</text>
    </box>
  )
}

