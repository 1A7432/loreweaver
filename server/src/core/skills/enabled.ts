// Which skills are enabled in a room, and what that means for the room: the bodies the
// Keeper's prompt carries, the gated tools they unlock, and whether the output filter is
// lifted.
//
// The enabled set is a room-state key, not a document. It is a short list of ids the room
// admin switches (`.skill enable|disable`), not content anyone reads as such: the table
// sees the skills through the `skill list` command, which names each skill from the
// registry; nobody needs a per-viewer projection of the ids themselves.
//
// Lifecycle: `never`. Enabling a skill is a ROOM SETTING — "this table plays with mature
// content", "this table may get images" — chosen by the people at it, in the same family as
// the room's language. A campaign reset replays the story with the same people under the
// same agreement; quietly dropping a consent-shaped switch such as mature mode on `.reset
// all` would surprise the admin, and silently keeping a word filter lifted is never what a
// reset is for either way. The reference server made the same call (`gateway/ops.py`
// `room_settings` facet: "`skills_enabled` surviving every scope is an explicit owner
// verdict (2026-08-13)").
import { jsonStateKey, type StateKey } from "../../infra/lifecycle/declarations.ts";
import type { RoomWriter, Store } from "../../infra/store.ts";
import { isMature, SKILL_ID_PATTERN, type Skill } from "./parse.ts";
import type { SkillRegistry } from "./registry.ts";

/** A room enables at most this many skills at once. */
export const MAX_ENABLED_SKILLS = 32;

function isIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ENABLED_SKILLS &&
    value.every((item) => typeof item === "string" && SKILL_ID_PATTERN.test(item)) &&
    new Set(value).size === value.length
  );
}

/** The ids of the skills enabled in a room, in the order they were enabled. */
export const ENABLED_SKILLS: StateKey<string[]> = jsonStateKey("room.skills_enabled", {
  reset: "never",
  because: "a room setting the table agreed to (mature content, images), not campaign content; owner verdict 2026-08-13",
}, isIdList);

/** The enabled ids as stored; an unreadable value reads as none. */
export function readEnabledSkills(store: Store, room: string): readonly string[] {
  return store.stateGet(room, ENABLED_SKILLS) ?? [];
}

export type SkillSwitch =
  | { readonly ok: true; readonly enabled: readonly string[]; readonly changed: boolean }
  | { readonly ok: false; readonly code: "unknown_skill" | "too_many" };

/** Enable `id` (a registry skill) in `enabled`. Enabling an enabled skill changes nothing. */
export function enableSkill(registry: SkillRegistry, enabled: readonly string[], id: string): SkillSwitch {
  if (registry.get(id) === null) return { ok: false, code: "unknown_skill" };
  if (enabled.includes(id)) return { ok: true, enabled, changed: false };
  if (enabled.length >= MAX_ENABLED_SKILLS) return { ok: false, code: "too_many" };
  return { ok: true, enabled: [...enabled, id], changed: true };
}

/** Disable `id`. An id no longer in the registry (an uninstalled pack) can still be switched off. */
export function disableSkill(enabled: readonly string[], id: string): SkillSwitch {
  if (!enabled.includes(id)) return { ok: true, enabled, changed: false };
  return { ok: true, enabled: enabled.filter((item) => item !== id), changed: true };
}

/** Store a switched set (pass the `enabled` of an `ok` switch). */
export function writeEnabledSkills(writer: RoomWriter, enabled: readonly string[]): void {
  if (enabled.length === 0) writer.stateDelete(ENABLED_SKILLS);
  else writer.statePut(ENABLED_SKILLS, [...enabled]);
}

/** The enabled skills the registry knows, in enabled order; unknown ids are skipped. */
export function activeSkills(registry: SkillRegistry, enabled: readonly string[]): readonly Skill[] {
  const out: Skill[] = [];
  for (const id of enabled) {
    const skill = registry.get(id);
    if (skill !== null) out.push(skill);
  }
  return out;
}

/**
 * The gated tool names the room's enabled skills unlock. The tool catalogue offers a gated
 * tool only when its name is here; a name no tool carries unlocks nothing.
 */
export function unlockedTools(registry: SkillRegistry, enabled: readonly string[]): ReadonlySet<string> {
  const tools = new Set<string>();
  for (const skill of activeSkills(registry, enabled)) for (const tool of skill.allowedTools) tools.add(tool);
  return tools;
}

/** Whether an enabled skill declares mature content: the room's output filter is then lifted. */
export function liftsOutputFilter(registry: SkillRegistry, enabled: readonly string[]): boolean {
  return activeSkills(registry, enabled).some(isMature);
}
