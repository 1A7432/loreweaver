// The SillyTavern variable vectors (`st_mvu_initvar`, `st_mvu_update`, `st_mvu_tree`,
// recorded from the frozen Python engine) mapped onto `core/variables`.
//
// The target is MagVarUpdate's behaviour, not the old engine's, so every row where the
// two differ is listed below with the reason and the outcome the new layer produces —
// those rows are pinned to the NEW behaviour, never skipped silently.
//
// Shared adapter decisions:
// - The vector files were written with sorted keys, so written order inside a mapping is
//   not recoverable from them; trees are compared as JSON (order-insensitive).
// - `st_mvu_update` inputs write commands without the `;` MagVarUpdate requires after
//   `)` (its `extractCommands` drops a call without one; MagVarUpdate's own test suite
//   pins that). The adapter appends the `;` (`withSemicolons`) so the rows still exercise
//   everything else; a separate test pins that a call without `;` is not a command.
// - Error rows compare the outcome (refused, and with which code) — the old English error
//   text is not a contract.
// - `normalize_tree` rows: the new layer REFUSES a tree past its bounds instead of cutting
//   it down; its bounds (16 levels, 4096 nodes) are wider than the old 8 / 512, so the
//   old truncation rows are accepted whole here. Refusal is pinned in variables.test.ts.
import { describe, expect, test } from "bun:test";

import {
  applyReplyUpdates,
  flattenLeaves,
  fromPlain,
  isInitVarTitle,
  parseCommandValue,
  parseInitVar,
  pathIsExposed,
  pruneToExposed,
  toJson,
  treeProblem,
  type VarMap,
} from "../../../src/core/variables/index.ts";
import { readReference } from "../../reference.ts";

type Row = Record<string, any>;

function asTree(value: unknown): VarMap {
  const converted = fromPlain(value);
  return converted instanceof Map ? converted : new Map();
}

// ---------------------------------------------------------------------------
// st_mvu_initvar
// ---------------------------------------------------------------------------

/** Rows where the new layer reads a declaration differently, and what it produces. */
const INITVAR_DEVIATIONS: Record<string, { reason: string; expect: unknown }> = {
  initvar_bare_cjk_key_json5: {
    reason: "JSON5 identifier keys include Unicode letters (spec.json5.org), so the JSON5 route already reads `{好感度: 5}`",
    expect: { route: "json5", tree: { 好感度: 5, mood: "ok" } },
  },
  initvar_json_with_bom_like_text: {
    reason: "MagVarUpdate `parseString` tests `trimStart()`, which drops U+FEFF, so the text is JSON-first; JSON5 treats U+FEFF as space",
    expect: { route: "json5", tree: { a: 1 } },
  },
  initvar_yaml_11_booleans_and_duplicates: {
    reason: "ruled: YAML 1.2, whose loader refuses a repeated key (and `yes` is text); JSON5 cannot read it either",
    expect: { code: "unreadable" },
  },
  initvar_yaml_datetime: {
    reason: "ruled: YAML 1.2 core schema has no timestamps; the text stays as written",
    expect: { route: "yaml", tree: { at: "2026-08-04 10:30:00" } },
  },
  initvar_yaml_null_and_numbers: {
    reason: "ruled: YAML 1.2 reads `010` as ten and `1e3` as a number",
    expect: { route: "yaml", tree: { a: null, b: null, c: 10, d: 1.5, e: 1000, f: 31 } },
  },
  initvar_json_nan_literal: {
    reason: "a stored tree is JSON and cannot hold NaN/Infinity: the declaration is refused, not silently thinned",
    expect: { code: "non_finite_number" },
  },
  initvar_json_deep_nesting: {
    reason: "nine levels are within the new 16-level bound; the old engine cut the tree at 8",
    expect: { route: "json5", tree: { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { l9: 1 } } } } } } } } } },
  },
  initvar_name_32: { reason: "MagVarUpdate matches `[initvar]` WITH brackets (`loadInitVarData`)", expect: false },
  initvar_name_33: { reason: "MagVarUpdate matches `[initvar]` WITH brackets (`loadInitVarData`)", expect: false },
};

