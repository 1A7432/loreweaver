# LWF: rulepacks (rule systems as data)

**Version 2.0 · stable (additive-only).** Reference implementation: `core/rulepacks.py`,
`core/resolution.py`, `core/check_outcome.py`, `core/dice_engine.py`, `core/sheets.py`,
`core/character_rules.py`, `core/subsystems.py`, `core/rules_script.py` and
`core/condexpr.py` in the Loreweaver engine. Reference packs: `rulepacks/coc7.yaml`,
`rulepacks/dnd5e.yaml`, `rulepacks/wod.yaml`.

A rulepack is one YAML file, `<id>.yaml`, that describes a tabletop rule system
completely: its sheet shape, how a check rolls and grades, its derived stats, its
character-creation limits, its extra mechanics (subsystems) and the words players type
to use them. A runtime holds no system knowledge of its own: deleting a rulepack
deletes the system.

Two principles govern the format:

- **Nothing is evaluated as code** except through the closed expression grammar (§3)
  and the sandboxed script lane (§13). Randomness lives only in the runtime's dice
  roller.
- **The format never grows syntax for one system.** A system the data cannot express
  uses the script lane.

## 1. File, identity, parsing

- The filename stem is the system **id**. Inside a pack it MUST be a slug
  ([pack.md](pack.md) §2).
- The file is UTF-8 YAML, parsed with a safe loader that rejects anchors and aliases.
  The root MUST be a mapping.
- Unknown **top-level** keys are ignored. Each block in §2 states whether it is
  **closed**: in a closed block an unknown key is a load error, so typos fail when the
  pack is built, not at the table.
- A rulepack that fails to load is not available. Discovery MUST skip it with a log and
  MUST NOT let it prevent other rulepacks from loading (§15).

## 2. Top-level keys

| Key | Section | Meaning |
|---|---|---|
| `extends` | §14 | The id of a base rulepack to patch. |
| `names` | §2.1 | Lookup aliases for the system. |
| `set_keys` | §2.1 | Lookup aliases that system-selection commands accept. |
| `defaults` | §2.2 | Default values by canonical name. |
| `alias` | §2.1 | Canonical stat name → list of alternative spellings. |
| `display` | §12 | Presentation names per locale. |
| `labels` | §6 | Rank labels per locale. |
| `resolution` | §5 | How a check rolls and grades. Closed. |
| `derived` | §7 | Derived stats. |
| `sheet` | §8 | The sheet shape. Closed. |
| `creation_constraints` | §9 | Character limits and creation methods. |
| `subsystems` | §10 | Extra mechanics. Closed per entry. |
| `commands` | §11 | Dot-command words. Closed per entry. |
| `initiative` | §12 | `{roll: <dice expression>}`. |
| `expertise` | §12 | Per-locale text about running the system. |
| `st_show` | §12 | Sheet display hints. |
| `turn_checks` | §12 | Runtime check table rows. Closed per row. |

### 2.1 Names and aliases

**Normalization.** Every lookup normalizes text the same way: trim, Unicode casefold,
replace `_` with a space, map the full-width `：（）` to their ASCII forms, and collapse
runs of whitespace to one space.

**System lookup.** A system resolves by its id, by any entry of `names`, or by any entry
of `set_keys`. Rulepacks are visited in discovery order (§15) and the first claim of a
normalized name wins, so a built-in's names cannot be taken over.

**Stat lookup.** `alias` maps a canonical name to a list of variants, which may be
empty or `null`. The canonical name and every variant resolve to the canonical name.
Canonical names are the single identity everywhere: sheets, derived stats, checks,
labels. They MAY be CJK; that is game data, not user-interface text.

### 2.2 `defaults`

A mapping from canonical name to a default value. A runtime uses it when a sheet value
or expression name is missing (§7, §8) and as part of the system's stat vocabulary.

## 3. The expression language

