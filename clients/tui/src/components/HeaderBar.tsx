import { useEffect, useState } from "react"
import {
  stripControlChars,
  type ClockState,
  type ConnectionStatus,
  type SceneState,
  type UsageState,
  type WelcomeFrame,
} from "@loreweaver/protocol"
import { tt } from "../i18n"
import type { Palette } from "../themes"

export interface HeaderBarProps {
  welcome: WelcomeFrame
  scene?: SceneState
  clock?: ClockState
  usage?: UsageState
  online: number
  theme: Palette
  locale?: string
  // The transport's liveness (App subscribes to `client.onStatus?.(...)`). Undefined when the
  // client doesn't implement `onStatus` (an older mock) — renders nothing, not a false state.
  connectionStatus?: ConnectionStatus
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

function ctxColor(theme: Palette, pct: number): string {
  if (pct < 50) return theme.dim
  if (pct <= 80) return theme.fg
  return theme.hard
}

function cacheColor(theme: Palette, rate: number | null): string {
  return rate !== null && rate >= 50 ? theme.success : theme.dim
}

// "connecting" and "reconnecting" share the same amber glyph + label — both mean "not fully
// online yet", and the distinction (first dial vs. mid-session redial) isn't worth two rows.
function connGlyph(status: ConnectionStatus): string {
  if (status === "online") return "🟢"
  if (status === "offline") return "🔴"
  return "🟡"
}

function connKey(status: ConnectionStatus): "hud.connOnline" | "hud.connReconnecting" | "hud.connOffline" {
  if (status === "online") return "hud.connOnline"
  if (status === "offline") return "hud.connOffline"
  return "hud.connReconnecting"
}

function connColor(theme: Palette, status: ConnectionStatus): string {
  if (status === "online") return theme.success
  if (status === "offline") return theme.fumble
  return theme.dim
}

// Replaces GameView's old plain `height={4}` header box: same overall footprint (a
// height=4 bordered row -- exactly the two inner rows the `tiny` ascii-font needs),
// now split into three zones -- room identity (left), scene + in-game clock
// (center), and a ticking wall clock + optional token/cache statusline (right).
export function HeaderBar({ welcome, scene, clock, usage, online, theme, locale, connectionStatus }: HeaderBarProps) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const pct = usage && usage.context_window > 0 ? Math.round((usage.context_tokens / usage.context_window) * 100) : null
  const cacheDenom = usage ? usage.cache_hit_tokens + usage.cache_miss_tokens : 0
  const cacheRate = usage && cacheDenom > 0 ? Math.round((usage.cache_hit_tokens / cacheDenom) * 100) : null

  return (
    <box height={4} flexDirection="row" border borderColor={theme.border} paddingX={1}>
      <ascii-font text="LOREWEAVER" font="tiny" color={theme.accent} />
      <box flexDirection="column" marginLeft={2} justifyContent="center">
        <text fg={theme.accent}>{tt(locale, "game.joined", { room: stripControlChars(welcome.room) })}</text>
        {online > 0 ? (
          <text fg={theme.dim}>
            {online} {tt(locale, "status.online")}
          </text>
        ) : null}
        {connectionStatus ? (
          <text fg={connColor(theme, connectionStatus)}>
            {connGlyph(connectionStatus)} {tt(locale, connKey(connectionStatus))}
          </text>
        ) : null}
      </box>

      <box flexGrow={1} flexDirection="column" marginLeft={2} justifyContent="center">
        <text fg={theme.kp}>{stripControlChars(scene?.name ?? tt(locale, "scene.unframed"))}</text>
        <text fg={theme.fg}>
          {CLOCK_GLYPH} {stripControlChars(clock?.time ?? "--:--")}
          {clock?.round ? ` · ${tt(locale, "scene.round")} ${clock.round}` : ""}
        </text>
      </box>

      <box flexDirection="column" alignItems="flex-end" justifyContent="center">
        <text fg={theme.dim}>{wallClock(now)}</text>
        {usage ? (
          <box flexDirection="row">
            {pct !== null ? (
              <>
                <text fg={theme.dim}>{tt(locale, "hud.ctx")} </text>
                <text fg={ctxColor(theme, pct)}>{pct}%</text>
                <text fg={theme.dim}> · </text>
              </>
            ) : null}
            <text fg={theme.dim}>
              ↑{fmtTokens(usage.input_tokens)} ↓{fmtTokens(usage.output_tokens)} · {tt(locale, "hud.cache")}{" "}
            </text>
            <text fg={cacheColor(theme, cacheRate)}>{cacheRate !== null ? `${cacheRate}%` : "—"}</text>
          </box>
        ) : null}
      </box>
    </box>
  )
}

export default HeaderBar
