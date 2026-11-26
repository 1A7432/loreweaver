// Declared module variables: the typed trackers a native pack or lorecard declares
// (`理智`, `suspicion`, `culprit`), with deterministic writes. The simpler of the two
// variable kinds: a flat, ordered list of named values, each with a kind, optional bounds,
// display labels per locale, and a visibility (`keeper` variables never reach a player).
//
// Four kinds: `number` (an integer, clamped into optional bounds), `bool`, `text` (a short
// string), `enum` (one of a fixed list of options, matched case-insensitively and stored
// in its declared spelling).
import { applied, refused, type WriteOutcome, type WriteRefusalCode } from "./results.ts";
import { codePoints } from "./tree.ts";

export const VARIABLE_KINDS = ["number", "bool", "text", "enum"] as const;
export type VariableKind = (typeof VARIABLE_KINDS)[number];
export type VariableVisibility = "player" | "keeper";
export type VariableValue = number | boolean | string;

export const MAX_VARIABLES = 64;
export const MAX_TEXT_CHARS = 200;
export const MAX_LABEL_CHARS = 50;
export const MAX_OPTIONS = 20;
export const MAX_OPTION_CHARS = 50;
export const MAX_ID_CHARS = 64;

/** Labels by language (`en`, `zh`). Built with `Object.fromEntries`; read with `Object.hasOwn`. */
export type LocalizedText = Readonly<Record<string, string>>;

export interface VariableSpec {
  readonly id: string;
  readonly kind: VariableKind;
  readonly visibility: VariableVisibility;
  readonly labels: LocalizedText;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly options?: readonly string[];
  /** Display names of an enum's options, `{language: {option: text}}`. */
  readonly optionLabels?: Readonly<Record<string, LocalizedText>>;
  /** A "set before play" variable: the table should choose it once before the module runs. */
  readonly setup?: true;
  readonly default: VariableValue;
}

export interface ModuleVariable {
  readonly spec: VariableSpec;
  readonly value: VariableValue;
}

/** A room's declared variables, in declaration order (clients show them in this order). */
export interface ModuleVariables {
  readonly variables: readonly ModuleVariable[];
}

export const EMPTY_MODULE_VARIABLES: ModuleVariables = { variables: [] };

// ---------------------------------------------------------------------------
// Ids and coercion
// ---------------------------------------------------------------------------

const ASCII_ALLOWED = /^[a-z0-9_]$/;
const SEPARATOR_OR_CONTROL = /^[\p{Z}\p{C}]$/u;

/**
 * A variable id in slug form: trimmed, lower-cased, runs of whitespace or hyphens become
 * `_`. ASCII characters must be letters, digits or `_`; any other character is kept
 * (CJK ids such as `理智` are first-class) unless it is a separator or a control
 * character. Null when nothing usable is left.
 */
export function normalizeVariableId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const slug = raw.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  const length = codePoints(slug);
  if (length < 1 || length > MAX_ID_CHARS) return null;
  for (const ch of slug) {
    if (ch.codePointAt(0)! < 0x80 ? !ASCII_ALLOWED.test(ch) : SEPARATOR_OR_CONTROL.test(ch)) return null;
  }
  return slug;
}

/**
 * A whole number from a number, a boolean (0/1) or numeric text; null otherwise. A
 * fraction is truncated toward zero; anything outside the safe-integer range is refused.
 */
export function coerceInteger(value: unknown): number | null {
  let number: number;
  if (typeof value === "boolean") number = value ? 1 : 0;
  else if (typeof value === "number") number = value;
  else if (typeof value === "string" && value.trim() !== "" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) number = Number(value.trim());
  else return null;
  if (!Number.isFinite(number)) return null;
  const whole = Math.trunc(number);
  return Number.isSafeInteger(whole) ? whole : null;
}

/** True/false from a boolean, 0/1, or the usual words; null otherwise. */
export function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return value === 1;
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(word)) return true;
    if (["false", "0", "no", "n", "off"].includes(word)) return false;
  }
  return null;
}

