// Installing a pack into a data directory, and reading installed packs back — the one
// implementation behind both callers: the operator's shell (`loreweaver install`, which
// fetches the archive and then calls `installArchive`) and a room admin's `pack install`
// (which fetches outside the room's lock, then calls it through `RoomPacks.install`).
//
// `installArchive` is synchronous on purpose: from the archive's bytes to the index on
// disk nothing waits, so two installs can never interleave between reading the index and
// writing it. The archive reader's and `readPack`'s checks are the same for both callers:
// who may install is the caller's business, what a pack may contain is not.
import { join } from "node:path";

import { PROTOCOL_VERSION } from "loreweaver-protocol/v3";

import { MANIFEST_FILE, MAX_MANIFEST_BYTES, parseManifest, readPack, ruleSystemId, sha256Hex, skillId, trustCard, versionAtLeast, type PackProblem, type TrustCard } from "../core/packs/index.ts";
import { builtInPackIds } from "../core/rulepacks/index.ts";
import { builtInSkillIds } from "../core/skills/index.ts";
import { type IndexEntry, PackDirectory, readConfined } from "../infra/packs/files.ts";
import { SERVER_VERSION } from "../infra/version.ts";
import { MAX_ENTRY_BYTES, readZip } from "../infra/zip.ts";
import type { LoadedPack } from "./packs.ts";

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

export interface ArchiveOptions {
  readonly yes: boolean;
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

/** Validate an archive's bytes, disclose — and with `yes`, install it under `<dataDir>/packs/`. */
export function installArchive(dataDir: string, archive: Uint8Array, options: ArchiveOptions): InstallOutcome {
  const zip = readZip(archive);
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
  const sha256 = sha256Hex(archive);
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

/**
 * One installed pack read back from disk and validated again — what is on disk is as
 * untrusted as the archive was — or the note saying why not
 * (`pack_unreadable:<id>@<version>:<code>`, `pack_invalid:<id>@<version>:<code>`,
 * `pack_mismatch:<id>@<version>`).
 */
export function loadInstalledPack(directory: PackDirectory, entry: IndexEntry): { readonly ok: true; readonly pack: LoadedPack } | { readonly ok: false; readonly note: string } {
  const label = `${entry.id}@${entry.version}`;
  const files = directory.read(entry.id, entry.version);
  if (!files.ok) return { ok: false, note: `pack_unreadable:${label}:${files.code}` };
  const read = readPack(files.entries);
  if (!read.ok) return { ok: false, note: `pack_invalid:${label}:${read.problems[0]?.code ?? "unknown"}` };
  if (read.pack.manifest.id !== entry.id || read.pack.manifest.version !== entry.version) return { ok: false, note: `pack_mismatch:${label}` };
  const home = directory.home(entry.id, entry.version);
  return {
    ok: true,
    pack: {
      pack: read.pack,
      trust: trustCard(read.pack),
      filePath: (path) => join(home, ...path.split("/")),
      read: (path) => {
        const file = readConfined(home, path, MAX_ENTRY_BYTES);
        return Promise.resolve(file.ok ? file.bytes : null);
      },
    },
  };
}

/**
 * Every installed pack, in install order. One that does not validate is left out with a
 * note (see `loadInstalledPack`; `pack_index_unreadable` for a damaged index).
 */
export function loadInstalledPacks(dataDir: string): { readonly packs: readonly LoadedPack[]; readonly notes: readonly string[] } {
  const directory = new PackDirectory(dataDir);
  const index = directory.index();
  if (!index.ok) return { packs: [], notes: ["pack_index_unreadable"] };
  const packs: LoadedPack[] = [];
  const notes: string[] = [];
  for (const entry of index.entries) {
    const loaded = loadInstalledPack(directory, entry);
    if (loaded.ok) packs.push(loaded.pack);
    else notes.push(loaded.note);
  }
  return { packs, notes };
}
