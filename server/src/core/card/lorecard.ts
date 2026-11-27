// The native card bundle (`*.lorecard.json`, `format: "loreweaver.card"`), format
// version 1 (`docs/lwf/formats/cards.md`). Unlike a SillyTavern card it carries what ST
// has no shape for: keeper-only (`secret`) lore, typed module variables, per-entry
// conditions, stable entry ids, a pregenerated cast.
//
// It only PARSES: every trust decision (who may bring world machinery in) belongs to the
// split and the import. The lore half is re-emitted in SillyTavern's V2 entry shape, so a
// native bundle goes through the same split and the same lore import as any card: a
// typed `condition` becomes a leading `@@if <expr>` line, `secret` stays a plain key.
//
// Flags are booleans: `secret`, `constant`, `enabled`, `case_sensitive` and
// `match_whole_words` take `true` or `false`, absent or null is the default, and any other
// value (`1`, `"false"`) skips the entry with a `flag_not_boolean` warning naming the field —
// never read by truthiness, where `secret: "false"` would mean secret.
//
// 3.0 has no hooks: code reaches a room only as a pack's module. A bundle that still
// carries a `hooks` section is read, the scripts are counted into a warning, and nothing
// of them is kept — they cannot be installed or run from here.
//
// Structural garbage (wrong format tag, unsupported version, past a hard cap) is a
// `CardError`. A malformed row is skipped and reported as a warning, so one bad entry
// never costs an author the whole bundle.
import type { JsonObject } from "../documents/model.ts";
import { codePoints, countKeptOptionLabels, countOfferedOptionLabels, normalizeSpec, MAX_VARIABLES, type VariableSpec } from "../variables/index.ts";
import { MAX_CARD_FILE_BYTES, isObject, parseJsonText, text, utf8, type BookEntry, type CharacterCard } from "./card.ts";
import { readStrictFlag } from "../worldbook/index.ts";
import { CardError } from "./errors.ts";

export const LORECARD_FORMAT = "loreweaver.card";
export const LORECARD_VERSION = 1;
/** A native bundle may be twice a SillyTavern card: large modules ship long lore. */
export const MAX_LORECARD_FILE_BYTES = 2 * MAX_CARD_FILE_BYTES;
/** The room's own import limits: more entries than this is refused at parse. */
export const MAX_LORECARD_ENTRIES = 200;
export const MAX_ENTRY_CONTENT_CHARS = 16_000;
export const MAX_PREGENS = 8;
/** `core/condexpr`'s expression limit: a longer condition can never fire. */
export const MAX_CONDITION_CHARS = 500;
const MAX_PREGEN_NAME_CHARS = 60;
const MAX_PREGEN_BLURB_CHARS = 200;
const MAX_PREGEN_NOTES_CHARS = 400;
const MAX_PREGEN_SKILLS = 32;

export type LorecardWarningCode =
  /** A section (`worldbook`, `variables`, `pregens`, `hooks`) has the wrong type. */
  | "section_wrong_type"
  | "entry_not_object"
  | "content_not_text"
  | "content_too_long"
  | "content_empty"
  /** The condition rides along; the lore import refuses the entry (a condition is never cut). */
  | "condition_too_long"
  /** A flag that is not a boolean (`where` names it); the entry was skipped. */
  | "flag_not_boolean"
  | "variable_not_object"
  /** Unusable id, kind, bounds, default, or an over-long label. */
  | "variable_unusable"
  | "variable_duplicate"
  | "option_labels_not_enum"
  | "option_labels_wrong_type"
  /** `count` option labels named no option, were empty or not text. */
  | "option_labels_dropped"
  | "pregen_not_object"
  | "pregen_missing_name"
  | "pregen_too_long"
  | "pregen_skill_not_integer"
  | "pregen_skills_wrong_type"
  /** More than `MAX_PREGENS`; the rest were not read. */
  | "pregens_truncated"
  /** The bundle carries `count` hook scripts; 3.0 has no hooks and they were not kept. */
  | "hooks_unsupported";