Ranks, difficulties, margins, derived stats, budgets, vital starts, loss ceilings, lore
conditions and panel conditions all share one closed grammar. It looks like JavaScript
but is not JavaScript: it is a fixed tokenizer and recursive-descent evaluator, and
nothing is ever passed to an `eval`. Reference: `core/condexpr.py`.

**Limits.** An expression is at most 500 characters and at most 200 tokens.

**Tokens.**

- Numbers: `\d+(\.\d+)?`. There is no exponent form. A literal containing `.` is a float,
  otherwise an integer.
- Strings: in `'…'` or `"…"`, where a backslash escapes the next character.
- Keywords, case-insensitive: `true`, `false`, and `null`/`undefined`/`none` (all null).
- Word operators, case-insensitive: `and` (`&&`), `or` (`||`), `not` (`!`).
- Identifiers: a Unicode letter or `_`, then word characters. CJK is allowed.
- Operators: `=== !== == != >= <= > < && || ! ( ) [ ] . , + - * / %`.

**Grammar.** From lowest to highest precedence:

```
expr       := and ( "||" and )*
and        := not ( "&&" not )*
not        := "!" not | comparison
comparison := additive ( op additive )?          # op: === !== == != >= <= > <
additive   := term ( ("+"|"-") term )*
term       := factor ( ("*"|"/"|"%") factor )*
factor     := "(" expr ")" | "-" factor | literal | reference | call
reference  := ident ( "." (ident|integer) | "[" (string|integer) "]" )*
call       := "getvar" "(" string ( "," any )* ")" | fn "(" [ expr ("," expr)* ] ")"
```

A comparison does not chain. `!` applies to the whole comparison that follows it:
`!a == b` means `!(a == b)`. A reference folds into one dotted path: `a.b[0]` and
`a['b']` are the paths `a.b.0` and `a.b`. Only the function names of the evaluation
context (below) may be called, plus `getvar('path')`, which reads the path and ignores
any further arguments.

**Semantics.**

- `===` and `!==` are strict: equal type and equal value. A boolean is never strictly
  equal to a number. In the reference an integer and a float are different types, so
  `1 === 1.0` is false. Packs SHOULD NOT rely on that distinction.
- `==` and `!=` are loose: values that differ are compared again as numbers when both
  parse as numbers.
- `> < >= <=` compare two numbers (numeric strings and booleans coerce), or two strings.
  Anything else is an error.
- `+` concatenates when both operands are strings. Otherwise the arithmetic operators
  coerce to numbers, and a value that does not coerce is an error.
- `/` is true division and `%` is floored modulo, with the sign of the divisor. Division
  or modulo by zero is an error.
- Unary `-` requires a number.
- Truthiness: `0`, `""`, null, `false` and empty lists or mappings are false; everything
  else is true.
- `&&` and `||` short-circuit. The skipped side is still parsed.
- An evaluation error is reported to the caller. Every context in this document then
  fails closed: no rank matches, no entry injects, no block shows, no ceiling applies.

**Evaluation contexts.**

| Context | Names | Functions |
|---|---|---|
| Resolution (`ranks[].when`, `difficulties.*.target`, `margin`) | Closed, §5.3. | `floor`, `ceil`, `min`, `max`, `abs` |
| Derived `expr`, vital `start` | The canonical namespace (§8.1). A missing name falls back to `defaults`, then 0. A non-numeric value falls back to the default. | as above, plus `if(cond, a, b)` |
| Creation budgets (§9) | The canonical namespace plus derived values. Missing or non-numeric values are 0. | none |
| `loss_ceiling.when` (§10) | `tag`, plus canonical names, bare or as `stat_data.<name>` | none |

A runtime MUST check every resolution expression **statically when the pack loads**:
every referenced name MUST be in the context's closed set. A dry run is not enough,
because `&&` short-circuits past a misspelled name.

The portable subset used by panel conditions is defined in [panels.md](panels.md) §5.

## 4. Dice expressions

The runtime's dice roller is the only source of randomness. Dice expressions are
case-insensitive. A pack SHOULD restrict itself to this portable core:

| Form | Meaning |
|---|---|
| `NdS`, `dS` | N dice (default 1) with S sides. |
| `+ - *`, parentheses, integer literals | Arithmetic. `x` or `×` between two numbers or parentheses means `*`, as in `3d6x5`. |
| `NdSkhK`, `NdSklK` | Keep the K highest or lowest dice. A bare `kK` means `khK`. |
| `NdS!` | Exploding dice: a maximum face rolls again and adds. |
| `NdS>=T`, `NdS<=T` | A success-counting pool, which MUST be the whole expression. N is 1–999 and S is 2–9999. The total is the number of faces meeting the threshold. The roller also reports `successes` and `ones` (the count of natural 1s). |
| `NdF`, `dF`, with an optional `+K` or `-K` | Fudge dice, which MUST be the whole expression. N defaults to 4; each die is −1, 0 or +1. |
| `{param}` | A roll parameter slot (§5.4), replaced by an integer before rolling. A slot with no value is an error. |

The reference also accepts the remainder of the `d20` dice notation (rerolls, minimum and
maximum, drop selectors). Those forms are not portable.

**Roll detail.** A roll produces `{expression, dice, total, modifiers, successes?, ones?}`.
For a pool, `dice` holds every face. Otherwise `dice` holds the kept natural faces of
the expression's first dice group, found left to right, and `total` is the whole
expression's value.

Reference: `core/dice_engine.py::roll_detail`, `roll_expression`.

## 5. Check resolution (`resolution:`)

A check runs in three phases with hard boundaries:

- **ROLL**: the runtime rolls the dice. This is the only random step.
- **INTERPRET**: a pure function `(roll detail, target, options) → outcome`, with no
  randomness and no state. Because it is pure, a runtime can re-grade a roll (house
  ladders, resource spends) and table-test a ladder exhaustively.
- **APPLY**: the runtime applies consequences: subsystems and sheet writes.

A language model MUST NOT be able to supply, pre-write or override the outcome of the
ROLL or INTERPRET phase.

### 5.1 Fields

The block is closed.

| Field | Default | Meaning |
|---|---|---|
| `version` | `1` | The block's schema version. A newer version MUST be refused. An older one loads only through a registered migration. |
| `roll` | required | The dice expression a check rolls. |
| `target` | `skill` | `skill`: the target is the sheet's check value (roll-under style). `dc`: the target is an external difficulty number, and the sheet value becomes the roll `modifier`. `none`: there is no target. |
| `compare` | `<=` | `<=` or `>=`. The direction used by the default margin (§5.5). |
| `params` | — | Roll parameter slots (§5.4). |
| `modifiers` | — | Named roll modifiers (§5.6). |
| `difficulties` | — | At most 16 named target transforms (§5.3). |
| `ranks` | required, unless `script` | The default rank ladder (§5.2). |
| `variants` | — | At most 32 named house ladders, each `{ranks: [...]}`. |
| `margin` | — | An expression for the outcome margin (§5.5). |
| `check` | — | How generic check commands feed the system (§5.7). |
| `script` | — | A rules script that replaces `ranks` and `variants` (§13). Declaring both is an error. |

Ids of ranks, variants, difficulties, params and modifiers MUST match
`^[a-z][a-z0-9_]{0,31}$`.

### 5.2 Rank ladders

A ladder is an ordered, non-empty list of at most 32 rules. A rule is closed:
`{id, when?, success?, critical?, fumble?, tier?}`.

- `when` is a resolution expression. The **first rule whose `when` is truthy wins**.
- The last rule MUST have no `when`; it is the fallback. No other rule may lack one.
- `success`, `critical` and `fumble` are booleans and default to false.
- `tier` is an integer 0–32. When omitted it defaults to `count − 1 − index`, so earlier
  rules rank higher. A higher tier is a better outcome.
- Rank ids MAY repeat within a ladder; the same id may be reached by several rules.

`variants` are whole replacement ladders. A runtime lets a room select one, and an
unknown or empty selection uses the default ladder. A patch can add a variant without
restating the base ladder, because mappings merge (§14).

