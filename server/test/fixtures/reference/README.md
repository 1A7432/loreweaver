# Reference vectors

Behaviour recorded from the frozen Python engine, for the TypeScript rebuild's tests.

## SillyTavern compatibility (`st_*`)

Written by `scripts/oracle/stcards.py` (`.venv/bin/python -m scripts.oracle.stcards`). Each file is
JSON Lines; every row has a short `case` id, a one-line `note`, an `input` object that is enough
to rebuild the case without the Python code, and the recorded outcome. Inputs come only from
public test fixtures (`tests/fixtures/studio_export.*`, `tests/fixtures/overlay_card.py`),
literals copied from public tests under `tests/`, and literals written in the exporter.

| File | Rows | Covers |
|---|---|---|
| `st_card_parse.jsonl` | 63 | Card bytes -> parsed card or error. ST v1/v2/v3 JSON, PNG `tEXt`/`zTXt`/`iTXt` (`chara`, `ccv3`), the native `loreweaver.card` lorecard |
| `st_card_split.jsonl` | 40 | `op=split_card`: card -> `kind` (`world`/`character`), payload counts, the stripped character half, and what a PLAYER import versus a keeper WORLD import stores (lore entries, MVU tree, hooks). Also `op=strip_ejs` and `op=is_variable_declaration_entry` |
| `st_worldbook_import.jsonl` | 40 | Lorebook import normalization: ST-native and V2 field names, clamps, decorators, `{{char}}` binding, secrecy/constant trust rules, `[InitVar]` consumption, caps, re-import |
| `st_worldbook_activation.jsonl` | 72 | Activation over a SEQUENCE of turns: keys, secondary-key logic, case/whole-word, scan depth, probability, inclusion groups, ordering, limit/budget, secrecy, conditions, EJS/macro rendering, `activewi`, sticky/cooldown/delay |
| `st_macros.jsonl` | 43 | `{{...}}` macro substitution |
| `st_decorators.jsonl` | 15 | Leading `@@decorator` lines |
| `st_mvu_initvar.jsonl` | 39 | `[InitVar]` text -> tree (JSON5-lite route, then YAML route); InitVar title detection |
| `st_mvu_update.jsonl` | 49 | A reply with `<UpdateVariable>` blocks + an initial tree -> parsed commands, cleaned text, applied commands, errors, resulting tree |
| `st_mvu_tree.jsonl` | 21 | `flatten_leaves`, `normalize_tree`, `path_is_exposed`, `prune_tree_to_exposed` |
| `st_ejs_full.jsonl` | 54 | Full EJS in the QuickJS sandbox (vendored ejs + lodash + the ST API bridge) |
| `st_ejs_lite.jsonl` | 54 | The subset renderer on the same templates (one row per template) |

### Shared shapes

- A stored lore entry (`entries`, `stored_entries`, `entries_after`) is the engine's entry model
  without its random `id`: `title, content, keys, secondary_keys, selective_logic` (`and_any |
  and_all | not_any | not_all`), `constant, enabled, secret, condition, priority, probability,
  case_sensitive, match_whole_words, scan_depth, position` (`before | "" | after`), `sticky,
  cooldown, delay, group, group_weight, category, scope` (always `session` for imports).
- Errors are `{"type", "message"}` with the Python exception class and message. Treat `message`
  as informative; the class (and for EJS, `error_class`) is the contract.
- Variables are `{"flat": {...}, "tree": {...}}`: `flat` are module variables (checked first),
  `tree` is the MVU tree. Reads strip a leading `variables.` / `stat_data.`, numeric segments
  index lists, and a `[value, "description"]` leaf reads as `value`.

### Scripted randomness

No vector depends on a real random stream. Where the engine draws, the draw comes from a script
and is recorded in order:

- `{"method": "randint", "args": [1, 100], "value": v}`: a worldbook `probability` roll. The
  entry survives when `v <= probability`. Rolls happen only for entries with `0 < probability <
  100` that are not sticky-active, in stored-entry order, BEFORE the secrecy/condition filters.
- `{"method": "choices", "population": [titles], "weights": [...], "index": i, "value": title}`:
  an inclusion-group pick (one per group with two or more surviving members, groups in order of
  first appearance).
- `{"method": "choice", "options": [...], "index": i, "value": ...}`: `{{random}}` / `{{pick}}`.
- `{"method": "roll", "expr": "1d20", "value": 17, "raised": false}`: `{{roll:...}}`. The real
  engine uses its dice roller here; the total is scripted (dice semantics live in the `dice_*`
  vectors). `raised: true` means the roller failed and the macro passed through untouched.

