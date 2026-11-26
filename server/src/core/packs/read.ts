// A whole pack, validated as data: `readPack(entries)` takes the `(path, bytes)` pairs of
// an archive (or of an installed pack's directory, read back at start-up) and either
// returns the pack — every part parsed by the parser that will use it — or every problem
// found, each a stable code with the path it concerns. Pure: no filesystem, no runtime
// APIs. The pack keeps no file bytes, only what each part means and the sizes and digests
// of its files; whoever installed the files reads them again when a room needs them.
//
// Everything in a pack is untrusted until this returns `ok`:
// - every file the manifest names exists; a module entry is one bundled `.js` file;
// - nothing executable is in the pack except the declared module entries (a `hooks.js`,
//   the 2.x scripting, is not run: it is reported as ignored and never installed);
// - each rule pack compiles (`extends:` reaches the pack's own rule packs, then the
//   built-in ones), each skill parses, each card parses and is the kind it says it is, the
//   presentation kit parses and every picture and sound it names is an asset of that type;
// - every asset is an image or a sound the media store accepts, within its size limit,
//   whose bytes start the way its type starts (an SVG passes the SVG validator).
// Files the manifest does not name are ignored and reported, never installed.
import { createHash } from "node:crypto";

import { AUDIO_MIMES, DEFAULT_MEDIA_LIMITS, IMAGE_MIMES, isAudioMime, isImageMime } from "../../infra/media/policy.ts";
import { matchesSignature } from "../../infra/media/signatures.ts";
import { normalisedPath } from "../../infra/zip.ts";
import { CardError, MAX_LORECARD_FILE_BYTES, parseCard, splitCard, type CardMachinery } from "../card/index.ts";
import { parsePresentationKit, type KitProblemCode, type PresentationKit } from "../presentation/kit.ts";
import { builtInBase, compileRulePack, RulePackError, type RulePack } from "../rulepacks/index.ts";
import { parseSkillDirectory, type Skill, type SkillWarning } from "../skills/index.ts";
import { loadYaml, YamlError } from "../yaml.ts";
import {
  BUNDLED_MODULE_EXTENSION,
  type CardKind,
  type LocalText,
  type Manifest,
  type ManifestProblem,
  MAX_MANIFEST_BYTES,
  parseManifest,
  ruleSystemId,
  skillId,
} from "./manifest.ts";

/** The manifest's file name at the root of a pack. */
export const MANIFEST_FILE = "pack.yaml";
/** The largest bundled module entry. */
export const MAX_MODULE_BYTES = 16 * 1024 * 1024;
export const MAX_RULEPACK_BYTES = 512 * 1024;
export const MAX_KIT_BYTES = 128 * 1024;
/** The 2.x scripting file name: never run, reported as ignored wherever it appears. */
export const HOOKS_FILE = "hooks.js";
/** Extensions of files that are code. Only declared module entries may be code. */
export const SCRIPT_EXTENSIONS: readonly string[] = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx", ".wasm", ".node", ".sh", ".bat", ".cmd", ".ps1", ".exe", ".dll", ".so", ".dylib"];
/** Media types by extension, fixed so a pack means the same on every machine. */
export const ASSET_MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".wav", "audio/wav"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
]);

export interface PackEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface PackFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface PackModule extends PackFile {
  readonly id: string;
}

export interface PackRuleSystem extends PackFile {
  readonly id: string;
  /** The base it extends, or null. */
  readonly extends: string | null;
  readonly compiled: RulePack;
}

export interface PackSkill extends PackFile {
  readonly id: string;
  readonly skill: Skill;
}

export interface PackCard extends PackFile {
  readonly kind: CardKind;
  /** The card's own name. */
  readonly name: string;
  readonly notes: LocalText | null;
  readonly machinery: CardMachinery;
}

export interface PackAsset extends PackFile {
  readonly mime: string;
  readonly title: string;
  readonly license: string;
  readonly tags: readonly string[];
}

export interface PackKit extends PackFile {
  readonly kit: PresentationKit;
}

export type IgnoredReason =
  /** A 2.x `hooks.js`: 3.0 does not run pack scripts outside modules. */
  | "hooks_js"
  /** A file the manifest does not name. */
  | "unknown_file"
  /** A top-level manifest key this version does not define. */
  | "unknown_key";

export interface Ignored {
  readonly path: string;
  readonly reason: IgnoredReason;
}