### 5.3 Names, difficulties and targets

The resolution namespace is **closed**:

| Name | Value |
|---|---|
| `roll` | The roll total plus `modifier`. |
| `dice.N` (also written `dice[N]`) | The N-th kept natural face, 0-based. |
| `target` | The difficulty-adjusted target. Absent when the check has no target. |
| `raw_target` | The target before difficulty. Absent when the check has no target. |
| `modifier` | The flat modifier: the sheet value for `dc` systems, otherwise 0. |
| `successes`, `ones` | Pool counts, 0 for non-pool rolls. |

- **No silent zero.** A check that has no target MUST leave `target` and `raw_target`
  absent from the namespace, never substitute 0. An expression that reads an absent name
  is an evaluation error.
- **`target: none`.** A `none` pack MUST NOT reference `target` or `raw_target` in any
  resolution expression, and this MUST be rejected when the pack loads.
- **Difficulties.** A difficulty is closed, `{target?, prefixes?}`. Inside a difficulty's
  `target` expression, both `target` and `raw_target` hold the **raw** target. Its result
  is truncated to an integer and becomes the effective `target`. A difficulty without
  `target` leaves the target unchanged. `prefixes` maps a locale to the words that select
  the difficulty in typed commands.

### 5.4 Parameters

`params` maps a slot name to a closed `{min, max, default?}` of integers, with
`max ≥ min`. Before rolling, each slot takes its supplied value, or its `default` when
none was supplied, and is then clamped into `[min, max]`. A slot that has neither value
nor default, or whose value is not an integer, MUST fail that roll with an error that
names the slot. Which lanes may supply parameter values is runtime-defined, so a pack
SHOULD give every slot a default.

### 5.5 Margin

When `margin` is declared, the outcome margin is its value, truncated to an integer.
Otherwise the margin is `target − roll` for `compare: "<="` and `roll − target` for
`compare: ">="`, and it is absent when there is no target. A positive margin is on the
success side.

### 5.6 Modifiers

A modifier is a closed `{roll?, tens_reroll?}`. A caller applies modifiers by name, each
with a positive count.

- **`roll`** replaces the check's roll expression, for example advantage as `2d20kh1`.
- **`tens_reroll`** is `keep_lowest` or `keep_highest`. It is the generic d100
  tens-reroll mechanic. Counts add up, `keep_lowest` positive and `keep_highest`
  negative, so opposing modifiers cancel one for one. When the net count is non-zero,
  the runtime rolls a d100, with tens × 10 + ones and 00 + 0 counting as 100. It then
  rolls |net| extra tens dice and keeps the candidate with the lowest (net > 0) or highest
  (net < 0) **full d100 value**. The kept value is the whole roll, whatever `roll` says.
  The reference caps the extra tens dice at 100.

Applied modifiers are recorded in the roll detail.

### 5.7 `check`

A closed block that tells a runtime's generic check commands and tools how to use the
system:

- `favorable`, `unfavorable`: the names of declared modifiers that favorable and
  unfavorable counts route to. Opposing counts cancel.
- `default_target`: the target for a `dc` check that names no difficulty number.
- `proficiency`: a canonical stat that a proficient check adds to the sheet value.
- `default_skill`: the canonical stat a bare check command rolls.

### 5.8 The outcome contract

An outcome is `{rank: {id, tier, success, critical, fumble}, target, margin?}`, and on
the wire `{id, label, success, critical, fumble, tier, margin?}`. The rank `id` is pack
vocabulary and purely presentational. Consumers MUST branch only on the three flags and
on `tier`, never on a rank id, and opposed checks compare `tier` first.

Reference: `core/resolution.py::compile_resolution`, `CheckResolver.interpret`;
`core/check_outcome.py`; `core/check_roll.py`.

## 6. Labels

`labels` maps a locale to a table from rank id to a label spec. A spec is one of:

- a string, which is both the display text and a marker;
- a non-empty list of strings, whose first entry is the display text and all of whose
  entries are markers;
- `{display: string, markers: [string]}`.

