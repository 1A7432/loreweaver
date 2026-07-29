import type { UiFrame } from "loreweaver-protocol"
import { tt } from "../i18n"
import type { Palette } from "../themes"
import { UiBlocksView } from "./UiBlocks"

export interface UiPanelProps {
  regions: UiFrame[]
  theme: Palette
  locale?: string
}

/** The hook-emitted module UI sidebar panel (protocol v1.7): one region per
 * distinct frame `id` — GameView keeps only the latest frame per id, so a
 * re-emitted region replaces itself instead of stacking. Renders nothing until
 * a sidebar `ui` frame arrives. Choices blocks are static here by design; the
 * keyboard-interactive select lives inline in the narrative log only. */
export function UiPanel({ regions, theme, locale }: UiPanelProps) {
  if (regions.length === 0) return null
  return (
    // flexShrink=0 like the other sidebar panels: a tight column would otherwise
    // squash this panel and composite its rows on top of each other.
    <box flexDirection="column" border borderColor={theme.border} paddingX={1} flexShrink={0}>
      <text fg={theme.accent} wrapMode="none" truncate>
        {tt(locale, "ui.title")}
      </text>
      {regions.map((frame, index) => (
        <UiBlocksView key={frame.id ?? `region-${index}`} frame={frame} theme={theme} locale={locale} />
      ))}
    </box>
  )
}