export interface LorecardWarning {
  readonly code: LorecardWarningCode;
  /** Where in the document (`worldbook[3]`, `variables[1].option_labels`, `hooks`). */
  readonly where: string;
  readonly count?: number;
}

export interface Pregen {
  readonly name: string;
  readonly blurb: string;
  readonly notes: string;
  readonly skills: Readonly<Record<string, number>>;
}

export interface Lorecard {
  readonly card: CharacterCard;
  readonly variables: readonly VariableSpec[];
  readonly pregens: readonly Pregen[];
  readonly warnings: readonly LorecardWarning[];
  /** Hook scripts found (and not kept). */
  readonly unsupportedHooks: number;
}

/** Whether `bytes` are a native bundle: the format tag occurs, and the JSON object declares it. Never throws. */
export function looksLikeLorecard(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.length > MAX_LORECARD_FILE_BYTES) return false;
  const source = utf8(bytes);
  if (source === null || !source.includes(LORECARD_FORMAT)) return false;
  try {
    const parsed = parseJsonText(source);
    return isObject(parsed) && parsed.format === LORECARD_FORMAT;
  } catch {
    return false;
  }
}

/** The boolean fields of a `worldbook` entry, and each one's default. */
const ENTRY_FLAGS: readonly (readonly [string, boolean])[] = [
  ["secret", false],
  ["constant", false],
  ["enabled", true],
  ["case_sensitive", false],
  ["match_whole_words", false],
];

/** A whole number (integer text, a number truncated, a boolean as 0/1), clamped; else the fallback. */
function integer(value: unknown, fallback: number, low?: number, high?: number): number {
  let parsed = fallback;
  if (typeof value === "boolean") parsed = value ? 1 : 0;
  else if (typeof value === "number" && Number.isFinite(value)) parsed = Math.trunc(value);
  else if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) parsed = fallback;
  if (low !== undefined) parsed = Math.max(low, parsed);
  if (high !== undefined) parsed = Math.min(high, parsed);
  return parsed;
}

/** Non-empty trimmed strings; one string is a one-item list. */
function textList(value: unknown): string[] {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return items.map((item) => text(item).trim()).filter((item) => item !== "");
}

const SELECTIVE_LOGICS = new Set(["and_any", "and_all", "not_any", "not_all"]);
const POSITIONS: Readonly<Record<string, string>> = { before: "before_char", after: "after_char" };

function parseEntry(raw: unknown, index: number, warnings: LorecardWarning[]): BookEntry | null {
  const where = `worldbook[${index}]`;
  if (!isObject(raw)) {
    warnings.push({ code: "entry_not_object", where });
    return null;
  }
  if (typeof raw.content === "object" && raw.content !== null) {
    warnings.push({ code: "content_not_text", where });
    return null;
  }
  let content = text(raw.content);
  if (codePoints(content) > MAX_ENTRY_CONTENT_CHARS) {
    warnings.push({ code: "content_too_long", where });
    return null;
  }
  if (content.trim() === "") {
    warnings.push({ code: "content_empty", where });
    return null;
  }
  const flags = new Map<string, boolean>();
  for (const [name, fallback] of ENTRY_FLAGS) {
    const read = readStrictFlag(raw[name]);
    if (read === "invalid") {
      warnings.push({ code: "flag_not_boolean", where: `${where}.${name}` });
      return null;
    }
    flags.set(name, read === "absent" ? fallback : read);
  }
  // A decorator is one line, so a multi-line condition collapses onto it.
  const condition = text(raw.condition).split(/\s+/u).filter((part) => part !== "").join(" ");
  if (codePoints(condition) > MAX_CONDITION_CHARS) warnings.push({ code: "condition_too_long", where });
  if (condition !== "") content = `@@if ${condition}\n${content}`;
  const secondaryKeys = textList(raw.secondary_keys);
  const logic = text(raw.selective_logic).trim();
  const id = text(raw.id).trim();
  return {
    ...(id !== "" ? { id } : {}),
    comment: text(raw.title).trim() || "Untitled Lore",
    content,
    keys: textList(raw.keys),
    secondary_keys: secondaryKeys,
    selective: secondaryKeys.length > 0,
    selective_logic: SELECTIVE_LOGICS.has(logic) ? logic : "and_any",
    category: text(raw.category).trim() || "lore",
    secret: flags.get("secret") === true,
    constant: flags.get("constant") === true,
    priority: integer(raw.priority, 0),
    enabled: flags.get("enabled") === true,
    probability: integer(raw.probability, 100, 0, 100),
    case_sensitive: flags.get("case_sensitive") === true,
    match_whole_words: flags.get("match_whole_words") === true,
    scan_depth: integer(raw.scan_depth, 0, 0, 200),
    position: POSITIONS[text(raw.position).trim()] ?? "",
    sticky: integer(raw.sticky, 0, 0, 999),
    cooldown: integer(raw.cooldown, 0, 0, 999),
    delay: integer(raw.delay, 0, 0, 9999),
  };
}

