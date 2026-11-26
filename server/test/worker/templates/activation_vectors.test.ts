// `st_worldbook_activation` vectors: multi-turn sequences through `assembleLoreWith` (the
// worldbook's activation with the real template engine as renderer), with every recorded
// draw replayed by `ScriptedRandom` and every `{{roll}}` answered by a scripted roller.
//
// Compared per turn: activated titles (final order), the injected text body (the two
// header lines are the caller's), `activewi` requests and pull-ins, template writes,
// the turn counter, the MVU tree after the writes are applied, and that the turn consumed
// exactly its recorded draws.
//
// Not compared:
// - the injected text's two header lines (`World Lore` + instruction): the caller's
//   message catalog;
// - `stored_entries` field by field: the import is covered by `st_worldbook_import`;
// - how a `[InitVar]` body becomes the tree (the MVU module's job): for a book with a
//   declaration, the starting tree is taken from the recorded first turn.

import { describe, expect, test } from "bun:test";

import { EMPTY_TIMERS, importLorebook, type LoreEntry, type TimerState, type VariableSnapshot } from "../../../src/core/worldbook/index.ts";
import { ScriptedRandom } from "../../../src/core/random.ts";
import { assembleLoreWith } from "../../../src/worker/templates/index.ts";
import { injectedBody, type RecordedDraw, scriptedDraws, scriptedRoller, withIds } from "../../core/worldbook/adapter.ts";
import { readReference } from "../../reference.ts";

interface Turn {
  readonly context: string;
  readonly viewer?: "keeper" | "player";
  readonly advance_timers?: boolean;
  readonly rolls?: Record<string, number | string>;
}
interface TurnResult {
  readonly activated: string[];
  readonly activewi_requested: string[];
  readonly activewi_injected: string[];
  readonly draws: RecordedDraw[];
  readonly macro_draws: RecordedDraw[];
  readonly injected_text: string;
  readonly template_writes?: [string, unknown][];
  readonly turn_counter_after: number;
  readonly mvu_tree_after: Record<string, unknown>;
}
interface Row {
  readonly case: string;
  readonly input: {
    readonly lorebook: unknown[];
    readonly import: { readonly char_name: string; readonly is_keeper: boolean; readonly source: string };
    readonly limit: number;
    readonly budget_chars: number;
    readonly macros: { readonly clock_time: string; readonly names: Record<string, string> };
    readonly variables: VariableSnapshot;
    readonly turns: Turn[];
  };
  readonly turns: TurnResult[];
}

/**
 * Rows that encode an old-engine behaviour this port deliberately changes. Each change
 * has a direct test (`corrections.test.ts` / `assemble.test.ts`).
 */
const SKIPPED: Readonly<Record<string, string>> = {
  inclusion_group_weighted: "the group winner keeps its place (ST filterByInclusionGroups); the old engine moved grouped entries last",
  inclusion_group_reorders: "same: grouped entries are no longer moved behind ungrouped ones",
  inclusion_groups_two: "same: the winners keep their places",
  inclusion_group_default_weights: "`groupWeight: 0` stays 0 (ST `?? DEFAULT_WEIGHT`), so the recorded weighted draw over [100, 100] is now a draw over [0, 100]",
  probability_before_secrecy: "secret entries are removed before any processing for a player viewer, so they draw nothing (structural secrecy)",
  render_lite_ejs: "the subset renderer is dropped in 3.0; templates always run on the full engine",
  render_bool_python_vs_js: "same: the full engine prints `true`, and macros print `true` too (ST sanitizeMacroValue)",
  render_bool_full_engine: "`{{getvar::flag}}` prints `true` (ST sanitizeMacroValue), not Python's `True`",
  render_full_ejs_error_falls_back: "a failed template renders as nothing; there is no subset fallback in 3.0",
  whole_word_non_word_key: "a one-word key with a hyphen is boundary-checked as in ST (only a key with whitespace is a plain substring): `dark-elf` is not in `dark-elfling`",
  condition_js_only_no_engine: "there is no engine-less mode in 3.0: the JavaScript condition is evaluated (and holds)",
  ordering_position_priority: "selected entries are laid out by Insertion Order ascending within a placement (ST: larger order numbers closer to the end of the context); the old engine laid them out largest first",
  limit_truncates: "same: the limit still keeps the larger order numbers, the layout is ascending",
  budget_skips_and_continues: "same: the budget still fills from the larger order numbers, the layout is ascending",
  whole_word_unicode_neighbor:"whole-word boundaries are ASCII as in ST's non-`u` `\\W`: `gun` is found in `他拿起gun了`",
};

function setPath(tree: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node: Record<string, unknown> = tree;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1] ?? ""] = value;
}

function transcriptOf(context: string): string[] {
  return context.split(/\r?\n/u).filter((line) => line.trim() !== "");
}

describe("st_worldbook_activation", () => {
  const rows = readReference<Row>("st_worldbook_activation");

  test("every row is accounted for", () => {
    expect(rows.length).toBe(72);
    for (const name of Object.keys(SKIPPED)) expect(rows.some((row) => row.case === name)).toBe(true);
  });

  for (const row of rows) {
    const skipped = SKIPPED[row.case];
    if (skipped !== undefined) {
      test.skip(`${row.case} (${skipped})`, () => {});
      continue;
    }
    test(row.case, () => {
      const { input } = row;
      const imported = importLorebook(input.lorebook, {
        trust: input.import.is_keeper ? "keeper" : "player",
        source: input.import.source,
        charName: input.import.char_name,
      });
      if (!imported.ok) throw new Error("import failed");
      const entries: LoreEntry[] = withIds(imported.entries);
      let tree: Record<string, unknown> = structuredClone(input.variables.tree);
      if (imported.declarations.length > 0) tree = structuredClone(row.turns[0]?.mvu_tree_after ?? {});
      let timers: TimerState = EMPTY_TIMERS;
      const clock = input.macros.clock_time === "" ? undefined : { time: input.macros.clock_time, date: input.macros.clock_time };

      input.turns.forEach((turn, index) => {
        const expected = row.turns[index];
        if (expected === undefined) throw new Error("missing turn result");
        const random = new ScriptedRandom(scriptedDraws([...expected.draws, ...expected.macro_draws]));
        const result = assembleLoreWith(
          {
            entries,
            viewer: turn.viewer ?? "keeper",
            transcript: transcriptOf(turn.context),
            timers,
            advanceTimers: turn.advance_timers ?? true,
            variables: { flat: input.variables.flat, tree },
            seed: "vectors",
            nowMs: 0,
            names: input.macros.names,
            ...(clock === undefined ? {} : { clock }),
            maxEntries: input.limit,
            budgetChars: input.budget_chars,
          },
          { random, roll: scriptedRoller(turn.rolls) },
        );
        expect(result.activatedTitles).toEqual(expected.activated);
        expect(result.text).toBe(injectedBody(expected.injected_text));
        expect(result.activationRequests).toEqual(expected.activewi_requested);
        expect(result.pulledInTitles).toEqual(expected.activewi_injected);
        expect(result.turn).toBe(expected.turn_counter_after);
        expect(random.remaining).toBe(0);
        if (expected.template_writes !== undefined) {
          expect(result.writes.map((write) => [write.path, write.value])).toEqual(expected.template_writes);
        }
        for (const write of result.writes) setPath(tree, write.path, write.value);
        expect(tree).toEqual(expected.mvu_tree_after);
        timers = result.timers;
      });
    });
  }
});
