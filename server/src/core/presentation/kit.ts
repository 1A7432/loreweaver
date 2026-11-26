// One pack's presentation kit as its author declared it (`presentation.yaml`, version 2):
// what the table should LOOK and SOUND like, as data. `parsePresentationKit` validates a
// plain value — whatever the pack reader read from the file — strictly: an unknown key is
// a problem, not a silent drop. Pure, so the pack reader (`core/packs`) checks a kit with
// the very parser the Stage Director's room kit is built from (`agent/lanes/presentation.ts`).
import { charCount } from "loreweaver-protocol/v3";

export const KIT_VERSION = 2;
export const GENERATION_MODES = ["allow", "pack_only"] as const;
export type GenerationMode = (typeof GENERATION_MODES)[number];
export const SUBJECT_KINDS = ["npc", "location", "item"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
export const AUDIO_LAYERS = ["bgm", "ambience", "sfx"] as const;
export type AudioLayer = (typeof AUDIO_LAYERS)[number];
/** The staging shapes the Director can perform. */
export const TEMPLATE_KINDS = ["image", "title_card", "letter", "clipping", "text"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
export const KIT_LOCALES = ["en", "zh"] as const;
export type KitLocale = (typeof KIT_LOCALES)[number];

export const MAX_SUBJECTS = 64;
export const MAX_AUDIO_CUES = 32;
export const MAX_BANNED = 24;
export const MAX_PALETTE = 8;
export const MAX_PALETTE_CHARS = 80;
export const MAX_KIT_TEXT_CHARS = 400;
export const MAX_SUBJECT_PROMPT_CHARS = 1_000;
export const MAX_ASSET_PATH_CHARS = 256;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `en`/`zh` text; at least one present. A fixed key set, so a plain object is safe. */
export interface KitText {
  readonly en?: string;
  readonly zh?: string;
}

export interface KitSubject {
  readonly id: string;
  readonly kind: SubjectKind;
  readonly name: KitText;
  /** Pack-relative path of the reference picture; null: nameable, never generated. */
  readonly ref: string | null;
  /** The subject's own description, sent with every generation of it. */
  readonly prompt: string;
}

export interface KitCue {
  readonly id: string;
  readonly layer: AudioLayer;
  /** Pack-relative path of the sound. */
  readonly asset: string;
  readonly title: string;
}

export interface PresentationKit {
  readonly version: typeof KIT_VERSION;
  readonly generation: GenerationMode;
  /** Empty: every `TEMPLATE_KINDS` shape is allowed. */
  readonly templates: readonly TemplateKind[];
  readonly style: {
    readonly keywords: KitText | null;
    readonly banned: readonly string[];
    readonly palette: readonly string[];
  };
  readonly subjects: readonly KitSubject[];
  readonly audio: readonly KitCue[];
}

export type KitProblemCode =
  | "not_an_object"
  | "unknown_key"
  | "missing_key"
  | "bad_version"
  | "bad_value"
  | "bad_slug"
  | "duplicate"
  | "too_long"
  | "too_many"
  | "bad_path";

export type KitParse = { readonly ok: true; readonly kit: PresentationKit } | { readonly ok: false; readonly code: KitProblemCode; readonly path: string };

class KitProblem extends Error {
  readonly code: KitProblemCode;
  readonly path: string;

  constructor(code: KitProblemCode, path: string) {
    super(`${code} at ${path}`);
    this.code = code;
    this.path = path;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(raw: Readonly<Record<string, unknown>>, path: string, required: readonly string[], optional: readonly string[]): void {
  for (const key of required) if (!Object.hasOwn(raw, key)) throw new KitProblem("missing_key", path === "" ? key : `${path}.${key}`);
  for (const key of Object.keys(raw)) {
    if (!required.includes(key) && !optional.includes(key)) throw new KitProblem("unknown_key", path === "" ? key : `${path}.${key}`);
  }
}

function field(raw: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(raw, key) ? raw[key] : undefined;
}

function text(raw: unknown, path: string, max: number, allowEmpty = false): string {
  if (typeof raw !== "string") throw new KitProblem("bad_value", path);
  const value = raw.trim();
  if (!allowEmpty && value === "") throw new KitProblem("bad_value", path);
  if (charCount(value) > max) throw new KitProblem("too_long", path);
  return value;
}

/** A plain string (read as English) or an `{en, zh}` mapping. */
function kitText(raw: unknown, path: string): KitText {
  if (typeof raw === "string") return { en: text(raw, path, MAX_KIT_TEXT_CHARS) };
  if (!isRecord(raw)) throw new KitProblem("bad_value", path);
  keys(raw, path, [], KIT_LOCALES);
  const out: { en?: string; zh?: string } = {};
  for (const locale of KIT_LOCALES) {
    const value = field(raw, locale);
    if (value !== undefined) out[locale] = text(value, `${path}.${locale}`, MAX_KIT_TEXT_CHARS);
  }
  if (out.en === undefined && out.zh === undefined) throw new KitProblem("bad_value", path);
  return out;
}

function slug(raw: unknown, path: string): string {
  if (typeof raw !== "string" || !SLUG.test(raw)) throw new KitProblem("bad_slug", path);
  return raw;
}

/** A pack-relative POSIX path: no absolute path, no `.`/`..`/empty segment, no backslash. */
function assetPath(raw: unknown, path: string): string {
  if (typeof raw !== "string") throw new KitProblem("bad_path", path);
  const value = raw.trim();
  if (value === "" || charCount(value) > MAX_ASSET_PATH_CHARS || value.startsWith("/") || value.includes("\\")) throw new KitProblem("bad_path", path);
  if (value.split("/").some((part) => part === "" || part === "." || part === "..")) throw new KitProblem("bad_path", path);
  return value;
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], path: string): T {
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) throw new KitProblem("bad_value", path);
  return raw as T;
}

function list(raw: unknown, path: string, max: number): readonly unknown[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new KitProblem("bad_value", path);
  if (raw.length > max) throw new KitProblem("too_many", path);
  return raw;
}

function parseSubject(raw: unknown, path: string): KitSubject {
  if (!isRecord(raw)) throw new KitProblem("not_an_object", path);
  keys(raw, path, ["id", "kind", "name"], ["ref", "prompt"]);
  const ref = field(raw, "ref");
  const prompt = field(raw, "prompt");
  return {
    id: slug(field(raw, "id"), `${path}.id`),
    kind: oneOf(field(raw, "kind"), SUBJECT_KINDS, `${path}.kind`),
    name: kitText(field(raw, "name"), `${path}.name`),
    ref: ref === undefined || ref === null || ref === "" ? null : assetPath(ref, `${path}.ref`),
    prompt: prompt === undefined ? "" : text(prompt, `${path}.prompt`, MAX_SUBJECT_PROMPT_CHARS, true),
  };
}

function parseCue(raw: unknown, path: string): KitCue {
  if (!isRecord(raw)) throw new KitProblem("not_an_object", path);
  keys(raw, path, ["id", "layer", "asset"], ["title"]);
  const title = field(raw, "title");
  return {
    id: slug(field(raw, "id"), `${path}.id`),
    layer: oneOf(field(raw, "layer"), AUDIO_LAYERS, `${path}.layer`),
    asset: assetPath(field(raw, "asset"), `${path}.asset`),
    title: title === undefined ? "" : text(title, `${path}.title`, MAX_KIT_TEXT_CHARS, true),
  };
}

function unique<T extends { readonly id: string }>(items: readonly T[], path: string): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) throw new KitProblem("duplicate", `${path}.${index}.id`);
    seen.add(item.id);
  });
}

