// Tier-1 panel template instantiation (protocol v1.8, M15): resolve a manifest
// panel's template blocks against THIS viewer's own `state.variables` into plain
// v1.7 `UiBlock`s the existing renderer draws. Pure functions, no React.
//
// Fail-closed is the load-bearing rule: a `{$var}` binding whose variable is absent
// from this viewer's state omits the WHOLE block — a panel can never widen
// visibility; the server-side state filter stays the single choke point. The same
// discipline applies to malformed shapes: resolve to nothing, never to a guess.

import {
  MAX_PANEL_REPEAT_INSTANCES,
  type ModuleVariable,
  type PanelTemplateBlock,
  type PanelText,
  type UiBadgeTone,
  type UiBlock,
  type UiChoiceOption,
} from "loreweaver-protocol"

const BADGE_TONES: ReadonlySet<string> = new Set(["info", "warn", "danger"])

type Resolved = { ok: true; value: unknown } | { ok: false }

const MISS: Resolved = { ok: false }

function isVarBinding(value: unknown): value is { $var: string } {
  return typeof value === "object" && value !== null && "$var" in value
}

function isLeafBinding(value: unknown): value is { $leaf: string } {
  return typeof value === "object" && value !== null && "$leaf" in value
}

/** Resolve one scalar template field: literals pass through; `$var` looks up the
 * viewer's variables (miss -> the block is omitted); `$leaf` reads the repeat
 * instance's matched variable (invalid outside a repeat). */
function resolveScalar(value: unknown, variables: ModuleVariable[], leaf?: ModuleVariable): Resolved {
  if (isVarBinding(value)) {
    const id = value.$var
    const match = typeof id === "string" ? variables.find((entry) => entry.id === id) : undefined
    return match === undefined ? MISS : { ok: true, value: match.value }
  }
  if (isLeafBinding(value)) {
    if (!leaf) return MISS
    if (value.$leaf === "id") return { ok: true, value: leaf.id }
    if (value.$leaf === "label") return { ok: true, value: leaf.label }
    if (value.$leaf === "value") return { ok: true, value: leaf.value }
    return MISS
  }
  return { ok: true, value }
}

/** Localized text pick: this locale, else `en`, else any value the map carries. */
export function pickPanelText(value: PanelText | string | undefined, locale?: string): string | undefined {
  if (typeof value === "string") return value
  if (typeof value !== "object" || value === null) return undefined
  const map = value as Record<string, unknown>
  const short = (locale ?? "en").slice(0, 2)
  for (const candidate of [map[short], map.en, ...Object.values(map)]) {
    if (typeof candidate === "string" && candidate) return candidate
  }
  return undefined
}

function resolveText(value: unknown, variables: ModuleVariable[], locale?: string, leaf?: ModuleVariable): string | undefined {
  const resolved = resolveScalar(value, variables, leaf)
  if (!resolved.ok) return undefined
  const raw = resolved.value
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw)
  return pickPanelText(raw as PanelText | string | undefined, locale)
}

function finiteNumber(resolved: Resolved): number | undefined {
  if (!resolved.ok || typeof resolved.value !== "number" || !Number.isFinite(resolved.value)) return undefined
  return resolved.value
}

function resolveOne(
  block: PanelTemplateBlock,
  variables: ModuleVariable[],
  locale?: string,
  leaf?: ModuleVariable,
): UiBlock | undefined {
  if ("repeat" in block) return undefined // expanded by resolvePanelBlocks; nesting resolves to nothing
  if (block.kind === "divider") return { kind: "divider" }
  if (block.kind === "meter") {
    const label = resolveText(block.label, variables, locale, leaf)
    const value = finiteNumber(resolveScalar(block.value, variables, leaf))
    const min = finiteNumber(resolveScalar(block.min, variables, leaf))
    const max = finiteNumber(resolveScalar(block.max, variables, leaf))
    if (label === undefined || value === undefined || min === undefined || max === undefined || max <= min) {
      return undefined
    }
    return { kind: "meter", label, value, min, max }
  }
  if (block.kind === "stat") {
    const label = resolveText(block.label, variables, locale, leaf)
    const resolved = resolveScalar(block.value, variables, leaf)
    if (label === undefined || !resolved.ok) return undefined
    const value = resolved.value
    if (typeof value !== "number" && typeof value !== "boolean") {
      const text = typeof value === "string" ? value : pickPanelText(value as PanelText, locale)
      return text === undefined ? undefined : { kind: "stat", label, value: text }
    }
    return { kind: "stat", label, value }
  }
  if (block.kind === "badge") {
    const label = resolveText(block.label, variables, locale, leaf)
    if (label === undefined) return undefined
    const badge: UiBlock = { kind: "badge", label }
    if (block.tone !== undefined) {
      const tone = resolveScalar(block.tone, variables, leaf)
      // v1.7 stance for optional enums: an invalid tone strips, the badge stays.
      if (tone.ok && typeof tone.value === "string" && BADGE_TONES.has(tone.value)) {
        badge.tone = tone.value as UiBadgeTone
      }
    }
    return badge
  }
  if (block.kind === "text") {
    const text = resolveText(block.text, variables, locale, leaf)
    if (text === undefined) return undefined
    return block.style === undefined ? { kind: "text", text } : { kind: "text", text, style: block.style }
  }
  if (block.kind === "choices") {
    const options: UiChoiceOption[] = []
    for (const option of block.options ?? []) {
      const label = resolveText(option.label, variables, locale, leaf)
      if (label === undefined || typeof option.input !== "string" || typeof option.id !== "string") continue
      options.push({ id: option.id, label, input: option.input })
    }
    if (options.length === 0) return undefined
    const prompt = block.prompt === undefined ? undefined : resolveText(block.prompt, variables, locale, leaf)
    return prompt === undefined ? { kind: "choices", options } : { kind: "choices", prompt, options }
  }
  return undefined
}

/** Instantiate a panel's template blocks for this viewer. Repeat constructs expand to
 * one instance per visible variable whose id starts with the prefix (capped); every
 * unresolved binding drops its whole block (fail-closed), so an empty result is a
 * legitimate outcome — the caller collapses the panel section entirely. */
export function resolvePanelBlocks(
  blocks: PanelTemplateBlock[] | undefined,
  variables: ModuleVariable[] | undefined,
  locale?: string,
): UiBlock[] {
  const visible = variables ?? []
  const resolved: UiBlock[] = []
  for (const block of blocks ?? []) {
    if ("repeat" in block) {
      const prefix = block.repeat?.prefix
      const inner = block.repeat?.block
      if (typeof prefix !== "string" || !prefix || !inner || "repeat" in inner) continue
      for (const match of visible.filter((entry) => entry.id.startsWith(prefix)).slice(0, MAX_PANEL_REPEAT_INSTANCES)) {
        const instance = resolveOne(inner, visible, locale, match)
        if (instance) resolved.push(instance)
      }
      continue
    }
    const instance = resolveOne(block, visible, locale)
    if (instance) resolved.push(instance)
  }
  return resolved
}
