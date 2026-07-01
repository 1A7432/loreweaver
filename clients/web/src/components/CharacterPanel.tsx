import type { CharacterState } from "@trpg-kp/protocol"

export interface CharacterPanelProps {
  character?: CharacterState
}

function ratio(value: number, max: number): number {
  if (max <= 0) return 0
  return Math.max(0, Math.min(1, value / max))
}

interface StatBarProps {
  kind: "hp" | "mp" | "san"
  label: string
  value: number
  max: number
}

function StatBar({ kind, label, value, max }: StatBarProps) {
  const pct = Math.round(ratio(value, max) * 100)
  const low = ratio(value, max) <= 0.35
  return (
    <div className="stat-row">
      <div className="stat-head">
        <span className="stat-label">{label}</span>
        <span className="stat-value">
          {value}/{max}
        </span>
      </div>
      <div
        className={`stat-bar ${kind}${low ? " low" : ""}`}
        role="progressbar"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        <div className="stat-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function CharacterPanel({ character }: CharacterPanelProps) {
  if (!character) {
    return (
      <section className="panel character-panel">
        <div className="panel-title">CHARACTER</div>
        <p className="muted">No character</p>
      </section>
    )
  }

  const attributes = Object.entries(character.attributes).slice(0, 8)
  return (
    <section className="panel character-panel">
      <div className="panel-title">CHARACTER</div>
      <div className="char-name">
        {character.name}
        {character.hp <= 0 ? <span className="incapacitated">DOWN</span> : null}
      </div>
      <StatBar kind="hp" label="HP" value={character.hp} max={character.hpmax} />
      <StatBar kind="mp" label="MP" value={character.mp} max={character.mpmax} />
      <StatBar kind="san" label="SAN" value={character.san} max={character.sanmax} />
      {attributes.length > 0 ? (
        <div className="attributes">
          {attributes.map(([key, value]) => (
            <span key={key}>
              <span className="attr-key">{key.toUpperCase()}</span> {String(value)}
            </span>
          ))}
        </div>
      ) : null}
      {character.status_effects.length > 0 ? (
        <div className="status-effects">✖ {character.status_effects.join(", ")}</div>
      ) : (
        <div className="status-ok">OK</div>
      )}
    </section>
  )
}
