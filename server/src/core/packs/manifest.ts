// `pack.yaml`, manifest version 3: what a pack says it carries. `parseManifest` reads the
// YAML (through `core/yaml.ts`: no anchors, no aliases) and checks every field, returning a
// typed manifest or every problem found, each a stable code with the dotted path of the
// field. Nothing here reads a file; whether the files the manifest names exist, and what
// they hold, is `readPack`'s business.
//
// Ids, versions, names and paths are content: counted in code points, capped by named
// constants, and refused — never cut — when over a cap.
import { charCount } from "loreweaver-protocol/v3";

import { checkEntryPath } from "../../infra/zip.ts";
import { NAME_PATTERN } from "loreweaver/runner";
import { PACK_ID as RULE_SYSTEM_ID } from "../rulepacks/index.ts";
import { loadYaml, YamlError } from "../yaml.ts";

/** The manifest version this engine reads. Earlier versions are refused; there is no migration. */
export const MANIFEST_VERSION = 3;
/** A pack id: a lowercase slug. It names the install directory. */
export const PACK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
/** `MAJOR.MINOR.PATCH`, with at most one pre-release (`-…`) or build (`+…`) suffix. */
export const PACK_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/u;
/** An engine minimum: one to four dotted integers. */
export const ENGINE_VERSION = /^\d{1,6}(?:\.\d{1,6}){0,3}$/u;
/** A module id: the name a module's commands and views are prefixed with (`<module>/<name>`). */
export const MODULE_ID = NAME_PATTERN;
const SHA256 = /^[0-9a-f]{64}$/u;

export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_TEXT_CHARS = 2_000;
export const MAX_AUTHORS = 32;
export const MAX_AUTHOR_CHARS = 200;
export const MAX_LICENSE_CHARS = 200;
export const MAX_MODULES = 16;
/** Entries per content kind (skills, rule packs, cards). */
export const MAX_KIND_ENTRIES = 64;
export const MAX_ASSETS = 512;
export const MAX_ASSET_TAGS = 16;
export const MAX_TAG_CHARS = 64;
/** At most one presentation kit per pack. */
export const MAX_PRESENTATION = 1;

/** Source extensions a module entry may have; inside an archive the entry is the bundled `.js`. */
export const MODULE_SOURCE_EXTENSIONS: readonly string[] = [".ts", ".mts", ".tsx", ".js", ".mjs", ".jsx"];
export const BUNDLED_MODULE_EXTENSION = ".js";
/** The content kinds of manifest version 3. */
export const CONTENT_KINDS: readonly string[] = ["skills", "rulepacks", "cards", "presentation"];
/**
 * Kinds of 2.x packs this version does not carry. `panels` arrive with the panel layer;
 * `lorebooks`, `presets` (prompt presets) and `prep` (prep scripts) are not part of 3.0.
 */
export const UNSUPPORTED_KINDS: readonly string[] = ["lorebooks", "panels", "presets", "prep"];

export type CardKind = "world" | "character";

/** `en`/`zh` text with at least one present. A fixed key set, so a plain object is safe. */
export interface LocalText {
  readonly en?: string;
  readonly zh?: string;
}

export interface ManifestModule {
  readonly id: string;
  /** The entry file: the author's source in a source tree, the bundled `.js` in an archive. */
  readonly entry: string;
}

export interface ManifestCard {
  readonly path: string;
  /** What the author says the card is; `readPack` checks it against what the card holds. */
  readonly kind: CardKind;
  /** Notes for the room admin; null when none. */
  readonly notes: LocalText | null;
}

export interface ManifestAsset {
  readonly path: string;
  /** Declared media type; null: from the extension. */
  readonly mime: string | null;
  /** Declared digest; null: none declared. */
  readonly sha256: string | null;
  readonly title: string;
  readonly license: string;
  readonly tags: readonly string[];
}

