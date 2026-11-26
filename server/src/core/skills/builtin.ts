/**
 * The built-in skills, parsed from the text embedded in the binary. Parsed afresh on each
 * call (no module-level state); a caller keeps the result in its `SkillRegistry`.
 */
import { parseSkillText, type Skill } from "./parse.ts";
import { SkillRegistry } from "./registry.ts";
import { BUILT_IN_SKILL_SOURCES } from "./sources.ts";

/** The built-in skill ids, in discovery order. */
export function builtInSkillIds(): readonly string[] {
  return Object.freeze([...BUILT_IN_SKILL_SOURCES.keys()]);
}

/** Every built-in skill. A built-in that does not parse is a build error, so it throws. */
export function builtInSkills(): readonly Skill[] {
  return Object.freeze(
    [...BUILT_IN_SKILL_SOURCES].map(([id, source]) => {
      const parsed = parseSkillText(id, source);
      if (!parsed.ok) throw new Error(`built-in skill '${id}' does not parse: ${parsed.code} ${parsed.path ?? ""}`.trim());
      return parsed.skill;
    }),
  );
}

/** A registry of the built-in skills, the base every other skill is added after. */
export function builtInSkillRegistry(): SkillRegistry {
  return new SkillRegistry(builtInSkills());
}
