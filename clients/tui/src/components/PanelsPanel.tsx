import { panelBlocks, stripControlChars, type Block, type HeldView, type PanelEntry } from "loreweaver-protocol/v3"
import { tt } from "../i18n"
import type { Palette } from "../themes"
import { UiBlocksView, type UiChoice } from "./UiBlocks"

/** One panel as the sidebar draws it: its blocks, or the "needs a rich client" line. */
export interface PanelSection {
  id: string
  title: string
  /** Null: a page with no fallback. */
  blocks: Block[] | null
}

/** Each view's data by name, from the session snapshot (the only source: nothing is copied). */
export function viewValues(views: ReadonlyMap<string, HeldView>): ReadonlyMap<string, unknown> {
  return new Map([...views].map(([name, held]) => [name, held.data]))
}

/**
 * The sections the sidebar shows, in the `panels` view's order: each panel instantiated
 * against the views the session holds (`instantiate`, shared with every other client). A
 * panel whose every block is hidden or unbound is left out entirely; a page without a
 * fallback stays, as one line.
 */
export function panelSections(panels: readonly PanelEntry[], values: ReadonlyMap<string, unknown>): PanelSection[] {
  return panels
    .map((panel) => ({ id: panel.id, title: stripControlChars(panel.title) || panel.id, blocks: panelBlocks(panel, values) }))
    .filter((section) => section.blocks === null || section.blocks.length > 0)
}

/** Whether a section has a choices block Tab can put the keys on. */
export function hasChoices(section: PanelSection): boolean {
  return section.blocks?.some((block) => block.kind === "choices") ?? false
}

export interface PanelsPanelProps {
  sections: readonly PanelSection[]
  theme: Palette
  locale?: string
  /** The panel whose choices own the keys now, or null. */
  focused?: string | null
  /** A choice picked: the caller runs its command with `command.run`, as the viewer. */
  onPick?: (option: UiChoice) => void
}

/** Pack panels (protocol 3.0 §8.5) — the terminal mapping: every slot (`sidebar`, `tray`,
 * `modal`) folds into one sidebar section per panel. Templates and a page's fallback draw with
 * the same block renderer as the story's blocks; a page without a fallback is one line. */
export function PanelsPanel({ sections, theme, locale, focused = null, onPick }: PanelsPanelProps) {
  if (sections.length === 0) return null
  return (
    <box flexDirection="column" border borderColor={theme.border} paddingX={1} flexShrink={0}>
      {sections.map((section) => (
        <box key={section.id} flexDirection="column" width="100%" flexShrink={0}>
          <text fg={theme.accent} wrapMode="none" truncate>
            {section.title}
          </text>
          {section.blocks === null ? (
            <text fg={theme.dim}>{tt(locale, "panels.richOnly")}</text>
          ) : (
            <UiBlocksView
              blocks={section.blocks}
              theme={theme}
              locale={locale}
              interactive={onPick && hasChoices(section) ? { focused: focused === section.id, onPick } : undefined}
            />
          )}
        </box>
      ))}
    </box>
  )
}