export interface Pack {
  readonly manifest: Manifest;
  readonly modules: readonly PackModule[];
  readonly ruleSystems: readonly PackRuleSystem[];
  readonly skills: readonly PackSkill[];
  readonly cards: readonly PackCard[];
  readonly presentation: PackKit | null;
  /** Declared assets, then the kit's pictures and sounds the manifest did not list. */
  readonly assets: readonly PackAsset[];
  /** Every file the pack installs, `pack.yaml` first, then by path. */
  readonly files: readonly PackFile[];
  readonly ignored: readonly Ignored[];
  readonly skillWarnings: readonly { readonly id: string; readonly warning: SkillWarning }[];
}

export type PackCode =
  | ManifestProblem["code"]
  /** The pack has no `pack.yaml` at its root. */
  | "no_manifest"
  /** A file the manifest names is not in the pack. */
  | "missing_file"
  /** A module entry is not a bundled `.js` file (build the pack with `loreweaver pack`). */
  | "module_not_bundled"
  | "module_too_large"
  /** A text file (module, rule pack, skill, kit) is not UTF-8. */
  | "not_utf8"
  /** A code file the manifest does not declare as a module entry. */
  | "undeclared_script"
  /** A rule pack does not compile (`detail`: its error code and field). */
  | "rulepack_invalid"
  | "rulepack_too_large"
  /** A skill does not parse (`detail`: the skill error code and field). */
  | "skill_invalid"
  /** A card does not parse (`detail`: the card error code). */
  | "card_invalid"
  /** A card is not the kind the manifest says (`detail`: the kind it is). */
  | "card_kind_mismatch"
  /** The presentation kit does not parse (`detail`: its problem code and field). */
  | "presentation_invalid"
  | "presentation_too_large"
  /** A picture or sound the kit names is not in the pack. */
  | "kit_asset_missing"
  /** A kit `ref` that is not an image, or a cue `asset` that is not a sound. */
  | "kit_asset_type"
  /** An asset whose extension is not an image or sound type. */
  | "asset_type"
  /** An asset whose declared media type differs from its extension's. */
  | "asset_mime_mismatch"
  /** An asset over its type's size limit. */
  | "asset_too_large"
  /** An asset whose bytes do not start the way its type starts (or an unsafe SVG). */
  | "asset_bad_signature"
  /** An asset whose declared sha256 is not its bytes'. */
  | "asset_digest_mismatch"
  /** Two archive entries that are one file on a case-insensitive filesystem. */
  | "duplicate_file";

export interface PackProblem {
  readonly code: PackCode;
  readonly path: string;
  readonly detail?: string;
}