export interface Manifest {
  readonly manifestVersion: typeof MANIFEST_VERSION;
  readonly id: string;
  readonly version: string;
  readonly name: LocalText;
  readonly description: LocalText;
  readonly authors: readonly string[];
  readonly license: string;
  readonly engine: { readonly protocol: string | null; readonly server: string | null };
  readonly modules: readonly ManifestModule[];
  /** Skill directories. */
  readonly skills: readonly string[];
  /** Rule-pack files (`.yaml`/`.yml`); each file's stem is the rule system's id. */
  readonly rulepacks: readonly string[];
  readonly cards: readonly ManifestCard[];
  /** The presentation kit file; null for none. */
  readonly presentation: string | null;
  readonly assets: readonly ManifestAsset[];
  /** Top-level keys this version does not define: ignored, and reported. */
  readonly ignoredKeys: readonly string[];
}

export type ManifestCode =
  /** `pack.yaml` is over `MAX_MANIFEST_BYTES`, or not UTF-8. */
  | "manifest_too_large"
  | "manifest_not_utf8"
  /** Not YAML this engine reads (`detail`: the YAML error code). */
  | "bad_yaml"
  /** The document, or a block that must be a mapping, is not one. */
  | "not_a_mapping"
  /** No `manifest_version`. */
  | "manifest_version_missing"
  /** An earlier manifest version (`detail`: the version found). */
  | "manifest_version_unsupported"
  /** A later manifest version than this engine reads. */
  | "manifest_version_too_new"
  | "missing_field"
  /** A value of the wrong type or shape. */
  | "bad_field"
  | "bad_id"
  | "bad_version"
  /** A path that breaks the path rules (`detail`: which), or has the wrong extension. */
  | "bad_path"
  | "too_long"
  | "too_many"
  /** The same entry, id or file twice. */
  | "duplicate"
  /** A key a closed block does not define. */
  | "unknown_key"
  /** A content kind of 2.x packs that 3.0 does not carry. */
  | "unsupported_kind"
  /** A content kind no version defines. */
  | "unknown_kind";

export interface ManifestProblem {
  readonly code: ManifestCode;
  readonly path: string;
  readonly detail?: string;
}

export type ManifestParse = { readonly ok: true; readonly manifest: Manifest } | { readonly ok: false; readonly problems: readonly ManifestProblem[] };

type Raw = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(raw: Raw, key: string): unknown {
  return Object.hasOwn(raw, key) ? raw[key] : undefined;
}

function join(path: string, key: string | number): string {
  return path === "" ? String(key) : `${path}.${key}`;
}

/** Collects problems; each reader returns a usable placeholder so reading goes on. */
class Reader {
  readonly problems: ManifestProblem[] = [];

  fail(code: ManifestCode, path: string, detail?: string): void {
    this.problems.push(detail === undefined ? { code, path } : { code, path, detail });
  }

  closed(raw: Raw, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(raw)) if (!allowed.includes(key)) this.fail("unknown_key", join(path, key));
  }

  text(raw: unknown, path: string, max: number, required: boolean): string {
    if (raw === undefined || raw === null) {
      if (required) this.fail("missing_field", path);
      return "";
    }
    if (typeof raw !== "string") {
      this.fail("bad_field", path);
      return "";
    }
    const value = raw.trim();
    if (required && value === "") this.fail("missing_field", path);
    if (charCount(value) > max) this.fail("too_long", path);
    return value;
  }

  localText(raw: unknown, path: string, required: boolean): LocalText {
    if (raw === undefined || raw === null) {
      if (required) this.fail("missing_field", path);
      return {};
    }
    if (typeof raw === "string") {
      const value = this.text(raw, path, MAX_TEXT_CHARS, required);
      return value === "" ? {} : { en: value };
    }
    if (!isRecord(raw)) {
      this.fail("bad_field", path);
      return {};
    }
    this.closed(raw, path, ["en", "zh"]);
    const out: { en?: string; zh?: string } = {};
    for (const locale of ["en", "zh"] as const) {
      const value = this.text(field(raw, locale), join(path, locale), MAX_TEXT_CHARS, false);
      if (value !== "") out[locale] = value;
    }
    if (required && out.en === undefined && out.zh === undefined) this.fail("missing_field", path);
    return out;
  }

  list(raw: unknown, path: string, max: number): readonly unknown[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      this.fail("bad_field", path);
      return [];
    }
    if (raw.length > max) {
      this.fail("too_many", path);
      return raw.slice(0, max);
    }
    return raw;
  }

  path(raw: unknown, path: string, extensions: readonly string[] | null): string {
    if (typeof raw !== "string" || raw.trim() === "") {
      this.fail(raw === undefined ? "missing_field" : "bad_field", path);
      return "";
    }
    const value = raw.trim();
    const problem = checkEntryPath(value);
    if (problem !== null) {
      this.fail("bad_path", path, problem);
      return "";
    }
    if (value === "pack.yaml") {
      this.fail("bad_path", path, "manifest");
      return "";
    }
    if (extensions !== null && !extensions.some((extension) => value.toLowerCase().endsWith(extension))) {
      this.fail("bad_path", path, "extension");
      return "";
    }
    return value;
  }
}