In activation rows, `draws` are worldbook draws and `macro_draws` are macro draws, per turn. The
turn's `script` / `macro_script` / `rolls` inputs are exactly the values consumed.

### Clock

`{{time}}` / `{{date}}` read the GAME clock string (`macros.clock_time` /
`macro_context.clock_time`), never the wall clock; it is pinned to a literal. Templates in the
EJS vectors avoid `Date`, `Math.random` and lodash's random helpers, so nothing reads the wall
clock or an unscripted random source.

### File details

**`st_card_parse`**: `input.text` (UTF-8 input) or `input.b64` (binary/PNG) plus `filename`.
`dispatch` is `lorecard` when the bytes contain `loreweaver.card` and parse as a JSON object
whose `format` equals it, else `st`. `card` holds the parsed fields (`raw` only for PNG, where
it is the embedded document); lorecards add `lorecard.{alternate_greetings, hooks,
variable_specs, pregens, warnings}`.

**`st_card_split`**: `kind` is `world` exactly when `payloads.any` (hooks, variable declarations,
EJS spans or secret entries; directives never count). `player_import` runs the CHARACTER HALF's
book with player trust and `char_name` = card name; `keeper_world_import` runs the ORIGINAL book
with keeper trust and also lists the hook scripts a world import installs.

**`st_worldbook_import`**: `input.steps` run in order against one empty room; each step records
`count` (entries stored), `skipped_titles` (over the content cap), `unreachable_titles` (disabled
and keyless), the whole book and MVU tree afterwards.

**`st_worldbook_activation`**: the lorebook is imported first (`input.import`: keeper trust by
default), then each turn runs the per-turn injection with `context` (the recent transcript),
`viewer` (`keeper`/`player`) and `advance_timers` (default true; false is a browse call that
neither ticks the turn counter nor starts windows). Per turn: `activated` (selected titles in
final order), `activewi_requested` / `activewi_injected` (the one extra `activewi()` pass),
`injected_text` (the full section, English header lines `World Lore` + instruction, then one
rendered entry per line group), `template_writes` (full-EJS `setvar` writes, applied to the tree
after the turn), `turn_counter_after`, `mvu_tree_after`. `limit` / `budget_chars` default to the
keeper turn's 12 entries / 12000 chars; the budget counts RAW content length. With `full_ejs` the
template library is every stored entry (disabled ones included) keyed by title. No vector
database is attached, so only keyword/constant selection is exercised.

**`st_macros`**: `names` is the legacy names argument; `macro_context` (or null) carries `names`,
`clock_time`, and whether an rng / roller is attached.

**`st_mvu_update`**: `loaded_tree` is the initial tree after load-time normalization;
`persisted` is whether anything applied (nothing is saved otherwise); `tree_after` is the result.

**`st_ejs_full`**: one engine per row; `input.templates` render in order on that engine (state
such as `define()` carries over), then `conditions` evaluate. A render is `{ok, text, warnings}`
or `{ok: false, error_class: syntax | runtime | timeout, error_message}`. The time limit is 1 s
per eval. `pending_writes` is capped at 64.

**`st_ejs_lite`**: `text`/`warnings` are the read-only render (how worldbook injection uses it);
`with_setter` renders again with a setter that records writes and makes them visible to later
reads in the same template.

### Behaviours worth knowing before porting

These are what the Python implementation does today, recorded as-is (not fixed):

- ST world-info `disable: true` is not read (only `enabled`), so a disabled native ST entry
  imports enabled. ST-native `order` is not read either (`priority`, then `insertion_order`).
- Trigger fields that ST writes under a V2 entry's `extensions` (`probability`, `useProbability`,
  `selectiveLogic`, `group`, `sticky`, `scan_depth`, `position`, `depth`, ...) are ignored; only
  `extensions.secret` / `extensions.category` are read. ST insertion `depth` and positions 2-7
  have no effect (default bucket).
- `groupWeight: 0` imports as 100 (falsy -> default); a negative weight becomes 1.
- Whole-word matching uses a Unicode `\b` over the haystack, so `gun` does not match in
  `他拿起gun了` (CJK letters count as word characters).
