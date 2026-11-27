// Installed packs, as the rooms see them. The operator installs packs from the shell, a
// room's admin from chat (`pack install`, which also enables the pack in that room); a
// room's admin enables and disables them (`pack` command, the `room.packs_enabled` room
// setting). Enabling a pack in a room makes, for that room only:
//
// - its modules load in the room's worker (`modulesFor`: the installed entry files, in the
//   order the packs were enabled; the hub restarts the worker when the list changes);
// - its presentation kit part of the room's kit (`kitFor` → `mergeRoomKit`), the pictures
//   and sounds the kit names registered as the room's unlisted media (audience `members`),
//   so the byte channel serves them to members of that room and to nobody else;
// - its skills available to the room's `skill` command (enabling a skill stays a step of
//   its own);
// - its cards importable with `import {pack, card, as}`;
// - its panels part of the room's `panels` view (each on unless the admin switched it off
//   with `panels disable`, the `room.panels_off` room setting), the pictures they name and
//   each page's HTML registered as the room's unlisted media like the kit's — a page that
//   only admins are listed is fetchable by admins only.
//
// A pack's rule systems are not per room: they join the server's rule-system registry at
// start-up (`assemblePacks`), chosen per room with `rule system`. Clashes are settled by
// FIRST CLAIM: the built-in rule systems and skills are added first, then the installed
// packs in the order they were installed; an id already claimed is not replaced, and the
// pack's own part is left out and named in a start-up note — a built-in is never replaced,
// silently or otherwise.
//
// A pack installed from chat joins the RUNNING server (`RoomPacks.install`): it is added to
// the installed packs (a new version in its old version's place), the two registries are
// assembled again by the same rule and swapped in place (`adopt`), and every room that has
// the pack enabled is told to reload its worker (`onInstalled`) — the new version takes
// effect for a room at that reload, and a room that did not enable it is not touched.
// Installing or uninstalling from the shell while the server runs is seen at its next start.
import type { InstalledKit, KitAsset, RoomKit } from "../agent/lanes/presentation.ts";
import { mergeRoomKit } from "../agent/lanes/presentation.ts";
import type { PanelEntry, Role } from "loreweaver-protocol/v3";

import type { Pack, PackAsset, PackPanel, TrustCard } from "../core/packs/index.ts";
import { panelAdminOnly, panelEntry, type PanelFile, panelListedTo } from "../core/panels/index.ts";
import { builtInPacks, type RulePack, RulePackRegistry } from "../core/rulepacks/index.ts";
import { builtInSkills, type Skill, SkillRegistry } from "../core/skills/index.ts";
import type { MediaStore } from "../infra/media/index.ts";
import { fetchPackSource, type FetchLike, type PackSource } from "../infra/packs/fetch.ts";
import { PackDirectory } from "../infra/packs/files.ts";
import type { Store } from "../infra/store.ts";
import type { Audience } from "../infra/media/index.ts";
import { MAX_ENABLED_PACKS, ROOM_PACKS, ROOM_PANELS_OFF } from "./commands/state.ts";
import { installArchive, type InstallOutcome, loadInstalledPack } from "./pack_install.ts";

/** An installed pack the server loaded and validated at start-up. */
export interface LoadedPack {
  readonly pack: Pack;
  readonly trust: TrustCard;
  /** The absolute path of one of the pack's installed files. */
  filePath(path: string): string;
  /** One of the pack's installed files; null when it cannot be read. */
  read(path: string): Promise<Uint8Array | null>;
}

/** Where a skill a room can enable comes from. */
export interface AvailableSkill {
  readonly skill: Skill;
  /** `null` for a built-in skill, else the pack id. */
  readonly pack: string | null;
}

export interface AssembledPacks {
  readonly ruleSystems: RulePackRegistry;
  readonly skills: SkillRegistry;
  /** Start-up notes, as stable codes: `rule_system_shadowed:<pack>:<id>`, `skill_shadowed:<pack>:<id>` (`skill_not_loaded` past the registry's cap). */
  readonly notes: readonly string[];
}

