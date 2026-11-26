// Reading one skill: a directory `<id>/` holding `SKILL.md` — YAML front matter and a
// Markdown body the Keeper's prompt carries while the skill is enabled in a room
// (LWF `docs/lwf/formats/skills-hooks.md` §1; reference `core/skills.py`).
//
// In 3.0 a skill is prompt text and a list of tools it unlocks, nothing else. A directory
// that also holds a `hooks.js` (a 2.x event script) loads normally; the script is ignored
// and a warning says so — module code now lives in modules, not skills.
//
// Content rules: the id is a slug; every string and list is capped by a named constant and
// a value over its cap is refused with a coded result (never cut); unknown front-matter
// keys are ignored, as the format says. Nothing here reads a file: the caller hands over
// the directory's file names and the text of `SKILL.md`.
import { loadYaml, YamlError } from "../yaml.ts";

/** A skill id: a lowercase slug, the directory's name. */
export const SKILL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
export const MAX_SKILL_FILE_CHARS = 100_000;
export const MAX_SKILL_BODY_CHARS = 20_000;
export const MAX_SKILL_NAME_CHARS = 100;
export const MAX_SKILL_DESCRIPTION_CHARS = 2_000;
export const MAX_ALLOWED_TOOLS = 32;
export const MAX_TOOL_NAME_CHARS = 64;
export const MAX_SKILL_SYSTEMS = 16;
export const MAX_SYSTEM_ID_CHARS = 64;
/** Localized display names (`name-<lang>`, `description-<lang>`) per skill. */
export const MAX_SKILL_LOCALES = 16;
export const MAX_CONTENT_RATING_CHARS = 32;

/** The content ratings that declare mature content (and lift the room's output filter). */
export const MATURE_RATINGS: ReadonlySet<string> = new Set(["mature", "explicit"]);

export interface Skill {
  readonly id: string;
  /** Display name; the id when the front matter names none. */
  readonly name: string;
  readonly description: string;
  /** Localized display names and descriptions by language (`name-zh` → `zh`). */
  readonly localizedNames: ReadonlyMap<string, string>;
  readonly localizedDescriptions: ReadonlyMap<string, string>;
  /** Tool names this skill unlocks while enabled. Names the runtime does not know are ignored by it. */
  readonly allowedTools: readonly string[];
  /** Rule-system ids the skill is written for: informative. */
  readonly systems: readonly string[];
  /** `metadata.content-rating`, lower-cased; "" when none. */
  readonly contentRating: string;
  /** The Markdown instructions, leading and trailing blank lines removed. */
  readonly body: string;
}

export type SkillErrorCode =
  /** The directory name is not a skill id. */
  | "bad_id"
  /** The directory has no `SKILL.md`. */
  | "no_skill_file"
  /** `SKILL.md` does not start with a `---` line. */
  | "no_front_matter"
  /** The front matter has no closing `---` line. */
  | "unclosed_front_matter"
  /** The front matter is not YAML this engine reads (see `detail`: the YAML error code). */
  | "yaml"
  /** The front matter is not a mapping. */
  | "not_a_mapping"
  /** A field has the wrong type (see `path`). */
  | "bad_field"
  /** A text is over its cap (see `path`). */
  | "too_long"
  /** A list is over its cap (see `path`). */
  | "too_many";

export type SkillWarningCode =
  /** The directory holds a `hooks.js`: 3.0 skills are prompt text only; the script is ignored. */
  | "hooks_ignored"
  /** `metadata.scope` is not `room`, the only defined scope; the skill is a room toggle anyway. */
  | "unknown_scope";

export interface SkillWarning {
  readonly code: SkillWarningCode;
}

export type SkillParse =
  | { readonly ok: true; readonly skill: Skill; readonly warnings: readonly SkillWarning[] }
  | { readonly ok: false; readonly code: SkillErrorCode; readonly path?: string; readonly detail?: string; readonly line?: number };

/** A skill directory as plain data: its name, the names of the files in it, and `SKILL.md`. */
export interface SkillDirectory {
  readonly id: string;
  readonly files: readonly string[];
  /** The text of `SKILL.md`; null when the directory has none. */
  readonly skillFile: string | null;
}

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Failure = Extract<SkillParse, { ok: false }>;

class Refused extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super(failure.code);
    this.failure = failure;
  }
}

function refuse(code: SkillErrorCode, path?: string): never {
  throw new Refused(path === undefined ? { ok: false, code } : { ok: false, code, path });
}

function text(value: unknown, path: string, max: number, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") refuse("bad_field", path);
  const trimmed = value.trim();
  if (codePoints(trimmed) > max) refuse("too_long", path);
  return trimmed;
}

function names(value: unknown, path: string, maxItems: number, maxChars: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) refuse("bad_field", path);
  if (value.length > maxItems) refuse("too_many", path);
  const out: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") refuse("bad_field", `${path}.${index}`);
    const trimmed = item.trim();
    if (codePoints(trimmed) > maxChars) refuse("too_long", `${path}.${index}`);
    if (!out.includes(trimmed)) out.push(trimmed);
  });
  return out;
}

