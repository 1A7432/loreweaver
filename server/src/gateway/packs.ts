// Installed packs, as the rooms see them. The operator installs packs from the shell; a
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
// - its cards importable with `import {pack, card, as}`.
//
// A pack's rule systems are not per room: they join the server's rule-system registry at
// start-up (`assemblePacks`), chosen per room with `rule system`. Clashes are settled by
// FIRST CLAIM: the built-in rule systems and skills are added first, then the installed
// packs in the order they were installed; an id already claimed is not replaced, and the
// pack's own part is left out and named in a start-up note — a built-in is never replaced,
// silently or otherwise.
import type { InstalledKit, KitAsset, RoomKit } from "../agent/lanes/presentation.ts";
import { mergeRoomKit } from "../agent/lanes/presentation.ts";
import type { Pack, PackAsset, TrustCard } from "../core/packs/index.ts";
import { builtInPacks, type RulePack, RulePackRegistry } from "../core/rulepacks/index.ts";
import { builtInSkills, type Skill, SkillRegistry } from "../core/skills/index.ts";
import type { MediaStore } from "../infra/media/index.ts";
import type { Store } from "../infra/store.ts";
import { MAX_ENABLED_PACKS, ROOM_PACKS } from "./commands/state.ts";

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

export interface RoomPacksOptions {
  /** The installed packs, in install order. */
  readonly packs: readonly LoadedPack[];
  /** The server's skill registry (built-ins first, then installed packs'). */
  readonly skills: SkillRegistry;
  /** Where kit assets become room media; absent: kits name no stored assets. */
  readonly media?: MediaStore | null;
  readonly report?: (room: string, text: string) => void;
}

export class RoomPacks {
  readonly #packs: readonly LoadedPack[];
  readonly #byId: ReadonlyMap<string, LoadedPack>;
  readonly #skills: SkillRegistry;
  readonly #media: MediaStore | null;
  readonly #report: (room: string, text: string) => void;
  readonly #reported = new Set<string>();

  constructor(options: RoomPacksOptions) {
    this.#packs = options.packs;
    this.#byId = new Map(options.packs.map((loaded) => [loaded.pack.manifest.id, loaded]));
    this.#skills = options.skills;
    this.#media = options.media ?? null;
    this.#report = options.report ?? (() => undefined);
  }

  /** No packs installed, the built-in skills only. */
  static none(): RoomPacks {
    return new RoomPacks({ packs: [], skills: new SkillRegistry(builtInSkills()) });
  }

  get skillRegistry(): SkillRegistry {
    return this.#skills;
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

  /**
   * Store the kit assets of the room's enabled packs as the room's unlisted media (audience
   * `members`): fetchable over the byte channel by that room's members, never listed or
   * broadcast. Bytes the room already holds are not stored twice. Resolves to the problems,
   * as codes; it never throws.
   */
  async registerAssets(room: string, store: Store): Promise<readonly string[]> {
    const media = this.#media;
    if (media === null) return [];
    const problems: string[] = [];
    for (const loaded of this.enabled(store, room)) {
      for (const asset of kitAssetsOf(loaded.pack)) {
        if (media.find(room, asset.sha256, "admin") !== undefined) continue;
        const bytes = await loaded.read(asset.path);
        if (bytes === null) {
          problems.push(`asset_unreadable:${loaded.pack.manifest.id}:${asset.path}`);
          continue;
        }
        const stored = await media.registerServerBlob({ room, bytes, mime: asset.mime, name: asset.path.split("/").at(-1) ?? asset.path, audience: "members" });
        if (!stored.ok) problems.push(`${stored.code}:${loaded.pack.manifest.id}:${asset.path}`);
      }
    }
    for (const problem of problems) this.#report(room, `pack assets: ${problem}`);
    return problems;
  }
}
