// `st_macros` vectors: `{{...}}` substitution, with scripted `{{random}}` draws and
// scripted `{{roll}}` totals (dice semantics live in the dice vectors).

import { describe, expect, test } from "bun:test";

import { type MacroContext, substituteMacros, type VariableSnapshot } from "../../../src/core/worldbook/index.ts";
import { ScriptedRandom } from "../../../src/core/random.ts";
import { readReference } from "../../reference.ts";
import { type RecordedDraw, scriptedDraws, scriptedRoller } from "./adapter.ts";

interface Row {
  readonly case: string;
  readonly input: {
    readonly text: string;
    readonly names: Record<string, string> | null;
    readonly macro_context: { clock_time: string; names: Record<string, string>; rng: boolean; roll: boolean } | null;
    readonly rolls: Record<string, number | string> | null;
    readonly variables: VariableSnapshot;
  };
  readonly draws: RecordedDraw[];
  readonly output: string;
}

/**
 * Rows where the old engine diverged from SillyTavern's `evaluateMacros` (macros.js /
 * variables.js) and this port follows ST. Each has a direct test in `corrections.test.ts`.
 */
export const MACRO_CORRECTIONS: Readonly<Record<string, string>> = {
  getvar_spaces: "ST's pattern is exactly `{{getvar::`: `{{ getvar::fear }}` is not a macro (`{{getvar:: fear }}` still is)",
  newline: "ST's pattern is exactly /{{newline}}/gi: `{{ NEWLINE }}` is not a macro",
  unknown_macros_pass_through: "`{{trim}}` is an ST macro (removes itself and the line breaks around it)",
  getvar_case_sensitive: "ST's getvar pattern is /{{getvar::([^}]+)}}/gi: case-insensitive",
  getvar_python_str: "values print like ST's sanitizeMacroValue (true, 2, JSON), not Python str()",
  getvar_branch: "an object value prints as JSON, not a Python dict repr",
  user_char_case: "ST's env macros are exact `{{user}}` (case-insensitive) with no inner spaces",
  names_empty_value: "an empty name substitutes as empty (ST replaces with the value as given)",
  comment_with_braces_kept: "ST's comment pattern /\\{\\{\\/\\/([\\s\\S]*?)\\}\\}/ removes a comment containing braces",
  order_comment_first: "ST strips comments AFTER the name pass, so `{{// {{user}} }}` is removed",
  random_trims_and_drops_empty: "ST keeps empty comma items (it trims them), so the draw is over 4 options",
  random_separators_only: "ST keeps the three empty items and draws among them",
  pick_alias: "`{{pick}}` is ST's stable seeded pick, not a random draw",
  roll_double_colon: "ST's roll pattern is /{{roll[ : ]([^}]+)}}/: `{{roll::2d6+1}}` reads `:2d6+1`, invalid, prints nothing",
  roll_bad_expression: "an invalid roll formula prints nothing in ST",
  roll_space_form_unsupported: "ST's roll pattern accepts the `{{roll 1d6}}` space form",
  nested_names_into_getvar: "ST's getvar name is [^}]+: `{{getvar::{{user}}}}` reads the variable `{{user`",
};

function contextFor(row: Row): MacroContext {
  const { input } = row;
  const names = { ...(input.names ?? {}), ...(input.macro_context?.names ?? {}) };
  const clockTime = input.macro_context?.clock_time ?? "";
  const draws = scriptedDraws(row.draws);
  return {
    names,
    variables: input.variables,
    ...(clockTime === "" ? {} : { clock: { time: clockTime, date: clockTime } }),
    ...(input.macro_context?.rng === true ? { random: new ScriptedRandom(draws) } : {}),
    ...(input.macro_context?.roll === true ? { roll: scriptedRoller(input.rolls) } : {}),
  };
}

describe("st_macros", () => {
  const rows = readReference<Row>("st_macros");

  test("every row is accounted for", () => {
    expect(rows.length).toBe(43);
    for (const name of Object.keys(MACRO_CORRECTIONS)) expect(rows.some((row) => row.case === name)).toBe(true);
  });

  for (const row of rows) {
    const corrected = MACRO_CORRECTIONS[row.case];
    if (corrected !== undefined) {
      test.skip(`${row.case} (corrected: ${corrected})`, () => {});
      continue;
    }
    test(row.case, () => {
      const context = contextFor(row);
      expect(substituteMacros(row.input.text, context)).toBe(row.output);
      if (context.random instanceof ScriptedRandom) expect(context.random.remaining).toBe(0);
    });
  }
});