A rank's display label for a locale is looked up by the locale's primary subtag, then
`en`, then falls back to the rank id. Markers are surface forms that a runtime MAY treat
as evidence that narration already stated a graded outcome. A pack SHOULD leave generic
words such as "Success" out of `markers`.

## 7. Derived stats (`derived:`)

`derived` maps a canonical name to a spec, using a fixed vocabulary. Derived values are
**never persisted** (§8.3). The derived values are evaluated as a **DAG fold in
declaration order**: each result joins the namespace, so a later entry may use an earlier
one. A value the sheet itself supplies always takes precedence as a reference, so a
trained skill overrides its derived base.

| Spec | Value |
|---|---|
| `{copy_of: s}` | `int(s)`. |
| `{half_of: s}` | `int(s) // 2`. |
| `{floor_div: {of: s, by: n}}` | `int(s) // n`. |
| `{expr: "<expression>", format?: "<template>"}` | The expression's value, where an integral float becomes an integer. With `format`, `{}` in the template is replaced by the value. |
| `{sum_ranges: {of: [s, …], ranges: [[lo, hi, v], …], else?: v}}` | Sum the stats. The first range with `lo ≤ sum ≤ hi` (inclusive) yields `v`, otherwise `else`. A `v` may be a literal, which keeps its YAML type (`"1d4"` stays a string), or an `{expr, format?}` spec. |
| `{computer: name}` | A runtime-registered function. The reference ships none, so a pack that uses this is not portable. An unknown name MUST fail the load. |
| `{computer_group: id}` | Adds a runtime-registered group of computers. Same portability caveat. |

Here `int(s)` means: the value of stat `s` as an integer, or its `defaults` value when
it is missing or non-numeric, or 0. `//` is floor division. Any other spec shape MUST
fail the load.

Reference: `core/rulepacks.py::_compile_derived_spec`, `RulePack.compute_derived`.

## 8. The sheet (`sheet:`)

### 8.1 Storage model and the canonical namespace

A character sheet stores:

- `attributes`, `skills` and `secondary_attributes`: maps from a storage key to a value;
- the named fields the pack declares in `sheet.fields`;
- when the pack declares `hit_points`, a current and a maximum hit-point pair.

The **canonical namespace** of a sheet is built from these parts: attributes, renamed
through the reverse of `attr_keys`; skills, through the reverse of `skill_keys`;
secondary values, through `secondary_keys`; and fields, through `field_keys`. Unmapped
keys keep their own names. Without a `sheet` block, the namespace is simply the
attributes and the skills.

### 8.2 Fields

The block is closed.

| Key | Meaning |
|---|---|
| `label` | Required: the sheet's display label. |
| `attr_keys`, `skill_keys`, `secondary_keys`, `field_keys` | Canonical name → storage key, or field name for `field_keys`. |
| `attributes`, `skills`, `secondary`, `fields` | Fresh-sheet values, by storage key or field name. |
| `hit_points` | `{current, max}`, integers. Declares that the sheet keeps hit points as a pair, under the canonical names `hp` and `hpmax`. |
| `derived_attrs`, `derived_skills`, `derived_secondary` | Storage key → canonical derived name. These slots hold derivations (§8.3). |
| `check_values` | Canonical → canonical. A check on the left name rolls against the right name's value, for example an ability check rolling its modifier. |
| `vitals` | Attribute storage key → `{max_key, start}`. `max_key` is required. `start` is `full` (the default) or `{expr}` in the canonical namespace plus derived values. |
| `resources` | At most 8 meters `{id, label, source?, value?, max?}`. `label` is a string (taken as `en`) or a locale map. `source` is `attributes` (the default), which requires the `value` and `max` storage keys, or `hit_points`. |

### 8.3 Derived values are never persisted

Readers MUST recompute derived slots from the pack before use. Stored copies are never
trusted. A refresh does the following:

- `derived_attrs` slots are overwritten with the derived value.
- A `derived_skills` or `derived_secondary` slot is **dropped** from storage when its
  stored value equals the derived value or is absent. When it differs, it is kept as a
  trained value or manual override. At creation, the slot is seeded cleanly.