/**
 * The server's rule-system and skill registries: the built-ins, then every installed pack's
 * in install order, first claim winning (see the file header).
 */
export function assemblePacks(packs: readonly LoadedPack[], base: { readonly ruleSystems?: readonly RulePack[]; readonly skills?: readonly Skill[] } = {}): AssembledPacks {
  const notes: string[] = [];
  const systems: RulePack[] = [...(base.ruleSystems ?? builtInPacks())];
  const claimed = new Set(systems.map((system) => system.id));
  for (const loaded of packs) {
    for (const system of loaded.pack.ruleSystems) {
      if (claimed.has(system.id)) {
        notes.push(`rule_system_shadowed:${loaded.pack.manifest.id}:${system.id}`);
        continue;
      }
      claimed.add(system.id);
      systems.push(system.compiled);
    }
  }
  const skills = new SkillRegistry(base.skills ?? builtInSkills()).with(packs.flatMap((loaded) => loaded.pack.skills.map((entry) => entry.skill))).registry;
  for (const loaded of packs) {
    for (const entry of loaded.pack.skills) {
      const holder = skills.get(entry.id);
      if (holder !== entry.skill) notes.push(`${holder === null ? "skill_not_loaded" : "skill_shadowed"}:${loaded.pack.manifest.id}:${entry.id}`);
    }
  }
  return { ruleSystems: new RulePackRegistry(systems), skills, notes };
}

/** The asset a kit path resolves to, by content hash as clients fetch it. */
function kitAsset(asset: PackAsset): KitAsset {
  return { hash: asset.sha256, mime: asset.mime, size: asset.size };
}

/** The kit assets of a pack: the files its presentation kit names. */
function kitAssetsOf(pack: Pack): readonly PackAsset[] {
  const kit = pack.presentation?.kit;
  if (kit === undefined) return [];
  const named = new Set<string>([...kit.subjects.flatMap((subject) => (subject.ref === null ? [] : [subject.ref])), ...kit.audio.map((cue) => cue.asset)]);
  return pack.assets.filter((asset) => named.has(asset.path));
}

/** One panel of a pack the room enabled, with its wire id and whether the room has it on. */
export interface RoomPanel {
  readonly loaded: LoadedPack;
  readonly panel: PackPanel;
  /** `<pack>/<panel>`. */
  readonly id: string;
  readonly on: boolean;
}

/** The files a panel names, by pack path, as a client fetches them. */
function panelFiles(pack: Pack): ReadonlyMap<string, PanelFile> {
  return new Map(pack.assets.map((asset) => [asset.path, { sha256: asset.sha256, size: asset.size, mime: asset.mime }]));
}

/** Installing from chat: where packs are installed and how a reference is fetched. */
export interface RuntimeInstall {
  /** The server's data directory (packs land under `<dataDir>/packs/`). */
  readonly dataDir: string;
  /** How an https URL or a `gh:` release is fetched (tests inject their own). */
  readonly fetch: FetchLike;
  readonly now?: () => number;
}

export interface RoomPacksOptions {
  /** The installed packs, in install order. */
  readonly packs: readonly LoadedPack[];
  /** The server's skill registry (built-ins first, then installed packs'). */
  readonly skills: SkillRegistry;
  /**
   * The server's rule-system registry — the one `Services` holds (built-ins first, then
   * installed packs'). Default: assembled here from the built-ins and `packs`.
   */
  readonly ruleSystems?: RulePackRegistry;
  /** Where kit assets become room media; absent: kits name no stored assets. */
  readonly media?: MediaStore | null;
  readonly report?: (room: string, text: string) => void;
  /** Installing from chat (`pack install`); absent: refused with `install_unavailable`. */
  readonly install?: RuntimeInstall;
}

/** What `RoomPacks.install` did: the installer's outcome, and the newly loaded pack when it installed. */
export type RuntimeInstallOutcome =
  | (Extract<InstallOutcome, { ok: true }> & { readonly loaded: LoadedPack })
  | Extract<InstallOutcome, { ok: false }>;

