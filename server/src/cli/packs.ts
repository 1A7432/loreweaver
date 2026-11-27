// The operator's pack commands, and loading the installed packs at start-up.
//
//   build      a source tree with a `pack.yaml` → one `.lwpack`: each module's entry and
//              everything it imports bundled into one file, the result validated as a whole
//              pack, the archive written deterministically (same tree, same bytes);
//   install    a local path, an https URL or `gh:owner/repo[@tag]` → validated, its trust card
//              shown, and with `yes` unpacked under `<dataDir>/packs/<id>/<version>/` and
//              listed in the index. Installing enables nothing anywhere. The version already
//              installed is refused unless `force` (the shell's `--force`) asks to replace it;
//   list / uninstall;
//   load       every installed pack read back from disk and validated again (start-up): one
//              that no longer validates is skipped with a note, never a crash.
//
// A room's admin may install from chat as well (`pack install`, decision 45); both paths
// share one installer (`../gateway/pack_install.ts`). A pack installed from chat joins the
// running server at once. One installed or uninstalled HERE, from the shell, is seen by a
// running server only when it next starts.
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";

import { MANIFEST_FILE, MAX_MANIFEST_BYTES, parseManifest, readPack, sha256Hex, trustCard, type Pack, type PackEntry, type PackProblem, type TrustCard } from "../core/packs/index.ts";
import { parsePanels } from "../core/panels/index.ts";
import { parsePresentationKit } from "../core/presentation/kit.ts";
import { loadYaml } from "../core/yaml.ts";
import { installArchive, type InstallOutcome } from "../gateway/pack_install.ts";
import { fetchPackSource, type FetchLike } from "../infra/packs/fetch.ts";
import { confinedPath, hasConfinedFile, PackDirectory, readConfined } from "../infra/packs/files.ts";
import { bundleModule } from "../infra/runtime/bundle.ts";
import { MAX_ENTRY_BYTES, writeZip } from "../infra/zip.ts";

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
  const modules: { id: string; entry: string; options?: unknown }[] = [];
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
    modules.push(Object.keys(module.options).length === 0 ? { id: module.id, entry: target } : { id: module.id, entry: target, options: module.options });
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

export type { InstallOutcome, Shadowed } from "../gateway/pack_install.ts";
export { loadInstalledPacks } from "../gateway/pack_install.ts";

export interface InstallOptions {
  readonly yes: boolean;
  /** Replace an installed pack of the same id and version. The shell only: a room's `pack install` never forces. */
  readonly force?: boolean;
  readonly fetch: FetchLike;
  readonly now?: () => number;
}

/** Fetch, validate, disclose — and with `yes`, install (`installArchive`, the room command's installer too). */
export async function installPack(dataDir: string, ref: string, options: InstallOptions): Promise<InstallOutcome> {
  const source = await fetchPackSource(ref, { fetch: options.fetch });
  if (!source.ok) return source.detail === undefined ? { ok: false, code: source.code } : { ok: false, code: source.code, detail: source.detail };
  const force = options.force === true;
  return installArchive(dataDir, source.bytes, options.now === undefined ? { yes: options.yes, force } : { yes: options.yes, force, now: options.now });
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
