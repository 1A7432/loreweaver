import type { DiceFrame, NarrativeFrame, SystemFrame } from "@loreweaver/protocol"
import { MiniMarkdown } from "../markdown"

export type LogFrame = NarrativeFrame | DiceFrame | SystemFrame

export interface NarrativeLogProps {
  frames: LogFrame[]
}

// Dice color-by-rank -> CSS class (styled in themes.css):
//   crit +4 gold · +3 / +2 cyan · +1 green · -1 amber · -2 red.
export function diceRankClass(rank?: number): string {
  const r = rank ?? 0
  if (r >= 4) return "crit-success"
  if (r === 3) return "extreme-success"
  if (r === 2) return "hard-success"
  if (r >= 1) return "regular-success"
  if (r <= -2) return "fumble"
  if (r <= -1) return "fail"
  return "neutral"
}

function speakerLabel(frame: NarrativeFrame): string {
  if (frame.speaker === "kp") return "KP"
  if (frame.speaker === "npc") return frame.name ?? "NPC"
  if (frame.name) return frame.name
  return frame.speaker.toUpperCase()
}

function DiceLine({ frame }: { frame: DiceFrame }) {
  const level = frame.level ?? (frame.success ? "SUCCESS" : "FAIL")
  const target = typeof frame.target === "number" ? ` vs ${frame.target}` : ""
  return (
    <div className="dice-line">
      <span className={`dice-chip ${diceRankClass(frame.rank)}`}>{level}</span>
      <span className="dice-detail">
        {frame.actor} {frame.expr} = {frame.total}
        {target}
      </span>
    </div>
  )
}

export function NarrativeLog({ frames }: NarrativeLogProps) {
  if (frames.length === 0) {
    return (
      <div className="narrative-inner">
        <p className="narrative-empty">Waiting for the Keeper...</p>
      </div>
    )
  }
  return (
    <div className="narrative-inner">
      {frames.map((frame, index) => {
        if (frame.type === "dice") {
          return <DiceLine key={`dice-${index}`} frame={frame} />
        }
        if (frame.type === "system") {
          return (
            <p key={`system-${index}`} className={`narrative-line system ${frame.level}`}>
              [{frame.level.toUpperCase()}] {frame.text}
            </p>
          )
        }
        if (frame.speaker === "kp") {
          return (
            <div key={`kp-${frame.id}-${index}`} className="narrative-line kp">
              <span className="speaker">{speakerLabel(frame)}</span>
              {frame.format === "markdown" ? (
                <MiniMarkdown text={frame.text} />
              ) : (
                <p className="md-p">{frame.text}</p>
              )}
            </div>
          )
        }
        if (frame.speaker === "npc") {
          return (
            <p key={`npc-${frame.id}-${index}`} className="narrative-line npc">
              <span className="npc-name">{speakerLabel(frame)}</span>
              <span className="npc-text">{frame.text}</span>
            </p>
          )
        }
        return (
          <p key={`${frame.speaker}-${frame.id}-${index}`} className={`narrative-line ${frame.speaker}`}>
            <span className="speaker-inline">{speakerLabel(frame)}: </span>
            {frame.text}
          </p>
        )
      })}
    </div>
  )
}