export type PackRead = { readonly ok: true; readonly pack: Pack } | { readonly ok: false; readonly problems: readonly PackProblem[] };

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function extensionOf(path: string): string {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

function fileOf(path: string, bytes: Uint8Array): PackFile {
  return { path, size: bytes.length, sha256: sha256Hex(bytes) };
}

function problem(code: PackCode, path: string, detail?: string): PackProblem {
  return detail === undefined ? { code, path } : { code, path, detail };
}

/** The media type of an asset path by its extension, or null for a type a pack cannot ship. */
export function assetMime(path: string): string | null {
  return ASSET_MIME_BY_EXTENSION.get(extensionOf(path)) ?? null;
}

function isScript(path: string): boolean {
  return SCRIPT_EXTENSIONS.includes(extensionOf(path));
}

/** Read and validate a whole pack from its files. */
export function readPack(entries: readonly PackEntry[]): PackRead {
  const problems: PackProblem[] = [];
  const byPath = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = normalisedPath(entry.path);
    if (seen.has(key)) problems.push(problem("duplicate_file", entry.path));
    seen.add(key);
    byPath.set(entry.path, entry.bytes);
  }
  const manifestBytes = byPath.get(MANIFEST_FILE);
  if (manifestBytes === undefined) return { ok: false, problems: [problem("no_manifest", MANIFEST_FILE)] };
  if (manifestBytes.length > MAX_MANIFEST_BYTES) return { ok: false, problems: [problem("manifest_too_large", MANIFEST_FILE)] };
  let manifestText: string;
  try {
    manifestText = UTF8.decode(manifestBytes);
  } catch {
    return { ok: false, problems: [problem("manifest_not_utf8", MANIFEST_FILE)] };
  }
  const parsed = parseManifest(manifestText);
  if (!parsed.ok) return { ok: false, problems: parsed.problems.map((item) => ({ ...item, path: item.path === "" ? MANIFEST_FILE : `${MANIFEST_FILE}:${item.path}` })) };
  const manifest = parsed.manifest;
  const used = new Set<string>([MANIFEST_FILE]);
  const files: PackFile[] = [fileOf(MANIFEST_FILE, manifestBytes)];

  const take = (path: string): Uint8Array | undefined => {
    const bytes = byPath.get(path);
    if (bytes === undefined) {
      problems.push(problem("missing_file", path));
      return undefined;
    }
    if (!used.has(path)) {
      used.add(path);
      files.push(fileOf(path, bytes));
    }
    return bytes;
  };
  const textOf = (path: string, bytes: Uint8Array): string | null => {
    try {
      return UTF8.decode(bytes);
    } catch {
      problems.push(problem("not_utf8", path));
      return null;
    }
  };

  // Modules: one bundled file each.
  const modules: PackModule[] = [];
  for (const module of manifest.modules) {
    if (!module.entry.endsWith(BUNDLED_MODULE_EXTENSION)) {
      problems.push(problem("module_not_bundled", module.entry));
      continue;
    }
    const bytes = take(module.entry);
    if (bytes === undefined) continue;
    if (bytes.length > MAX_MODULE_BYTES) {
      problems.push(problem("module_too_large", module.entry));
      continue;
    }
    if (textOf(module.entry, bytes) === null) continue;
    modules.push({ id: module.id, ...fileOf(module.entry, bytes) });
  }

  // Rule packs: compiled with the pack's own rule packs as the first `extends:` bases.
  const ruleTexts = new Map<string, string>();
  for (const file of manifest.rulepacks) {
    const bytes = take(file);
    if (bytes === undefined) continue;
    if (bytes.length > MAX_RULEPACK_BYTES) {
      problems.push(problem("rulepack_too_large", file));
      continue;
    }
    const text = textOf(file, bytes);
    if (text !== null) ruleTexts.set(ruleSystemId(file), text);
  }
  const ruleSystems: PackRuleSystem[] = [];
  for (const file of manifest.rulepacks) {
    const id = ruleSystemId(file);
    const text = ruleTexts.get(id);
    if (text === undefined) continue;
    try {
      const compiled = compileRulePack(id, text, { bases: (base) => (base === id ? builtInBase(base) : (ruleTexts.get(base) ?? builtInBase(base))) });
      const document = loadYaml(text) as Record<string, unknown> | null;
      const base = document !== null && typeof document === "object" && typeof document.extends === "string" ? document.extends.trim() : null;
      ruleSystems.push({ id, extends: base, compiled, ...fileOf(file, byPath.get(file) as Uint8Array) });
    } catch (error) {
      if (error instanceof RulePackError) problems.push(problem("rulepack_invalid", file, `${error.code}${error.layerCode === undefined || error.layerCode === error.code ? "" : `/${error.layerCode}`}@${error.path}`));
      else if (error instanceof YamlError) problems.push(problem("rulepack_invalid", file, `BAD_YAML/${error.code}`));
      else throw error;
    }
  }

  // Skills: a directory holding SKILL.md (a `hooks.js` beside it is ignored).
  const skills: PackSkill[] = [];
  const skillWarnings: { id: string; warning: SkillWarning }[] = [];
  for (const directory of manifest.skills) {
    const file = `${directory}/SKILL.md`;
    const bytes = take(file);
    if (bytes === undefined) continue;
    const text = textOf(file, bytes);
    if (text === null) continue;
    const prefix = `${directory}/`;
    const names = [...byPath.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/")).map((path) => path.slice(prefix.length));
    const id = skillId(directory);
    const parsedSkill = parseSkillDirectory({ id, files: names, skillFile: text });
    if (!parsedSkill.ok) {
      problems.push(problem("skill_invalid", file, `${parsedSkill.code}${parsedSkill.path === undefined ? "" : `@${parsedSkill.path}`}`));
      continue;
    }
    for (const warning of parsedSkill.warnings) skillWarnings.push({ id, warning });
    skills.push({ id, skill: parsedSkill.skill, ...fileOf(file, bytes) });
  }

  // Cards: each parses, and is the kind the manifest says.
  const cards: PackCard[] = [];
  for (const card of manifest.cards) {
    const bytes = take(card.path);
    if (bytes === undefined) continue;
    if (bytes.length > MAX_LORECARD_FILE_BYTES) {
      problems.push(problem("card_invalid", card.path, "file_too_large"));
      continue;
    }
    try {
      const imported = parseCard(bytes, card.path.split("/").at(-1) ?? "");
      const split = splitCard(imported);
      if (split.kind !== card.kind) {
        problems.push(problem("card_kind_mismatch", card.path, split.kind));
        continue;
      }
      cards.push({ kind: card.kind, name: imported.card.name, notes: card.notes, machinery: split.machinery, ...fileOf(card.path, bytes) });
    } catch (error) {
      if (error instanceof CardError) problems.push(problem("card_invalid", card.path, error.code));
      else throw error;
    }
  }

  // The presentation kit, and the pictures and sounds it names.
  let presentation: PackKit | null = null;
  const kitAssets = new Map<string, "image" | "audio">();
  if (manifest.presentation !== null) {
    const file = manifest.presentation;
    const bytes = take(file);
    if (bytes !== undefined) {
      if (bytes.length > MAX_KIT_BYTES) problems.push(problem("presentation_too_large", file));
      else {
        const text = textOf(file, bytes);
        if (text !== null) {
          let raw: unknown;
          let readable = true;
          try {
            raw = loadYaml(text);
          } catch (error) {
            if (!(error instanceof YamlError)) throw error;
            problems.push(problem("presentation_invalid", file, `bad_yaml/${error.code}`));
            readable = false;
          }
          if (readable) {
            const kit = parsePresentationKit(raw);
            if (!kit.ok) problems.push(problem("presentation_invalid", file, `${kit.code satisfies KitProblemCode}@${kit.path}`));
            else {
              presentation = { kit: kit.kit, ...fileOf(file, bytes) };
              for (const subject of kit.kit.subjects) if (subject.ref !== null) kitAssets.set(subject.ref, "image");
              for (const cue of kit.kit.audio) kitAssets.set(cue.asset, "audio");
            }
          }
        }
      }
    }
  }

  // Assets: the declared ones, then the kit's that the manifest did not list.
  const assets: PackAsset[] = [];
  const declared = new Map(manifest.assets.map((asset) => [asset.path, asset]));
  const assetPaths = [...manifest.assets.map((asset) => asset.path), ...[...kitAssets.keys()].filter((path) => !declared.has(path))];
  for (const path of assetPaths) {
    const record = declared.get(path);
    const wanted = kitAssets.get(path);
    if (!byPath.has(path)) {
      problems.push(problem(record === undefined ? "kit_asset_missing" : "missing_file", path));
      continue;
    }
    const mime = assetMime(path);
    if (mime === null || !(isImageMime(mime) || isAudioMime(mime))) {
      problems.push(problem(wanted === undefined ? "asset_type" : "kit_asset_type", path));
      continue;
    }
    if (record?.mime !== null && record?.mime !== undefined && record.mime !== mime) {
      problems.push(problem("asset_mime_mismatch", path, mime));
      continue;
    }
    if ((wanted === "image" && !isImageMime(mime)) || (wanted === "audio" && !isAudioMime(mime))) {
      problems.push(problem("kit_asset_type", path, mime));
      continue;
    }
    const bytes = take(path) as Uint8Array;
    const limit = isImageMime(mime) ? DEFAULT_MEDIA_LIMITS.image.maxFileBytes : DEFAULT_MEDIA_LIMITS.audio.maxFileBytes;
    if (bytes.length === 0 || bytes.length > limit) {
      problems.push(problem("asset_too_large", path));
      continue;
    }
    if (!matchesSignature(mime as (typeof IMAGE_MIMES)[number] | (typeof AUDIO_MIMES)[number], bytes)) {
      problems.push(problem("asset_bad_signature", path, mime));
      continue;
    }
    const file = fileOf(path, bytes);
    if (record?.sha256 !== null && record?.sha256 !== undefined && record.sha256 !== file.sha256) {
      problems.push(problem("asset_digest_mismatch", path));
      continue;
    }
    assets.push({ ...file, mime, title: record?.title ?? "", license: record?.license ?? "", tags: record?.tags ?? [] });
  }

  // Everything else: a `hooks.js` is ignored, code is refused, the rest is ignored.
  const ignored: Ignored[] = manifest.ignoredKeys.map((key) => ({ path: `${MANIFEST_FILE}:${key}`, reason: "unknown_key" }));
  for (const path of [...byPath.keys()].sort()) {
    if (used.has(path)) continue;
    const name = path.split("/").at(-1) ?? "";
    if (name === HOOKS_FILE) ignored.push({ path, reason: "hooks_js" });
    else if (isScript(path)) problems.push(problem("undeclared_script", path));
    else ignored.push({ path, reason: "unknown_file" });
  }

  if (problems.length > 0) return { ok: false, problems };
  const [manifestFile, ...rest] = files;
  const sortedFiles = [manifestFile as PackFile, ...rest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))];
  return { ok: true, pack: { manifest, modules, ruleSystems, skills, cards, presentation, assets, files: sortedFiles, ignored, skillWarnings } };
}
