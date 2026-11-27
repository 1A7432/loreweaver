# LWF: rule packs (rule systems as data)

**Version 3.0 · draft.** This is a breaking revision of rule packs 2.0 (see §17): the
rules-script lane and runtime-registered computers are gone, and a few semantics changed.
Reference implementation, in the Loreweaver engine: `server/src/core/rulepacks/` (compiling,
`extends:`, the registry), `server/src/core/resolution/` (checks), `server/src/core/dice/`
(dice notation), `server/src/core/condexpr.ts` (the expression language),
`server/src/core/sheets/` (sheets, derived values, constraints) and
`server/src/core/subsystems/` (subsystems). Reference packs, built into the engine:
`rulepacks/coc7.yaml`, `rulepacks/dnd5e.yaml`, `rulepacks/wod.yaml`.

A rule pack is one YAML file that describes a tabletop rule system completely: its sheet,
how a check rolls and grades, its derived values, its character-creation limits, its extra
mechanics and the words players type for them. A runtime holds no system knowledge of its
own: deleting a rule pack deletes the system. Two principles govern the format:

- **Nothing is evaluated as code** except through the closed expression language (§3).
  Randomness lives only in the runtime's dice roller (§4).
- **The format never grows syntax for one system.** A system the data cannot express is
  not expressible in this version.

## 1. File, identity, loading

- The file's stem is the system **id**: `^[a-z0-9][a-z0-9-]{0,63}$` (`PACK_ID`, else
  `BAD_ID`). Inside a pack the file is listed under `contents.rulepacks`, is a `.yaml` or
  `.yml` file of at most 512 KiB ([pack.md](pack.md) §4–§5), and its id is unique in the pack.
- The file is UTF-8 YAML read as [SPEC.md](../SPEC.md) §4 says (`BAD_YAML`). The root MUST be
  a mapping (`NOT_A_MAPPING`); an empty document is an empty pack.
- Unknown **top-level** keys are ignored. Each block below says whether it is **closed**: an
  unknown key in a closed block is a load error (`UNKNOWN_KEY`), so a typo fails when the
  pack is built, not at the table.
- Compiling is all-or-nothing: a pack with any problem does not load (§15). Every problem is
  reported with a stable code and the dotted path of the field.

## 2. Top-level keys

| Key | Section | Meaning |
|---|---|---|
| `extends` | §13 | A base rule system to patch. |
| `names`, `set_keys` | §2.1 | Names the system answers to (lists of text). |
| `defaults` | §2.2 | Canonical name → integer. |
| `alias` | §2.1 | Canonical name → list of other spellings. |
| `display` | §12 | Display names per locale. |
| `labels` | §6 | Rank labels per locale. |
| `resolution` | §5 | How a check rolls and grades. Closed. |
| `derived` | §7 | Derived values. |
| `sheet` | §8 | The sheet shape. Closed. |
| `creation_constraints` | §9 | Character limits and creation rolls. |
| `subsystems` | §10 | Extra mechanics. Closed per entry. |
| `commands` | §11 | Typed command words. Closed per entry. |
| `initiative` | §12 | `{roll: <dice notation>}`. |
| `expertise` | §12 | Locale → text for the Keeper about running the system. |
| `st_show` | §12 | Opaque sheet-display hints. |
| `turn_checks` | §12 | End-of-turn check table. Closed per row. |

### 2.1 Names and aliases

**Normalising a name.** Every lookup below normalises text the same way: trim (Unicode
whitespace), case-fold, read `_` as a space, read the full-width `：（）` as `:()`, and
collapse whitespace runs to one space. Trimming comes first, so `_str` does not match `str`.
Full-width letters are not folded (`ＳＴＲ` is not `STR`).

**System lookup.** A system resolves by its id, any entry of `names` or any entry of
`set_keys`, normalised. The **first** system to claim a normalised name keeps it (§14), so a
built-in's names cannot be taken over.

**Stat lookup.** A typed stat name resolves to a **canonical name**, in this order:

1. the `alias` table: each canonical name and each of its listed variants (a list, or null
   for none) resolves to the canonical name; when two rows claim one variant, the later row
   wins;
2. a name the pack derives (§7);
3. a name the pack displays a stat under in any locale (§12): the display label is also a
   name of that stat.

Canonical names are the one identity everywhere: sheets, derived values, checks, labels.
They MAY be CJK; that is game data, not interface text.

### 2.2 `defaults`

A mapping from canonical name to an integer (`BAD_SHEET`/`NOT_INTEGER` otherwise): what an
unset stat reads as in formulas (§7) and sheet reads (§8.4).

## 3. The expression language

Rank conditions, difficulty transforms, margins, derived values, budgets, vital starts, loss
ceilings, lore conditions ([cards.md](cards.md) §6) and panel conditions
([panels.md](panels.md) §5.1) share one closed language. It looks like JavaScript but is
not: a fixed tokenizer and recursive-descent parser, no assignment, no loops, nothing ever
passed to an `eval`.

**Limits.** At most 500 UTF-16 units of source (`MAX_SOURCE_LENGTH`, `TOO_LONG`), 200 tokens
(`MAX_TOKENS`, `TOO_MANY_TOKENS`), 32 levels of nesting of parentheses, `!`, unary `-` and
call arguments (`MAX_DEPTH`, `TOO_DEEP`); a string built by `+` is at most 65,536 units.