export class RoomPacks {
  #packs: readonly LoadedPack[];
  #byId: ReadonlyMap<string, LoadedPack>;
  readonly #skills: SkillRegistry;
  readonly #ruleSystems: RulePackRegistry;
  /** What the registries hold that no installed pack brought: the built-ins, kept first on every re-assembly. */
  readonly #base: { readonly ruleSystems: readonly RulePack[]; readonly skills: readonly Skill[] };
  readonly #media: MediaStore | null;
  readonly #report: (room: string, text: string) => void;
  readonly #reported = new Set<string>();
  readonly #install: RuntimeInstall | null;
  readonly #listeners: ((id: string) => void)[] = [];

  constructor(options: RoomPacksOptions) {
    this.#packs = options.packs;
    this.#byId = new Map(options.packs.map((loaded) => [loaded.pack.manifest.id, loaded]));
    this.#skills = options.skills;
    this.#ruleSystems = options.ruleSystems ?? assemblePacks(options.packs).ruleSystems;
    const ownSystems = new Set<RulePack>(options.packs.flatMap((loaded) => loaded.pack.ruleSystems.map((system) => system.compiled)));
    const ownSkills = new Set<Skill>(options.packs.flatMap((loaded) => loaded.pack.skills.map((entry) => entry.skill)));
    this.#base = {
      ruleSystems: this.#ruleSystems.packs().filter((system) => !ownSystems.has(system)),
      skills: this.#skills.skills().filter((skill) => !ownSkills.has(skill)),
    };
    this.#media = options.media ?? null;
    this.#report = options.report ?? (() => undefined);
    this.#install = options.install ?? null;
  }

  /** No packs installed, the built-in skills only. */
  static none(): RoomPacks {
    return new RoomPacks({ packs: [], skills: new SkillRegistry(builtInSkills()) });
  }

  get skillRegistry(): SkillRegistry {
    return this.#skills;
  }

  get ruleSystemRegistry(): RulePackRegistry {
    return this.#ruleSystems;
  }

  /** Whether this server installs packs from chat. */
  get canInstall(): boolean {
    return this.#install !== null;
  }

  /** The archive a reference names: the network part of an install, run outside any room's lock. */
  fetchSource(ref: string): Promise<PackSource> {
    if (this.#install === null) return Promise.resolve({ ok: false, code: "fetch_failed", detail: "install_unavailable" });
    return fetchPackSource(ref, { fetch: this.#install.fetch });
  }

  /** Told the id of every pack installed while the server runs (the hub reloads the rooms that enabled it). */
  onInstalled(listener: (id: string) => void): void {
    this.#listeners.push(listener);
  }

  /**
   * Install an archive's bytes into the data directory (`installArchive`, the shell's
   * installer) and take the pack into the running server: read back from disk and validated
   * again as at start-up, put in its old version's place or after the others, the rule-system
   * and skill registries assembled again by first claim and swapped in place. Synchronous,
   * so nothing interleaves between the index read and the swap. Enables nothing in any room.
   */
  install(archive: Uint8Array): RuntimeInstallOutcome {
    const install = this.#install;
    if (install === null) return { ok: false, code: "install_unavailable" };
    const outcome = installArchive(install.dataDir, archive, install.now === undefined ? { yes: true } : { yes: true, now: install.now });
    if (!outcome.ok) return outcome;
    const directory = new PackDirectory(install.dataDir);
    const loaded = loadInstalledPack(directory, { id: outcome.id, version: outcome.version, sha256: outcome.sha256, installedAt: 0 });
    if (!loaded.ok) return { ok: false, code: "install_failed", detail: loaded.note };
    const replacing = this.#packs.some((each) => each.pack.manifest.id === outcome.id);
    const packs = replacing ? this.#packs.map((each) => (each.pack.manifest.id === outcome.id ? loaded.pack : each)) : [...this.#packs, loaded.pack];
    const assembled = assemblePacks(packs, this.#base);
    this.#ruleSystems.adopt(assembled.ruleSystems);
    this.#skills.adopt(assembled.skills);
    this.#packs = packs;
    this.#byId = new Map(packs.map((each) => [each.pack.manifest.id, each]));
    for (const listener of this.#listeners) listener(outcome.id);
    return { ...outcome, loaded: loaded.pack };
  }

  /** Every installed pack, in install order. */
  installed(): readonly LoadedPack[] {
    return this.#packs;
  }

  get(id: string): LoadedPack | null {
    return this.#byId.get(id) ?? null;
  }

  /** The ids the room enabled, as stored (an uninstalled pack's id stays until disabled). */
  enabledIds(store: Store, room: string): readonly string[] {
    return store.stateGet(room, ROOM_PACKS) ?? [];
  }

  /** The installed packs the room enabled, in the order it enabled them. */
  enabled(store: Store, room: string): readonly LoadedPack[] {
    return this.enabledIds(store, room).flatMap((id) => {
      const loaded = this.#byId.get(id);
      return loaded === undefined ? [] : [loaded];
    });
  }

  /** Room-setting bookkeeping for `pack enable`: the new list, or why not. */
  enable(store: Store, room: string, id: string): { readonly ok: true; readonly ids: readonly string[]; readonly changed: boolean } | { readonly ok: false; readonly code: string; readonly detail?: string } {
    const loaded = this.#byId.get(id);
    if (loaded === undefined) return { ok: false, code: "unknown_pack" };
    const ids = this.enabledIds(store, room);
    if (ids.includes(id)) return { ok: true, ids, changed: false };
    if (ids.length >= MAX_ENABLED_PACKS) return { ok: false, code: "too_many_packs" };
    // Two modules of one id cannot share a room's worker: refuse before the worker would.
    const taken = new Set(this.enabled(store, room).flatMap((other) => other.pack.modules.map((module) => module.id)));
    const clash = loaded.pack.modules.find((module) => taken.has(module.id));
    if (clash !== undefined) return { ok: false, code: "module_id_taken", detail: clash.id };
    return { ok: true, ids: [...ids, id], changed: true };
  }

  /** The module entry files of the room's enabled packs, in dispatch order. */
  modulesFor(store: Store, room: string): readonly string[] {
    return this.enabled(store, room).flatMap((loaded) => loaded.pack.modules.map((module) => loaded.filePath(module.path)));
  }

  /** The room's kit: every enabled pack's kit merged; null when none of them has one. */
  kitFor(store: Store, room: string, locale: string): RoomKit | null {
    const installed: InstalledKit[] = [];
    for (const loaded of this.enabled(store, room)) {
      const kit = loaded.pack.presentation?.kit;
      if (kit === undefined) continue;
      installed.push({ packId: loaded.pack.manifest.id, kit, assets: new Map(kitAssetsOf(loaded.pack).map((asset) => [asset.path, kitAsset(asset)])) });
    }
    if (installed.length === 0) return null;
    const merged = mergeRoomKit(installed, locale);
    for (const problem of merged.problems) {
      // Said once per room and problem: the kit is merged on every turn.
      const line = `room kit: ${problem.code} (${problem.packId}${"id" in problem ? `/${problem.id}` : ""})`;
      const key = `${room}\u0000${line}`;
      if (this.#reported.has(key)) continue;
      this.#reported.add(key);
      this.#report(room, line);
    }
    return merged.kit;
  }

  /** The skills the room may enable: the built-ins, then those of its enabled packs (not shadowed ones). */
  skillsFor(store: Store, room: string): readonly AvailableSkill[] {
    const out: AvailableSkill[] = [];
    const builtIn = new Set(builtInSkills().map((skill) => skill.id));
    for (const skill of this.#skills.skills()) if (builtIn.has(skill.id)) out.push({ skill, pack: null });
    for (const loaded of this.enabled(store, room)) {
      for (const entry of loaded.pack.skills) {
        if (this.#skills.get(entry.id) === entry.skill) out.push({ skill: entry.skill, pack: loaded.pack.manifest.id });
      }
    }
    return out;
  }

  /** The skill ids a pack contributes to the registry (its shadowed ones excluded). */
  ownSkills(loaded: LoadedPack): readonly string[] {
    return loaded.pack.skills.filter((entry) => this.#skills.get(entry.id) === entry.skill).map((entry) => entry.id);
  }

  /** The panel ids (`<pack>/<panel>`) the room switched off, as stored. */
  panelsOff(store: Store, room: string): readonly string[] {
    return store.stateGet(room, ROOM_PANELS_OFF) ?? [];
  }

  /** Every panel of the room's enabled packs, in the order the packs were enabled, then as each declares them. */
  panels(store: Store, room: string): readonly RoomPanel[] {
    const off = new Set(this.panelsOff(store, room));
    return this.enabled(store, room).flatMap((loaded) =>
      loaded.pack.panels.map((panel) => {
        const id = `${loaded.pack.manifest.id}/${panel.spec.id}`;
        return { loaded, panel, id, on: !off.has(id) };
      }),
    );
  }

  /**
   * The `panels` view for a member with `role`, in `locale`: the room's panels that are on and
   * listed to that role — a panel reading an `admin/*` view, or with `audience: admin`, to
   * admins only; `audience: player` to everyone else.
   */
  panelsFor(store: Store, room: string, role: Role, locale: string): PanelEntry[] {
    const out: PanelEntry[] = [];
    for (const { loaded, panel, on } of this.panels(store, room)) {
      if (!on || !panelListedTo(panel.spec, role)) continue;
      const page = panel.page === null ? null : { sha256: panel.page.sha256, size: panel.page.size, mime: "text/html" };
      const entry = panelEntry(loaded.pack.manifest.id, panel.spec, locale, panelFiles(loaded.pack), page);
      if (entry !== null) out.push(entry);
    }
    return out;
  }

  /**
   * Store the kit assets of the room's enabled packs, and the pictures and page HTML of the
   * panels it has on, as the room's unlisted media: fetchable over the byte channel by that
   * room's members (`members`) — or, for what only admin-only panels name, by its admins
   * (`admin`) — never listed or broadcast. Bytes the room already holds are not stored twice.
   * Resolves to the problems, as codes; it never throws.
   */
  async registerAssets(room: string, store: Store): Promise<readonly string[]> {
    const media = this.#media;
    if (media === null) return [];
    const problems: string[] = [];
    // Each file once, with the widest audience any use of it needs.
    const wanted = new Map<string, { loaded: LoadedPack; path: string; mime: string; audience: Audience }>();
    const want = (loaded: LoadedPack, path: string, sha256: string, mime: string, audience: Audience): void => {
      const held = wanted.get(sha256);
      if (held === undefined) wanted.set(sha256, { loaded, path, mime, audience });
      else if (audience === "members") held.audience = "members";
    };
    for (const loaded of this.enabled(store, room)) for (const asset of kitAssetsOf(loaded.pack)) want(loaded, asset.path, asset.sha256, asset.mime, "members");
    for (const { loaded, panel, on } of this.panels(store, room)) {
      if (!on) continue;
      const audience: Audience = panelAdminOnly(panel.spec) ? "admin" : "members";
      const files = panelFiles(loaded.pack);
      for (const image of panel.spec.images) {
        const file = files.get(image);
        if (file !== undefined) want(loaded, image, file.sha256, file.mime, audience);
      }
      if (panel.page !== null) want(loaded, panel.page.path, panel.page.sha256, "text/html", audience);
    }
    for (const [sha256, { loaded, path, mime, audience }] of wanted) {
      if (media.find(room, sha256, "admin") !== undefined) continue;
      const bytes = await loaded.read(path);
      if (bytes === null) {
        problems.push(`asset_unreadable:${loaded.pack.manifest.id}:${path}`);
        continue;
      }
      const stored = await media.registerServerBlob({ room, bytes, mime, name: path.split("/").at(-1) ?? path, audience });
      if (!stored.ok) problems.push(`${stored.code}:${loaded.pack.manifest.id}:${path}`);
    }
    for (const problem of problems) this.#report(room, `pack assets: ${problem}`);
    return problems;
  }
}