function parseWorldbook(raw: unknown, label: string, warnings: LorecardWarning[]): BookEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push({ code: "section_wrong_type", where: "worldbook" });
    return [];
  }
  if (raw.length > MAX_LORECARD_ENTRIES) {
    throw new CardError("too_many_entries", `${label}: worldbook has ${raw.length} entries; at most ${MAX_LORECARD_ENTRIES} are allowed`);
  }
  return raw.map((item, index) => parseEntry(item, index, warnings)).filter((entry): entry is BookEntry => entry !== null);
}

function parseVariables(raw: unknown, label: string, warnings: LorecardWarning[]): VariableSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push({ code: "section_wrong_type", where: "variables" });
    return [];
  }
  if (raw.length > MAX_VARIABLES) {
    throw new CardError("too_many_variables", `${label}: ${raw.length} variables declared; at most ${MAX_VARIABLES} are allowed`);
  }
  const specs: VariableSpec[] = [];
  raw.forEach((item, index) => {
    const where = `variables[${index}]`;
    if (!isObject(item)) {
      warnings.push({ code: "variable_not_object", where });
      return;
    }
    const spec = normalizeSpec(item);
    if (spec === null) {
      warnings.push({ code: "variable_unusable", where });
      return;
    }
    if (specs.some((existing) => existing.id === spec.id)) {
      warnings.push({ code: "variable_duplicate", where });
      return;
    }
    const labels = item.option_labels;
    if (labels !== undefined && labels !== null) {
      if (spec.kind !== "enum") warnings.push({ code: "option_labels_not_enum", where: `${where}.option_labels` });
      else if (!isObject(labels)) warnings.push({ code: "option_labels_wrong_type", where: `${where}.option_labels` });
      else {
        const dropped = countOfferedOptionLabels(labels) - countKeptOptionLabels(spec);
        if (dropped > 0) warnings.push({ code: "option_labels_dropped", where: `${where}.option_labels`, count: dropped });
      }
    }
    specs.push(spec);
  });
  return specs;
}