**Tokens.**

- Numbers: ASCII `[0-9]+(\.[0-9]+)?`; no exponent form. Right after a `.`, digits are a path
  segment (`a.1.0` is the path `a.1.0`).
- Strings in `'…'` or `"…"`; a backslash takes the next character literally.
- Keywords, case-insensitive: `true`, `false`; `null`, `undefined`, `none` (all null).
- Word operators, case-insensitive: `and` (`&&`), `or` (`||`), `not` (`!`).
- Identifiers: a Unicode letter or `_`, then letters, digits, `_`.
- Operators: `=== !== == != >= <= > < && || ! ( ) [ ] . , + - * / %`. Anything else is an
  error.

**Grammar**, loosest first:

```
or      := and ( "||" and )*
and     := not ( "&&" not )*
not     := "!" not | compare
compare := sum [ ( "===" | "!==" | "==" | "!=" | ">=" | "<=" | ">" | "<" ) sum ]
sum     := term ( ( "+" | "-" ) term )*
term    := unary ( ( "*" | "/" | "%" ) unary )*
unary   := "-" unary | primary
primary := number | string | keyword | "(" or ")" | call | getvar | path
call    := NAME "(" [ or ( "," or )* ] ")"
getvar  := "getvar" "(" string ( "," or )* ")"
path    := NAME ( "." ( NAME | INTEGER ) | "[" ( STRING | INTEGER ) "]" )*
```

A comparison does not chain (`CHAINED_COMPARISON`). `!` binds looser than comparison:
`!a == b` is `!(a == b)`. A path folds into one dotted name: `a.b[0]` and `a['b']` are
`a.b.0` and `a.b`; a numeric segment loses its leading zeros. `getvar('x')` reads the name `x`;
further arguments must be well-formed but are never evaluated. A call names one of the
functions the context allows (`UNKNOWN_FUNCTION`), with the right number of arguments
(`ARITY`): `floor(x)`, `ceil(x)`, `abs(x)`, `min(x, …)`, `max(x, …)` take numbers (a boolean
is 0/1; text is an error); `if(c, a, b)` evaluates all three and returns `a` when `c` is
truthy, else `b`.

**Semantics.**

- There is one number type. Every result MUST stay within ±(2^53 − 1), else the evaluation
  fails (`NUMBER_RANGE`); `NaN` and infinities never become values.
- `===` / `!==`: same type and same value (`2.0 === 2` holds; `true === 1` does not); lists
  and mappings compare structurally.
- `==` / `!=`: strictly equal, or both sides read as numbers and the numbers are equal. A
  value reads as a number when it is a number, a boolean (0/1), or text that is a decimal
  numeral after trimming (`"7"`, `" 2.5 "`, `"1e3"`); nothing looser (no hexadecimal, no
  empty text). So `"5" == 5` holds and `"" == 0` does not.
- `< <= > >=`: numerically when both sides read as numbers, by code point when both are text,
  and otherwise an **error** (`UNORDERABLE`): `"abc" > 5` is never silently false.
- `+` joins two strings; otherwise `+ - * / %` need two numbers (`TYPE_MISMATCH`). `/` is true
  division; `%` takes the sign of the divisor (`-7 % 3` is 2); division or modulo by zero is
  an error. Unary `-` needs a number.
- Truthiness: `0`, `""`, null, `false`, an empty list and an empty mapping are false;
  everything else is true. `&&` and `||` short-circuit.
- A name the context does not supply reads as null, unless the context says otherwise: in
  the closed namespace of §5.3 it is an error; in sheet formulas it reads as the pack
  default, then 0 (§7).

Every context fails closed: an expression that errors matches no rank, injects no entry,
shows no block, applies no ceiling.

| Context | Names | Functions |
|---|---|---|
| Rank `when`, `margin` (§5) | the closed namespace of §5.3 | `floor ceil min max abs` |
| Difficulty `target` (§5.3) | `target`, `raw_target` | `floor ceil min max abs` |
| Derived values, vital starts, budgets (§7–§9) | canonical names | `floor ceil min max abs if` |
| `loss_ceiling.when` (§10) | `tag`, canonical names bare or as `stat_data.<name>` | none |

A runtime MUST check every resolution expression **statically when the pack loads**: every
name it reads MUST be in the context's closed set (`UNKNOWN_NAME`). A dry run is not enough,
because `&&` short-circuits past a misspelled name. The portable subset panels use is
[panels.md](panels.md) §5.1.

## 4. Dice notation

The runtime's dice roller is the only randomness. One grammar serves every entry point: the
pack's notations and the players' typed rolls.

```
expr        := comparison
comparison  := additive (("==" | "!=" | ">=" | "<=" | ">" | "<") additive)*
additive    := multiplicative (("+" | "-") multiplicative)*
multiplicative := unary (("*" | "x" | "×" | "//" | "/" | "%") unary)*
unary       := ("+" | "-") unary | atom
atom        := (dice | set | number | slot) label*
dice        := int? "d" (int | "%" | "f") diceop*         no spaces inside
diceop      := ("rr" | "ro" | "ra" | "e" | "k" | "p") selector | ("mi" | "ma") int | "!"
set         := "(" [expr ("," expr)* [","]] ")" (("k" | "p") selector)*
selector    := ["h" | "l" | ">" | "<"] int
int         := digits | "{" name "}"
label       := "[" text "]"
```

