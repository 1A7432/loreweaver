// The operator's pack commands, and loading the installed packs at start-up.
//
//   build      a source tree with a `pack.yaml` → one `.lwpack`: each module's entry and
//              everything it imports bundled into one file, the result validated as a whole
//              pack, the archive written deterministically (same tree, same bytes);
//   install    a local path, an https URL or `gh:owner/repo[@tag]` → validated, its trust card
//              shown, and with `yes` unpacked under `<dataDir>/packs/<id>/<version>/` and
//              listed in the index. Installing enables nothing anywhere;
//   list / uninstall;
//   load       every installed pack read back from disk and validated again (start-up): one
//              that no longer validates is skipped with a note, never a crash.
//
// Installing is the OPERATOR's action, from the shell only: a pack's modules run as real
// code in the server's process, with no sandbox (decisions 1–4), so which code the server
// runs is decided by whoever runs the server. Room admins enable what is installed.
// Installed packs are loaded when the server starts: restart it after installing or
// uninstalling.
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";

import { PROTOCOL_VERSION } from "loreweaver-protocol/v3";

import { MANIFEST_FILE, MAX_MANIFEST_BYTES, parseManifest, readPack, ruleSystemId, sha256Hex, skillId, trustCard, versionAtLeast, type Pack, type PackEntry, type PackProblem, type TrustCard } from "../core/packs/index.ts";
import { builtInPackIds } from "../core/rulepacks/index.ts";
import { builtInSkillIds } from "../core/skills/index.ts";
import { parsePanels } from "../core/panels/index.ts";
import { parsePresentationKit } from "../core/presentation/kit.ts";
import { loadYaml } from "../core/yaml.ts";
import type { LoadedPack } from "../gateway/packs.ts";
import { fetchPackSource, type FetchLike } from "../infra/packs/fetch.ts";
import { confinedPath, hasConfinedFile, type IndexEntry, PackDirectory, readConfined } from "../infra/packs/files.ts";
import { bundleModule } from "../infra/runtime/bundle.ts";
import { SERVER_VERSION } from "../infra/version.ts";
import { MAX_ENTRY_BYTES, readZip, writeZip } from "../infra/zip.ts";

/** Where a built module lands inside the archive. */
export function bundledEntry(moduleId: string): string {
  return `modules/${moduleId}.js`;
}

export type BuildOutcome =
  | { readonly ok: true; readonly out: string; readonly sha256: string; readonly bytes: number; readonly trust: TrustCard; readonly ignored: readonly string[] }
  | { readonly ok: false; readonly code: string; readonly path?: string; readonly detail?: string; readonly problems?: readonly PackProblem[] };

function pathOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The archive of a validated pack: `pack.yaml` first, then every file in path order. */
function archive(entries: ReadonlyMap<string, Uint8Array>, pack: Pack): Uint8Array {
  const paths = pack.files.map((file) => file.path).filter((path) => path !== MANIFEST_FILE).sort(pathOrder);
  return writeZip([MANIFEST_FILE, ...paths].map((path) => ({ path, bytes: entries.get(path) as Uint8Array })));
}

