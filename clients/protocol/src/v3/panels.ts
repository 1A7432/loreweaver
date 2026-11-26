// Panels (protocol 3.0 §8.5): the `panels` view's entries, the template a panel ships, and
// `instantiate` — turning a template plus the views a client holds into the blocks it draws.
//
// Every client calls `instantiate`, so that no two clients can disagree about what a panel
// shows. It is pure and deterministic: no I/O, no clock, no randomness.
//
// A panel's data comes from VIEWS only. A template names the views it reads under short
// local HANDLES (`views: [{as: "tide", view: "harbor/tide"}]`) and its fields bind to a PATH
// inside one: `{$view: "tide.level"}`. The same paths are the references of `visible_when`
// conditions, evaluated by the shared condition evaluator (`../condexpr.ts`).
//
// The rule under every line here is FAIL CLOSED: a binding that does not resolve drops its
// block (a required field) or the field (an optional one); a condition that cannot be
// decided hides its block. A panel can never show more than its viewer's views hold.
//
// The path grammar (bindings, `repeat.each`, condition references alike):
//
//   path     = handle *( "." segment )        at most 200 code points, at most 8 parts
//   handle   = [a-z][a-z0-9_]{0,31}           declared in the panel's `views`, or a repeat's `as`
//   segment  = name / index
//   name     = [\p{L}_][\p{L}\p{N}_]*          (the condition language's identifiers)
//   index    = "0" / [1-9][0-9]*
//
// Reading a segment: on a record, its own property of that name; on a list, an `index` picks
// that element and a `name` picks the first element whose key — its `id`, else `key`, else
// `path`, whichever is the first string present — equals it. A list is always read with its
// elements marked `hidden: true` removed first (an admin's view flags what players do not
// see; a panel never surfaces it). Anything else is absent.
import { isVisible } from "../condexpr.js";
import type { Block } from "./frames.js";

// ---------------------------------------------------------------------------
// Caps — shared by the server's validation and by `instantiate`
// ---------------------------------------------------------------------------

export const PANEL_SLOTS = ["sidebar", "tray", "modal"] as const;
export type PanelSlot = (typeof PANEL_SLOTS)[number];
export const PANEL_KINDS = ["template", "page"] as const;
export type PanelKind = (typeof PANEL_KINDS)[number];

/** Panels one pack may ship. */
export const MAX_PANELS_PER_PACK = 16;
/** Blocks in one template (a panel's blocks, or a page's fallback); a repeat counts as one. */
export const MAX_PANEL_BLOCKS = 32;
/** Views one panel may declare. */
export const MAX_PANEL_VIEWS = 8;
/** A binding path, in code points. */
export const MAX_BINDING_PATH_CHARS = 200;
/** Parts of a binding path, the handle included. */
export const MAX_BINDING_PATH_DEPTH = 8;
/** Instances one `repeat` expands to at most. */
export const MAX_REPEAT_INSTANCES = 32;
export const MAX_REPEAT_PREFIX_CHARS = 128;
/** A `visible_when` condition, in code points. */
export const MAX_CONDITION_CHARS = 500;
/** A page's HTML, in bytes. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
/** The repeat element's handle when the author names none. */
export const DEFAULT_REPEAT_AS = "item";

export const VIEW_HANDLE = /^[a-z][a-z0-9_]{0,31}$/u;
const PATH_NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const PATH_INDEX = /^(?:0|[1-9][0-9]*)$/u;

// ---------------------------------------------------------------------------
// Types: the `panels` view and a template
// ---------------------------------------------------------------------------

/** A field read from a view instead of written out. */
export interface Binding {
  $view: string;
}

/** A value written out, or bound to a path inside a view. */
export type Bindable<T> = T | Binding;

interface Gate {
  /** A condition; the block shows only when it holds. */
  visible_when?: string;
}

export type TemplateBlock = Gate &
  (
    | { kind: "meter"; label: Bindable<string>; value: Bindable<number>; min: Bindable<number>; max: Bindable<number> }
    | { kind: "stat"; label: Bindable<string>; value: Bindable<number | string | boolean> }
    | { kind: "badge"; label: Bindable<string>; tone?: Bindable<string> }
    | { kind: "text"; text: Bindable<string>; style?: "quote" | "warning" }
    | { kind: "divider" }
    | { kind: "choices"; prompt?: Bindable<string>; options: { id: string; label: Bindable<string>; command: string; args?: Record<string, unknown> }[] }
    | { kind: "image"; hash: string; mime?: string; size?: number; caption?: Bindable<string>; alt?: Bindable<string> }
    | { kind: "letter"; body: Bindable<string>; from?: Bindable<string>; to?: Bindable<string>; date?: Bindable<string> }
    | { kind: "clipping"; headline: Bindable<string>; body: Bindable<string>; source?: Bindable<string>; date?: Bindable<string> }
    | { kind: "map_pin"; hash: string; mime?: string; size?: number; label: Bindable<string>; x: Bindable<number>; y: Bindable<number>; note?: Bindable<string> }
    | { kind: "title_card"; title: Bindable<string>; subtitle?: Bindable<string>; act?: Bindable<string> }
    | { repeat: { each: string; as: string; prefix?: string; block: TemplateBlock } }
  );