/** One pack's kit, validated in full; the first problem refuses it. */
export function parsePresentationKit(raw: unknown): KitParse {
  try {
    if (!isRecord(raw)) throw new KitProblem("not_an_object", "");
    keys(raw, "", ["version"], ["generation", "templates", "style", "subjects", "audio"]);
    if (field(raw, "version") !== KIT_VERSION) throw new KitProblem("bad_version", "version");
    const generationRaw = field(raw, "generation");
    const generation = generationRaw === undefined ? "allow" : oneOf(generationRaw, GENERATION_MODES, "generation");
    const templates: TemplateKind[] = [];
    list(field(raw, "templates"), "templates", TEMPLATE_KINDS.length).forEach((entry, index) => {
      const kind = oneOf(entry, TEMPLATE_KINDS, `templates.${index}`);
      if (templates.includes(kind)) throw new KitProblem("duplicate", `templates.${index}`);
      templates.push(kind);
    });
    const styleRaw = field(raw, "style") ?? {};
    if (!isRecord(styleRaw)) throw new KitProblem("not_an_object", "style");
    keys(styleRaw, "style", [], ["keywords", "banned", "palette"]);
    const keywordsRaw = field(styleRaw, "keywords");
    const style = {
      keywords: keywordsRaw === undefined || keywordsRaw === null ? null : kitText(keywordsRaw, "style.keywords"),
      banned: list(field(styleRaw, "banned"), "style.banned", MAX_BANNED).map((entry, index) => text(entry, `style.banned.${index}`, MAX_KIT_TEXT_CHARS)),
      palette: list(field(styleRaw, "palette"), "style.palette", MAX_PALETTE).map((entry, index) => text(entry, `style.palette.${index}`, MAX_PALETTE_CHARS)),
    };
    const subjects = list(field(raw, "subjects"), "subjects", MAX_SUBJECTS).map((entry, index) => parseSubject(entry, `subjects.${index}`));
    unique(subjects, "subjects");
    const audio = list(field(raw, "audio"), "audio", MAX_AUDIO_CUES).map((entry, index) => parseCue(entry, `audio.${index}`));
    unique(audio, "audio");
    return { ok: true, kit: { version: KIT_VERSION, generation, templates, style, subjects, audio } };
  } catch (error) {
    if (error instanceof KitProblem) return { ok: false, code: error.code, path: error.path };
    throw error;
  }
}

/** Text for `locale`: its language, then English, then whichever is present. */
export function kitTextFor(value: KitText, locale: string): string {
  const short = locale.split(/[-_]/u, 1)[0] ?? "";
  if (short === "zh" && value.zh !== undefined) return value.zh;
  return value.en ?? value.zh ?? "";
}

