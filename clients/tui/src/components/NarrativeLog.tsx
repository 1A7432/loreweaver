import { SyntaxStyle } from "@opentui/core"
import { stripControlChars, type DiceFrame, type NarrativeFrame, type SystemFrame } from "@loreweaver/protocol"
import { tt } from "../i18n"
import type { Palette } from "../themes"
import { Spinner } from "./Spinner"

export type LogFrame = NarrativeFrame | DiceFrame | SystemFrame

// Markdown rendering requires a SyntaxStyle instance; one shared instance is enough
// since KP narrative markdown only needs basic emphasis styling.
const narrativeSyntaxStyle = SyntaxStyle.fromStyles({
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.strikethrough": { dim: true },
})

export interface NarrativeLogProps {
  frames: LogFrame[]
  theme: Palette
  revealTicks?: number
  critFlash?: boolean
  // While the Keeper's reply to the latest player turn is in flight, a trailing
  // "构思中" spinner rides the bottom of the log (like a chat typing indicator).
  kpWorking?: boolean
  locale?: string
}

function diceColor(frame: DiceFrame, theme: Palette): string {
  if ((frame.rank ?? 0) >= 4) return theme.crit
  if ((frame.rank ?? 0) >= 2) return frame.rank === 2 ? theme.hard : theme.extreme
  if ((frame.rank ?? 0) >= 1) return theme.success
  if ((frame.rank ?? 0) <= -2) return theme.fumble
  if ((frame.rank ?? 0) <= -1) return theme.fail
  return theme.system
}

function diceLine(frame: DiceFrame, revealTicks: number): string {
  const level = frame.level ?? (frame.success ? "SUCCESS" : "FAIL")
  const target = typeof frame.target === "number" ? ` vs ${frame.target}` : ""
  const prefix = revealTicks < 2 ? "⚄ ..." : "⚄"
  // actor / expr / level are server-supplied; scrub control bytes off the line.
  return stripControlChars(`${prefix} ${frame.actor} ${frame.expr} ${frame.total}${target} -> ${level}`)
}

function speakerLabel(frame: NarrativeFrame): string {
  if (frame.speaker === "kp") return "KP"
  if (frame.speaker === "npc") return frame.name ? `[${stripControlChars(frame.name)}]` : "[NPC]"
  if (frame.name) return stripControlChars(frame.name)
  return stripControlChars(frame.speaker.toUpperCase())
}

export function NarrativeLog({
  frames,
  theme,
  revealTicks = 3,
  critFlash = false,
  kpWorking = false,
  locale,
}: NarrativeLogProps) {
  return (
    <box flexDirection="column" width="100%" paddingX={1}>
      {frames.length === 0 ? (
        kpWorking ? (
          // A turn is genuinely in flight (submitted, reply not landed yet): animate
          // so this obviously reads as "alive, awaiting the Keeper" rather than a
          // hung/dropped connection. The client no longer echoes the player's own
          // submitted line optimistically (the server's own `narrative{speaker:"player"}`
          // broadcast is the only echo, so it never renders twice) — so right after a
          // submit, `frames` can still be empty for the round trip.
          <Spinner active label={tt(locale, "log.working")} color={theme.accent} />
        ) : (
          // Idle (no turn in flight): a STATIC hint, no motion — an animated spinner
          // here with nothing actually happening reads as frozen/deceptive (a player
          // waiting on a fresh, empty join saw it spin for 10 minutes with nothing
          // going on). The server also replays room history as narrative frames on
          // join, so this mostly only shows on a genuinely fresh, empty room.
          <text fg={theme.dim}>{tt(locale, "log.ready")}</text>
        )
      ) : (
        frames.map((frame, index) => {
          if (frame.type === "dice") {
            const color = critFlash && (frame.rank ?? 0) >= 4 ? theme.bg : diceColor(frame, theme)
            const backgroundColor = critFlash && (frame.rank ?? 0) >= 4 ? theme.crit : theme.bg
            return (
              <text key={`${frame.type}-${index}`} fg={color} bg={backgroundColor}>
                {diceLine(frame, revealTicks)}
              </text>
            )
          }

          if (frame.type === "system") {
            return (
              <text key={`${frame.type}-${index}`} fg={frame.level === "warn" ? theme.fail : theme.system}>
                {stripControlChars(`[${frame.level.toUpperCase()}] ${frame.text}`)}
              </text>
            )
          }

          if (frame.speaker === "kp" && frame.format === "markdown") {
            // `streaming` must stay true until the frame is marked done: besides matching
            // "chunks still being appended", it also makes MarkdownRenderable draw its
            // synchronous unstyled fallback instead of waiting on async tree-sitter
            // highlighting (which never resolves inside a single render pass/test flush).
            return (
              <box key={`${frame.type}-${frame.id}-${index}`} flexDirection="column" width="100%">
                <text fg={theme.dim}>{speakerLabel(frame)}</text>
                <markdown content={stripControlChars(frame.text)} fg={theme.kp} syntaxStyle={narrativeSyntaxStyle} streaming={!frame.done} />
              </box>
            )
          }

          const color = frame.speaker === "player" ? theme.player : frame.speaker === "npc" ? theme.npc : theme.system
          return (
            <text key={`${frame.type}-${frame.id}-${index}`} fg={color}>
              {speakerLabel(frame)}: {stripControlChars(frame.text)}
            </text>
          )
        })
      )}
      {frames.length > 0 && kpWorking ? <Spinner active label={tt(locale, "log.working")} trailing color={theme.accent} /> : null}
    </box>
  )
}