function parsePregens(raw: unknown, warnings: LorecardWarning[]): Pregen[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push({ code: "section_wrong_type", where: "pregens" });
    return [];
  }
  const out: Pregen[] = [];
  for (const [index, item] of raw.entries()) {
    if (out.length >= MAX_PREGENS) {
      warnings.push({ code: "pregens_truncated", where: "pregens", count: MAX_PREGENS });
      break;
    }
    const where = `pregens[${index}]`;
    if (!isObject(item)) {
      warnings.push({ code: "pregen_not_object", where });
      continue;
    }
    const name = text(item.name).trim();
    if (name === "") {
      warnings.push({ code: "pregen_missing_name", where });
      continue;
    }
    // `concept` when it says anything (a non-empty string, a non-zero number, true), else `blurb`.
    const concept = item.concept;
    const said = (typeof concept === "string" && concept !== "") || (typeof concept === "number" && concept !== 0) || concept === true;
    const blurb = text(said ? concept : item.blurb).trim();
    const notes = text(item.notes).trim();
    const skillsRaw = item.skills;
    const tooLong =
      codePoints(name) > MAX_PREGEN_NAME_CHARS ||
      codePoints(blurb) > MAX_PREGEN_BLURB_CHARS ||
      codePoints(notes) > MAX_PREGEN_NOTES_CHARS ||
      (isObject(skillsRaw) && Object.keys(skillsRaw).length > MAX_PREGEN_SKILLS);
    if (tooLong) {
      warnings.push({ code: "pregen_too_long", where });
      continue;
    }
    const skills: [string, number][] = [];
    if (isObject(skillsRaw)) {
      for (const [key, value] of Object.entries(skillsRaw)) {
        const parsed = typeof value === "boolean" || typeof value === "number" || typeof value === "string" ? integer(value, Number.NaN) : Number.NaN;
        if (Number.isNaN(parsed)) warnings.push({ code: "pregen_skill_not_integer", where: `${where}.skills.${key}` });
        else skills.push([key.trim(), parsed]);
      }
    } else if (skillsRaw !== undefined && skillsRaw !== null) {
      warnings.push({ code: "pregen_skills_wrong_type", where: `${where}.skills` });
    }
    out.push({ name, blurb, notes, skills: Object.fromEntries(skills) });
  }
  return out;
}

/** Hook scripts in a `hooks` section: code strings and `{code}` objects that are not blank. */
export function countHookScripts(value: unknown): number {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return items.filter((item) => {
    const code = typeof item === "string" ? item : isObject(item) ? item.code : undefined;
    return typeof code === "string" && code.trim() !== "";
  }).length;
}

/** Parse one native bundle; throws `CardError` when it is structurally unusable. */
export function parseLorecard(bytes: Uint8Array, filename = ""): Lorecard {
  const label = filename || "lorecard";
  if (bytes.length > MAX_LORECARD_FILE_BYTES) throw new CardError("too_large", `${label}: native card bundle exceeds ${MAX_LORECARD_FILE_BYTES} bytes`);
  const source = utf8(bytes);
  if (source === null) throw new CardError("bad_json", `${label}: not UTF-8 text`);
  const raw = parseJsonText(source);
  if (!isObject(raw)) throw new CardError("not_an_object", `${label}: native card bundle must be a JSON object`);
  if (raw.format !== LORECARD_FORMAT) throw new CardError("unsupported_format", `${label}: not a Loreweaver native card`);
  const version = raw.format_version;
  if (typeof version !== "number" || !Number.isInteger(version)) throw new CardError("bad_version", `${label}: format_version must be an integer`);
  if (version !== LORECARD_VERSION) throw new CardError("unsupported_version", `${label}: unsupported format_version ${version}; this build reads ${LORECARD_VERSION}`);

  const warnings: LorecardWarning[] = [];
  const book = parseWorldbook(raw.worldbook, label, warnings);
  const variables = parseVariables(raw.variables, label, warnings);
  const unsupportedHooks = countHookScripts(raw.hooks);
  if (unsupportedHooks > 0) warnings.push({ code: "hooks_unsupported", where: "hooks", count: unsupportedHooks });
  else if (raw.hooks !== undefined && raw.hooks !== null && typeof raw.hooks !== "string" && !Array.isArray(raw.hooks)) {
    warnings.push({ code: "section_wrong_type", where: "hooks" });
  }
  const pregens = parsePregens(raw.pregens, warnings);

  // The bundle keeps no hook source anywhere downstream: drop the section from `raw` too.
  const { hooks: _dropped, ...document } = raw;
  const card: CharacterCard = {
    name: text(raw.name).trim(),
    description: text(raw.description),
    personality: text(raw.personality),
    scenario: text(raw.scenario),
    firstMessage: text(raw.opening),
    exampleMessages: text(raw.dialogue_examples),
    creatorNotes: text(raw.author_notes),
    creatorNotesMultilingual: {},
    systemPrompt: "",
    postHistoryInstructions: "",
    tags: textList(raw.tags),
    alternateGreetings: textList(raw.alternate_openings),
    book,
    raw: document as JsonObject,
  };
  return { card, variables, pregens, warnings, unsupportedHooks };
}
