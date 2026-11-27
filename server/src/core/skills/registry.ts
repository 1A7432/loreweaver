// A set of loaded skills. An explicit value the caller builds — built-ins first, then
// installed ones — never process-wide state; nothing changes it but `adopt` (a pack
// installed while the server runs: the new set, built the same way, swapped in at once). The FIRST skill to claim an id keeps it,
// so an installed skill can never replace a built-in of the same id (LWF: built-ins win).
import type { Skill } from "./parse.ts";

/** A registry holds at most this many skills. */
export const MAX_SKILLS = 256;

export type SkillAddRefusal = "duplicate_id" | "too_many";

export interface SkillAdd {
  readonly registry: SkillRegistry;
  /** Skills not added, in the order given, each with why. */
  readonly refused: readonly { readonly id: string; readonly code: SkillAddRefusal }[];
}

export class SkillRegistry {
  #skills: ReadonlyMap<string, Skill>;

  constructor(skills: Iterable<Skill> = []) {
    const byId = new Map<string, Skill>();
    for (const skill of skills) {
      if (byId.has(skill.id) || byId.size >= MAX_SKILLS) continue;
      byId.set(skill.id, skill);
    }
    this.#skills = byId;
    Object.freeze(this);
  }

  /** A new registry with `skills` after these; a claimed id or one over the cap is refused. */
  with(skills: Iterable<Skill>): SkillAdd {
    const all = [...this.#skills.values()];
    const ids = new Set(this.#skills.keys());
    const refused: { id: string; code: SkillAddRefusal }[] = [];
    for (const skill of skills) {
      if (ids.has(skill.id)) refused.push({ id: skill.id, code: "duplicate_id" });
      else if (all.length >= MAX_SKILLS) refused.push({ id: skill.id, code: "too_many" });
      else {
        ids.add(skill.id);
        all.push(skill);
      }
    }
    return { registry: new SkillRegistry(all), refused };
  }

  /** Take `other`'s skills in place of these, in one step, for every holder of this registry. */
  adopt(other: SkillRegistry): void {
    this.#skills = other.#skills;
  }

  get(id: string): Skill | null {
    return this.#skills.get(id) ?? null;
  }

  /** Every skill id, in the order the skills were added. */
  ids(): readonly string[] {
    return Object.freeze([...this.#skills.keys()]);
  }

  /** Every skill, in the order they were added. */
  skills(): readonly Skill[] {
    return Object.freeze([...this.#skills.values()]);
  }
}
