import { useEffect, useState } from "react"
import { useTerminalDimensions } from "@opentui/react"
import { stripControlChars, type SceneView, type UsageView } from "loreweaver-protocol/v3"
import { tt } from "../i18n"
import { headerVisibility } from "../layout"
import type { Palette } from "../themes"
import { sceneName } from "./ScenePanel"

/** The link as a person sees it: up, being redialled, or gone for good. */
export type LinkStatus = "online" | "reconnecting" | "offline"

export interface HeaderBarProps {
  /** The room id from the welcome. */
  room: string
  scene?: SceneView | null
  usage?: UsageView | null
  online: number
  theme: Palette
  locale?: string
  link?: LinkStatus
}
// A plain geometric clock face -- single-width in every terminal font (unlike an
// emoji clock, which typically renders double-width and would throw off column math).
const CLOCK_GLYPH = "◷"

// Formats a raw token count for the compact statusline: 999 -> "999", 12345 -> "12.3k",
// 4200000 -> "4.2M". Exported so its unit tests can pin down the exact thresholds.
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

function wallClock(now: Date): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
}

function cacheColor(theme: Palette, rate: number | null): string {
  return rate !== null && rate >= 50 ? theme.success : theme.dim
}

// A single-width dot for the liveness light — like CLOCK_GLYPH above, an emoji circle
// (🟢/🟡/🔴) renders double-width or as tofu in many terminal fonts and throws off column
// math; the STATE is carried by the dot's color (+ the label when no online count shows).
const CONN_GLYPH = "●"

function connKey(status: LinkStatus): "hud.connOnline" | "hud.connReconnecting" | "hud.connOffline" {
  if (status === "online") return "hud.connOnline"
  if (status === "offline") return "hud.connOffline"
  return "hud.connReconnecting"
}

function connColor(theme: Palette, status: LinkStatus): string {
  if (status === "online") return theme.success
  if (status === "offline") return theme.fumble
  return theme.dim
}

/** The share of the last turn's prompt read from the provider's cache, in percent; null when
 * the prompt was empty. `cachedInputTokens` is a part of `inputTokens`. */
export function cacheRate(usage: NonNullable<UsageView["last"]>): number | null {
  if (usage.inputTokens <= 0) return null
  return Math.min(100, Math.round((usage.cachedInputTokens / usage.inputTokens) * 100))
}

// A height=4 bordered row -- exactly the two inner rows the `tiny` ascii-font needs --
// carrying room identity, scene + in-game clock and a ticking wall clock on the top row,
// and liveness + the last turn's token figures (the `usage` view) on the bottom row.
export function HeaderBar({ room, scene, usage, online, theme, locale, link }: HeaderBarProps) {
  const { width } = useTerminalDimensions()
  const visible = headerVisibility(width)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const last = usage?.last ?? null
  const rate = last ? cacheRate(last) : null

  const sceneLine =
    visible.scene || visible.clock ? (
      // Scene + in-game clock + round share the top row, between the room name and the wall
      // clock. wrapMode none + truncate: when the row is squeezed this must TRUNCATE, never
      // wrap into a phantom row (the collision class the reshoot caught).
      <box flexGrow={1} flexShrink={1} minWidth={0} marginLeft={2}>
        <text wrapMode="none" truncate>
          {visible.scene ? <span fg={theme.kp}>{sceneName(scene, locale)}</span> : null}
          {visible.clock ? (
            <span fg={theme.fg}>
              {visible.scene ? " " : ""}{CLOCK_GLYPH}{stripControlChars(scene?.time ?? "--:--")}
              {scene?.round ? ` ·${tt(locale, "scene.round")}${scene.round}` : ""}
            </span>
          ) : null}
        </text>
      </box>
    ) : (
      <box flexGrow={1} minWidth={0} />
    )
  const showStatus = Boolean(last && (visible.usage || visible.cache))

  // Two ROWS, not three columns. As columns, the scene line could only be as wide as what
  // the statusline (bottom row, far wider than the wall clock above it) left over, so it was
  // cut short while the top row sat half empty — and a one-line column centred in two rows
  // lands on whichever row the layout engine rounds to. As rows, each line competes only
  // with what actually shares it.
  return (
    <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
      <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
      <box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} marginLeft={2}>
        <box flexDirection="row">
          <text fg={theme.accent} wrapMode="none" truncate>
            {tt(locale, "game.joined", { room: stripControlChars(room) })}
          </text>
          {sceneLine}
          {showStatus && visible.usage ? (
            <box flexShrink={0}>
              <text fg={theme.dim}>{wallClock(now)}</text>
            </box>
          ) : null}
        </box>
        {/* ONE line for liveness: the status glyph + the online count share it — the header has
            exactly two inner rows, and stacking these separately overflowed the box and collided
            with the row below (caught by the screenshot harness at 118 cols). With no count the
            status label rides alone; with no status the count renders as before. */}
        <box flexDirection="row">
          {link ? <text fg={connColor(theme, link)}>{CONN_GLYPH} </text> : null}
          {link && link !== "online" ? (
            <text fg={connColor(theme, link)} wrapMode="none" truncate>
              {tt(locale, connKey(link))}
            </text>
          ) : online > 0 ? (
            <text fg={theme.dim} wrapMode="none" truncate>
              {online} {tt(locale, "status.online")}
            </text>
          ) : link ? (
            <text fg={connColor(theme, link)} wrapMode="none" truncate>
              {tt(locale, connKey(link))}
            </text>
          ) : null}
          <box flexGrow={1} minWidth={0} />
          {last && showStatus ? (
            <box flexShrink={0} flexDirection="row">
              {visible.usage ? (
                <text fg={theme.dim}>
                  {tt(locale, "hud.lastTurn")} ↑{fmtTokens(last.inputTokens)} ↓{fmtTokens(last.outputTokens)}
                </text>
              ) : null}
              {visible.usage && visible.cache ? <text fg={theme.dim}> · </text> : null}
              {visible.cache ? (
                <>
                  <text fg={theme.dim}>{tt(locale, "hud.cache")}{" "}</text>
                  <text fg={cacheColor(theme, rate)}>{rate !== null ? `${rate}%` : "—"}</text>
                </>
              ) : null}
            </box>
          ) : null}
        </box>
      </box>
    </box>
  )
}

export default HeaderBar