- Grouped entries are moved behind ungrouped ones before the stable sort, so they lose ties.
- A two-element list whose second item is a string is ALWAYS a `[value, description]` leaf:
  `["甲", "乙"]` reads as `"甲"`, `getvar('list.1')` is empty in both renderers, `_.add` on
  `["a", "c"]` reports "target 'a' isn't a number".
- Macro and subset-EJS output uses Python `str()`: `True`/`False`, `2.0` for `4 / 2`, and
  Python dict/list reprs. Full EJS prints `true` and `2`. `{{getvar::flag}}` prints `True` even
  when the full engine rendered the rest of the entry.
- A variable value that itself contains macros is partially expanded by later passes
  (`{{user}}` inside a `getvar` result is substituted; a nested `getvar` is not).
- The subset renderer can leak raw template syntax: an unclosed `<%=` stays in the text, and a
  template over 20000 chars is returned verbatim. It does not support `<%%` literals (silently
  dropped), does not strip whitespace before `<%_`, cannot index a `[value, description]` pair
  with `[0]`, and passes `variables.`-prefixed names to its setter unstripped.
- Full EJS: `print()` returns its argument but outputs nothing unless used in `<%= %>`; bare
  variable names are not defined (use `getvar` / `variables.x`); the `<#escape-ejs>` block is a
  subset-only feature and passes through the full engine literally.
- `_.add` with a boolean delta toggles a number into a boolean (`10 + true` -> `false`); only the
  first `_.op(...)` on a line is parsed; `_.set` with an expected-old value never rejects.
- `[InitVar]` YAML is YAML 1.1: `yes`/`no` are booleans, `010` is 8, `1e3` is a string, duplicate
  keys last-win. JSON `NaN`/`Infinity` parse and are then dropped by normalization.
- Card parse: a non-string field is `str()`-ed (Python repr for objects, `True` for booleans),
  and an empty `creator_notes` falls back to the str()-ed `creator_notes_multilingual` object.
  Invalid JSON under a `.json` name raises the raw JSON decode error, not a wrapped one.
- Card split: hook scripts are looked up in one place only (top-level `hooks`, else
  `data.extensions`, else root `extensions`); a v2 card with a `data.extensions` object hides
  root-level `extensions.loreweaver_hooks` from both the classifier and the keeper import.
  `extensions.secret` entries are not counted as world machinery by the split (the player import
  drops them anyway). EJS inside `raw` (e.g. `alternate_greetings`), entry titles and keys is not
  stripped from the character half.

### Not covered