- Each vital is clamped to `[0, value of max_key]`. It is initialized from `start` at
  creation, or when its slot is missing. An edit never heals a vital.

### 8.4 Reading and writing values

A canonical name's value is read in this order:

1. the attribute slot, via `attr_keys`;
2. `hp` or `hpmax`, from the hit-point pair (when `hit_points` is declared);
3. the secondary slot, via `secondary_keys`;
4. the skill slot, via `skill_keys` or the name itself;
5. the field, via `field_keys`;
6. the derived value;
7. the source value;
8. `defaults`;
9. 0.

Writes go to the declared slot by the same mapping, and an unmapped name is written as a
skill. A check on a name that resolves neither through `alias` nor to a slot on the sheet
MUST be refused. A runtime MUST NOT run it as a target-0 check.

Resource meters reach the wire as `{id, label, value, max}`, with the label resolved for
each viewer's locale: the exact locale, then `en`, then any.

Reference: `core/sheets.py`; `core/character_manager.py` (sheet record, hit points).

## 9. Character constraints (`creation_constraints:`)

Every stat write path MUST validate the sheet against these constraints, in
deterministic code: manual edits, AI tool writes, rolled generation and imports alike.
Validation returns a corrected sheet together with a list of violations.

| Key | Semantics |
|---|---|
| `attributes.<storage key>` | `{min (default 0), max (default 100), roll?}`. Every write clamps into the range, and a non-numeric value becomes `min`. When a character is generated, `roll` is rolled for each attribute in declaration order. |
| `skills.default` | `{min (default 0), max (default 99)}`. Every write clamps every non-derived skill. |
| `budgets.<id>.parts` | A list of budget formulas (§3). The budget is their sum, and a `{max: [formula, …]}` part contributes its largest alternative. *Spent* is the sum over non-derived skills of `max(0, value − fresh-sheet value)`. Overspending is reported as `<id>_exceeded`, never auto-corrected. A formula that does not evaluate contributes 0. |
| `methods.point_buy` | `{budget, min, max, costs: {value: cost}}`. Checked only when the caller says the sheet was point-bought, and only once every constrained attribute lies within `[min, max]`. |

The reference also reads `methods.standard_array`, `methods.rolled`,
`archetype_priorities` and `default_archetype` in its character-drafting helper. That
use is informative and not part of this contract.

Reference: `core/character_rules.py::validate_sheet`;
`core/character_manager.py::generate_character`.

## 10. Subsystems (`subsystems:`)

A subsystem binds one of the runtime's closed **behavior templates** to pack parameters
and a pack-chosen name. A pack declares at most 16. The key MUST be an identifier that
does not start with `_`. It names both the runtime tool or command that runs the
mechanic and the `subsystem` id on the wire. Every entry may carry `display`, a locale
map of names. Each entry is closed to its template's keys.

| Template | Keys | Semantics |
|---|---|---|
| `check_with_loss` | `stat` (required), `stat_max`, `fumble_loss`, `loss_ceiling` | Roll the system check against the attribute `stat`, using the room's variant and no difficulty. The caller supplies two loss expressions, one for success and one for failure. Roll the one for the outcome. On a fumble, `fumble_loss: all` makes the loss the full current value, and `max` makes it the loss expression's maximum. Then `loss_ceiling: {when, value ≥ 0}` caps the loss when `when` holds; the condition reads the call's optional scene `tag` and the sheet. The new value is `max(0, stat − loss)`. `stat_max` names the attribute reported as the maximum. |
| `improvement_check` | `roll` (default `1d100`), `improve` (default `1d10`), `cap` (default 100), `auto_success_above` | For a skill below `cap`, roll `roll`. It succeeds when the roll exceeds the skill value, or exceeds `auto_success_above` when that is set. On success the skill grows by `improve`, up to `cap`. |
| `resource_spend_adjust` | `stat` (required) | Spend N points of the attribute `stat` to lower the roll of the character's most recent recorded check by N, then re-grade it through the pack's ladder with the check's original target, variant and difficulty. N MUST NOT exceed the available points or bring the roll below 1. A fumble cannot be adjusted. Which checks are eligible is runtime-defined. |
| `opposed` | — | Two checks graded by the pack, and the higher `tier` wins. Tie-breaking is runtime-defined. |
| `table_draw` | `tables` (required), `default` | Draw one entry uniformly from a table: `1d<count>` on the runtime's roller. `tables.<id>` is closed: `{entries (1–64 strings), display?, aliases?}`. Table ids and aliases are casefolded. `default` names a table and defaults to the first. |