function readEngine(r: Reader, raw: unknown): Manifest["engine"] {
  if (raw === undefined || raw === null) return { protocol: null, server: null };
  if (!isRecord(raw)) {
    r.fail("not_a_mapping", "engine");
    return { protocol: null, server: null };
  }
  r.closed(raw, "engine", ["protocol", "server"]);
  const version = (key: string): string | null => {
    const value = field(raw, key);
    if (value === undefined || value === null) return null;
    const text = typeof value === "number" ? String(value) : value;
    if (typeof text !== "string" || !ENGINE_VERSION.test(text.trim())) {
      r.fail("bad_version", join("engine", key));
      return null;
    }
    return text.trim();
  };
  return { protocol: version("protocol"), server: version("server") };
}

function readModules(r: Reader, raw: unknown): ManifestModule[] {
  const out: ManifestModule[] = [];
  r.list(raw, "modules", MAX_MODULES).forEach((item, index) => {
    const path = join("modules", index);
    if (!isRecord(item)) {
      r.fail("not_a_mapping", path);
      return;
    }
    r.closed(item, path, ["id", "entry"]);
    const id = field(item, "id");
    if (typeof id !== "string" || !MODULE_ID.test(id)) {
      r.fail(id === undefined ? "missing_field" : "bad_id", join(path, "id"));
      return;
    }
    if (out.some((module) => module.id === id)) r.fail("duplicate", join(path, "id"));
    const entry = r.path(field(item, "entry"), join(path, "entry"), MODULE_SOURCE_EXTENSIONS);
    if (entry !== "") out.push({ id, entry });
  });
  return out;
}

function readCards(r: Reader, raw: unknown): ManifestCard[] {
  const out: ManifestCard[] = [];
  r.list(raw, "contents.cards", MAX_KIND_ENTRIES).forEach((item, index) => {
    const path = join("contents.cards", index);
    if (!isRecord(item)) {
      // A card's kind is required, so a bare path is not enough.
      r.fail(typeof item === "string" ? "missing_field" : "not_a_mapping", typeof item === "string" ? join(path, "kind") : path);
      return;
    }
    r.closed(item, path, ["path", "kind", "notes"]);
    const file = r.path(field(item, "path"), join(path, "path"), [".png", ".json"]);
    const kind = field(item, "kind");
    if (kind !== "world" && kind !== "character") {
      r.fail(kind === undefined ? "missing_field" : "bad_field", join(path, "kind"));
      return;
    }
    const notesRaw = field(item, "notes");
    const notes = notesRaw === undefined || notesRaw === null ? null : r.localText(notesRaw, join(path, "notes"), false);
    if (file !== "") out.push({ path: file, kind, notes });
  });
  return out;
}

