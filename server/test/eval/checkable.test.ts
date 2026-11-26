// The cases the 2.6 judge's own documentation names, each a red night it was shaped by.
import { expect, test } from "bun:test";

import { checkTerms, judgeCheckable, nameCheckableSkill } from "../../eval/checkable.ts";
import { builtInPacks } from "../../src/core/rulepacks/index.ts";

const TERMS = checkTerms(builtInPacks());

test("the vocabulary is the packs': names, aliases and display names, two characters at least", () => {
  for (const term of ["Spot Hidden", "Library Use", "侦查", "图书馆使用", "投掷"]) expect([term, TERMS.has(term)]).toEqual([term, true]);
  expect([...TERMS].every((term) => [...term].length >= 2)).toBe(true);
});

test("a skill named next to a request to check it is checkable, in either language", () => {
  expect(nameCheckableSkill("Make a Library Use check before you go on.", TERMS)?.skill.toLowerCase()).toBe("library use");
  expect(nameCheckableSkill("掷一次侦查", TERMS)?.skill).toBe("侦查");
  // A comma or a colon between the request and its skill is ordinary phrasing.
  expect(nameCheckableSkill("Roll for it: Spot Hidden", TERMS)?.skill.toLowerCase()).toBe("spot hidden");
  expect(nameCheckableSkill("掷骰，侦查", TERMS)?.skill).toBe("侦查");
});

test("what it must not score", () => {
  // An oath is not a check, whatever attribute alias hides in it.
  expect(nameCheckableSkill("I swear aloud: I will never enter the cellar alone", TERMS)).toBeNull();
  // A skill that contains a request character does not license itself…
  expect(nameCheckableSkill("他把绳子投掷过去", TERMS)).toBeNull();
  // …nor a term two words away.
  expect(nameCheckableSkill("守卫的护甲上有一道深深的凹痕，他投掷了长矛。", TERMS)).toBeNull();
  // A request one full stop away is out of reach.
  expect(nameCheckableSkill("Make a check. Library Use.", TERMS)).toBeNull();
  // A skill named with no request at all.
  expect(nameCheckableSkill("I search the room, relying on my Spot Hidden.", TERMS)).toBeNull();
  expect(nameCheckableSkill("", TERMS)).toBeNull();
});

test("the player's side is quoted before the Keeper's echo of it", () => {
  const found = judgeCheckable("I want to roll Spot Hidden on the map.", "Make a Spot Hidden check.", TERMS);
  expect([found?.source, found?.rule]).toEqual(["player_action", "explicit_check_request"]);
  expect(judgeCheckable("I look at the map.", "Make a Spot Hidden check, please.", TERMS)?.source).toBe("keeper_reply");
  expect(judgeCheckable("I look at the map.", "The map hangs crooked.", TERMS)).toBeNull();
});