/** Build `sourceDir` into a `.lwpack`. `out` defaults to `<id>-<version>.lwpack` in `cwd`. */
export async function buildPack(sourceDir: string, options: { readonly out?: string; readonly cwd?: string } = {}): Promise<BuildOutcome> {
  let root: string;
  try {
    root = realpathSync(sourceDir);
  } catch {
    return { ok: false, code: "source_not_found" };
  }
  const manifestFile = readConfined(root, MANIFEST_FILE, MAX_MANIFEST_BYTES);
  if (!manifestFile.ok) return { ok: false, code: manifestFile.code === "not_found" ? "no_manifest" : manifestFile.code, path: MANIFEST_FILE };
  const manifestText = new TextDecoder().decode(manifestFile.bytes);
  const parsed = parseManifest(manifestText);
  if (!parsed.ok) return { ok: false, code: "invalid_manifest", problems: parsed.problems.map((item) => ({ ...item, path: item.path === "" ? MANIFEST_FILE : `${MANIFEST_FILE}:${item.path}` })) };
  const manifest = parsed.manifest;
  const files = new Map<string, Uint8Array>();
  const ignored: string[] = [];
  const read = (path: string): BuildOutcome | null => {
    if (files.has(path)) return null;
    const file = readConfined(root, path, MAX_ENTRY_BYTES);
    // A file that is simply not there is the whole-pack check's to report, with its code.
    if (!file.ok) return file.code === "not_found" ? null : { ok: false, code: file.code, path };
    files.set(path, file.bytes);
    return null;
  };

  // Modules: each entry and what it imports, as one file.
  const modules: { id: string; entry: string }[] = [];
  for (const module of manifest.modules) {
    if (!hasConfinedFile(root, module.entry)) return { ok: false, code: "missing_file", path: module.entry };
    const entry = readConfined(root, module.entry, MAX_ENTRY_BYTES);
    if (!entry.ok) return { ok: false, code: entry.code, path: module.entry };
    const confined = confinedPath(root, module.entry);
    if (!confined.ok) return { ok: false, code: confined.code, path: module.entry };
    const bundled = await bundleModule(confined.path, root);
    if (!bundled.ok) return { ok: false, code: bundled.code, path: module.entry, detail: bundled.detail };
    const target = bundledEntry(module.id);
    files.set(target, new TextEncoder().encode(bundled.code));
    modules.push({ id: module.id, entry: target });
  }
  for (const directory of manifest.skills) {
    const failed = read(`${directory}/SKILL.md`);
    if (failed !== null) return failed;
    if (hasConfinedFile(root, `${directory}/hooks.js`)) ignored.push(`${directory}/hooks.js`);
  }
  for (const path of [...manifest.rulepacks, ...manifest.cards.map((card) => card.path), ...manifest.assets.map((asset) => asset.path)]) {
    const failed = read(path);
    if (failed !== null) return failed;
  }
  if (manifest.presentation !== null) {
    const failed = read(manifest.presentation);
    if (failed !== null) return failed;
    // The pictures and sounds the kit names travel with it, listed or not.
    const kitBytes = files.get(manifest.presentation);
    if (kitBytes !== undefined) {
      try {
        const kit = parsePresentationKit(loadYaml(new TextDecoder().decode(kitBytes)));
        if (kit.ok) {
          for (const path of [...kit.kit.subjects.flatMap((subject) => (subject.ref === null ? [] : [subject.ref])), ...kit.kit.audio.map((cue) => cue.asset)]) {
            const kitFailed = read(path);
            if (kitFailed !== null) return kitFailed;
          }
        }
      } catch {
        // The whole-pack check reports a kit that does not read.
      }
    }
  }

  // Panels files, and what their panels name: a page's HTML and the pictures, listed or not.
  for (const file of manifest.panels) {
    const failed = read(file);
    if (failed !== null) return failed;
    const bytes = files.get(file);
    if (bytes === undefined) continue;
    const parsed = parsePanels(new TextDecoder().decode(bytes));
    // The whole-pack check reports a panels file that does not read.
    if (!parsed.ok) continue;
    for (const panel of parsed.panels) {
      for (const path of [...(panel.entry === null ? [] : [panel.entry]), ...panel.images]) {
        const panelFailed = read(path);
        if (panelFailed !== null) return panelFailed;
      }
    }
  }

  // The archive's manifest: the author's, with each module entry pointing at its bundle.
  const document = loadYaml(manifestText) as Record<string, unknown>;
  if (modules.length > 0) document.modules = modules;
  files.set(MANIFEST_FILE, new TextEncoder().encode(stringify(document)));

  const entries: PackEntry[] = [...files].map(([path, bytes]) => ({ path, bytes }));
  const checked = readPack(entries);
  if (!checked.ok) return { ok: false, code: "invalid_pack", problems: checked.problems };
  const bytes = archive(files, checked.pack);
  const out = options.out ?? join(options.cwd ?? process.cwd(), `${manifest.id}-${manifest.version}.lwpack`);
  try {
    writeFileSync(out, bytes);
  } catch {
    return { ok: false, code: "unwritable_output", path: out };
  }
  return { ok: true, out, sha256: sha256Hex(bytes), bytes: bytes.length, trust: trustCard(checked.pack), ignored };
}