function language(locale: string): string {
  return (locale.split("-")[0] ?? "").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

export type SpecProblem =
  | "bad_id"
  | "bad_kind"
  | "bad_visibility"
  | "bad_bound"
  | "bounds_not_for_kind"
  | "no_options"
  | "options_not_for_kind"
  | "option_labels_not_for_kind"
  | "too_long"
  | "bad_default";

export type SpecResult = { readonly ok: true; readonly spec: VariableSpec } | { readonly ok: false; readonly problem: SpecProblem };

export interface SpecInput {
  readonly id: unknown;
  readonly kind: unknown;
  readonly visibility?: unknown;
  readonly labels?: unknown;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  readonly options?: unknown;
  readonly optionLabels?: unknown;
  readonly setup?: unknown;
  readonly default?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A validated spec, or the first problem. The strict path, used when a variable is
 * DEFINED: an over-long label or option is a problem, not something cut to fit.
 * Labels tolerate junk the way a display map should (a non-text or empty label is simply
 * absent); an option label naming no option is dropped likewise.
 */
export function buildSpec(input: SpecInput): SpecResult {
  const id = normalizeVariableId(input.id);
  if (id === null) return { ok: false, problem: "bad_id" };
  const kind = input.kind;
  if (typeof kind !== "string" || !(VARIABLE_KINDS as readonly string[]).includes(kind)) return { ok: false, problem: "bad_kind" };
  const visibility = input.visibility ?? "player";
  if (visibility !== "player" && visibility !== "keeper") return { ok: false, problem: "bad_visibility" };

  const labelEntries: [string, string][] = [];
  if (isRecord(input.labels)) {
    for (const [locale, label] of Object.entries(input.labels)) {
      if (typeof label !== "string" || label.trim() === "") continue;
      if (codePoints(label.trim()) > MAX_LABEL_CHARS) return { ok: false, problem: "too_long" };
      const lang = language(locale);
      if (lang !== "") labelEntries.push([lang, label.trim()]);
    }
  }
  const spec: { -readonly [K in keyof VariableSpec]: VariableSpec[K] } = {
    id,
    kind: kind as VariableKind,
    visibility,
    labels: Object.fromEntries(labelEntries),
    default: "",
  };

  if (kind === "number") {
    const low = input.minimum === undefined || input.minimum === null ? null : coerceInteger(input.minimum);
    const high = input.maximum === undefined || input.maximum === null ? null : coerceInteger(input.maximum);
    if ((input.minimum !== undefined && input.minimum !== null && low === null) || (input.maximum !== undefined && input.maximum !== null && high === null)) {
      return { ok: false, problem: "bad_bound" };
    }
    if (low !== null && high !== null && low > high) return { ok: false, problem: "bad_bound" };
    if (low !== null) spec.minimum = low;
    if (high !== null) spec.maximum = high;
  } else if ((input.minimum ?? null) !== null || (input.maximum ?? null) !== null) {
    return { ok: false, problem: "bounds_not_for_kind" };
  }

  if (kind === "enum") {
    const options: string[] = [];
    if (Array.isArray(input.options)) {
      for (const option of input.options) {
        if (typeof option !== "string" || option.trim() === "") continue;
        const text = option.trim();
        if (codePoints(text) > MAX_OPTION_CHARS) return { ok: false, problem: "too_long" };
        if (!options.some((existing) => existing.toLowerCase() === text.toLowerCase())) options.push(text);
      }
    }
    if (options.length === 0) return { ok: false, problem: "no_options" };
    if (options.length > MAX_OPTIONS) return { ok: false, problem: "too_long" };
    spec.options = options;
    const named = cleanOptionLabels(options, input.optionLabels);
    if (named === "too_long") return { ok: false, problem: "too_long" };
    if (named !== null) spec.optionLabels = named;
  } else if (Array.isArray(input.options) && input.options.length > 0) {
    return { ok: false, problem: "options_not_for_kind" };
  } else if (isRecord(input.optionLabels) && Object.keys(input.optionLabels).length > 0) {
    return { ok: false, problem: "option_labels_not_for_kind" };
  }

  if (input.setup === true) spec.setup = true;
  if (input.default === undefined || input.default === null) {
    spec.default = defaultValue(spec);
  } else {
    const checked = checkValue(spec, input.default);
    if (!checked.ok) return { ok: false, problem: "bad_default" };
    spec.default = checked.value;
  }
  return { ok: true, spec };
}

function cleanOptionLabels(options: readonly string[], raw: unknown): Record<string, LocalizedText> | null | "too_long" {
  if (!isRecord(raw)) return null;
  const canonical = new Map(options.map((option) => [option.toLowerCase(), option]));
  const out = new Map<string, Map<string, string>>();
  for (const [locale, names] of Object.entries(raw)) {
    const lang = language(locale);
    if (lang === "" || !isRecord(names)) continue;
    for (const [option, text] of Object.entries(names)) {
      const target = canonical.get(option.trim().toLowerCase());
      if (target === undefined || typeof text !== "string" || text.trim() === "") continue;
      if (codePoints(text.trim()) > MAX_LABEL_CHARS) return "too_long";
      const perLanguage = out.get(lang) ?? new Map<string, string>();
      perLanguage.set(target, text.trim());
      out.set(lang, perLanguage);
    }
  }
  if (out.size === 0) return null;
  return Object.fromEntries([...out].map(([lang, names]) => [lang, Object.fromEntries(names)]));
}

/** How many option labels `raw` offers (for telling an author how many were dropped). */
export function countOfferedOptionLabels(raw: unknown): number {
  if (!isRecord(raw)) return 0;
  return Object.values(raw).reduce<number>((sum, names) => sum + (isRecord(names) ? Object.keys(names).length : 1), 0);
}

export function countKeptOptionLabels(spec: VariableSpec): number {
  return Object.values(spec.optionLabels ?? {}).reduce((sum, names) => sum + Object.keys(names).length, 0);
}

function defaultValue(spec: Pick<VariableSpec, "kind" | "minimum" | "maximum" | "options">): VariableValue {
  switch (spec.kind) {
    case "number":
      if (spec.minimum !== undefined) return spec.minimum;
      return spec.maximum !== undefined ? Math.min(0, spec.maximum) : 0;
    case "bool":
      return false;
    case "enum":
      return spec.options?.[0] ?? "";
    default:
      return "";
  }
}

/** Clamp into the spec's bounds (each side independent; absent means unbounded). */
export function clamp(spec: VariableSpec, value: number): number {
  let out = value;
  if (spec.minimum !== undefined) out = Math.max(spec.minimum, out);
  if (spec.maximum !== undefined) out = Math.min(spec.maximum, out);
  return out;
}

export type ValueCheck = { readonly ok: true; readonly value: VariableValue } | { readonly ok: false; readonly code: WriteRefusalCode };

/**
 * A value made fit for `spec`: a number becomes a clamped integer, a bool a boolean, an
 * enum value its declared spelling, text stays text. A number or boolean written to a
 * text variable becomes its JSON text (`42`, `true`); a mapping, a list or null is not
 * text, and text longer than `MAX_TEXT_CHARS` is refused rather than cut.
 */
export function checkValue(spec: VariableSpec, value: unknown): ValueCheck {
  switch (spec.kind) {
    case "number": {
      const number = coerceInteger(value);
      return number === null ? { ok: false, code: "not_a_number" } : { ok: true, value: clamp(spec, number) };
    }
    case "bool": {
      const flag = coerceBoolean(value);
      return flag === null ? { ok: false, code: "not_a_boolean" } : { ok: true, value: flag };
    }
    case "enum": {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return { ok: false, code: "not_an_option" };
      const wanted = String(value).trim().toLowerCase();
      const option = spec.options?.find((candidate) => candidate.toLowerCase() === wanted);
      return option === undefined ? { ok: false, code: "not_an_option" } : { ok: true, value: option };
    }
    default: {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return { ok: false, code: "not_text" };
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return codePoints(text) > MAX_TEXT_CHARS ? { ok: false, code: "too_long" } : { ok: true, value: text };
    }
  }
}

function specInputFromStored(id: unknown, raw: Record<string, unknown>): SpecInput {
  const kind = raw.kind;
  return {
    id,
    kind,
    visibility: raw.visibility === "player" || raw.visibility === "keeper" ? raw.visibility : "player",
    labels: raw.labels,
    minimum: kind === "number" ? raw.minimum : undefined,
    maximum: kind === "number" ? raw.maximum : undefined,
    options: kind === "enum" ? raw.options : undefined,
    // Option labels on a non-enum are dropped, never a reason to lose the variable.
    optionLabels: kind === "enum" ? (raw.optionLabels ?? raw.option_labels) : undefined,
    setup: raw.setup === true,
    default: raw.default,
  };
}

/**
 * The tolerant sibling of `buildSpec`, for specs read from a pack, a lorecard or storage:
 * an unknown visibility reads as `player`, misplaced option labels are ignored. Null when
 * the spec is unusable all the same (bad id, kind, bounds or default).
 */
export function normalizeSpec(raw: unknown): VariableSpec | null {
  if (!isRecord(raw)) return null;
  const built = buildSpec(specInputFromStored(raw.id, raw));
  return built.ok ? built.spec : null;
}

// ---------------------------------------------------------------------------
// State and writes
// ---------------------------------------------------------------------------

/**
 * A stored state made valid: unusable specs dropped, a repeated id dropped (first wins),
 * a value re-checked against its spec (an invalid one becomes the default), at most
 * `MAX_VARIABLES`.
 */
export function normalizeModuleVariables(raw: unknown): ModuleVariables {
  if (!isRecord(raw) || !Array.isArray(raw.variables)) return EMPTY_MODULE_VARIABLES;
  const out: ModuleVariable[] = [];
  for (const item of raw.variables) {
    if (out.length >= MAX_VARIABLES) break;
    if (!isRecord(item)) continue;
    const spec = normalizeSpec(item.spec);
    if (spec === null || out.some((existing) => existing.spec.id === spec.id)) continue;
    const checked = item.value === undefined ? null : checkValue(spec, item.value);
    out.push({ spec, value: checked !== null && checked.ok ? checked.value : spec.default });
  }
  return { variables: out };
}

/** The JSON a document stores for a state. */
export function moduleVariablesData(state: ModuleVariables): { variables: { spec: VariableSpec; value: VariableValue }[] } {
  return { variables: state.variables.map((variable) => ({ spec: variable.spec, value: variable.value })) };
}

export interface VariableWrite {
  readonly state: ModuleVariables;
  readonly outcome: WriteOutcome;
}

function find(state: ModuleVariables, id: string): number {
  const slug = normalizeVariableId(id) ?? id;
  return state.variables.findIndex((variable) => variable.spec.id === slug);
}

function replaceAt(state: ModuleVariables, index: number, variable: ModuleVariable): ModuleVariables {
  return { variables: state.variables.map((existing, at) => (at === index ? variable : existing)) };
}

/**
 * Add a variable, or redefine one in place: a redefinition keeps its position and its
 * current value when that value still fits the new spec (a number re-clamps), else the
 * new default.
 */
export function defineVariable(state: ModuleVariables, spec: VariableSpec): VariableWrite {
  const index = find(state, spec.id);
  if (index < 0) {
    if (state.variables.length >= MAX_VARIABLES) return { state, outcome: refused("limit_reached") };
    return { state: { variables: [...state.variables, { spec, value: spec.default }] }, outcome: applied(null, spec.default) };
  }
  const old = (state.variables[index] as ModuleVariable).value;
  const checked = checkValue(spec, old);
  const value = checked.ok ? checked.value : spec.default;
  return { state: replaceAt(state, index, { spec, value }), outcome: applied(old, value) };
}

export function setVariable(state: ModuleVariables, id: string, value: unknown): VariableWrite {
  const index = find(state, id);
  if (index < 0) return { state, outcome: refused("unknown_path") };
  const variable = state.variables[index] as ModuleVariable;
  const checked = checkValue(variable.spec, value);
  if (!checked.ok) return { state, outcome: refused(checked.code) };
  return { state: replaceAt(state, index, { spec: variable.spec, value: checked.value }), outcome: applied(variable.value, checked.value) };
}

/** Add a signed whole-number delta to a number variable, clamped into its bounds. */
export function adjustVariable(state: ModuleVariables, id: string, delta: unknown): VariableWrite {
  const index = find(state, id);
  if (index < 0) return { state, outcome: refused("unknown_path") };
  const variable = state.variables[index] as ModuleVariable;
  if (variable.spec.kind !== "number") return { state, outcome: refused("wrong_kind") };
  const step = typeof delta === "boolean" ? null : coerceInteger(delta);
  if (step === null) return { state, outcome: refused("delta_not_number") };
  const old = typeof variable.value === "number" ? variable.value : (variable.spec.default as number);
  const value = clamp(variable.spec, old + step);
  if (!Number.isSafeInteger(value)) return { state, outcome: refused("too_large") };
  return { state: replaceAt(state, index, { spec: variable.spec, value }), outcome: applied(old, value) };
}

export function removeVariable(state: ModuleVariables, id: string): VariableWrite {
  const index = find(state, id);
  if (index < 0) return { state, outcome: refused("unknown_path") };
  const old = (state.variables[index] as ModuleVariable).value;
  return { state: { variables: state.variables.filter((_, at) => at !== index) }, outcome: applied(old, null) };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** `{language: text}` for `locale`: the exact language, then English, then any; null when none. */
export function pickLocalized(texts: LocalizedText | undefined, locale: string): string | null {
  if (texts === undefined) return null;
  const lang = language(locale || "en");
  for (const candidate of [lang, "en"]) {
    if (Object.hasOwn(texts, candidate) && texts[candidate]) return texts[candidate] as string;
  }
  for (const value of Object.values(texts)) if (value) return value;
  return null;
}

export function labelFor(spec: VariableSpec, locale: string): string {
  return pickLocalized(spec.labels, locale) ?? spec.id;
}

/** The display name of an enum value for `locale`, or null when no language names it. */
export function optionLabelFor(spec: VariableSpec, value: VariableValue, locale: string): string | null {
  if (spec.kind !== "enum" || typeof value !== "string" || spec.optionLabels === undefined) return null;
  const perLanguage: [string, string][] = [];
  for (const [lang, names] of Object.entries(spec.optionLabels)) {
    if (Object.hasOwn(names, value)) perLanguage.push([lang, names[value] as string]);
  }
  return pickLocalized(Object.fromEntries(perLanguage), locale);
}