describe("st_mvu_initvar", () => {
  const rows = readReference<Row>("st_mvu_initvar");
  test("covers every row", () => {
    expect(rows.length).toBe(39);
  });
  for (const row of rows) {
    test(row.case, () => {
      const deviation = INITVAR_DEVIATIONS[row.case];
      if (row.op === "is_initvar_entry") {
        expect(isInitVarTitle(row.input.name)).toBe(deviation ? deviation.expect : row.result);
        return;
      }
      const parsed = parseInitVar(row.input.text);
      const got = parsed.ok ? { route: parsed.route, tree: toJson(parsed.tree) } : { code: parsed.code };
      if (deviation) {
        expect<unknown>(got).toEqual(deviation.expect);
        return;
      }
      if (row.normalized_tree === null) {
        expect(parsed.ok).toBe(false);
      } else {
        expect(got).toEqual({ route: row.route, tree: row.normalized_tree });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// st_mvu_tree
// ---------------------------------------------------------------------------

describe("st_mvu_tree", () => {
  const rows = readReference<Row>("st_mvu_tree");
  test("covers every row", () => {
    expect(rows.length).toBe(21);
  });
  for (const row of rows) {
    test(row.case, () => {
      const input = row.input;
      switch (row.op) {
        case "flatten_leaves":
          expect(flattenLeaves(asTree(input.tree), input.limit).map((leaf) => ({ path: leaf.path, value: leaf.value }))).toEqual(row.result);
          return;
        case "path_is_exposed":
          expect(pathIsExposed(input.path, input.prefixes)).toBe(row.result);
          return;
        case "prune_tree_to_exposed":
          expect(toJson(pruneToExposed(asTree(input.tree), input.prefixes))).toEqual(row.result);
          return;
        case "normalize_tree": {
          // A non-mapping is no tree; everything else is accepted whole when within bounds.
          const tree = fromPlain(input.tree);
          if (!(tree instanceof Map)) {
            expect(row.result).toEqual({});
            return;
          }
          expect(treeProblem(tree)).toBeNull();
          const truncatedByOldBounds = ["normalize_depth", "normalize_nodes", "normalize_list_depth"];
          expect(toJson(tree)).toEqual(truncatedByOldBounds.includes(row.case) ? input.tree : row.result);
          return;
        }
        default:
          throw new Error(`unmapped op ${row.op}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// st_mvu_update
// ---------------------------------------------------------------------------

/** MagVarUpdate needs `;` after a command; the vectors were written without it. */
function withSemicolons(text: string): string {
  return text.replace(/(_\.[a-z]+\((?:[^;\n])*?\))(?!;)(?=[ \t]*(?:\/\/[^\n]*)?(?:\n|<\/|$))/gi, "$1;");
}

const UNKNOWN = "unknown_path";
const SET_NEEDS_PATH = "MagVarUpdate refuses `_.set` on a path that does not exist yet (`setPathMissing`); only insert/assign create";

/**
 * Rows where MagVarUpdate (and so the new layer) differs from the old engine: the
 * outcome of each command, in order, and why. `commands: false` marks rows whose parsed
 * command list itself differs (the tree is then not compared either).
 */
const UPDATE_DEVIATIONS: Record<string, { reason: string; outcomes: string[]; commands?: false; tree?: unknown }> = {
  mvu_rich_arguments: {
    reason: `${SET_NEEDS_PATH}; and a single-quoted value is a YAML scalar in MagVarUpdate (\`parseCommandValue\`), so 'line1\\nline2' keeps its backslashes`,
    outcomes: [UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, "applied", UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN],
    commands: false,
  },
  mvu_garbage_lines_skipped: {
    reason: "MagVarUpdate's grammar: the path is the trimmed argument text (`42` is a path), `_.delete` takes extra arguments, `+5`/`.5` are arithmetic, `_ . set (` is not a command; and set needs an existing path",
    outcomes: [UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN],
    commands: false,
  },
  mvu_one_command_per_line: {
    reason: "ruled: MagVarUpdate scans the whole text, so several commands on one line all apply",
    outcomes: ["applied", "applied"],
    commands: false,
  },
  mvu_set_vwd_with_vwd_value: {
    reason: "MagVarUpdate writes a set on a described number into its value as `Number(new)`; a pair is not a number (NaN), which a stored tree cannot hold — refused",
    outcomes: ["not_a_number"],
  },
  mvu_set_autocreates: { reason: SET_NEEDS_PATH, outcomes: [UNKNOWN] },
  mvu_set_path_whitespace: {
    reason: "MagVarUpdate trims only the ends of the path text (`trimQuotesAndBackslashes`); lodash keeps the spaces inside, so `世界 ` is not `世界`",
    outcomes: [UNKNOWN],
    commands: false,
  },
  mvu_insert_append_and_index: {
    reason: "MagVarUpdate splices a NUMBER index (negative counts from the end, as JavaScript splice); the text key '0' is refused here (in MagVarUpdate it would overwrite element 0 as an array property)",
    outcomes: ["applied", "applied", "bad_index", "applied", "applied"],
    tree: { tags: ["a", "b", "c", "d", "neg", "last"] },
  },
  mvu_insert_dict_and_wrapped: {
    reason: "MagVarUpdate does not unwrap a described value for insert: the item is pushed onto the pair itself",
    outcomes: ["applied", "applied", "applied"],
    tree: { vwd_list: [["x"], "desc", "y"] },
  },
  mvu_add_numbers: {
    reason: "MagVarUpdate rounds a sum to 12 significant digits (`toPrecision(12)`): 0.1 + 0.2 is 0.3",
    outcomes: ["applied", "applied", "applied"],
    tree: { hp: 7, 理: { 好感度: [38, "对主角的好感"], 情绪: { pleasure: [0.3, "[-1,1]"] } } },
  },
  mvu_add_toggles: {
    reason: "ruled + MagVarUpdate: `_.add` only adds numbers (`addUnsupportedValue` for a boolean target, `deltaNotNumber` for a boolean delta); a number never becomes a boolean",
    outcomes: ["unsupported_target", "unsupported_target", "delta_not_number"],
  },
  mvu_add_toggle_false_delta: {
    reason: "as mvu_add_toggles",
    outcomes: ["unsupported_target", "delta_not_number"],
  },
  mvu_move_node: { reason: "MagVarUpdate's text grammar has no `_.move` (its command pattern is set|insert|assign|remove|unset|delete|add)", outcomes: [], commands: false },
  mvu_move_list_append: { reason: "no `_.move` in MagVarUpdate's text grammar", outcomes: [], commands: false },
  mvu_move_errors: { reason: "no `_.move` in MagVarUpdate's text grammar", outcomes: [], commands: false },
  mvu_move_failed_destination_keeps_source: { reason: "no `_.move` in MagVarUpdate's text grammar", outcomes: [], commands: false },
  mvu_json_chunk_single_quotes: { reason: SET_NEEDS_PATH, outcomes: [UNKNOWN] },
  mvu_json_chunk_bad: {
    reason: "MagVarUpdate falls back to YAML, which reads `{k: v}` as a mapping, so the line IS a command (then refused: set needs an existing path)",
    outcomes: [UNKNOWN],
    commands: false,
  },
  mvu_json_chunk_nested_brackets_in_string: { reason: SET_NEEDS_PATH, outcomes: [UNKNOWN] },
  mvu_empty_initial_tree: { reason: SET_NEEDS_PATH, outcomes: [UNKNOWN, UNKNOWN, "applied"], tree: { a: { c: [] } } },
  mvu_non_dict_initial_tree: { reason: SET_NEEDS_PATH, outcomes: [UNKNOWN] },
};

function commandView(command: { op: string; path: string; args: readonly string[]; reason: string }) {
  return {
    op: command.op,
    path: command.path,
    args: command.args.map((arg) => {
      const value = parseCommandValue(arg);
      return value.ok ? toJson(value.value) : "<undefined>";
    }),
    reason: command.reason,
  };
}

describe("st_mvu_update", () => {
  const rows = readReference<Row>("st_mvu_update");
  test("covers every row", () => {
    expect(rows.length).toBe(49);
  });
  for (const row of rows) {
    test(row.case, () => {
      const deviation = UPDATE_DEVIATIONS[row.case];
      const loaded = asTree(row.input.tree);
      // `loaded_tree` is the old load-time normalization: a non-mapping loads as empty.
      expect(toJson(loaded)).toEqual(row.loaded_tree);
      const out = applyReplyUpdates(loaded, withSemicolons(row.input.text));
      const outcomes = out.results.map((result) => (result.outcome.status === "applied" ? "applied" : result.outcome.code));

      // The cleaned text is compared on every row.
      expect(out.text).toBe(withSemicolons(row.cleaned_text));

      if (deviation?.commands !== false) {
        // The old path kept its surrounding spaces; MagVarUpdate trims the ends (only).
        const expected = row.commands.map((command: Row) => ({ ...command, path: command.path.replace(/^[\\"'` ]*(.*?)[\\"'` ]*$/, "$1") }));
        expect(out.results.map((result) => commandView(result.command))).toEqual(expected);
      }
      if (deviation) {
        expect<string[]>(outcomes).toEqual(deviation.outcomes);
        if (deviation.tree !== undefined) expect(toJson(out.tree)).toMatchObject(deviation.tree as object);
        expect(out.changed).toBe(outcomes.includes("applied"));
        return;
      }
      expect(outcomes.filter((outcome) => outcome === "applied").length).toBe(row.applied.length);
      expect(outcomes.length - row.applied.length).toBe(row.errors.length);
      expect(toJson(out.tree)).toEqual(row.tree_after);
      expect(out.changed).toBe(row.persisted);
    });
  }
});