- Letters are case-insensitive outside labels and slot names. Full-width ASCII forms and the
  ideographic space read as their ASCII counterparts (`１d20＋5`).
- `NdS` rolls N dice (default 1) of S faces; `d%` is `d100`; `dF` is Fate dice (−1, 0, +1),
  four when no count is written.
- `k` keeps and `p` drops the selected dice; a bare `k` keeps the highest (`4d6k3` is
  `4d6kh3`). `h` / `l` select the highest / lowest *n*, `>` / `<` the faces above / below
  *n*, a bare number the faces equal to it. `rr` rerolls while any die matches, `ro` rerolls
  matching dice once, `ra` adds one die for the first match, `e` explodes matching dice (a new
  die per match, again for new matches), `!` explodes on the highest face (`!!` is refused),
  `mi` / `ma` raise / lower faces to a minimum / maximum.
- **Success pools.** A `>`, `>=`, `<` or `<=` whose left operand is a dice group (operators and
  labels included) **counts** the kept dice meeting the threshold (`5d10>=6`,
  `{pool}d10>={difficulty}`). Anything else compares values and yields 1 or 0: `(5d10)>6`,
  `2d6+3>8`. `==` and `!=` always compare values.
- `x`, `X` and `×` multiply (`3d6x5`). `/` is true division, `//` floors, `%` takes the sign of
  the divisor, and only the final total is truncated toward zero.
- `{name}` is a slot, replaced by an integer before rolling (§5.4, §12).

**Limits** (`LIMITS`): 1,000 dice per roll counting rerolls and explosions (`TOO_MANY_DICE`),
1,000,000,000 faces (`TOO_MANY_SIDES`), 1,000 code points of notation (`TOO_LONG`), 64 levels
of nesting (`TOO_DEEP`), values within ±(2^53 − 1) (`VALUE_TOO_LARGE`). Other errors: `EMPTY`,
`SYNTAX`, `ZERO_SIDED_DIE`, `BAD_POOL`, `DIVISION_BY_ZERO`, `MISSING_PARAM`, `BAD_PARAM`.

**A rolled check** carries: `total`; `dice`, the kept natural faces of the notation's first dice
group in left-to-right order (every face, for a pool); and for a pool `successes` and `ones`
(kept dice showing 1).

## 5. Check resolution (`resolution:`)

A check runs in three phases with hard boundaries:

- **ROLL**: the runtime rolls the dice — the only random step.
- **INTERPRET**: a pure function of (rolled values, target, variant, difficulty, modifier) →
  outcome; no randomness, no state. A runtime can therefore re-grade a roll (a resource spend)
  and table-test a ladder exhaustively.
- **APPLY**: the runtime applies consequences (subsystems, sheet writes).

A language model MUST NOT be able to supply, pre-write or override the outcome of ROLL or
INTERPRET.

### 5.1 Fields

The block is closed (`UNKNOWN_KEY`). A pack without `resolution` has no check.

| Field | Default | Meaning |
|---|---|---|
| `version` | `1` | The block's schema version; any other value is refused (`UNSUPPORTED_VERSION`). |
| `roll` | required | The notation a check rolls (`BAD_NOTATION`). Its slots MUST be declared `params` (`UNDECLARED_PARAM`). |
| `target` | `skill` | `skill`: the target is the stat's value (roll-under). `dc`: the target is a difficulty number and the stat's value is the roll's `modifier`. `none`: there is no target. |
| `compare` | `<=` | `<=` or `>=`: the direction of the default margin, and of an `opposed` subsystem's default (§10). |
| `params` | — | Roll parameter slots (§5.4). |
| `modifiers` | — | Named roll modifiers (§5.6). |
| `difficulties` | — | At most 16 (`MAX_DIFFICULTIES`) named target transforms (§5.3). |
| `ranks` | required | The default rank ladder (§5.2). |
| `variants` | — | At most 32 (`MAX_VARIANTS`) house ladders: `{id: {ranks: [...]}}`, closed. |
| `margin` | — | An expression for the outcome's margin (§5.5). |
| `check` | — | How generic check commands use the system (§5.7). |
| `script` | — | **Refused** (`SCRIPT_UNSUPPORTED`): the rules-script lane is not part of this version. |

Ids of ranks, variants, difficulties, parameters and modifiers MUST match
`^[a-z][a-z0-9_]{0,31}$` (`BAD_ID`). A key that is absent takes its default; an explicit null
is a wrong value.

### 5.2 Rank ladders

A ladder is a non-empty list of at most 32 rules (`MAX_RANKS`). A rule is closed:
`{id, when?, success?, critical?, fumble?, tier?}`.

- `when` is an expression (§3). The **first rule whose `when` is truthy wins**.
- The last rule MUST have no `when`; it is the fallback. No other rule may lack one
  (`BAD_LADDER`).
- `success`, `critical`, `fumble` are booleans, default false.
- `tier` is an integer 0–32; omitted, it is `count − 1 − index`, so earlier rules rank
  higher. A higher tier is a better outcome.
- A rank id MAY appear in several rules.

A room may select a variant; an unknown or empty selection grades with the default ladder.

### 5.3 The namespace, difficulties and targets

A ladder and a margin read only these names (closed; anything else fails the load):

