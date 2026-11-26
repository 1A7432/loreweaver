// A panel as one viewer's `panels` view lists it: text in the viewer's language, pictures by
// content hash, the page by the hash of its HTML. Pure: the pack's files are already read and
// digested (`readPack`).
import type { PanelEntry, TemplateBlock } from "loreweaver-protocol/v3";

import type { AuthoredBlock, PanelSpec, PanelText } from "./format.ts";

/** A pack file as a client fetches it: by hash over the byte channel. */
export interface PanelFile {
  readonly sha256: string;
  readonly size: number;
  readonly mime: string;
}

/** Text for `locale`: its language, then English, then whichever is present. */
export function panelText(value: PanelText, locale: string): string {
  const short = locale.split(/[-_]/u, 1)[0] ?? "";
  if (short === "zh" && value.zh !== undefined) return value.zh;
  return value.en ?? value.zh ?? "";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A field as it goes on the wire: a binding as it is, localised text as the viewer's string. */
function wireValue(value: unknown, locale: string): unknown {
  if (isRecord(value) && !Object.hasOwn(value, "$view") && (Object.hasOwn(value, "en") || Object.hasOwn(value, "zh"))) return panelText(value as PanelText, locale);
  return value;
}

function wireBlock(block: AuthoredBlock, locale: string, images: ReadonlyMap<string, PanelFile>): TemplateBlock | null {
  if (isRecord(block.repeat)) {
    const spec = block.repeat;
    const inner = wireBlock(spec.block as AuthoredBlock, locale, images);
    if (inner === null) return null;
    const repeat: Record<string, unknown> = { each: spec.each, as: spec.as, block: inner };
    if (typeof spec.prefix === "string") repeat.prefix = spec.prefix;
    return (typeof block.visible_when === "string" ? { repeat, visible_when: block.visible_when } : { repeat }) as TemplateBlock;
  }
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(block)) {
    if (name === "src") {
      const file = images.get(value as string);
      if (file === undefined) return null;
      out.hash = file.sha256;
      out.mime = file.mime;
      out.size = file.size;
    } else if (name === "options" && Array.isArray(value)) {
      out.options = value.map((option: Readonly<Record<string, unknown>>) => ({ ...option, label: wireValue(option.label, locale) }));
    } else {
      out[name] = wireValue(value, locale);
    }
  }
  return out as unknown as TemplateBlock;
}

function wireBlocks(blocks: readonly AuthoredBlock[], locale: string, images: ReadonlyMap<string, PanelFile>): TemplateBlock[] | null {
  const out: TemplateBlock[] = [];
  for (const block of blocks) {
    const wired = wireBlock(block, locale, images);
    if (wired === null) return null;
    out.push(wired);
  }
  return out;
}

/**
 * `panel` of pack `packId` as the `panels` view lists it for a viewer in `locale`. `images`
 * maps the pack paths of its pictures to their files; `page` is its HTML's file. Null when a
 * file it names is missing (the pack was validated, so only a damaged install gets here).
 */
export function panelEntry(packId: string, panel: PanelSpec, locale: string, images: ReadonlyMap<string, PanelFile>, page: PanelFile | null): PanelEntry | null {
  const entry: PanelEntry = {
    id: `${packId}/${panel.id}`,
    title: panelText(panel.title, locale) || panel.id,
    slot: panel.slot,
    kind: panel.kind,
    views: panel.views.map((ref) => ({ as: ref.as, view: ref.view })),
    source: { kind: "pack", id: packId },
  };
  if (panel.kind === "template") {
    const blocks = wireBlocks(panel.blocks, locale, images);
    if (blocks === null) return null;
    entry.blocks = blocks;
    return entry;
  }
  if (page === null) return null;
  entry.page = { hash: page.sha256, size: page.size, mime: "text/html" };
  if (panel.fallback === null) entry.fallback = null;
  else {
    const fallback = wireBlocks(panel.fallback, locale, images);
    if (fallback === null) return null;
    entry.fallback = fallback;
  }
  return entry;
}