function readAssets(r: Reader, raw: unknown): ManifestAsset[] {
  const out: ManifestAsset[] = [];
  r.list(raw, "assets", MAX_ASSETS).forEach((item, index) => {
    const path = join("assets", index);
    const record: Raw | null = typeof item === "string" ? { path: item } : isRecord(item) ? item : null;
    if (record === null) {
      r.fail("not_a_mapping", path);
      return;
    }
    r.closed(record, path, ["path", "mime", "sha256", "title", "license", "tags"]);
    const file = r.path(field(record, "path"), join(path, "path"), null);
    const mimeRaw = field(record, "mime");
    let mime: string | null = null;
    if (mimeRaw !== undefined && mimeRaw !== null) {
      if (typeof mimeRaw !== "string" || !/^[a-z]+\/[a-z0-9.+-]{1,64}$/u.test(mimeRaw)) r.fail("bad_field", join(path, "mime"));
      else mime = mimeRaw;
    }
    const shaRaw = field(record, "sha256");
    let sha256: string | null = null;
    if (shaRaw !== undefined && shaRaw !== null) {
      if (typeof shaRaw !== "string" || !SHA256.test(shaRaw)) r.fail("bad_field", join(path, "sha256"));
      else sha256 = shaRaw;
    }
    const tags = r.list(field(record, "tags"), join(path, "tags"), MAX_ASSET_TAGS).map((tag, at) => r.text(tag, join(join(path, "tags"), at), MAX_TAG_CHARS, true));
    if (file === "") return;
    out.push({
      path: file,
      mime,
      sha256,
      title: r.text(field(record, "title"), join(path, "title"), MAX_TEXT_CHARS, false),
      license: r.text(field(record, "license"), join(path, "license"), MAX_LICENSE_CHARS, false),
      tags,
    });
  });
  return out;
}

function readPathList(r: Reader, raw: unknown, path: string, max: number, extensions: readonly string[] | null): string[] {
  const out: string[] = [];
  r.list(raw, path, max).forEach((item, index) => {
    const value = r.path(item, join(path, index), extensions);
    if (value !== "") out.push(value);
  });
  return out;
}

const TOP_LEVEL = ["manifest_version", "id", "version", "name", "description", "authors", "license", "engine", "modules", "contents", "assets"];

