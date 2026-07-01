import type { ClockState, SceneState } from "@trpg-kp/protocol"

export interface ScenePanelProps {
  scene?: SceneState
  clock?: ClockState
}

export function ScenePanel({ scene, clock }: ScenePanelProps) {
  return (
    <section className="panel scene-panel">
      <div className="panel-title">SCENE</div>
      <div className="scene-name">{scene?.name ?? "Unframed"}</div>
      {scene?.focus ? <div className="scene-focus">{scene.focus}</div> : null}
      <div className="scene-clock">
        <span>CLOCK {clock?.time ?? "--:--"}</span>
        <span>ROUND {clock?.round ?? "-"}</span>
      </div>
    </section>
  )
}
