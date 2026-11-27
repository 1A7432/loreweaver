// Every name a built-in rule system shows a person has a label in both languages: a viewer
// never reads an attribute, a derived value or a skill in a script that is not theirs.
import { expect, test } from "bun:test";

import { builtInPacks, type RulePack } from "../../../src/core/rulepacks/index.ts";

/** A name an English viewer can read as it is: Latin letters, digits, punctuation, symbols. */
const LATIN_ONLY = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\p{Zs}]+$/u;
/** A name a Chinese viewer can read as it is: it is written with Han characters. */
const HAN = /\p{Script=Han}/u;

/**
 * Labels held back, each with why. A display label is also a name the stat answers to (the
 * 2026-11-27 ruling in `test/core/sheets/vectors.test.ts`), so a label can change which names
 * resolve, and those are pinned by the reference vectors. None is held now: coc7 `知识` → "Know"
 * (CoC 7e's own term) was the one, added on the owner's word (2026-11-27) with the one pinned
 * `sheets_cases` cell it moves.
 */
const HELD: ReadonlySet<string> = new Set<string>();

/** The canonical names a pack's sheet shows: attributes, derived values, skills (and the names its defaults give). */
function shownNames(pack: RulePack): string[] {
  const spec = pack.sheet;
  const shape = spec.shape;
  const names = new Set<string>();
  for (const name of shape?.attrKeys.keys() ?? []) names.add(name);
  for (const rule of spec.derived) names.add(rule.name);
  const canonicalOfSkill = new Map([...(shape?.skillKeys ?? [])].map(([canonical, key]) => [key, canonical] as const));
  for (const [key] of shape?.skills ?? []) names.add(canonicalOfSkill.get(key) ?? key);
  for (const name of shape?.skillKeys.keys() ?? []) names.add(name);
  for (const name of spec.defaults.keys()) names.add(name);
  return [...names];
}

test("every attribute, derived value and skill of a built-in pack has a label in en and zh unless it is already in that script", () => {
  const missing: string[] = [];
  for (const pack of builtInPacks()) {
    const labels = pack.sheet.displayNames;
    for (const name of shownNames(pack)) {
      if (!LATIN_ONLY.test(name) && labels.get("en")?.has(name) !== true) missing.push(`${pack.id} en ${name}`);
      if (!HAN.test(name) && labels.get("zh")?.has(name) !== true) missing.push(`${pack.id} zh ${name}`);
    }
  }
  expect(missing.filter((entry) => !HELD.has(entry))).toEqual([]);
  // A held label that has been added since is no longer held: take it off the list.
  expect([...HELD].filter((entry) => !missing.includes(entry))).toEqual([]);
});

test("the check sees what it should: a pack's names are found, and an English name needs no English label", () => {
  const coc = builtInPacks().find((pack) => pack.id === "coc7");
  expect(coc).toBeDefined();
  const names = shownNames(coc as RulePack);
  for (const name of ["力量", "灵感", "DB", "侦查", "信用评级"]) expect(names).toContain(name);
  expect(LATIN_ONLY.test("Fighting (Brawl)")).toBe(true);
  expect(LATIN_ONLY.test("灵感")).toBe(false);
  expect(HAN.test("驾驶:飞行器")).toBe(true);
});