/** Check a manifest value already read from YAML. */
export function checkManifest(document: unknown): ManifestParse {
  const r = new Reader();
  if (!isRecord(document)) return { ok: false, problems: [{ code: "not_a_mapping", path: "" }] };
  const versionRaw = field(document, "manifest_version");
  if (versionRaw === undefined) return { ok: false, problems: [{ code: "manifest_version_missing", path: "manifest_version" }] };
  if (typeof versionRaw !== "number" || !Number.isSafeInteger(versionRaw) || versionRaw < 1) return { ok: false, problems: [{ code: "bad_field", path: "manifest_version" }] };
  if (versionRaw < MANIFEST_VERSION) return { ok: false, problems: [{ code: "manifest_version_unsupported", path: "manifest_version", detail: String(versionRaw) }] };
  if (versionRaw > MANIFEST_VERSION) return { ok: false, problems: [{ code: "manifest_version_too_new", path: "manifest_version", detail: String(versionRaw) }] };

  const ignoredKeys = Object.keys(document).filter((key) => !TOP_LEVEL.includes(key));
  const idRaw = field(document, "id");
  const id = typeof idRaw === "string" ? idRaw : "";
  if (!PACK_ID.test(id)) r.fail(idRaw === undefined ? "missing_field" : "bad_id", "id");
  const versionValue = field(document, "version");
  const version = typeof versionValue === "string" ? versionValue.trim() : "";
  if (!PACK_VERSION.test(version)) r.fail(versionValue === undefined ? "missing_field" : "bad_version", "version");
  const name = r.localText(field(document, "name"), "name", true);
  const description = r.localText(field(document, "description"), "description", true);
  const authors = r.list(field(document, "authors"), "authors", MAX_AUTHORS).map((author, index) => r.text(author, join("authors", index), MAX_AUTHOR_CHARS, true));
  const license = r.text(field(document, "license"), "license", MAX_LICENSE_CHARS, true);
  const engine = readEngine(r, field(document, "engine"));
  const modules = readModules(r, field(document, "modules"));

  let skills: string[] = [];
  let rulepacks: string[] = [];
  let cards: ManifestCard[] = [];
  let presentation: string | null = null;
  const contents = field(document, "contents");
  if (contents !== undefined && contents !== null) {
    if (!isRecord(contents)) r.fail("not_a_mapping", "contents");
    else {
      for (const kind of Object.keys(contents)) {
        if (UNSUPPORTED_KINDS.includes(kind)) r.fail("unsupported_kind", join("contents", kind));
        else if (!CONTENT_KINDS.includes(kind)) r.fail("unknown_kind", join("contents", kind));
      }
      skills = readPathList(r, field(contents, "skills"), "contents.skills", MAX_KIND_ENTRIES, null);
      rulepacks = readPathList(r, field(contents, "rulepacks"), "contents.rulepacks", MAX_KIND_ENTRIES, [".yaml", ".yml"]);
      cards = readCards(r, field(contents, "cards"));
      const kits = readPathList(r, field(contents, "presentation"), "contents.presentation", MAX_PRESENTATION, [".yaml", ".yml"]);
      presentation = kits[0] ?? null;
    }
  }
  const assets = readAssets(r, field(document, "assets"));

  // One file, one role: a file is named once across modules, content and assets.
  const named = new Map<string, string>();
  const claim = (file: string, path: string): void => {
    const key = file.normalize("NFC").toLowerCase();
    if (named.has(key)) r.fail("duplicate", path, file);
    else named.set(key, path);
  };
  modules.forEach((module, index) => claim(module.entry, `modules.${index}.entry`));
  skills.forEach((skill, index) => claim(`${skill}/SKILL.md`, `contents.skills.${index}`));
  rulepacks.forEach((file, index) => claim(file, `contents.rulepacks.${index}`));
  cards.forEach((card, index) => claim(card.path, `contents.cards.${index}.path`));
  if (presentation !== null) claim(presentation, "contents.presentation.0");
  assets.forEach((asset, index) => claim(asset.path, `assets.${index}.path`));
  const skillIds = new Set<string>();
  skills.forEach((skill, index) => {
    const skillId = skill.split("/").at(-1) ?? "";
    if (skillIds.has(skillId)) r.fail("duplicate", `contents.skills.${index}`, skillId);
    skillIds.add(skillId);
  });
  const systems = new Set<string>();
  rulepacks.forEach((file, index) => {
    const stem = (file.split("/").at(-1) ?? "").replace(/\.ya?ml$/iu, "");
    if (!RULE_SYSTEM_ID.test(stem)) r.fail("bad_id", `contents.rulepacks.${index}`, stem);
    if (systems.has(stem)) r.fail("duplicate", `contents.rulepacks.${index}`, stem);
    systems.add(stem);
  });

  if (r.problems.length > 0) return { ok: false, problems: r.problems };
  return {
    ok: true,
    manifest: { manifestVersion: MANIFEST_VERSION, id, version, name, description, authors, license, engine, modules, skills, rulepacks, cards, presentation, assets, ignoredKeys },
  };
}

/** Parse `pack.yaml` text. */
export function parseManifest(text: string): ManifestParse {
  if (charCount(text) > MAX_MANIFEST_BYTES) return { ok: false, problems: [{ code: "manifest_too_large", path: "" }] };
  let document: unknown;
  try {
    document = loadYaml(text);
  } catch (error) {
    if (error instanceof YamlError) return { ok: false, problems: [{ code: "bad_yaml", path: error.line === undefined ? "" : `line ${error.line}`, detail: error.code }] };
    throw error;
  }
  return checkManifest(document);
}

/** A rule system's id: its file's stem. */
export function ruleSystemId(file: string): string {
  return (file.split("/").at(-1) ?? "").replace(/\.ya?ml$/iu, "");
}

/** A skill's id: its directory's last segment. */
export function skillId(directory: string): string {
  return directory.split("/").at(-1) ?? "";
}

/** Whether `have` (a version, possibly with a suffix) is at least `want` (dotted integers). */
export function versionAtLeast(have: string, want: string): boolean {
  const lead = /^\d+(?:\.\d+)*/u.exec(have)?.[0] ?? "0";
  const a = lead.split(".").map(Number);
  const b = want.split(".").map(Number);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Text for `locale`: its language, then English, then whichever is present. */
export function localText(value: LocalText, locale: string): string {
  const short = locale.split(/[-_]/u, 1)[0] ?? "";
  if (short === "zh" && value.zh !== undefined) return value.zh;
  return value.en ?? value.zh ?? "";
}