/** A view a panel reads, under the handle its paths use. */
export interface PanelViewRef {
  as: string;
  view: string;
}

/** Blocks and the views their paths name: what `instantiate` takes. */
export interface PanelTemplate {
  views: readonly PanelViewRef[];
  blocks: readonly TemplateBlock[];
}

/** One entry of the `panels` view. Text is already in the viewer's language. */
export interface PanelEntry {
  /** `<pack>/<panel>`. */
  id: string;
  title: string;
  slot: PanelSlot;
  kind: PanelKind;
  /** The views the panel reads: subscribe to each `view`. */
  views: PanelViewRef[];
  /** Where it comes from: a pack, or (later) the room itself. */
  source: { kind: "pack" | "room"; id: string };
  /** A template panel's blocks. */
  blocks?: TemplateBlock[];
  /** A page panel's HTML, fetched by hash over the byte channel. */
  page?: { hash: string; size: number; mime: "text/html" };
  /** A page panel's template for clients that cannot run the page; null: none. */
  fallback?: TemplateBlock[] | null;
}

/** `panels`: this viewer's panel list. */
export interface PanelsView {
  panels: PanelEntry[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ABSENT: unique symbol = Symbol("absent");
type Found = unknown | typeof ABSENT;

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** A path's parts, or null when it breaks the grammar or the caps. */
export function parsePath(path: unknown): string[] | null {
  if (typeof path !== "string" || path === "" || codePoints(path) > MAX_BINDING_PATH_CHARS) return null;
  const parts = path.split(".");
  if (parts.length > MAX_BINDING_PATH_DEPTH || !VIEW_HANDLE.test(parts[0] as string)) return null;
  for (const part of parts.slice(1)) if (!PATH_NAME.test(part) && !PATH_INDEX.test(part)) return null;
  return parts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A list as a panel reads it: without the elements flagged `hidden`. */
function shown(list: readonly unknown[]): unknown[] {
  return list.filter((item) => !(isRecord(item) && item.hidden === true));
}

/** An element's key: its `id`, else `key`, else `path` — the first that is a string. */
function keyOf(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  for (const field of ["id", "key", "path"]) {
    if (Object.hasOwn(item, field) && typeof item[field] === "string") return item[field] as string;
  }
  return undefined;
}

function step(current: unknown, part: string): Found {
  if (Array.isArray(current)) {
    const items = shown(current);
    if (PATH_INDEX.test(part)) {
      const index = Number(part);
      return index < items.length ? items[index] : ABSENT;
    }
    const match = items.find((item) => keyOf(item) === part);
    return match === undefined ? ABSENT : match;
  }
  if (isRecord(current) && Object.hasOwn(current, part)) return current[part];
  return ABSENT;
}

/** Handles in scope: the declared views by handle, and inside a repeat its element. */
type Scope = ReadonlyMap<string, Found>;

function resolve(path: unknown, scope: Scope): Found {
  const parts = parsePath(path);
  if (parts === null) return ABSENT;
  if (!scope.has(parts[0] as string)) return ABSENT;
  let current: Found = scope.get(parts[0] as string);
  for (const part of parts.slice(1)) {
    if (current === ABSENT) return ABSENT;
    current = step(current, part);
  }
  return current === undefined ? ABSENT : current;
}

/**
 * What a condition reads at `path`: a scalar as it is; a list or a record as whether it has
 * anything in it (a list without its hidden elements); absent, `null`.
 */
export function conditionValue(found: unknown): null | boolean | number | string {
  if (found === ABSENT || found === undefined || found === null) return null;
  if (typeof found === "boolean" || typeof found === "string") return found;
  if (typeof found === "number") return Number.isFinite(found) ? found : null;
  if (Array.isArray(found)) return shown(found).length > 0;
  if (isRecord(found)) return Object.keys(found).length > 0;
  return null;
}

/**
 * The resolver a condition is evaluated with, over the views a client holds (by view name)
 * and a template's handles. Exported so a second evaluator can be checked against this one.
 */
export function panelResolver(views: readonly PanelViewRef[], values: ReadonlyMap<string, unknown>, extra: ReadonlyMap<string, unknown> = new Map()): (path: string) => unknown {
  const scope = scopeOf(views, values, extra);
  return (path) => conditionValue(resolve(path, scope));
}

function scopeOf(views: readonly PanelViewRef[], values: ReadonlyMap<string, unknown>, extra: ReadonlyMap<string, unknown>): Map<string, Found> {
  const scope = new Map<string, Found>();
  for (const ref of views) {
    if (!isRecord(ref) || typeof ref.as !== "string" || typeof ref.view !== "string" || scope.has(ref.as)) continue;
    scope.set(ref.as, values.has(ref.view) ? values.get(ref.view) : ABSENT);
  }
  for (const [handle, value] of extra) scope.set(handle, value);
  return scope;
}

// ---------------------------------------------------------------------------
// instantiate
// ---------------------------------------------------------------------------

function isBinding(value: unknown): value is Binding {
  return isRecord(value) && Object.hasOwn(value, "$view");
}

/** A field as written, or as its binding resolves; ABSENT when the binding misses. */
function field(value: unknown, scope: Scope): Found {
  if (isBinding(value)) return resolve(value.$view, scope);
  return value === undefined ? ABSENT : value;
}

function text(value: unknown, scope: Scope): string | undefined {
  const found = field(value, scope);
  if (typeof found === "string") return found;
  if (typeof found === "number" && Number.isFinite(found)) return String(found);
  if (typeof found === "boolean") return found ? "true" : "false";
  return undefined;
}

function number(value: unknown, scope: Scope): number | undefined {
  const found = field(value, scope);
  return typeof found === "number" && Number.isFinite(found) ? found : undefined;
}

function visible(block: Record<string, unknown>, scope: Scope): boolean {
  if (!Object.hasOwn(block, "visible_when")) return true;
  const condition = block.visible_when;
  if (typeof condition !== "string" || codePoints(condition) > MAX_CONDITION_CHARS) return false;
  return isVisible(condition, (path) => conditionValue(resolve(path, scope)));
}

const BADGE_TONES: ReadonlySet<string> = new Set(["info", "warn", "danger"]);
const TEXT_STYLES: ReadonlySet<string> = new Set(["quote", "warning"]);
const PERFORMANCE: ReadonlyMap<string, readonly [readonly string[], readonly string[]]> = new Map([
  ["letter", [["body"], ["from", "to", "date"]]],
  ["clipping", [["headline", "body"], ["source", "date"]]],
  ["map_pin", [["label"], ["note"]]],
  ["title_card", [["title"], ["subtitle", "act"]]],
]);

function media(block: Record<string, unknown>, out: Record<string, unknown>): boolean {
  if (typeof block.hash !== "string" || block.hash === "") return false;
  out.hash = block.hash;
  if (typeof block.mime === "string") out.mime = block.mime;
  if (typeof block.size === "number" && Number.isFinite(block.size)) out.size = block.size;
  return true;
}

function one(block: unknown, scope: Scope): Block | undefined {
  if (!isRecord(block) || Object.hasOwn(block, "repeat")) return undefined;
  if (!visible(block, scope)) return undefined;
  switch (block.kind) {
    case "divider":
      return { kind: "divider" };
    case "meter": {
      const label = text(block.label, scope);
      const value = number(block.value, scope);
      const min = number(block.min, scope);
      const max = number(block.max, scope);
      if (label === undefined || value === undefined || min === undefined || max === undefined || max <= min) return undefined;
      return { kind: "meter", label, value, min, max };
    }
    case "stat": {
      const label = text(block.label, scope);
      const value = field(block.value, scope);
      if (label === undefined) return undefined;
      if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return { kind: "stat", label, value };
      return undefined;
    }
    case "badge": {
      const label = text(block.label, scope);
      if (label === undefined) return undefined;
      const tone = Object.hasOwn(block, "tone") ? field(block.tone, scope) : ABSENT;
      // An optional enum that does not resolve to one of its values strips; the badge stays.
      return typeof tone === "string" && BADGE_TONES.has(tone) ? { kind: "badge", label, tone: tone as "info" | "warn" | "danger" } : { kind: "badge", label };
    }
    case "text": {
      const value = text(block.text, scope);
      if (value === undefined) return undefined;
      return typeof block.style === "string" && TEXT_STYLES.has(block.style) ? { kind: "text", text: value, style: block.style as "quote" | "warning" } : { kind: "text", text: value };
    }
    case "image": {
      const out: Record<string, unknown> = { kind: "image" };
      if (!media(block, out)) return undefined;
      const caption = text(block.caption, scope);
      if (caption !== undefined) out.caption = caption;
      const alt = text(block.alt, scope);
      if (alt !== undefined) out.alt = alt;
      return out as Block;
    }
    case "choices": {
      const options: { id: string; label: string; command: string; args?: Record<string, unknown> }[] = [];
      for (const option of Array.isArray(block.options) ? block.options : []) {
        if (!isRecord(option) || typeof option.id !== "string" || typeof option.command !== "string" || option.command === "") continue;
        const label = text(option.label, scope);
        if (label === undefined) continue;
        if (Object.hasOwn(option, "args") && !isRecord(option.args)) continue;
        options.push(isRecord(option.args) ? { id: option.id, label, command: option.command, args: option.args } : { id: option.id, label, command: option.command });
      }
      if (options.length === 0) return undefined;
      const prompt = Object.hasOwn(block, "prompt") ? text(block.prompt, scope) : undefined;
      return prompt === undefined ? { kind: "choices", options } : { kind: "choices", prompt, options };
    }
    default: {
      const fields = typeof block.kind === "string" ? PERFORMANCE.get(block.kind) : undefined;
      if (fields === undefined) return undefined;
      const out: Record<string, unknown> = { kind: block.kind };
      for (const name of fields[0]) {
        const value = text(block[name], scope);
        if (value === undefined) return undefined;
        out[name] = value;
      }
      for (const name of fields[1]) {
        const value = text(block[name], scope);
        if (value !== undefined) out[name] = value;
      }
      if (block.kind === "map_pin") {
        const x = number(block.x, scope);
        const y = number(block.y, scope);
        if (x === undefined || y === undefined || !media(block, out)) return undefined;
        // Fractions of the map's own box: a pin outside it is clamped, not dropped.
        out.x = Math.min(1, Math.max(0, x));
        out.y = Math.min(1, Math.max(0, y));
      }
      return out as Block;
    }
  }
}

/**
 * The blocks `template` shows, given the views a client holds (`values`: each view's data by
 * view name; a view not held is absent). Bindings resolve, `repeat` expands (at most
 * `MAX_REPEAT_INSTANCES` instances, elements filtered by `prefix` first), `visible_when`
 * gates — and every miss drops what it was for. A template over a cap shows nothing.
 */
export function instantiate(template: PanelTemplate, values: ReadonlyMap<string, unknown>): Block[] {
  if (!isRecord(template) || !Array.isArray(template.views) || !Array.isArray(template.blocks)) return [];
  if (template.views.length > MAX_PANEL_VIEWS || template.blocks.length > MAX_PANEL_BLOCKS) return [];
  const scope = scopeOf(template.views, values, new Map());
  const out: Block[] = [];
  for (const block of template.blocks) {
    if (!isRecord(block)) continue;
    if (!Object.hasOwn(block, "repeat")) {
      const made = one(block, scope);
      if (made !== undefined) out.push(made);
      continue;
    }
    // The repeat's own gate decides for the whole list, outside any element.
    if (!visible(block, scope)) continue;
    const spec = block.repeat;
    if (!isRecord(spec) || !isRecord(spec.block) || Object.hasOwn(spec.block, "repeat")) continue;
    const as = spec.as === undefined ? DEFAULT_REPEAT_AS : spec.as;
    if (typeof as !== "string" || !VIEW_HANDLE.test(as)) continue;
    const list = resolve(spec.each, scope);
    if (!Array.isArray(list)) continue;
    let items = shown(list);
    if (spec.prefix !== undefined) {
      const prefix = spec.prefix;
      if (typeof prefix !== "string" || prefix === "") continue;
      items = items.filter((item) => keyOf(item)?.startsWith(prefix) === true);
    }
    for (const item of items.slice(0, MAX_REPEAT_INSTANCES)) {
      const inner = new Map(scope);
      inner.set(as, item);
      const made = one(spec.block, inner);
      if (made !== undefined) out.push(made);
    }
  }
  return out;
}

/**
 * What a client draws for one `panels` entry: a template's blocks, a page's fallback blocks,
 * or null for a page with no fallback (the client shows one "needs a rich client" line).
 */
export function panelBlocks(panel: PanelEntry, values: ReadonlyMap<string, unknown>): Block[] | null {
  if (panel.kind === "template") return instantiate({ views: panel.views, blocks: panel.blocks ?? [] }, values);
  if (panel.fallback === null || panel.fallback === undefined) return null;
  return instantiate({ views: panel.views, blocks: panel.fallback }, values);
}

/** The distinct view names a panel reads, in declaration order: what a client subscribes to. */
export function panelViewNames(panel: Pick<PanelEntry, "views">): string[] {
  const names: string[] = [];
  for (const ref of panel.views) if (isRecord(ref) && typeof ref.view === "string" && !names.includes(ref.view)) names.push(ref.view);
  return names;
}