/** Split `SKILL.md` into front matter and body (LWF §1: fences are lines exactly `---`). */
function split(source: string): { readonly front: string; readonly body: string } {
  const lines = source.replace(/^﻿/u, "").split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") refuse("no_front_matter");
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]?.trim() === "---") {
      return { front: lines.slice(1, index).join("\n"), body: lines.slice(index + 1).join("\n").replace(/^\n+|\n+$/gu, "") };
    }
  }
  return refuse("unclosed_front_matter");
}

const LOCALIZED = /^(name|description)-([a-z]{2,3})$/u;

/** Parse `SKILL.md` text as the skill `id`. */
export function parseSkillText(id: string, source: string): SkillParse {
  try {
    if (!SKILL_ID_PATTERN.test(id)) refuse("bad_id");
    if (codePoints(source) > MAX_SKILL_FILE_CHARS) refuse("too_long", "SKILL.md");
    const { front, body } = split(source);
    let data: unknown;
    try {
      data = front.trim() === "" ? {} : loadYaml(front);
    } catch (error) {
      if (error instanceof YamlError) {
        return error.line === undefined ? { ok: false, code: "yaml", detail: error.code } : { ok: false, code: "yaml", detail: error.code, line: error.line + 1 };
      }
      throw error;
    }
    if (data === null) data = {};
    if (!isRecord(data)) refuse("not_a_mapping");
    const front_ = data;
    const field = (key: string): unknown => (Object.hasOwn(front_, key) ? front_[key] : undefined);
    const metadataRaw = field("metadata");
    if (metadataRaw !== undefined && metadataRaw !== null && !isRecord(metadataRaw)) refuse("bad_field", "metadata");
    const metadata: Record<string, unknown> = isRecord(metadataRaw) ? metadataRaw : {};
    const meta = (key: string): unknown => (Object.hasOwn(metadata, key) ? metadata[key] : undefined);

    const localizedNames = new Map<string, string>();
    const localizedDescriptions = new Map<string, string>();
    for (const key of Object.keys(front_)) {
      const match = LOCALIZED.exec(key);
      if (match === null) continue;
      const [, kind, language] = match as unknown as [string, "name" | "description", string];
      const target = kind === "name" ? localizedNames : localizedDescriptions;
      const value = text(front_[key], key, kind === "name" ? MAX_SKILL_NAME_CHARS : MAX_SKILL_DESCRIPTION_CHARS, "");
      if (value === "") continue;
      if (target.size >= MAX_SKILL_LOCALES) refuse("too_many", key);
      target.set(language, value);
    }

    if (codePoints(body) > MAX_SKILL_BODY_CHARS) refuse("too_long", "body");
    const rating = text(meta("content-rating"), "metadata.content-rating", MAX_CONTENT_RATING_CHARS, "").toLowerCase();
    const scope = text(meta("scope"), "metadata.scope", MAX_CONTENT_RATING_CHARS, "room");
    const skill: Skill = Object.freeze({
      id,
      name: text(field("name"), "name", MAX_SKILL_NAME_CHARS, "") || id,
      description: text(field("description"), "description", MAX_SKILL_DESCRIPTION_CHARS, ""),
      localizedNames,
      localizedDescriptions,
      allowedTools: Object.freeze(names(field("allowed-tools"), "allowed-tools", MAX_ALLOWED_TOOLS, MAX_TOOL_NAME_CHARS)),
      systems: Object.freeze(names(meta("systems"), "metadata.systems", MAX_SKILL_SYSTEMS, MAX_SYSTEM_ID_CHARS)),
      contentRating: rating,
      body,
    });
    const warnings: SkillWarning[] = scope === "room" ? [] : [{ code: "unknown_scope" }];
    return { ok: true, skill, warnings };
  } catch (error) {
    if (error instanceof Refused) return error.failure;
    throw error;
  }
}

/** Parse a skill directory. A `hooks.js` beside `SKILL.md` is ignored with a warning. */
export function parseSkillDirectory(directory: SkillDirectory): SkillParse {
  if (!SKILL_ID_PATTERN.test(directory.id)) return { ok: false, code: "bad_id" };
  if (directory.skillFile === null) return { ok: false, code: "no_skill_file" };
  const parsed = parseSkillText(directory.id, directory.skillFile);
  if (!parsed.ok || !directory.files.includes("hooks.js")) return parsed;
  return { ...parsed, warnings: [...parsed.warnings, { code: "hooks_ignored" }] };
}

/** The skill's display name in `locale`'s language, falling back to the English name. */
export function skillName(skill: Skill, locale: string): string {
  return skill.localizedNames.get(locale.toLowerCase().split(/[-_]/u, 1)[0] ?? "") ?? skill.name;
}

/** The skill's description in `locale`'s language, falling back to the English one. */
export function skillDescription(skill: Skill, locale: string): string {
  return skill.localizedDescriptions.get(locale.toLowerCase().split(/[-_]/u, 1)[0] ?? "") ?? skill.description;
}

/** Whether the skill declares mature content (LWF: `mature` or `explicit`). */
export function isMature(skill: Skill): boolean {
  return MATURE_RATINGS.has(skill.contentRating);
}