A subsystem that declares `script` is a **script flow** (§13), closed to
`{script, display?, rolls?}`.

Reference: `core/subsystems.py`; template bodies in `agent/kp_tools_subsystems.py`.

## 11. Commands (`commands:`)

`commands` maps a dot-command word to a binding. Words are trimmed and casefolded. A
binding is closed: `{action}` or `{tool, args?}`, exactly one of `action` and `tool`.

- `action: check` binds the word to the generic check command.
- `action: make_char` makes the word create a character **in the declaring system**.
  This word is the entry point into a system, so it resolves to the first pack in
  discovery order that declares it, whatever the room's current system is. An inherited
  word therefore routes to its base pack. A patch that needs its own character creation
  MUST declare a word of its own.
- `tool: <subsystem key>` runs that subsystem, with `args` as preset arguments. Naming an
  undeclared subsystem MUST fail the load.

Other words are scoped to the room's system.

Reference: `core/rulepacks.py::_parse_commands_section`, `pack_declaring_command`,
`own_make_char_word`.

## 12. Presentation and runtime hints

- **`display`**: `{locale: {canonical: display name}}`, looked up by the locale's primary
  subtag. It never affects resolution, and an unmapped name falls back to its canonical
  name. Since protocol 2.5 it also names things on the wire: each character attribute key
  is labelled with the `display` name of its canonical name (`attribute_labels`), and a
  subsystem's own `display` (§10) is sent as the dice frame's `subsystem_label`.
- **`initiative`**: a mapping with a required `roll`, a dice expression whose
  `{name}` slots are replaced by the sheet's canonical values before rolling.
- **`expertise`**: `{locale: text}`, text a runtime MAY give its game-master agent about
  running the system. The fallback order is the locale, then `en`.
- **`st_show`**: opaque sheet-display hints (`top`, `sortBy`, `itemsPerLine`,
  `ignores`). It is not validated.
- **`turn_checks`**: a list of closed rows
  `{id?, when (or condition), instruction?: {locale: text}, max_rounds?: int ≥ 1, enabled?}`.
  Condition names are runtime-defined. A runtime MUST skip a row that names a condition
  it does not implement, and MAY clamp `max_rounds`.

## 13. The rules-script lane

A system that the data cannot express ships a script. A **resolution script** replaces
the rank ladder (`resolution: {script: <file>}`). A **flow script** is a whole subsystem
(`subsystems: {<name>: {script: <file>, rolls?: {slot: dice expression}}}`).

- **Files.** The file is a bare filename next to the rulepack YAML, at most 40,000
  characters. It MUST define a global function: `resolve(input)` for resolution, or
  `flow(input)` for a flow. A flow declares at most 8 `rolls`, and slot names MUST be
  identifiers.
- **Zero-callable sandbox.** The script runs in a JavaScript sandbox with no host
  callables: no I/O, no randomness source, no engine state. Limits are a 64 MiB memory cap
  and a 1 s time limit per evaluation, armed before the script's top level runs. The
  runtime pre-rolls every die and passes the input in as plain JSON.
- **Load.** A pack whose script cannot load does not load. A runtime without a sandbox
  MUST NOT load the pack.
- **Resolution input:** `{roll, dice, total, target, raw_target, modifier, successes,
  ones, variant, difficulty}`. `target` is effective (after difficulty) or `null`;
  `raw_target`, `successes` and `ones` are `null` when absent.