| Name | Value |
|---|---|
| `roll` | The roll total plus `modifier`. |
| `dice.N` (also `dice[N]`) | The N-th kept natural face, 0-based. |
| `target` | The difficulty-adjusted target. |
| `raw_target` | The target before the difficulty. |
| `modifier` | The flat modifier (the stat's value in a `dc` system; else as the runtime supplies, normally 0). |
| `successes`, `ones` | Pool counts; 0 outside a pool. |

- **No silent zero.** A check without a target leaves `target` and `raw_target` **absent**;
  an expression that reads an absent name fails (`TARGET_REQUIRED`), and so does a missing die
  (`DIE_MISSING`). A `skill` or `dc` check rolled without a target is left **ungraded**; a
  `none` system always grades.
- **`target: none`.** No resolution expression of a `none` pack may read `target` or
  `raw_target` (`TARGET_FORBIDDEN`, at load).
- **Difficulties.** A difficulty is closed: `{target?, prefixes?}`. `target` is an expression
  over `target` and `raw_target`, both holding the raw target; its value, truncated toward
  zero, is the effective target. A difficulty without `target` leaves the target unchanged,
  and so does an unknown difficulty id. `prefixes` maps a locale to the words that select the
  difficulty in typed commands.

### 5.4 Parameters

`params` maps a slot to a closed `{min, max, default?}` of integers with `max ≥ min`
(`BAD_RANGE`). Before rolling, each slot takes the supplied value, else its `default`, as an
integer (a number truncates; text must be a plain decimal integer), clamped into
`[min, max]`. A slot with neither fails the roll (`MISSING_PARAM`); a value that is not an
integer fails it (`INVALID_PARAM`). Which callers may supply values is the runtime's, so a
pack SHOULD give every slot a default.

### 5.5 Margin

With `margin`, the outcome's margin is its value truncated toward zero. Without it, the margin
is `target − roll` for `compare: "<="` and `roll − target` for `">="`, and absent when there
is no target. A positive margin is on the success side.

### 5.6 Modifiers

A modifier is closed: `{roll?, tens_reroll?}`. A caller applies modifiers by name, each with a
count; a count of 0 or less does nothing, an undeclared name fails the roll
(`UNKNOWN_MODIFIER`).

- **`roll`** replaces the check's notation (advantage as `2d20kh1`); when two do, the later
  wins.
- **`tens_reroll`** is `keep_lowest` or `keep_highest`, the d100 tens-die mechanic. Counts net,
  `keep_lowest` positive and `keep_highest` negative, so opposing modifiers cancel one for
  one. A non-zero net rolls a d100 (1–100; ones = value mod 10, tens = ⌊value / 10⌋ mod 10),
  then |net| extra tens dice (0–9, at most 100), and keeps the candidate whose **full value**
  (tens × 10 + ones, with 0 and 0 meaning 100) is lowest (net > 0) or highest (net < 0), the
  earliest on a tie. That value is the whole roll, whatever `roll` says.

### 5.7 `check`

A closed block telling a runtime's generic check commands and tools how to use the system:

- `favorable`, `unfavorable`: declared modifiers (`UNDECLARED_MODIFIER` otherwise) that
  favourable and unfavourable counts route to; the counts net first (two bonus and one
  penalty is one bonus).
- `default_target`: an integer, the target of a `dc` check that names none. (The reference
  Keeper's dice tool uses it; its typed check command leaves such a check ungraded.)
- `proficiency`: a canonical stat a proficient check adds to the modifier.
- `default_skill`: the canonical stat a bare check rolls.

### 5.8 The outcome

An outcome is `{rank: {id, tier, success, critical, fumble}, margin, target, effectiveTarget,
roll, variant}`. The rank id is pack vocabulary and purely presentational. Consumers MUST
branch only on the three flags and `tier`, never on a rank id, and opposed checks compare
`tier`. How an outcome reaches a client is the wire protocol's ([protocol](../../protocol.md)).

Errors at grading time: `INVALID_TARGET`, `INVALID_ROLL`, `INVALID_MODIFIER`, `INVALID_COUNT`,
`UNKNOWN_MODIFIER`, `MISSING_PARAM`, `INVALID_PARAM`, `TARGET_REQUIRED`, `DIE_MISSING`,
`EXPRESSION_FAILED`, `ROLL_FAILED`.

## 6. Labels

`labels` maps a locale to a table from rank id to a label, each one of:

- a string: the display text, and its one marker;
- a non-empty list of strings: the first is the display text, all are markers;
- `{display, markers}` (closed).

Locales compare trimmed and case-folded; one declared twice is `DUPLICATE_ID`. A rank's label
for a viewer is looked up by the viewer's base language (the part before `-` or `_`), then
`en`, then the rank id itself. Markers are surface forms a runtime MAY take as evidence that
narration already stated a graded outcome; a pack SHOULD keep generic words such as
"Success" out of them.

## 7. Derived values (`derived:`)

`derived` maps a canonical name to exactly one of these specs (`BAD_SHAPE` otherwise; each
spec is closed):

| Spec | Value |
|---|---|
| `{copy_of: s}` | The integer value of `s`. |
| `{half_of: s}` | ⌊value of `s` / 2⌋. |
| `{floor_div: {of: s, by: n}}` | ⌊value of `s` / n⌋; `n` a non-zero integer (`BAD_BOUND`). |
| `{expr: "<expression>", format?: "<template>"}` | The expression's value. |
| `{sum_ranges: {of: [s, …], ranges: [[lo, hi, v], …], else?: v}}` | Sum the stats; the first band with `lo ≤ sum ≤ hi` yields `v`, else `else`. |

A band value `v` (or `else`) is text, an integer, or `{expr, format?}`. `format` replaces `{}`
(or `{0}`) with the value; `{{` and `}}` are literal braces; any other placeholder is refused
(`BAD_FORMAT`). `{computer: …}` and `{computer_group: …}` are refused
(`UNSUPPORTED_COMPUTER`): there are no engine-side functions; express the value as a formula.

**Evaluation.** Derived values are **never stored** (§8.3). They fold in declaration order: a
name a formula reads resolves to the sheet's own value, else an earlier derived result, else
the pack default, else 0. Each result joins the namespace for later entries, but a value the
sheet itself stores always wins as a reference (a trained skill over its derived base). A
result must be an integer or text. A formula that fails — division by zero, text where a
number belongs, a non-integer result, an input whose own formula failed, a sum in no band
without `else` — makes the value **absent**, never 0, and reports a formula issue
(`evaluation_failed`, `input_failed`, `not_integer`, `out_of_range`, `no_band`,
`bad_result`).

## 8. The sheet (`sheet:`)

### 8.1 Storage and the canonical namespace

A character sheet stores `attributes`, `skills` and `secondary` tables (storage key →
integer), the pack's named `fields` (text or integer), and, when the pack declares
`hit_points`, a current/maximum pair under the canonical names `hp` and `hpmax`. The **canonical
namespace** maps canonical names to the stored values through `attr_keys`, `skill_keys`,
`secondary_keys` and `field_keys` (canonical → storage key). Where several slots claim one
name the more specific wins, lowest first: an undeclared skill of that name, the declared skill
slot, the declared secondary slot, an undeclared attribute of that name, the declared attribute
slot, the hit points, the declared field. A pack without `sheet` keeps bare attribute and skill
tables, read by their own names.

### 8.2 Fields

The block is closed.

| Key | Meaning |
|---|---|
| `label` | Required, non-empty: the sheet's name for the system. |
| `attr_keys`, `skill_keys`, `secondary_keys`, `field_keys` | Canonical name → storage key (field name for `field_keys`). |
| `attributes`, `skills`, `secondary` | A fresh sheet's integers, by storage key. |
| `fields` | A fresh sheet's fields: a text or integer each; the default's type is the field's type. |
| `hit_points` | `{current, max}` (closed, integers, default 0): the sheet keeps hit points as a pair. Without it, hit points are the `HP` / `HPMAX` attribute slots. |
| `derived_attrs` | Storage key → derived canonical name: a **pure derivation**, never stored and never written (`DERIVED_SLOT`). |
| `derived_skills`, `derived_secondary` | Storage key → derived canonical name: shows the derivation unless a different value is stored (§8.3). |
| `check_values` | Canonical → canonical: a check on the left name rolls against the right name's value (an ability check rolling its modifier). |
| `vitals` | Attribute storage key → `{max_key, start?}` (closed): a current pool. `max_key` is required; `start` is `full` (default) or `{expr}` (§3). |
| `resources` | At most 8 (`MAX_RESOURCES`) meters `{id, label, source?, value?, max?}` (closed): `id` unique; `label` text (English) or locale → text; `source` `attributes` (default; `value` and `max` storage keys required) or `hit_points` (no `value`/`max`). |

### 8.3 Derived values are never persisted

Readers MUST recompute derived values from the pack; stored copies are never trusted. A
refresh, after any change of source values:

- drops a `derived_skills` / `derived_secondary` slot whose stored value equals its derivation
  (an untrained copy would otherwise turn into a false override when its source changes); a
  differing value stays, as a trained value or manual override. At creation every such slot is
  seeded cleanly;
- clamps each vital into `[0, value of max_key]`; a vital is set from `start` at creation, or
  when it has no value yet. An edit never heals. A vital whose maximum is unknown is left as
  it is;
- leaves a slot whose derivation failed as it is, and reports the failure.

### 8.4 Reading and writing

The value of a canonical name is its stored value, else its derived value, else (when its
formula failed) **nothing**, else the pack default, else unset. A check on a typed name that
resolves through §2.1 neither to a known stat nor to a slot the sheet stores MUST be refused;
a runtime MUST NOT run it as a target-0 check. A known name with no value and no default reads 0.

A write goes to the name's declared slot: a field (its type must match: `not_text`,
`not_integer`); an attribute slot (refused for a derived attribute: `derived_slot`; then the
sheet is refreshed); the hit points; a secondary slot; else a skill (by `skill_keys` or the
name itself, so a custom skill is added). Values are safe integers. A write applies no range:
ranges are §9's.

Hit points: with `hit_points`, the pair; otherwise the `HP` / `HPMAX` attributes (either may be
a vital or a derivation; a lone value stands for both). The current value is reported clamped
into `[0, max]`.

Resource meters are reported as `{id, label, value, max}`, the label in each viewer's language
(the full locale tag, then its base language, then `en`, then the id). An attribute-backed
meter whose value or maximum the sheet lacks is left out.

## 9. Character constraints (`creation_constraints:`)

Every stat write path MUST validate the sheet against these constraints in deterministic code
— manual edits, the Keeper's tools, generation and imports alike. Validation returns the
corrected sheet and a list of violations; it never throws on content.

| Key | Semantics |
|---|---|
| `attributes.<storage key>` | Closed `{min (default 0), max (default 100), roll?}`. A stored value is clamped into the range; a non-numeric one becomes `min`. `roll` is a creation roll (notation, checked at load; never on a derived attribute slot: `DERIVED_SLOT`). |
| `skills.default` | Closed `{min (default 0), max (default 99), growth_max?}`. Every non-derived skill is clamped into the range. `growth_max` is accepted; this version defines no behaviour for it. |
| `budgets.<id>` | Closed `{parts: [...]}`, non-empty. A part is a formula (§3) or `{max: [formula, …]}`, which contributes its largest alternative. The budget is the sum. *Spent* is the sum over non-derived skills of `max(0, value − fresh-sheet value)` (a custom skill's fresh value is 0). Overspending is reported (`budget_exceeded`, naming the budget), never corrected. A formula that fails leaves that budget unchecked and reports the issue. |
| `methods.point_buy` | Closed `{budget, min, max, costs: {value: cost}}` (integers; defaults 0). Checked only when the caller says the sheet was point-bought, and only once every constrained attribute lies within `[min, max]`; an unlisted value costs 0 (`point_buy_budget_exceeded`). |

Other keys under `creation_constraints` and `methods` (the built-in packs carry e.g.
`methods.standard_array`) are not read by this version's compiler; their meaning is not
specified in this version.

**Violations**: `attribute_not_numeric`, `attribute_below_min`, `attribute_above_max`,
`skill_not_numeric`, `skill_below_min`, `skill_above_max`, `secondary_not_numeric`,
`field_not_numeric`, `field_not_text`, `hit_points_not_numeric`, `unknown_entry`,
`malformed`, `budget_exceeded`, `point_buy_budget_exceeded`.

**Generating a character.** A fresh sheet (the pack's starting tables), then every attribute
with a creation `roll` rolled in declaration order, then a creation refresh (vitals from their
starts, derived slots seeded cleanly), then validation.

## 10. Subsystems (`subsystems:`)

A subsystem binds one of the runtime's closed **templates** to pack parameters and a
pack-chosen name. A pack declares at most 16 (`MAX_SUBSYSTEMS`). The key is an identifier
(`^[\p{L}\p{Nl}][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*$`: it starts with a letter, so never with
`_`; `BAD_ID`) and not `module_action` (`RESERVED_NAME`); it names the tool or command that
runs the mechanic and the subsystem on the wire. Every entry has `template` and MAY have
`display` (locale → name); otherwise it is closed to its template's keys. A `script` key is
refused (`SCRIPT_UNSUPPORTED`). The templates `check_with_loss`, `resource_spend_adjust` and
`opposed` roll the system's check, so need a `resolution` (`NEEDS_RESOLUTION`).

| Template | Keys | Semantics |
|---|---|---|
| `check_with_loss` | `stat` (required), `stat_max`, `fumble_loss`, `loss_ceiling` | Roll the system's check against the attribute slot `stat` (the room's variant, no difficulty, no modifiers, parameters at their defaults). The caller supplies a loss notation for success and one for failure; roll the one for the outcome (never below 0). On a fumble, `fumble_loss: all` makes the loss the whole current value and `max` the notation's maximum (defined for `NdM`, `NdM + K` with K ≥ 0, or a constant; otherwise the rolled loss stands). Then `loss_ceiling: {when, value ≥ 0}` (closed; `when` ≤ 500) caps the loss when `when` holds; a `when` that fails to evaluate never caps. The attribute becomes `max(0, value − loss)`. `stat_max` names the slot reported as the maximum. `stat` MUST NOT be a derived attribute slot. |
| `improvement_check` | `roll` (default `1d100`), `improve` (default `1d10`), `cap` (default 100), `auto_success_above` | For a skill below `cap` (else refused, `at_cap`), roll `roll`; the skill grows when the roll exceeds its value, or exceeds `auto_success_above` when set, by `improve`, up to `cap`. The skill is found through §2.1; an unknown name is refused, never grown from 0. |
| `resource_spend_adjust` | `stat` (required) | Spend N points of the attribute `stat` to lower the roll of a recorded check by N, then re-grade it with the check's own target, variant and difficulty. Nothing is rolled. N is a positive integer, at most the points available, and less than the roll (the roll never goes below 1). A fumble cannot be adjusted. A check on `stat` itself, or on the stat of any `check_with_loss` subsystem, is not eligible. Which check is "recorded" is the runtime's. `stat` MUST NOT be a derived attribute slot. |
| `opposed` | `settle` | Two sides each roll the system's check. `outcome`: each graded against its own value; the higher tier wins, then the higher value; equal values tie. `total`: each side's value is its roll's modifier; the higher total wins; equal totals tie; no side is graded. Default: `total` when `compare` is `>=`, else `outcome`. |
| `table_draw` | `tables` (required), `default` | One uniform draw (`1d<count>`) from a table. `tables` holds at least one table; an id is trimmed and case-folded, unique; a table is closed `{entries (1–64 strings, MAX_TABLE_ENTRIES), display?, aliases?}`. A caller names a table by id, then by alias; `default` (case-folded) names the table drawn without one (`UNDECLARED` when unknown), else the first. |

## 11. Commands (`commands:`)

`commands` maps a typed command word to a binding. Words are trimmed and case-folded; an empty
word or one declared twice is refused. A binding is closed: `{action}` or `{tool, args?}`,
exactly one of `action` and `tool`.

- `action: check` binds the word to the generic check command.
- `action: make_char` makes the word create a character **in the declaring system**. It is
  the entry point into a system, so it resolves to the first system (§14) that declares it,
  whatever the room's current system; a word inherited through `extends` routes to its base.
  A patch that needs its own character creation MUST declare a word of its own.
- `tool: <subsystem key>` runs that subsystem (`UNDECLARED` when it is not declared), with
  `args` (a mapping) as fixed arguments. `args` with an `action` is refused.

Other words act in the room's current system.

## 12. Presentation and runtime hints

- **`display`**: `{locale: {canonical name: display name}}`. Locales are trimmed, case-folded,
  `_` read as `-`; a locale declared twice merges, the later name winning. A stat's display
  name for a viewer is looked up by the full locale tag, then its base language, else the
  canonical name itself (no `en` fallback: canonical names are already names in the pack's own
  language). A display name never affects resolution, but it is a **name the stat answers to**
  (§2.1). A pack SHOULD give a display name in each language it serves for every attribute,
  derived value and skill whose canonical name is not written in that language's script; the
  built-in packs do for `en` and `zh`, with one label held back (checked by the reference's
  `display_names.test.ts`).
- **`initiative`**: a mapping whose `roll` is a notation; each `{name}` slot is replaced by the
  sheet's value of that canonical name before rolling (a name without a value fails the roll).
- **`expertise`**: locale → text a runtime MAY give its Keeper about running the system;
  looked up by base language, then `en`.
- **`st_show`**: opaque sheet-display hints (the built-ins use `top`, `sortBy`,
  `itemsPerLine`, `ignores`); not validated.
- **`turn_checks`**: a list of closed rows
  `{id?, when (or condition), instruction?: {locale: text}, max_rounds?: integer ≥ 1, enabled?}`.
  The condition names are the runtime's; a pack's table replaces the runtime's default table
  and may reword, reorder, drop or disable rows and lower their caps, never raise them. A
  runtime MUST skip a row naming a condition it does not implement, and a condition after its
  first row. The reference implements `narration_lost`, `dice_forged`, `dice_contradicts` and
  `stale_scene_hud`, and clamps `max_rounds` to its own cap per condition and to 3.

## 13. `extends:` — patching a base system

A world that needs bespoke rules ships a pack that patches a base instead of restating a whole
system:

```yaml
# rules/ashfall.yaml — an invented module's house rules on CoC 7e
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

1. While the document has `extends`, remove it, load the named base as raw data, and
   **deep-merge** the document over the base. The base's own `extends` survives the merge, so
   the loop continues with the grandparent.
2. Mappings merge recursively; an explicit `null` deletes the inherited key. Scalars and lists
   replace the inherited value wholesale: a rank ladder is replaced, never appended to.
   Inherited keys keep their position; keys only the child has follow, in the child's order.
3. At most 4 bases (`MAX_EXTENDS_DEPTH`; `EXTENDS_TOO_DEEP`). A base that is not a non-empty
   string (`EXTENDS_INVALID`), an unknown base (`EXTENDS_UNKNOWN`), a cycle or a
   self-reference (`EXTENDS_CYCLE`) fails the load; so does a base that is not a mapping.
4. Bases are looked up by id among raw files, not among loaded systems. Inside a pack: the
   pack's own rule packs first, then the runtime's built-ins. A pack cannot extend another
   pack's system. A pack file that extends its own id reaches the built-in of that id.
5. The merged document is then compiled as an ordinary pack under the **child's** id.

## 14. Where systems come from

A runtime's systems are its built-ins, then the rule packs of installed packs in install order
([pack.md](pack.md) §8). An id is kept by its first claimant: a later pack's system with a
taken id is not loaded, and the runtime names it. A system name (id, `names`, `set_keys`) is
likewise kept by the first system to claim it. Installed packs are validated again when a
runtime starts, and a pack that no longer validates is skipped. A room chooses its system by
name; a system needs no enabling.

## 15. What is refused

A pack that fails to compile does not load; inside a pack it refuses the pack
(`rulepack_invalid`, with the code, the inner code and the path). Codes: `BAD_YAML`,
`NOT_A_MAPPING`, `BAD_ID`, `BAD_FIELD`, `UNKNOWN_KEY`, `DUPLICATE_ID`, `TOO_MANY`,
`RESERVED_NAME`, `UNDECLARED`, `BAD_NOTATION`, `BAD_EXPRESSION`, `SCRIPT_UNSUPPORTED`,
`NEEDS_RESOLUTION`, `DERIVED_SLOT`, `EXTENDS_INVALID`, `EXTENDS_UNKNOWN`, `EXTENDS_CYCLE`,
`EXTENDS_TOO_DEEP`; and two wrappers that carry the inner layer's code: `BAD_RESOLUTION`
(`BAD_FIELD`, `UNKNOWN_KEY`, `UNSUPPORTED_VERSION`, `BAD_ID`, `TOO_MANY`, `BAD_EXPRESSION`,
`UNKNOWN_NAME`, `TARGET_FORBIDDEN`, `BAD_LADDER`, `BAD_NOTATION`, `UNDECLARED_PARAM`,
`BAD_RANGE`, `UNDECLARED_MODIFIER`, `DUPLICATE_ID`) and `BAD_SHEET` (`BAD_SHAPE`,
`UNKNOWN_KEY`, `MISSING`, `NOT_INTEGER`, `BAD_FORMULA`, `UNSUPPORTED_COMPUTER`, `BAD_FORMAT`,
`BAD_BOUND`).

## 16. A complete small pack

```yaml
# rules/d20lite.yaml
names: [d20 lite]
set_keys: [d20lite]
defaults: {Might: 10, Wits: 10, Athletics: 0}
alias:
  Might: [mig, 力量]
  Wits: [wit]
display:
  zh: {Might: 力量, Wits: 机智, Athletics: 运动, Might Bonus: 力量加值}
resolution:
  roll: 1d20
  target: dc
  compare: ">="
  modifiers:
    advantage: {roll: 2d20kh1}
    disadvantage: {roll: 2d20kl1}
  check: {favorable: advantage, unfavorable: disadvantage, default_target: 10}
  ranks:
    - {id: critical, when: "dice.0 == 20", success: true, critical: true, tier: 3}
    - {id: fumble, when: "dice.0 == 1", fumble: true, tier: 0}
    - {id: success, when: "roll >= target", success: true, tier: 2}
    - {id: failure, tier: 1}
labels:
  en: {critical: Critical, fumble: Fumble, success: Success, failure: Failure}
  zh: {critical: 大成功, fumble: 大失败, success: 成功, failure: 失败}
derived:
  Might Bonus: {expr: "floor((Might - 10) / 2)"}
sheet:
  label: d20 Lite
  attr_keys: {Might: MIG, Wits: WIT}
  attributes: {MIG: 10, WIT: 10}
  skills: {Athletics: 0}
  hit_points: {current: 10, max: 10}
  resources:
    - {id: hp, label: {en: HP, zh: 生命}, source: hit_points}
creation_constraints:
  attributes:
    MIG: {min: 3, max: 18, roll: 3d6}
    WIT: {min: 3, max: 18, roll: 3d6}
  skills:
    default: {min: 0, max: 10}
initiative: {roll: "1d20 + {Wits}"}
subsystems:
  omen:
    template: table_draw
    display: {en: Omen, zh: 预兆}
    tables:
      sky: {entries: [A red moon., Gulls fly inland., Still water.]}
commands:
  d20lite: {action: make_char}
  r: {action: check}
  omen: {tool: omen}
```

## 17. Conformance and migration

**Shared vectors.** A second implementation proves itself against tables, not prose. A ladder,
a derived table and a constraint block are pure data plus §3, so they can be table-tested
exhaustively. This repository holds the reference's recorded tables under
`server/test/fixtures/reference/`: `rules_pack_meta.jsonl`, `rules_coc7_grid.jsonl.gz`,
`rules_dnd5e_grid.jsonl`, `rules_wod_grid.jsonl`, `rules_interpret_cases.jsonl`,
`rules_check_roll.jsonl.gz`, `rules_params.jsonl`, `rules_luck.jsonl.gz`,
`rules_subsystems.jsonl.gz`, `rules_synthetic.jsonl.gz`, `sheets_cases.jsonl`,
`sheets_aliases.jsonl`, `sheets_derived.jsonl`, `sheets_ops.jsonl`, `dice_vectors.jsonl.gz`,
`dice_normalize.jsonl`, `dice_result_flags.jsonl` (their `README.md` describes each), and the
expression table `clients/protocol/src/condexpr.vectors.json` for the portable subset. The
`rules_*`, `sheets_*` and `dice_*` tables were recorded from the 2.6 engine; the reference's
3.0 tests replay them and pin every deliberate departure from them in the test files beside
them (`server/test/core/{resolution,rulepacks,sheets,subsystems,dice}/`). A row that a test
supersedes is not a 3.0 contract. `rules_script_lane.jsonl` records a lane this version does
not have. [loreweaver-dsh](https://github.com/1A7432/loreweaver-dsh) implemented rule packs
2.0 against these tables.

**From rule packs 2.0.**

- `resolution.script` and `script` subsystems are refused (`SCRIPT_UNSUPPORTED`); nothing
  replaces the rules-script lane. Express the system as ladders, or not at all.
- `{computer}` and `{computer_group}` derived specs are refused (`UNSUPPORTED_COMPUTER`).
- A derived formula that fails makes its value absent instead of falling back to the default;
  a non-integer result is a failure, not truncated.
- One number type: `2.0 === 2` holds. `if(c, a, b)` is available to sheet formulas.
- A display name is also a name the stat answers to, and so is a derived name; display names
  no longer fall back to `en`.
- Overspending a budget is reported as `budget_exceeded` naming the budget (2.0:
  `<id>_exceeded`); a budget whose formula fails is not checked (2.0: it contributed 0).
- `opposed` gained `settle`; `skills.default` accepts `growth_max`.
- Systems are no longer discovered from directories: they come from the built-ins and from
  installed packs (§14).
- YAML is read as 1.2 with SPEC.md §4's restrictions (2.0 read YAML 1.1 in the reference).