/** What installing would shadow: ids an earlier claimant (a built-in or a pack installed before) keeps. */
export interface Shadowed {
  readonly ruleSystems: readonly string[];
  readonly skills: readonly string[];
}

export type InstallOutcome =
  | {
      readonly ok: true;
      /** False: the trust card is shown and nothing was written (pass `yes` to install). */
      readonly installed: boolean;
      readonly id: string;
      readonly version: string;
      readonly sha256: string;
      readonly trust: TrustCard;
      readonly shadowed: Shadowed;
      /** The version this install replaced, or null. */
      readonly replaced: string | null;
    }
  | { readonly ok: false; readonly code: string; readonly path?: string; readonly detail?: string; readonly problems?: readonly PackProblem[] };

export interface InstallOptions {
  readonly yes: boolean;
  readonly fetch: FetchLike;
  readonly now?: () => number;
}

/** The rule-system and skill ids an installed pack claims, read from its manifest. */
function claimsOf(directory: PackDirectory, entry: IndexEntry): { readonly ruleSystems: readonly string[]; readonly skills: readonly string[] } {
  const file = readConfined(directory.home(entry.id, entry.version), MANIFEST_FILE, MAX_MANIFEST_BYTES);
  if (!file.ok) return { ruleSystems: [], skills: [] };
  const parsed = parseManifest(new TextDecoder().decode(file.bytes));
  if (!parsed.ok) return { ruleSystems: [], skills: [] };
  return { ruleSystems: parsed.manifest.rulepacks.map(ruleSystemId), skills: parsed.manifest.skills.map(skillId) };
}

/** Fetch, validate, disclose — and with `yes`, install. */
export async function installPack(dataDir: string, ref: string, options: InstallOptions): Promise<InstallOutcome> {
  const source = await fetchPackSource(ref, { fetch: options.fetch });
  if (!source.ok) return source.detail === undefined ? { ok: false, code: source.code } : { ok: false, code: source.code, detail: source.detail };
  const zip = readZip(source.bytes);
  if (!zip.ok) return { ok: false, code: `zip_${zip.code}`, ...(zip.path === undefined ? {} : { path: zip.path }), ...(zip.detail === undefined ? {} : { detail: zip.detail }) };
  const read = readPack(zip.entries);
  if (!read.ok) return { ok: false, code: "invalid_pack", problems: read.problems };
  const pack = read.pack;
  const { id, version, engine } = pack.manifest;
  if (engine.protocol !== null && !versionAtLeast(PROTOCOL_VERSION, engine.protocol)) return { ok: false, code: "engine_too_old", detail: `protocol ${engine.protocol}` };
  if (engine.server !== null && !versionAtLeast(SERVER_VERSION, engine.server)) return { ok: false, code: "engine_too_old", detail: `server ${engine.server}` };
  const directory = new PackDirectory(dataDir);
  const index = directory.index();
  if (!index.ok) return { ok: false, code: index.code };
  const previous = index.entries.find((entry) => entry.id === id) ?? null;
  if (previous !== null && previous.version === version) return { ok: false, code: "already_installed", detail: `${id}@${version}` };

  // First claim wins: the built-ins, then the packs installed before this one.
  const earlier = index.entries.filter((entry) => entry.id !== id).map((entry) => claimsOf(directory, entry));
  const takenSystems = new Set([...builtInPackIds(), ...earlier.flatMap((claims) => claims.ruleSystems)]);
  const takenSkills = new Set([...builtInSkillIds(), ...earlier.flatMap((claims) => claims.skills)]);
  const shadowed: Shadowed = {
    ruleSystems: pack.ruleSystems.map((system) => system.id).filter((system) => takenSystems.has(system)),
    skills: pack.skills.map((skill) => skill.id).filter((skill) => takenSkills.has(skill)),
  };
  const sha256 = sha256Hex(source.bytes);
  const result = { ok: true as const, id, version, sha256, trust: trustCard(pack), shadowed, replaced: previous?.version ?? null };
  if (!options.yes) return { ...result, installed: false };
  const bytes = new Map(zip.entries.map((entry) => [entry.path, entry.bytes]));
  try {
    directory.install(
      { id, version, sha256, installedAt: (options.now ?? Date.now)() },
      pack.files.map((file) => ({ path: file.path, bytes: bytes.get(file.path) as Uint8Array })),
      index.entries,
    );
  } catch (error) {
    return { ok: false, code: "install_failed", detail: error instanceof Error ? error.message : String(error) };
  }
  return { ...result, installed: true };
}