- **Resolution output:** exactly `{rank: {id, tier, success?, critical?, fumble?},
  margin?}`. `id` matches `^[a-z][a-z0-9_]{0,31}$`, `tier` is an integer 0–32, the flags
  are booleans, and `margin` is an integer or `null`. Any extra key, wrong type or
  out-of-range value MUST be rejected as an error, never partially applied.
- **Flow input:** `{rolls: {slot: {expr, total, dice}}, sheet: {canonical: scalar}}`. The
  sheet snapshot includes derived values.
- **Flow output:** a closed effect `{stat_delta?, mark?, narration?}`.
  - `stat_delta` holds at most 8 entries, from name to integer, each clamped to ±1000.
    The runtime resolves each name through `alias` and applies it through the sheet
    layer, then validates the sheet (§9).
  - `mark` is a string, truncated to 64 characters.
  - `narration` is a string, truncated to 2,000 characters.
- **Purity.** Authors MUST write scripts as pure functions of their input. A runtime MAY
  reuse one interpreter across calls, so script state is not guaranteed to persist or to
  reset.
- **Disclosure.** A pack that ships scripts is disclosed as `has_rules_script`
  ([pack.md](pack.md) §4.2).

Reference: `core/rules_script.py`.

## 14. `extends:`, patching a base system

A world that needs bespoke rules ships a rulepack that patches a base, instead of
rewriting a whole system:

```yaml
# rulepacks/ashfall.yaml — an invented module's house rules on CoC 7e
extends: coc7
names: [ashfall]
defaults: {Ember Lore: 5}
alias: {Ember Lore: [ember, emberlore]}
resolution:
  variants:
    smoke_night:                       # added beside the base's own variants
      ranks:
        - {id: crit, when: "roll == 1", success: true, critical: true, tier: 5}
        - {id: regular, when: "roll <= target", success: true, tier: 2}
        - {id: fumble, when: "roll >= 95", fumble: true, tier: 0}
        - {id: fail, tier: 1}
commands:
  ashfall: {action: make_char}         # the patch's own entry point (§11)
```

Resolution is normative:

1. While the current document has `extends`, remove it, load the named base as raw YAML,
   and **deep-merge** the current document over the base. The base's own `extends`
   survives the merge, so the loop continues with the grandparent.
2. In the merge, mappings merge recursively. An explicit `null` deletes the inherited
   key. Scalars and lists replace the inherited value wholesale; a rank ladder, for
   example, is replaced, never appended to.
3. At most 4 bases may be chained. A cycle, a self-reference, a base that is not a
   non-empty string, or an unknown base MUST fail the load.
4. Bases are looked up by id. Inside a pack, the pack's own bundled rulepacks (by stem)
   come first, then the host's discovery directories, built-in first. The lookup reads
   files, not the registry, so it does not depend on discovery order.
5. The merged document is then loaded as an ordinary rulepack under the **child's** id.

A patch MUST use a new id: discovery never lets a pack or user file shadow a built-in
id (§15).

Reference: `core/rulepacks.py::resolve_extends`, `_merge_extends`.

## 15. Discovery

A runtime discovers rulepacks from its built-in directory first, then from user and pack
directories. A built-in id always wins over a same-named file elsewhere. Within one
directory, files are visited in sorted filename order. A malformed file is skipped with a
log. A runtime SHOULD notice rulepacks installed while it runs without needing a
restart.

## 16. Conformance

A second implementation proves itself against shared vectors, not against prose. Every
`ranks` ladder, `derived` table and `creation_constraints` block is pure data plus the
grammar of §3, so it can be table-tested exhaustively against the reference: every
target and roll through every ladder, every band edge of a derived table, alias probes,
and sheet validation. The reference packs listed at the top of this document are the
test corpus. [loreweaver-dsh](https://github.com/1A7432/loreweaver-dsh) is the first
implementation to do this: it grades 108,500 checks across every ladder of the reference
`coc7` pack against tables exported from the reference implementation.
