import type { ModuleVariable, UiManifestPanel } from "loreweaver-protocol"
import { tt } from "../i18n"
import { pickPanelText, resolvePanelBlocks } from "../panelTemplates"
import type { Palette } from "../themes"
import { UiBlocksView } from "./UiBlocks"

export interface PanelsPanelProps {
  panels: UiManifestPanel[]
  variables?: ModuleVariable[]
  theme: Palette
  locale?: string
}

/** Pack-declared module UI panels (protocol v1.8, M15) — the TUI mapping: every slot
 * (`sidebar`/`tray`/`modal`) folds into one sidebar section per panel, in manifest
 * order. Tier-1 templates instantiate against THIS viewer's own `state.variables`
 * (fail-closed — an unresolved binding omits its block, an all-omitted panel omits its
 * whole section); tier-2 panels render their `fallback` blocks, or one localized
 * "rich client only" line when the author declared `fallback: null`. Choices stay
 * static here like the hook-UI sidebar; the interactive surface is the rich client. */
export function PanelsPanel({ panels, variables, theme, locale }: PanelsPanelProps) {
  if (panels.length === 0) return null
  const sections = panels
    .map((panel) => {
      const title = pickPanelText(panel.title, locale) ?? panel.id
      if (panel.tier === 2 && panel.fallback === null) {
        return { id: panel.id, title, richOnly: true as const, blocks: [] }
      }
      const templates = panel.tier === 2 ? (panel.fallback ?? []) : (panel.blocks ?? [])
      return { id: panel.id, title, richOnly: false as const, blocks: resolvePanelBlocks(templates, variables, locale) }
    })
    .filter((section) => section.richOnly || section.blocks.length > 0)
  if (sections.length === 0) return null
  return (
    <box flexDirection="column" border borderColor={theme.border} paddingX={1} flexShrink={0}>
      {sections.map((section) => (
        <box key={section.id} flexDirection="column" width="100%" flexShrink={0}>
          <text fg={theme.accent} wrapMode="none" truncate>
            {section.title}
          </text>
          {section.richOnly ? (
            <text fg={theme.dim} wrapMode="none" truncate>
              {tt(locale, "panels.richOnly")}
            </text>
          ) : (
            <UiBlocksView
              frame={{ type: "ui", blocks: section.blocks, panel: "sidebar" }}
              theme={theme}
              locale={locale}
            />
          )}
        </box>
      ))}
    </box>
  )
}