export interface ListedPack {
  readonly id: string;
  readonly version: string;
  readonly name: { readonly en?: string; readonly zh?: string };
  readonly sha256: string;
  readonly installedAt: number;
}

export function listPacks(dataDir: string): { readonly ok: true; readonly packs: readonly ListedPack[] } | { readonly ok: false; readonly code: string } {
  const directory = new PackDirectory(dataDir);
  const index = directory.index();
  if (!index.ok) return { ok: false, code: index.code };
  return {
    ok: true,
    packs: index.entries.map((entry) => {
      const file = readConfined(directory.home(entry.id, entry.version), MANIFEST_FILE, MAX_MANIFEST_BYTES);
      const parsed = file.ok ? parseManifest(new TextDecoder().decode(file.bytes)) : null;
      return { id: entry.id, version: entry.version, name: parsed?.ok === true ? parsed.manifest.name : {}, sha256: entry.sha256, installedAt: entry.installedAt };
    }),
  };
}

export function uninstallPack(dataDir: string, id: string): { readonly ok: true; readonly id: string } | { readonly ok: false; readonly code: string } {
  const directory = new PackDirectory(dataDir);
  const index = directory.index();
  if (!index.ok) return { ok: false, code: index.code };
  return directory.uninstall(id, index.entries) ? { ok: true, id } : { ok: false, code: "not_installed" };
}

/**
 * Every installed pack, read back from disk and validated again — what is on disk is as
 * untrusted as the archive was. One that does not validate is left out with a note
 * (`pack_index_unreadable`, `pack_unreadable:<id>@<version>:<code>`,
 * `pack_invalid:<id>@<version>:<code>`, `pack_mismatch:<id>@<version>`).
 */
export function loadInstalledPacks(dataDir: string): { readonly packs: readonly LoadedPack[]; readonly notes: readonly string[] } {
  const directory = new PackDirectory(dataDir);
  const index = directory.index();
  if (!index.ok) return { packs: [], notes: ["pack_index_unreadable"] };
  const packs: LoadedPack[] = [];
  const notes: string[] = [];
  for (const entry of index.entries) {
    const label = `${entry.id}@${entry.version}`;
    const files = directory.read(entry.id, entry.version);
    if (!files.ok) {
      notes.push(`pack_unreadable:${label}:${files.code}`);
      continue;
    }
    const read = readPack(files.entries);
    if (!read.ok) {
      notes.push(`pack_invalid:${label}:${read.problems[0]?.code ?? "unknown"}`);
      continue;
    }
    if (read.pack.manifest.id !== entry.id || read.pack.manifest.version !== entry.version) {
      notes.push(`pack_mismatch:${label}`);
      continue;
    }
    const home = directory.home(entry.id, entry.version);
    packs.push({
      pack: read.pack,
      trust: trustCard(read.pack),
      filePath: (path) => join(home, ...path.split("/")),
      read: (path) => {
        const file = readConfined(home, path, MAX_ENTRY_BYTES);
        return Promise.resolve(file.ok ? file.bytes : null);
      },
    });
  }
  return { packs, notes };
}