- Semantic (vector) recall of lore entries: no vector database is attached.
- The M26 keeper lore overlay (`.lore enable/bind`, pack `overlay:` files).
- Real dice totals behind `{{roll}}` (scripted here; see the dice vectors).
- `Math.random`, `Date` and lodash random helpers inside full EJS (unscriptable through the
  engine's API).

<!-- BEGIN rules-sheets-dice -->
## Rules, sheets and dice (`rules_*`, `sheets_*`, `dice_*`)

Written by `scripts/oracle/{rules,sheets,dice}.py`. The whole set (these files, the `st_*` files and
`MANIFEST.json`) is regenerated with `.venv/bin/python -m scripts.oracle`; two runs on one commit are
byte-identical. `MANIFEST.json` records the Python and `d20` versions, the git commit, and per file the
row count and the SHA-256 of the UNCOMPRESSED JSON-lines text.

### Reading the files

- JSON Lines, UTF-8, `\n`, keys sorted. A file whose text exceeded about 1 MB is stored as
  `<name>.jsonl.gz` instead of `<name>.jsonl`; a loader must accept either.
- `null` is Python `None`. Where a call can fail the row carries `error: {"class", "message"}`
  (Python exception class name, English message) and the result field is `null`. The class is the
  contract; the message is informative. Classes you will meet: `ValueError`, `RollValueError` /
  `TooManyRolls` (from the `d20` library), `ResolutionError`, `MissingRollParamError`,
  `InvalidRollParamError`, `RulesScriptError`.
- `kind` names the row type; files that mix row types always carry it.
- Built-in packs are the `rulepacks/{coc7,dnd5e,wod}.yaml` files. Ids ending in `synth`, `pool` or
  `script` are LITERAL packs written in the exporter; their YAML (and the one JavaScript file) is
  recorded verbatim in `rules_synthetic` / `rules_script_lane` (`kind: "pack"`), so a test can load
  them through its own pack compiler.

### Scripted randomness

No vector depends on CPython's `random` stream. Every draw the engine made is recorded, in call order,
in the row's `draws` as `[lo, hi, value, step]`:

- `lo`, `hi`: inclusive bounds of the value the engine used. `step`: stride between possible values
  (1 everywhere except percentile dice).
- Plain draws (`DiceRoller` tens dice, success pools, Fate dice) are `randint(lo, hi)`.
- A die rolled inside the `d20` library is recorded as the FACE: `[1, sides, face, 1]` (the library
  asks for a zero-based index and adds 1). A percentile `d%` die is `[0, 90, tens, 10]` (a multiple
  of 10; the library's `d%` is a tens die, distinct from `d100`).
- To replay: answer the k-th draw request with `draws[k][2]` and check the request's bounds equal
  `draws[k][0..1]`; the list is exactly what was consumed (for an error row, what was consumed before
  the error). Dice-count limits are the library's: more than 1000 dice in one expression raise.
- `seed` and `forced` say how the exporter produced the draws and are informational: `forced` (or
  `null`) pins the leading draws, the rest come from `value = lo + step * (SplitMix64(seed * 2^32 + k)
  mod n)` with `n = (hi - lo) / step + 1` and `k` the 0-based draw index (the standard SplitMix64
  finalizer: add `0x9E3779B97F4A7C15`, then the two xor-shift-multiply rounds with
  `0xBF58476D1CE4E5B9` and `0x94D049BB133111EB`, then `^ >> 31`). Replaying the recorded draws is
  enough; the generator is documented only so cases can be extended.
- One place in the `d20` library is not deterministic in the real engine: `rr` / `ro` reroll the
  matching dice in the iteration order of a Python `set` of objects, which follows memory addresses, so
  with two or more matching dice the assignment of draws to dice changes from run to run. The
  exporter pins it to LEFT-TO-RIGHT die position. Implement that order.

### `dice_vectors` (`.jsonl.gz`)

One row per call of a `DiceRoller` entry point (`core/dice_engine.py`):

`{id, fn, args, seed, forced, draws, result, error}`.

| `fn` | `args` | `result` |
|---|---|---|
| `roll_expression` | `{expression, is_check}` | a **DiceResult** |
| `roll_detail` | `{expression, params}` (`params`: object or null) | a **RollDetail** |
| `roll_for_check` | `{pack, params, modifiers}`; `modifiers` is an ORDERED list of `[name, count]` pairs (iterated in order; if two modifiers both override the roll expression the last one wins). Counts may be odd JSON values (`"2"`, `true`, `null`, `2.9`) | a **RollDetail** |
| `roll_advantage`, `roll_disadvantage` | `{expression, is_check}` | `{kept, kept_index, candidates}`: both candidates (two rolls of the expression, in order) as DiceResults; the higher (lower) total is kept, the FIRST on a tie |
| `roll_explode` | `{expression, max_explosions}` (`null` = default 10) | a DiceResult |
| `roll_fate` | `{dice_count, modifier}` | a DiceResult |
| `roll_repeat` | `{expression, times}` (1..20 else `ValueError`) | list of DiceResults |
| `roll_d100_tens_reroll` | `{net}` | `{roll, final_roll, tens, ones, extra_tens, final_tens}` |

**DiceResult** (`DiceResult` plus its methods; the wall-clock timestamp is left out):
`expression` (the text as given), `rolls` (the KEPT faces of the first dice group in left-to-right
tree order; `[0]` when the expression has no dice), `modifier` (`total - sum(rolls)`, so it absorbs
every other term, even negation: `-1d6` is `rolls [5]`, `modifier -10`), `dice_count` (number of kept
faces; 0 without dice), `dice_sides` (6, 20, ... ; 100 for `d%`; 0 without dice; for a success pool
the die size), `total` (the library total truncated to an int; for a pool the success count),
`is_check`, `all_rolls` (every face of that first group including dropped dice, BUT a dropped die
shows as `0`; `null` for pools / Fate / when not set), `critical_success`, `critical_failure`
(`is_critical_success()` / `is_critical_failure()`: only for `is_check` results with `dice_count` 1;
d100 crits on 1 and fumbles on 100, other sizes crit on the max face and fumble on 1),
`text.{en,zh}.{detail,simple}` (`format_result(show_details=True/False)`).

Pool shortcut: `roll_expression("NdM>=K")` / `<=` with a 1-3 digit count and 1-4 digit size and
threshold is a success-counting pool (`rolls` = faces, `total` = successes, `modifier` 0,
`is_check` false). `1d20>10` (a comparison that is not a pool) goes to `d20` and yields total 1 or 0
with a backfilled `modifier`.

**RollDetail**: `expression` (lower-cased, `{slot}`s substituted, `!` rewritten for `roll_detail`),
`dice` (the kept faces, i.e. `DiceResult.rolls`, so `[0]` for an expression without dice), `total`, `modifiers` (a dict: `modifier` when a flat term exists and is not 0, `dice_all` (zero-filled
dropped faces, see above) when dice were dropped, `threshold` for pools, `base_roll` /
`extra_tens` / `final_tens` for a bonus/penalty tens-die roll, plus the applied pack modifier counts
by name), `successes`, `ones` (pools only, else `null`).

### `dice_normalize`

`{input, output}`: the pure SealDice-to-`d20` rewrite (`x` / `X` / `×` between digits or parentheses
becomes `*`; a bare `kN` becomes `khN`). `input` is expected lower-cased by the callers; the vectors
include upper-case input (`3d6X5` is unchanged) to show the function itself does not lower-case.

### `dice_result_flags`

`{enable_critical_effects, input, result}`: a `DiceResult` built directly from
`input {expression, rolls, modifier, dice_count, dice_sides, is_check}` with the global
`ENABLE_CRITICAL_EFFECTS` switch set as recorded; `result` is a DiceResult object as above (no
randomness).

### `rules_pack_meta`

One row per built-in pack (`kind: "pack_meta"`): `names`, `set_keys`, the compiled resolver's
`roll`, `compare`, `target_kind` (`skill`/`dc`/`none`), `modifiers` (as in the YAML), `variants`
(sorted ids), `has_margin_expression`, `ladders` (key `""` = default ladder, else variant id; each an
ordered list of `{id, tier, success, critical, fumble, conditional}`; the last rule is the
unconditional fallback), `difficulties` (`{id, has_target_transform, prefixes}`), `params`
(`{id, min, max, default}`), `check` (`favorable`, `unfavorable`, `default_target`, `proficiency`,
`default_skill`), `rank_labels` and `display_names` (lists of `{locale, ...}` over the locales `en, zh,
zh-CN, zh_TW, EN, fr, "", null`: locale matching is the base language before `-`/`_`, case-folded,
falling back to `en`, then to the id), `initiative_roll`, `commands`, `subsystems` (template,
parameters, draw tables, per-locale labels).

### `rules_coc7_grid` (`.jsonl.gz`), `rules_dnd5e_grid`

`{kind: "interpret_grid", pack, variant, difficulty, target, modifier, effective_target, legend, rank,
margin}`. Each row is `CheckResolver.interpret(RollDetail(expr, dice=(roll,), total=roll), target,
variant=, difficulty=, modifier=)` for every roll: **coc7** `roll` 1..100 (`expr` `1d100`),
**dnd5e** the natural face 1..20 (`expr` `1d20`). `rank[i]` is an index into `legend` for roll `i+1`,
`margin[i]` the outcome's margin; `legend` entries are `{id, tier, success, critical, fumble}`.
`effective_target` is `effective_target(target, difficulty=)` (the difficulty-transformed target).
`variant` / `difficulty` `null` = the pack default ladder / no transform.

- coc7: variants `null` + the six declared (`dg`, `rule1`..`rule5`), difficulties `null`, `regular`,
  `hard`, `extreme`, `critical`, targets -10, -1 and 0..120, `modifier` 0; plus `modifier` -7 and 13 for
  every variant at difficulty `null`, targets 0..120.
- dnd5e: `modifier` -10..20 (the flat add folded into `roll`), DC (`target`) -2..35, no variants or
  difficulties.

### `rules_wod_grid`

`{kind: "pool_grid", pack: "wod", pool, target: null, legend, cells}` for pools 1..20. `cells` is a
list of `[successes, ones, legend_index, margin]` for every `successes` 0..pool and `ones` 0..pool-successes,
graded as `interpret(RollDetail(f"{pool}d10>=6", dice=(0,)*pool, total=successes, successes=,
ones=), None)`.

### `rules_interpret_cases`

Single-cell edge cases of `interpret`. `{kind: "interpret_case", pack, rolled {expression, dice, total,
successes, ones}, target, variant, difficulty, modifier, effective_target, outcome, error}`; `outcome` is
`{rank, margin, target}` (`rank` as in a legend entry) or `null` with `error` set. Covered: unknown /
empty / differently-cased variant and difficulty ids (an unknown variant falls back to the default
ladder, an unknown difficulty is the identity), no target (only a rank that never reads `target` can be
graded; otherwise `ResolutionError`), negative / huge targets, rolls outside the die range, totals
that do not match the kept dice, empty `dice`, WoD `successes` / `ones` of `null` or inconsistent.

### `rules_check_roll` (`.jsonl.gz`)

- `{kind: "favor_modifiers", check {label, favorable, unfavorable}, bonus, penalty, modifiers,
  applied, error}`: `favor_modifiers(CheckSpec, bonus, penalty)`: the net of the two counts goes to the
  pack's favorable (net > 0) or unfavorable (net < 0) modifier name, `{}`/`""` when they cancel or the
  pack declares no name. Counts include odd values (`"2"`, `2.7`, `true`, `null`; conversion is
  `int(...)`, so some raise).
- `{kind: "graded_roll", args {pack, modifiers, target, modifier, variant, difficulty}, seed, forced,
  draws, result, error}`: `graded_roll(DiceRoller(), resolver, ...)`; `modifiers` is an ordered pair list
  as in `dice_vectors`. `result` is `{rolled (a RollDetail), total (rolled.total + modifier), target,
  effective_target, outcome}`; `outcome` is `null` when `target` is `null` (an ungraded roll), else
  `{rank, margin, target, rolled, wire}` where `wire.{en,zh}` is `outcome_wire(outcome, rank_label)`.
  Note `graded_roll` never passes pool params, so a WoD roll is always the declared defaults
  (1 die, difficulty 6).

### `rules_params`

`{kind: "clamp_params", pack, values, result, error}`: `resolver.clamp_params(values)` (each declared
slot: value or default, `int()`ed, clamped into `[min, max]`; a slot with no value and no default
raises `MissingRollParamError`, a non-integer `InvalidRollParamError`; both carry `error.param`), and
`{kind: "effective_target", pack, target, difficulty, result}`.

### `rules_luck` (`.jsonl.gz`)

`core/luck.py`, pure. `{kind: "adjust", check, points, adjustment, check_after, error}`:
`adjust_check_with_luck(check, points, grade=...)` with `grade` = the coc7 resolver interpreting a
d100 at the check's own `target` / `variant` / `difficulty`; `check_after` is the mutated check dict
(also on error, where it shows what was changed before the failure). `adjustment` is `{before_roll,
after_roll, before, after, total_spent}`. `{kind: "eligible", check, result}`:
`is_luck_eligible_check`. `{kind: "find_latest", checks, user_id, char_name, result}`:
`find_latest_character_check`, `result` being the matched check's `n` or `null`.

### `rules_subsystems` (`.jsonl.gz`)

The pack-declared subsystem tools run end to end through the real dispatcher
(`agent.kp_tools_subsystems.dispatch_subsystem`) on an in-memory service graph:
`{kind: "flow", pack, subsystem, locale, variant, arguments, sheet_input, prior_check, seed, forced,
draws, reply, error, dice_payloads, sheet_before, sheet_after, skill_checks, player_stats}`.

- `subsystem`: `sanity_check` (`check_with_loss`), `skill_growth` (`improvement_check`), `spend_luck`
  (`resource_spend_adjust`), `opposed_check`, `random_madness` (`table_draw`) on coc7 / dnd5e, and on the
  literal pack `oraclesynth`: `stress_check`, `grow`, `spend_fate`, `clash`, `omen`.
- `sheet_input` is saved first as the active character (so `sheet_before` is it after the save-time
  refresh); `variant` is the room's house-rule ladder; `prior_check` (spend flows) is a check recorded
  into the session before the call: `{char_name, skill, target, roll, details}`.
- `reply` is the localized tool text (`locale` `en` or `zh`, alternating); `dice_payloads` the dice
  frames the tool emitted; `sheet_*` are `to_dict` shapes without timestamps; `skill_checks` /
  `player_stats` are the session record afterwards (timestamps and ids removed).
- `error` is only set when the dispatcher itself raised; tool-level failures are plain `reply` text.
- `draws` are consumed in this order: the check roll, then the loss / growth roll(s). Forced draws that
  fall outside a draw's range were clamped into it; `draws` has what the engine really received.

### `rules_synthetic` (`.jsonl.gz`)

Literal packs for DSL features the built-in packs do not use. Row kinds: `pack` (`pack`, `yaml`,
`files`), `pack_meta` (as in `rules_pack_meta`), `interpret_grid` (as above, for `oraclesynth`: a
dc-kind d20 system with difficulty transforms `easy/hard/brutal/thirds/swing/flat/plain`, a `lenient`
variant, a `margin` expression, tier defaults; natural 1..20), `pool_grid` (`oraclepool`, a
`{pool}d6>={need}` pool with params and a `margin` expression; pools 1..8), `interpret_case`,
`roll_for_check` (`{args {pack, params, modifiers}, seed, forced, draws, result, error}`),
`graded_roll`, `favor_modifiers`, `clamp_params`, `effective_target`.

### `rules_script_lane`

The QuickJS resolution script lane. First row: `kind: "pack"` for `oraclescript` with its
`resolve.js`. Then `interpret_case` rows (as in `rules_interpret_cases`) whose outcome came from running
that script; `variant` steers deliberately malformed returns. The engine passes the script one JSON
object `{roll, dice, total, target, raw_target, modifier, successes, ones, variant, difficulty}` and
validates the return. `validate_rank_result` rows (`raw` -> `result` / `error`) and
`validate_flow_effect` rows pin the validators' exact accept / reject / clamp rules.
(The pack id inside the validator's messages is the literal `script`.)

### `sheets_cases`

First one `probe_names` row per pack: `{kind, pack, names, canonical, resolved}`. `names` is the
probe list (canonical names, derived names, aliases, storage keys, plus samples with CJK aliases and
junk); `resolved[i]` is `RulePack.resolve_skill(names[i])` (alias lookup: strip, case-fold, `_` to space,
full-width `：（）` to ASCII, collapse spaces; `null` if unknown); `canonical[i]` is `resolved[i]` or
`names[i]` itself.

Then one `sheet_case` row per literal sheet: `{kind, pack, case, input, loaded, canonical_values, derived,
hit_points, refreshed, probe, wire, validate}`.

- `input`: the sheet as plain JSON (`CharacterSheet.to_dict` shape without timestamps: `name, system,
  attributes, secondary_attributes, hp_current, hp_max, skills, equipment, background, notes, avatar,
  fields`). Build it with `CharacterSheet.from_dict`: the constructor first creates the pack's fresh
  sheet, then `attributes`, `secondary_attributes`, `skills`, `equipment` are REPLACED wholesale by the
  dict's values (a missing key becomes `{}`, not the defaults), each entry of `fields` is set one by
  one, and for packs with a `hit_points` section the hit-point fields are adopted from `hp_current` /
  `hp_max`, else the legacy secondary keys `生命值`/`生命值上限`, else attributes `HP`/`HPMAX`, else the
  pack default (a lone value copies to the other), then written through `set_hit_points(...,
  allow_raise_max=True)`, which also deletes those legacy slots. No refresh happens on load.
- `loaded`: that sheet right after `from_dict` (the `to_dict` shape). Every later value is computed from
  `loaded`.
- `canonical_values`: `canonical_values(sheet, pack)`: the sheet's SOURCE values in the pack's canonical
  names (attributes via `attr_keys`, skills via `skill_keys`, secondary via `secondary_keys`, meta fields
  via `field_keys`); derived slots are not read. `derived`: `pack.compute_derived(canonical_values)`
  (declaration-order DAG fold: later formulas see earlier results; a missing / non-numeric input falls
  back to the pack default, then 0).
- `hit_points`: `[current, max]` from `get_hit_points`.
- `refreshed`: `refresh_sheet(sheet, pack, initialize_vitals=, preserve_trained=)` in place, result as a
  sheet; keys `init{0|1}_keep{0|1}` = `initialize_vitals` / `preserve_trained`.
- `probe`: three arrays aligned with the pack's `probe_names.names`: `value[i] = sheet_value(sheet, pack,
  canonical[i])`, `check_value[i] = check_value(...)` (an ability check on a pack with a `check_values`
  bridge reads its modifier), `has_check[i] = has_check_value(sheet, pack, names[i])` (note: the RAW name).
  An element `{"$error": {class, message}}` replaces a value when the call raised (none do today).
- `wire`: `{loaded: [...], refreshed: [...]}`, each a list of `{locale, resources}` over the locales
  `null, en, zh, zh-CN, zh_TW, fr, ja`: `wire_resources(sheet, pack, locale)` = `[{id, label, value,
  max}]` (the refreshed side uses `refresh_sheet(sheet, pack)` defaults). Labels resolve per VIEWER
  locale: exact base language, else `en`, else any declared one.
- `validate`: one entry per mode `{initialize_vitals, creation_method, result}` where `result` is
  `{sheet, violations}` from `validate_sheet(sheet, system=pack, initialize_vitals=, creation_method=)`:
  the clamped sheet and the violations in report order as `{code, path, original, corrected, limit}`
  (`code` is `attribute|skill` + `_not_numeric|_below_min|_above_max`, `<budget id>_exceeded`, or
  `point_buy_budget_exceeded`; `limit` is `[min, max]` for clamps or the budget number).

The `wod` pack has no `sheet:` section: sheets stay bare dicts, nothing derives, `wire` is empty.

### `sheets_derived`

`{kind: "derived", pack, values, derived}`: `pack.compute_derived(values)` on its own, `values` being a
canonical-name dict (often partial, so defaults are exercised): coc7 damage-bonus / build bands and every
boundary, MOV, HP / MP / SAN maxima, copies and halves, and odd values (`"50"`, `"abc"`, `null`, `true`,
`12.7`, `-5`, `10^12`, lists, objects); dnd5e ability modifiers (floor toward -infinity, negatives),
proficiency by level, derived skills; `oraclesynth` `floor_div`, `half_of`, banded string results,
`if`/`min`/`max`/`abs`/`ceil`.

### `sheets_aliases`

Row kinds: `resolve_skill` (`{pack, name, canonical}`: every alias of every pack plus upper-cased and
padded variants, normalization probes, junk); `load_rulepack` (`{name, pack, error}`: lookup by id,
declared `names:` or `set_keys:`, case/space-insensitive); `built_in_ids`; `available_systems_contains`;
`resource_label_map` (`{system, locale, labels}`).

### `sheets_ops`

- `{kind: "set_sheet_value", pack, case, canonical, value, sheet_after, error}`: `set_sheet_value` on
  the `loaded` sheet of the named `sheets_cases` row (routes to the declared storage slot and refreshes).
- `{kind: "set_hit_points", pack, case, operation, result, sheet_after, error}`: `set_hit_points(sheet,
  **operation)` (`current`, `maximum`, `delta`, `allow_raise_max`); `result` is `[current, max]`.
- `{kind: "new_sheet", system, name, sheet}`: `CharacterSheet(name, system)` for several spellings of
  the system (an unknown system gives bare empty dicts).
- `{kind: "generate_character", system, name, seed, forced, draws, sheet, error}`:
  `CharacterManager.generate_character`: each attribute with a creation `roll:` in declaration order via
  `roll_expression`, then `refresh_sheet(initialize_vitals=True, preserve_trained=False)`; an unknown
  system raises `ValueError`.

### Behaviours worth knowing before porting

Recorded as-is from the Python engine; none were fixed.

- `all_rolls` / `modifiers.dice_all` list a dropped die as `0`, not its face (`2d20kh1` -> `[20, 0]`).
- `NdM>=K` / `<=` is a success pool in `roll_expression`, never a `d20` comparison; `1d20>10` is.
- `roll_expression` wraps `d20` errors raised while rolling (bad syntax, more than 1000 dice) as
  `ValueError("Invalid dice expression: ...")`, but a zero divisor surfaces later, when the total is
  read, as an unwrapped `RollValueError`; `roll_explode` lets `TooManyRolls` through unwrapped too.
- `roll_detail` accepts `!` (`5d6!` = explode on the max face) and `{slot}`s; `roll_expression` does not.
  `roll_detail("0df")` rolls FOUR fate dice (a zero count is replaced by the default 4).
- `graded_roll` never wires pool params, so WoD checks through it are always 1 die at difficulty 6.
- `skill_growth` reads and writes `skills[<canonical name>]` without the pack's storage-key bridge:
  growing `信用评级` reads 0 and adds a second `信用评级` entry next to the real `信用` skill.
- `sanity_check` fumble policy `all` drains the whole stat; `max` takes the maximum of `NdM(+K)` only
  (any other loss text falls back to the rolled loss); `loss_ceiling` is applied last.
- The localized `sanity_check` reply prints the loss expression twice (`roll: 1d6=1d6 = [3] = 3`).
<!-- END rules-sheets-dice -->
