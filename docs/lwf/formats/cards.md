# LWF: cards, lore and room variables

**Version 3.0 · draft.** This is a breaking revision of cards 2.0 (see §11): hook scripts
are no longer run, a character import brings a name and a persona and nothing else, the
pack overlay file and pregenerated casts are not imported, and a standalone lorebook has no
import path. Reference implementation, in the Loreweaver engine: `server/src/core/card/`
(parsing a card, the split), `server/src/core/worldbook/` (lore import, activation,
macros, decorators), `server/src/core/lore/` (stored entries, the overlay, timers),
`server/src/core/variables/` (the variable tree, updates, exposure, typed variables),
`server/src/worker/templates/` (templates), `server/src/agent/card_import.ts` (what each
import writes) and `server/src/gateway/commands/engine/files.ts` (the `import` command).

A **card** is how a world or a character arrives: a SillyTavern character card (§1) or
Loreweaver's own bundle (§2). Every card is split (§3) into a **character half**, which
any player may bring to a table, and **world machinery**, which only a room admin may
import. A world import (§4.1) turns the card into the room's lore entries (§5–§7), its
variable tree and typed variables (§8), and a keeper-only record of the card itself.
Players never receive what the projections of §10 keep from them.

Terms are those of [SPEC.md](../SPEC.md) §2. Text lengths are counted in Unicode code
points unless a limit says otherwise. Reading YAML follows SPEC.md §4.

## 1. SillyTavern cards

A SillyTavern card is JSON, either a file or embedded in a PNG. The file is at most
16 MiB (`MAX_CARD_FILE_BYTES`); larger is refused (`too_large`).

**Recognising the bytes.**

- A file whose first eight bytes are the PNG signature is a PNG, whatever it is called.
  The reader walks the chunks and decodes every `tEXt`, `zTXt` and `iTXt` chunk. It takes
  the first chunk whose keyword is `ccv3` (keywords compare case-insensitively), else the
  first whose keyword is `chara`. A `tEXt` chunk is ISO-8859-1; a `zTXt` chunk and a
  compressed `iTXt` chunk are inflated, and one that inflates past 4 MiB
  (`MAX_INFLATED_TEXT_BYTES`) refuses the card (`compressed_text_too_large`); a corrupt or
  malformed chunk is skipped; a chunk whose length runs past the end of the file ends the
  walk. The chunk text is base64 (whitespace and stray characters skipped), decoded as
  UTF-8, and parsed as a JSON object (`bad_embedded_payload`, `embedded_not_an_object`).
  No such chunk: `no_card_in_png`.
- A file named `*.json`, or whose first non-blank byte is `{` or `[`, is JSON. It MUST be
  UTF-8 (`bad_json`); a leading byte-order mark is dropped.
- Any other file is tried as JSON and otherwise refused (`unsupported_format`).

JSON nested deeper than 64 levels (`MAX_CARD_JSON_DEPTH`) is refused (`too_deep`); text that
does not parse is `bad_json`; a top-level value that is not an object is `not_an_object`.

**Where fields are read.** A document that has a `spec` key, whatever its value, is a V2
or V3 card: the fields below marked *body* are read from `data` only, the others from
`data` and, when `data` lacks one, from the root. A document without `spec` is a V1 card
and every field is read from the root.

| Card field | Read from | As |
|---|---|---|
| `name`, `description`, `personality`, `scenario`, `first_mes`, `mes_example` | `data`, else root | text |
| `tags` | `data`, else root | a list keeps its non-empty strings; a string is split on commas, trimmed, empties dropped |
| `creator_notes` | body (V1: `creatorcomment`, else `creator_notes`) | text |
| `creator_notes_multilingual` | body | language → text, string values only |
| `system_prompt`, `post_history_instructions` | body | text: the card's **directives** |
| `alternate_greetings` | body | a list keeps its strings; one string is one greeting |
| `character_book` | body | its `entries` list (§5); anything else is no entries |

*Text*: a string is itself; a finite number or a boolean is its JSON text (`42`, `true`);
anything else (null, an object, a list) is empty. A character book holding more than
1,000 entries (`MAX_BOOK_ENTRIES`) refuses the card (`too_many_entries`); entries that are
not objects are dropped. Every other field is ignored, never refused.

> **Differs from SillyTavern.** SillyTavern reads only `tEXt` chunks and goes by the file
> extension; Loreweaver also reads `zTXt` and `iTXt` chunks and goes by the bytes.

## 2. The native bundle (`*.lorecard.json`)

The native bundle is Loreweaver's own card. It carries what a SillyTavern card has no
place for: keeper-only lore, typed variables, per-entry conditions. A runtime recognises
it by content: UTF-8 JSON whose top-level object has `format: "loreweaver.card"`
(`LORECARD_FORMAT`). Recognition is tried first; anything else is read as a SillyTavern
card (§1). The file is at most 32 MiB (`MAX_LORECARD_FILE_BYTES`, twice a SillyTavern
card).

**Refused** (the bundle is unusable): over the size (`too_large`), not UTF-8 or not JSON
(`bad_json`), nested past 64 levels (`too_deep`), not an object (`not_an_object`),
`format_version` not an integer (`bad_version`), a version other than `1`
(`LORECARD_VERSION`; older and newer alike: `unsupported_version`), more than 200
`worldbook` entries (`MAX_LORECARD_ENTRIES`, `too_many_entries`) or more than 64
`variables` (`MAX_VARIABLES`, `too_many_variables`). **Skipped with a warning**, the rest of
the bundle kept: a malformed entry, variable or pregen (codes below).

| Field | Type | Meaning |
|---|---|---|
| `format` | string | Required, exactly `loreweaver.card`. |
| `format_version` | integer | Required, `1`. |
| `name` | text | The card's name, trimmed. |
| `description`, `personality`, `scenario` | text | Prose. |
| `opening` | text | The first message (SillyTavern: `first_mes`). |
| `alternate_openings` | list of text, or one text | Alternative openings, trimmed, empties dropped. |
| `dialogue_examples`, `author_notes` | text | SillyTavern: `mes_example`, `creator_notes`. |
| `tags` | list of text, or one text | Trimmed, empties dropped. |
| `worldbook` | list | Lore entries, below. |
| `variables` | list | Typed variable specs (§8.5). |
| `pregens` | list | A cast, below. Parsed; **not imported** in this version. |
| `hooks` | list or text | Counted, never kept (§3.1). |

A bundle has no directives. Unknown fields are ignored. Flags in a bundle are read by
truthiness: absent or null is the default; `false`, `0`, `""`, an empty list and an empty
object are false; everything else, the string `"false"` included, is true.

**`worldbook[]` entries.** Each becomes a SillyTavern-shaped entry and goes through the
same split and lore import (§5) as any card's entry.

| Key | Meaning |
|---|---|
| `content` | Required text. An object or list is skipped (`content_not_text`); blank is skipped (`content_empty`); over 16,000 (`MAX_ENTRY_CONTENT_CHARS`) is skipped (`content_too_long`). |
| `title` | Trimmed; default `Untitled Lore`. |
| `condition` | A condition expression (§6, step 5). Whitespace runs collapse to one space and it becomes a leading `@@if` line. Over 500 (`MAX_CONDITION_CHARS`) warns `condition_too_long`. |
| `keys`, `secondary_keys` | Lists of text, or one text; trimmed, empties dropped. Secondary keys gate the entry exactly when there are some. |
| `selective_logic` | `and_any` (default), `and_all`, `not_any` or `not_all`; anything else is `and_any`. |
| `category` | Default `lore`. |
| `secret`, `constant` | Flags, default false. |
| `enabled` | Flag, default true. |
| `priority` | Integer, default 0. |
| `probability` | Integer, default 100, clamped to 0–100. |
| `case_sensitive`, `match_whole_words` | Flags, default false. |
| `scan_depth` | Integer, default 0, clamped to 0–200. |
| `position` | `before` or `after`; anything else is the default placement. |
| `sticky`, `cooldown` | Integers, default 0, clamped to 0–999. `delay`: 0–9,999. |
| `id` | Read and carried; the lore import ignores it (ids are always assigned by the room). |

An integer is a number (truncated), a boolean (0/1) or integer text; anything else is the
default. Warnings: `entry_not_object`, `content_not_text`, `content_empty`,
`content_too_long`, `condition_too_long`, `section_wrong_type` (a section of the wrong
type, read as empty).

**`pregens[]`.** `{name, concept or blurb, notes, skills}`: `name` required (≤ 60),
`concept` (or, when `concept` is falsy, `blurb`) ≤ 200, `notes` ≤ 400, `skills` a mapping of
at most 32 names to integers. At most 8 are read (`MAX_PREGENS`; `pregens_truncated`);
warnings `pregen_not_object`, `pregen_missing_name`, `pregen_too_long`,
`pregen_skill_not_integer`, `pregen_skills_wrong_type`. This version parses a cast and
reports it as not imported (§4.1); claiming pregenerated characters is not specified in
this version.

**`variables[]`.** Each spec is read as in §8.5; warnings `variable_not_object`,
`variable_unusable`, `variable_duplicate` (the first of an id wins),
`option_labels_not_enum`, `option_labels_wrong_type` and `option_labels_dropped` (with
the count).

### 2.1 Example

```json
{
  "format": "loreweaver.card",
  "format_version": 1,
  "name": "The Drowned Harbor",
  "description": "A fishing town where the tide keeps secrets.",
  "opening": "Fog rolls in over the quay.",
  "worldbook": [
    { "title": "The lighthouse", "content": "The lighthouse has been dark for a week.", "keys": ["lighthouse"] },
    { "title": "Who drowned the keeper", "content": "The harbourmaster did it.", "secret": true, "keys": ["keeper"] },
    { "title": "High tide", "content": "Boats cannot leave.", "condition": "tide >= 8", "constant": true }
  ],
  "variables": [
    { "id": "tide", "kind": "number", "minimum": 0, "maximum": 10, "default": 3, "labels": { "en": "Tide", "zh": "潮位" } },
    { "id": "culprit_known", "kind": "bool", "visibility": "keeper" }
  ]
}
```

## 3. The split (拆卡)

A SillyTavern "heavy card" fuses two things into one file. LWF keeps them apart:

- the **character half**: persona prose and plain lore. Any player may import it;
- **world machinery**: variable declarations, templates, keeper-only lore, typed
  variables and hook scripts. It reprograms play for the whole table, so only the room
  admin may import it.

A card's directives (`system_prompt`, `post_history_instructions`) are standing prompt text,
not machinery: they never make a card a world card, but only a world import keeps them.

### 3.1 Machinery detection (normative)

A card is a **world card** if and only if at least one of these holds; otherwise it is a
**character card**:

1. **Variable declarations.** A lore entry is a declaration (§8.2).
2. **Templates.** At least one EJS span — `<%` up to the next `%>`, any variant; an
   unclosed `<%` runs to the end of the text — occurs in the card's `name`,
   `description`, `personality`, `scenario`, `first_mes`, `mes_example`, `creator_notes`,
   a `creator_notes_multilingual` value, a tag, an alternate greeting, or in the
   `content`, `title`, `comment`, `name`, `keys`, `secondary_keys`, `key` or
   `keysecondary` of a lore entry that is neither a declaration nor keeper-only.
   Directives are not scanned.
3. **Keeper-only lore.** A lore entry has `secret: true`, or `extensions.secret: true`
   (the boolean `true`, nothing else).
4. **Typed variables.** A native bundle declares at least one usable variable spec.
5. **Hook scripts.** The card carries a non-blank hook script — a string, or an object
   whose `code` is a string — in a native bundle's `hooks`, or in a SillyTavern
   document's top-level `hooks`, `data.extensions.loreweaver_hooks` or root
   `extensions.loreweaver_hooks` (all three are counted). This version runs no hook: a
   script is counted, reported (`hooks_unsupported`) and never kept anywhere.

Detection MUST be deterministic code, never a model's judgement. A pack builder and a
runtime MUST use the same predicate: it is what a pack's declared card `kind` is checked
against ([pack.md](pack.md) §4.1).

### 3.2 The character half

The character half is the card with: every declaration entry and every keeper-only entry
removed; every EJS span removed from each field listed in §3.1 item 2 (a key that was
nothing but template code is dropped, and so is a tag left empty); both directives
blanked; and no source document attached, so nothing downstream can read machinery back
off it. A split never modifies its input.

## 4. Imports

A card reaches a room by the `import` command ([protocol](../../protocol.md)): a file the
member uploaded to that room (any other member's upload, or one removed by a reset, gives
one answer: `not_uploaded`), or a card that a pack **enabled in that room** ships, named by
pack id and its path in the pack. `as: "world"` is the room admin's; `as: "character"` is
any player's. A card that does not parse is `not_a_card` with the card error code of §1–§2.

Every refusal below is decided before anything is written; the writes of one import then
land together or not at all.

### 4.1 World import

The world import MUST be a deterministic privilege check of the room-admin role, and MUST
NOT be offered to the Keeper as a tool. It reads the **original** card, both halves:

- **Lore.** Every entry except declarations becomes a lore entry at **keeper trust** (§5.4):
  `secret` and `constant` are honoured, templates are kept to be rendered at activation
  (§7). The entries' source is `card:<name>`.
- **The variable tree.** Every declaration entry is parsed and the parses are merged in
  order (§8.2); the room's tree is seeded with the result: a top-level key the room already
  has keeps the room's value, so a re-import never resets progress; the exposure list is
  kept. A declaration that cannot be read is skipped and counted.
- **Typed variables.** A native bundle's specs are defined in the room (§8.5). Redefining an
  existing id keeps its position, and its value when that value fits the new spec.
- **The world card.** A keeper-only record of the card: its name, `description`,
  `personality`, `scenario`, example messages and creator notes verbatim; its directives,
  each prepared once — EJS spans removed, `{{original}}` and `{{// …}}` dropped, `{{char}}`
  bound to the card's name, trimmed; its first message and alternate greetings as written
  (templates included: an opening is rendered like lore before it is spoken); and its
  provenance (a SHA-256 of the parsed card, the time, the importing member, the format).
  The system-prompt directive joins the head of the Keeper's prompt verbatim; the
  post-history directive is passed through the macros (§7.2) on every turn. Where a
  runtime places directives in its prompt is not specified.
- **Not imported**, reported by count: hook scripts and a native bundle's pregens.

**Re-import and stacking.** The world card's identity is its name. Importing a card whose
name the room already holds replaces that card's lore entries and its world card, and
re-seeds the tree as above. A card of a different name **stacks**: its entries join the
first card's, both cards' directives reach the Keeper (in import order), and the trees merge
by the same rule. A room admin who wants a clean slate resets the room first.

**Limits and refusals.**

| Limit | Value | Constant | Refusal |
|---|---|---|---|
| Entries in one card's lorebook | 200 | `MAX_IMPORT_ENTRIES` | `too_many_entries` |
| Lore entries in a room | 2,000 | `MAX_ROOM_LORE_ENTRIES` | `lore_full` |
| Card name | 200 | `MAX_WORLD_NAME_CHARS` | `name_too_long` |
| One prose field | 100,000 | `MAX_WORLD_PROSE_CHARS` | `prose_too_long` |
| One prepared directive | 50,000 | `MAX_DIRECTIVE_CHARS` | `directive_too_long` |
| First message, each greeting | 50,000 | `MAX_OPENING_CHARS` | `opening_too_long` |
| Alternate greetings | 64 | `MAX_ALTERNATE_GREETINGS` | `too_many_openings` |
| Typed variables in a room | 64 | `MAX_VARIABLES` | `module_variables_full` |
| The seeded tree | §8.1 | | `variables_too_large` |

An entry the stored-entry rules refuse is `entry_invalid`; a document the store refuses is
`document_refused`; a room that moved to another generation meanwhile (undo, reset) is
`stale_writer`. One entry longer than 16,000 is skipped and reported by title, not refused;
so is an entry stored disabled with no keys (nothing can fire it until the admin acts, §9).

### 4.2 Character import

Any player may import a card as **their** character. The import reads the character half
only (§3.2) and writes exactly two things: a new character, owned by the importing member,
and that member's seat (they now play it; the character they played before is unseated).
**Nothing else is written, whatever the card holds**: no lore entry, no variable, no
directive, no opening.

- **Name**: the caller's choice, else the card's name; trimmed, 1–64 code points
  (`MAX_CHARACTER_NAME_CHARS`, else `card_bad_name`), and unique in the room, compared
  case-insensitively (`name_taken`).
- **Persona**: the character half's `description` and `personality`, each trimmed, with
  `{{char}}`, `<char>` and `<BOT>` bound to the name, joined by a blank line; at most
  20,000 (`MAX_PERSONA_CHARS`, `persona_too_long`). It is kept as the character's
  background.
- **Sheet**: built by the runtime for the room's rule system ([rulepacks.md](rulepacks.md)
  §8–§9): a fresh sheet with every creation roll made, then validated. A runtime MAY bias
  the sheet toward a concept read from the persona; how is not specified. A room without
  a rule system refuses the import (`no_rule_system`); a sheet or seat the character layer
  refuses is `sheet_refused` / `seat_refused`; an import with no member is `no_member`.

The import reports what it left behind, each part with its count and reason:
`variable_declarations`, `templates`, `module_variables` and `pregens` (world machinery);
`hooks` (unsupported); `secret_entries` (keeper-only); `directives`, `lore_entries`,
`openings` and `scenario` (world only). It also says whether the card was a world card.

## 5. Lore entries

### 5.1 The stored entry

A room's lore is a list of entries in stored order. Every entry has every field below; the
id is assigned by the room, the source records which import wrote it (`""` for an entry the
room admin wrote at the table).

| Field | Type | Range | Default |
|---|---|---|---|
| `title` | text | 1–200 (`MAX_TITLE_CHARS`) | — |
| `content` | text | ≤ 16,000 (`MAX_ENTRY_CHARS`) | — |
| `keys`, `secondaryKeys` | list of non-blank text | ≤ 64 items (`MAX_KEYS`), each ≤ 200 | `[]` |
| `selectiveLogic` | `and_any` `not_all` `not_any` `and_all` | | `and_any` |
| `constant`, `enabled`, `secret` | boolean | | false, true, false |
| `condition` | text | ≤ 500 | `""` |
| `priority` | integer | safe integer | 0 |
| `probability` | integer | 0–100 | 100 |
| `caseSensitive`, `matchWholeWords` | boolean | | false |
| `scanDepth` | integer | 0–200 | 0 |
| `placement` | `before` `default` `after` `author_note_top` `author_note_bottom` `at_depth` `examples_top` `examples_bottom` `outlet` | | `default` |
| `depth` | integer | 0–10,000 | 4 |
| `sticky`, `cooldown` | integer | 0–999 | 0 |
| `delay` | integer | 0–9,999 | 0 |
| `group` | text | ≤ 200 | `""` |
| `groupWeight` | integer | 0–10,000 | 100 |
| `groupOverride` | boolean | | false |
| `category` | text | ≤ 200 | `lore` |

### 5.2 Import, field by field

An import reads a book's `entries` (a list, or an object whose values are the entries) and
normalises each object entry; non-objects are ignored. Where a field has an *extension*
name, `entry.extensions.<name>` is read first when it is present and not null (SillyTavern
writes a character book's trigger fields there); otherwise the top-level names are tried in
order, the first present and not null winning.

| Stored | Extension | Top-level names | Reading |
|---|---|---|---|
| `title` | | `title`, `comment`, `name` | The first that is non-empty text. A leading `[GENERATE:…]` prefix is removed. Cut to 200. Default `<source> <n>` (`n` the 1-based position in the book). |
| `content` | | `content` | The text after the leading decorator lines (§5.3). |
| `keys` | | `keys`, `key` | A string is one key; a list keeps strings and numbers (as text); blank keys dropped; each cut to 200; the first 64 kept. |
| `secondaryKeys` | | `secondary_keys`, `keysecondary` | As `keys`, but only when `selective` is absent or truthy; otherwise none. |
| `selectiveLogic` | `selectiveLogic` | `selective_logic`, `selectiveLogic` | An integer 0–3 means `and_any`, `not_all`, `not_any`, `and_all`; a name is itself; anything else `and_any`. |
| `constant` | | `constant` | Truthy, or an `@@activate` decorator; **keeper trust only** (§5.4). |
| `enabled` | | `disable`, `enabled` | False when `disable` is `true`, or `enabled` is present and falsy; also forced false by §5.3. |
| `secret` | `secret` | `secret` | Truthy. |
| `condition` | | | The `@@if` expression, cut to 500. |
| `priority` | | `priority`, `insertion_order`, `order` | Integer. |
| `probability` | `probability` | `probability` | Integer clamped to 0–100; 100 when `useProbability` (extension, then `useProbability`, `use_probability`) is present and falsy. |
| `caseSensitive` | `case_sensitive` | `case_sensitive`, `caseSensitive` | Truthy. |
| `matchWholeWords` | `match_whole_words` | `match_whole_words`, `matchWholeWords` | Truthy. |
| `scanDepth` | `scan_depth` | `scan_depth`, `scanDepth` | Integer clamped to 0–200. |
| `placement` | `position` | `position` | An integer 0–7 means `before`, `after`, `author_note_top`, `author_note_bottom`, `at_depth`, `examples_top`, `examples_bottom`, `outlet`; `before_char` / `after_char` mean `before` / `after`; anything else `default`. |
| `depth` | `depth` | `depth` | Integer clamped to 0–10,000. |
| `sticky`, `cooldown`, `delay` | same | same | Integers clamped as in §5.1. |
| `group` | `group` | `group` | Text, cut to 200. |
| `groupWeight` | `group_weight` | `groupWeight`, `group_weight` | Integer clamped to 0–10,000. |
| `groupOverride` | `group_override` | `groupOverride`, `group_override` | Truthy. |
| `category` | `category` | `category` | Text; default `lore`. |

*Truthy*: a non-empty list or object, or any other value JavaScript reads as true.
*Integer*: a number truncated toward zero, a boolean as 0/1, or a string of 1–15 digits
with an optional sign; anything else is the default. *Text*: a string, or a number or
boolean that is truthy, as its text.

When the import binds a card name, `{{char}}` (any case and spacing), `<char>` and `<BOT>`
are replaced by it in the title, content and keys. An entry whose content is then longer than
16,000 is skipped and its title reported; an entry with empty content is dropped.
Declaration entries (§8.2) are never stored as lore. The lore import also treats as a
declaration, and drops, an entry whose title (`title`, `comment` or `name`) contains
`initvar` case-insensitively without the brackets of §8.2: such an entry is neither stored
as lore nor read into the tree; the world import reports how many there were.

> **Differs from SillyTavern.** SillyTavern turns a character-book entry that lacks
> `enabled` into a disabled one, one that lacks `selective` into one that ignores its
> secondary keys, and one that lacks `position` into "after". Loreweaver keeps the lenient
> defaults for all three: enabled, selective, default placement.

### 5.3 Decorators

An entry's content may start with decorator lines: `@@name` or `@@name argument`. Parsing
starts at the first line and stops at the first line that is neither a decorator nor
blank; a blank first line means there are none; blank lines after a decorator are
consumed; leading whitespace on a decorator line is allowed; a name is letters and `_`,
lower-cased; a repeated decorator's last value wins. Every decorator line is removed from
the stored content. Meanings:

| Decorator | Effect |
|---|---|
| `@@if <expression>` | The entry's condition (§6 step 5). |
| `@@activate` | Like `constant` (keeper trust only). |
| `@@dont_activate` | The entry imports disabled. |
| `@@render_before`, `@@render_after`, `@@iframe`, `@@message_formatting` | Front-end rendering: the entry imports disabled. |
| `@@initial_variables` | The entry is a variable declaration (§8.2). |
| any other | Removed, no effect. |

An entry also imports disabled when its title starts with `[RENDER:` (case-insensitive), or
when its content is nothing but status-bar residue (§7.3). Disabled entries are kept, so
the room admin can switch them on (§9).

### 5.4 Trust

An imported file never chooses its own privileges. Ids are always assigned by the room, so
a file cannot address another file's entries.

- **Keeper trust** (the world import): `secret` and `constant` are honoured, declarations
  feed the variable tree. A re-import of the same source replaces that source's entries.
- **Player trust**: a secret entry MUST be dropped, never stored as public lore; `constant`
  and `@@activate` are ignored; declarations are dropped; entries are only ever added.

In this version only the world import stores imported lore; the player rules apply to any
runtime path that stores lore from a non-admin file.

## 6. Activation

Each turn the runtime selects the entries the Keeper's prompt carries. The input is the
room's entries in stored order (each with the overlay of §9 applied), a transcript window
(oldest message first; which messages it holds is the runtime's), the room's timer state,
and who the result is for: **keeper** or **player** grade. Randomness comes from a source
seeded from persisted inputs (the reference: room, generation and turn), so a retry of a
turn draws the same.

1. **Visibility.** Disabled entries are removed; for a player-grade run every secret entry
   is removed too. A removed entry cannot trigger, draw, win a group or open a timer.
2. **Timers.** The room counts turns: each turn's first assembly is turn *t* = previous + 1
   (a retry or a browse re-uses *t*, opens no window, and disregards the windows *t* itself
   opened). An entry inside its sticky window
   is selected without its keys and skips steps 3–4. An entry with `delay` *d* > 0 is not
   eligible while *t* < *d*; an entry inside its cooldown window is not eligible.
3. **Triggers.** An eligible entry triggers when it is `constant`; or when one of its keys
   matches the scanned text and its secondary keys pass `selectiveLogic` (`and_any`: one
   matches; `and_all`: all match; `not_any`: none matches; `not_all`: not all match; no
   secondary keys: pass); or when the runtime's semantic recall named it (optional; a recall
   hit still passes every other step). The scanned text is the newest `scanDepth` messages
   (0: the whole window), each trimmed, joined with a newline and U+0001 so no key spans
   two messages, at most the newest 200,000 characters (`MAX_SCAN_CHARS`). A key is
   trimmed (blank never matches) and matched as a literal substring, case-folded unless
   `caseSensitive`. With `matchWholeWords`, a key of one word must be bounded on both sides
   by the text's edge or a character outside `[A-Za-z0-9_]` (so a CJK letter is a
   boundary); a key of several words is a substring test.
4. **Probability.** For each triggered entry with 0 < `probability` < 100, in stored order,
   one draw of 1–100; it survives when the draw ≤ `probability`. `probability` 0 never
   survives; 100 never draws.
5. **Conditions.** An entry with a non-empty `condition` survives only when it holds. The
   condition is evaluated in the closed expression language ([rulepacks.md](rulepacks.md)
   §3) with names read from the room's variables (§8.6). A condition the language cannot
   compile, or whose evaluation fails, MAY be evaluated as JavaScript in the template
   sandbox (§7.1); the reference does. Every other failure is false: a condition fails
   closed.
6. **Inclusion groups.** `group` is a comma-separated list of names; an entry may belong to
   several. Of the survivors sharing a group, one remains: a sticky-active member (all
   others removed), else the member with `groupOverride` and the highest `priority` (the
   first on a tie), else a weighted draw of 1–Σweights over the members in stored order (a
   total of 0 picks the first). Winners keep their place.
7. **Selection order.** Sort by placement bucket (`before`, then every other placement,
   then `after`), then `priority` descending, then stored order.
8. **Count and budget.** Take the first *N* entries, then keep each whose content fits the
   remaining character budget (raw content code points; an entry that would overflow is
   skipped and a later, smaller one may still fit). *N* and the budget are the runtime's;
   the reference Keeper turn uses 12 entries and 12,000 characters (`DEFAULT_MAX_ENTRIES`,
   `DEFAULT_BUDGET_CHARS`).
9. **Placement.** Lay the kept entries out by bucket, then `priority` **ascending**, then
   stored order: larger priorities end up later, nearer the end of the prompt.
10. **Timers open.** Each kept entry that was not already sticky-active and has `sticky` *s*
    or `cooldown` *c* opens its windows at *t*: sticky through *t* + *s*, cooldown through
    *t* + *s* + *c*.

Only `before` and `after` change the order inside the lore section. Every entry reports its
placement and `depth`; a runtime MAY place `at_depth` and the other SillyTavern positions
elsewhere in its prompt. The reference renders one lore section.

**The `activewi` pass.** After the selected entries are rendered, the names their templates
passed to `activewi()` pull further entries in, by id or title, once each, from the
visible entries (step 1), at most *N*, without the budget. Names requested while rendering a
pulled-in entry are reported but not followed.

> **Differs from SillyTavern.** Timers count the room's turns, not chat messages.
> Probability is drawn before conditions and groups (SillyTavern draws after groups and has
> no conditions). Regular-expression keys (`/…/flags`) match as the literal text they are.

## 7. Rendering: templates and macros

An entry whose content contains neither `<%` nor `{{` is used as it is. Otherwise: content
with `<%` is rendered as a template (§7.1) — a template that fails renders as **nothing**,
never as its source; then the macros run (§7.2); then status-bar residue is scrubbed
(§7.3). An entry that renders empty counts as selected but adds no text. Raw template
syntax MUST NOT reach a model.

### 7.1 Templates

Templates are EJS with the API of the ST-Prompt-Template extension, as far as this section
lists it. They are content code: a runtime MUST run them away from its own state, with no
host I/O and no host callables, and MUST bound their running time.

**Environment.** A fresh context for each prompt assembly, dropped after it. Only text
crosses into it, and results are re-checked when they come out. Inside it `Math.random` is
a stream seeded from the assembly's seed, `Date` is fixed at a persisted time (the reference:
the player line's), and `console` (no-ops), `Temporal`, `ShadowRealm`, `WebAssembly`,
`SharedArrayBuffer`, `Atomics`, `WeakRef` and `FinalizationRegistry` are removed. The
template sees, as locals:

| Name | Meaning |
|---|---|
| `getvar(name, {defaults}?)` | A typed variable by id, else a tree path (§8.6); `defaults` when nothing is there. Sees the template's own earlier writes. |
| `setvar(name, value)`, `incvar(name, n = 1)`, `decvar(name, n = 1)` | Write requests, applied after the assembly (below). |
| `getwi(name)`, `getwi(book, name)`, `getWorldInfo` | An entry's content **as stored** (not rendered), by title; disabled entries included; for a player-grade run, secret entries excluded. |
| `activewi(name)` | Requests an entry for the `activewi` pass (§6). At most 64 per assembly. |
| `variables` | The tree merged with the typed variables, as the render starts. `stat_data`, `data.stat_data`: the tree. |
| `define(name, value)` | Defines a local for the later renders of the same assembly; returns the old value. |
| `execvar(name)` | Evaluates a variable's text as JavaScript in the context. |
| `injectPrompt(key, text)`, `getPromptsInjected(key)` | A store inside the context only; nothing reaches the prompt. |
| `getchar(field?)`, `getchat(field?)` | Snapshots the runtime supplies (the reference: none). |
| `SafeGetValue(node)`, `_` (lodash), `print(…)`, `faker` | `faker` returns `""` for every call and records a warning. |

Output is not escaped. The tree a keeper-grade run sees is the whole tree; a player-grade
run sees only exposed leaves (§8.4).

**Limits** (the reference's; a runtime MAY choose smaller):

| Limit | Value |
|---|---|
| One render or condition | 1,000 ms by default, at most 5,000 (`MAX_PER_TEMPLATE_MS`) |
| All renders and conditions of one assembly | 3,000 ms by default, at most 15,000 (`MAX_PER_ASSEMBLY_MS`) |
| Template source | 65,536 UTF-16 units (`MAX_TEMPLATE_CHARS`) |
| Rendered text | 100,000 UTF-16 units (`MAX_OUTPUT_CHARS`) |
| Writes per assembly | 64 (`MAX_TEMPLATE_WRITES`); each value ≤ 16,384 UTF-16 units of JSON |

A promise a template leaves pending when its call returns has failed. After a timeout the
context is rebuilt (writes so far kept, `define`s lost). Failure codes: `syntax`, `runtime`,
`timeout`, `unsettled`, `template_too_large`, `output_too_large`,
`assembly_time_exhausted`, `engine`. Failures are reported to the operator; the turn goes on.
This version does not require a memory limit on templates; the reference sets none beyond
the room worker's.

**Writes.** After the assembly, each write's path (`variables.` / `stat_data.` removed) is
applied in order: to a typed variable when it names one (validated by its kind, §8.5),
otherwise as a `set` on the tree (§8.3: the path must already exist). A write that fails is
skipped and reported.

### 7.2 Macros

Macros run on rendered lore, on the post-history directive every turn, and on an opening
before it is spoken, in this order, each pass reading the previous pass's output:

1. `<USER>`; `<BOT>` and `<CHAR>` (case-insensitive);
2. `{{roll:F}}` / `{{roll F}}`: the total of dice formula *F* rolled by the runtime's dice
   roller (a bare number *N* is `1dN`; a formula that does not roll prints nothing);
3. `{{getvar::name}}` and `{{var:name}}`: a variable (§8.6);
4. `{{newline}}` (a line break), `{{trim}}` (removed with the line breaks around it),
   `{{noop}}` (removed);
5. `{{user}}` (the speaking member's character), `{{char}}`;
6. `{{// comment}}`: removed;
7. `{{time}}`, `{{date}}`, `{{weekday}}`, `{{isotime}}`, `{{isodate}}`: the **game** clock;
   `{{reverse:text}}`; `{{random::a::b}}` or `{{random:a,b}}` (`::` splits without
   trimming; otherwise commas, trimmed, `\,` escaping a comma): a seeded draw;
   `{{pick…}}`: the same lists, a pick seeded from the room, the text and the macro's
   position, so the same text picks the same item.

A macro whose context is absent (no clock string, no roller) stays as written. Values print
as text: strings as they are, null as nothing, objects and lists as JSON. The
variable-writing macros (`{{setvar}}`, `{{addvar}}`, `{{incvar}}`, `{{decvar}}` and their
global forms) are not run and stay as written; so does every unknown macro.

> **Differs from SillyTavern.** Time macros print the game clock, not the wall clock;
> random draws are seeded, so a retried turn draws the same.

### 7.3 Status-bar residue

Cards built for SillyTavern's front end carry `{{format_message_variable::…}}` and
`{{get_message_variable::…}}` inside wrapper tags. Rendering removes these macros, then
repeatedly removes wrapper pairs `<tag>…</tag>` left holding only whitespace (at most 64
passes), and trims. Content that is nothing but such residue — empty, or only separator
lines (three or more of `-=_*·—`) once scrubbed — imports disabled (§5.3). This is
Loreweaver's own rule.

## 8. Room variables

A room holds two kinds of variables: the **tree** a world card declares and the Keeper
updates, and **typed variables** a native bundle declares.

### 8.1 The tree

A tree is a mapping whose values are null, booleans, finite numbers, strings, lists and
mappings. Key order is meaning and MUST be preserved; every key, including `__proto__` or
`10`, is an ordinary key. A leaf written `[value, "description"]` — a two-element list whose
second item is a string and whose first is a scalar or a list of scalars — is one **described
leaf**: it reads as its value.

| Bound | Value | Problem code |
|---|---|---|
| Nesting | 16 levels (`MAX_TREE_DEPTH`) | `too_deep` |
| Nodes | 4,096 (`MAX_TREE_NODES`) | `too_many_nodes` |
| Key | 256 (`MAX_KEY_CHARS`) | `key_too_long` |
| String | 20,000 (`MAX_STRING_CHARS`) | `string_too_long` |
| Numbers | finite | `non_finite_number` |

A tree over a bound is refused whole, never cut. **Leaves** are listed depth-first in written
order with dotted paths (mapping keys and list indexes joined by `.`): a described leaf is
one leaf, a list of scalars is one leaf, a list holding containers recurses by index, an
empty mapping has none.

### 8.2 Declarations (`[InitVar]`)

A lore entry is a **declaration** when its title (`title`, else `comment`, else `name`: the
first non-empty string), lower-cased, contains `[initvar]`; or that title with spaces
removed, lower-cased, contains `[initialvariables]`; or its content starts with an
`@@initial_variables` decorator.

The declaration's text is its content without decorator lines; then the text between an
`<initvar>` line and a `</initvar>` line, if present; then the inside of a fenced code block,
if present. Text that starts with `{` or `[` is read as JSON5 and then, if that fails, as
YAML; any other text as YAML and then JSON5. The first reading that succeeds decides: a
result that is not a mapping is `not_a_mapping`; a result over a bound fails with the §8.1
code; blank text is `empty`; nothing readable is `unreadable`. YAML here is SPEC.md §4's
profile; JSON5 is read in full (comments, trailing commas, single quotes, identifier keys
including CJK, hexadecimal, `Infinity`, `NaN`), with a non-finite number then failing
`non_finite_number`. No macro is substituted in a declaration.

Several declarations merge in order: mappings merge key by key, anything else in the later
one (a list included) replaces the earlier value.

### 8.3 The update block

The Keeper changes the tree by writing update blocks in its reply. The runtime finds them,
applies them in deterministic code, and publishes the reply **without** them. A reply over
500,000 characters (`MAX_UPDATE_TEXT_CHARS`) is not scanned. A room without a tree applies
nothing, but the blocks are still removed.

- **Blocks.** `<UpdateVariable>…</UpdateVariable>`, also `<VariableUpdate>` and `<Update>`
  (case-insensitive; attributes allowed; a block must be closed by its own tag). A block
  fenced in triple backticks is unwrapped first. Inside a block, `<think>`, `<thinking>`,
  `<reasoning>`, `<analysis>` and `<analyze>` regions are ignored. Commands outside a closed
  block are not read.
- **Commands.** `_.op(arguments);` — the closing `;` is required; an optional `// reason`
  follows on the same line. Arguments split on commas outside quotes and brackets. `set`
  takes ≥ 2 arguments, `insert` (alias `assign`) ≥ 2, `delete` (aliases `remove`, `unset`)
  ≥ 1, `add` exactly 2; other counts are not commands. At most 512 commands per reply
  (`MAX_UPDATE_COMMANDS`; the rest are refused `too_large`).
- **Paths.** The first argument, quotes and backslashes trimmed off its ends, is a path in
  lodash form: `a.b.0`, `a.b[0]`, `a["x.y"]`. Segments are not trimmed. A numeric segment
  indexes a list.
- **Values.** Read in this order: `true`, `false`, `null`; strict JSON; a bracketed JSON5
  object or list; a single-quoted YAML scalar; arithmetic (`+ - * / ^`, parentheses, unary
  signs over number literals, rounded to 12 significant digits); YAML; else the text with
  its quotes trimmed. `undefined` is refused (`bad_value`).

| Operation | Effect |
|---|---|
| `set(path, [expected,] value)` | The last argument replaces the value at an **existing** path (`expected` is never checked). On a described leaf whose value is not a list, the value is replaced and the description kept, a number staying a number. Text written to a number target becomes that number. |
| `insert(path, value)` | Appends to a list, or deep-merges a mapping into a mapping. A missing target is created when its parent exists (a list holding the value when it is a list, else the mapping). |
| `insert(path, key, value)` | Inserts into a list at an index (`-` appends; negative counts from the end; past the end appends), or sets a mapping's key. |
| `delete(path)` | Removes the node, or a list element by its index segment. |
| `delete(path, target)` | Removes from the container at `path`: from a list the element at a numeric index, else the first equal element; from a mapping the key named (a number names the *n*-th key in written order). |
| `add(path, delta)` | Adds a number to a number (or to a described number), rounded to 12 significant digits. |

Each command applies to a copy and replaces the tree only when it succeeds; a refused command
changes nothing and does not stop the others. Refusals (stable codes): `unknown_path`,
`not_a_container`, `missing_parent`, `root_path`, `bad_index`, `not_a_number`,
`delta_not_number`, `unsupported_target`, `bad_value`, `not_found`, `merge_mismatch`,
`too_large` (the result would break §8.1).

> **Differs from MagVarUpdate.** Commands are read only inside closed blocks, so what is
> applied and what is removed from view are the same set. `set` on a missing path is
> refused; a non-numeric key on a list is refused; arithmetic is the operators above, not
> a full math language; `add` does not add to dates or booleans.

### 8.4 Exposure

The tree is the module's own state: by default **no** leaf reaches a player. The room admin
exposes prefixes. A prefix exposes the leaf with exactly that path and every leaf below it,
aligned on segments (`hero` exposes `hero.mood`, never `hero2`); `*` exposes every leaf. A
prefix is trimmed of spaces and stray dots and is at most 200 (`MAX_EXPOSED_PREFIX_CHARS`);
a room keeps at most 64 (`MAX_EXPOSED_PREFIXES`). A player-grade reader receives the exposed
leaves and the tree pruned to them, its shape kept (a described leaf stays a pair); pruning
a list of containers drops hidden elements and shifts later indexes. No runtime path other
than the room admin's own action exposes a leaf in this version.

### 8.5 Typed variables

A typed variable is a spec and a value. Specs are kept in declaration order; a room holds at
most 64 (`MAX_VARIABLES`).

| Spec field | Meaning |
|---|---|
| `id` | Trimmed, lower-cased, runs of whitespace or `-` become `_`; 1–64 code points (`MAX_ID_CHARS`); ASCII characters MUST be `[a-z0-9_]`; any other character is allowed unless it is a separator or control character (`理智` is a valid id). |
| `kind` | `number`, `bool`, `text` or `enum`. |
| `visibility` | `player` (default) or `keeper`. Any other value reads as `player` when a spec is read from a card. |
| `labels` | `{language: text}`; the language is the part of the key before `-`, lower-cased; a blank or non-text label is skipped; one over 50 (`MAX_LABEL_CHARS`) makes the spec unusable. |
| `minimum`, `maximum` | `number` only: integers (numbers truncate; numeric text and booleans coerce), `minimum` ≤ `maximum`. |
| `options` | `enum` only, required: non-blank strings, trimmed, duplicates (case-insensitive) dropped, 1–20 (`MAX_OPTIONS`) of at most 50 (`MAX_OPTION_CHARS`). |
| `option_labels` (or `optionLabels`) | `enum` only: `{language: {option: text}}`; options match case-insensitively; a label naming no option, blank or non-text, is dropped; one over 50 makes the spec unusable. On another kind it is ignored with a warning. |
| `default` | Checked like a write (below); absent: `minimum` (else `min(0, maximum)`, else 0), `false`, the first option, or `""`. |
| `setup` | `true` marks a choice the table makes before play. Recorded; this version defines no behaviour for it. |

**Writes** are validated, never trusted: a `number` takes an integer (truncated toward zero)
clamped into its bounds (`not_a_number` otherwise); a `bool` takes a boolean, 0/1 or one of
`true 1 yes y on` / `false 0 no n off` (`not_a_boolean`); an `enum` takes an option,
case-insensitively, stored in its declared spelling (`not_an_option`); `text` takes text of at
most 200 (`MAX_TEXT_CHARS`), a number or boolean as its JSON text (`not_text`, `too_long`).
Adjusting is for `number` only (`wrong_kind`, `delta_not_number`). An unknown id is
`unknown_path`; a 65th variable is `limit_reached`.

### 8.6 How content names a variable

Lore conditions, `getvar`, `{{getvar::}}` and `{{var:}}` read a name the same way: a leading
`variables.` or `stat_data.` is removed; a typed variable whose id is exactly the rest wins;
otherwise the rest is a dotted path into the tree, where a numeric segment (≤ 9 digits)
indexes a list, a described leaf reads as its value and cannot be indexed into, only own
keys are read, and a path of more than 32 segments reads as nothing. Nothing there reads
as null.

## 9. The lore overlay (keeper-only)

An imported entry is stored as the file wrote it and is never rewritten, so a revised card
re-imports as a clean replacement. The room admin's own decisions live beside the entries,
in the room's **overlay**: per entry **title**, an effective `enabled` and an effective
`condition`. Titles are the key because ids change on every import; entries sharing a title
share an annotation.

- **One effective state.** An overlay `enabled` overrides the entry's; a non-empty overlay
  `condition` replaces the entry's. Nothing else can change: an overlay cannot make a secret
  entry public or rewrite content. A runtime MUST compute the effective entry in one place,
  and every activation path (keywords, semantic recall, `activewi`, the Keeper's lore tools)
  MUST use it.
- **Commands** (the reference's `lore` command, room admin only): `enable <title>`,
  `disable <title>`; `bind <title> | <condition>` sets a condition and switches the entry on
  (a condition on an entry left off could never fire); `unbind <title>` clears the
  condition; `restore <title>` drops the annotation (`*`: all of them). A title MUST name an
  entry the room holds (`not_found`).
- **Conditions** are checked against the closed expression language when written (and again
  when read: a stored condition the language refuses is dropped). An overlay condition MUST
  NOT reach the JavaScript fallback of §6 step 5.
- **Limits.** At most 200 titled annotations (`MAX_OVERLAY_ENTRIES`); a title is 1–200.
- **Re-import** replaces the lore and leaves the overlay alone; annotations whose title no
  entry carries any more are kept until restored.
- **No inference.** A runtime MUST NOT derive annotations from titles, group entries into
  families or pick variants by pattern.

The overlay document can also hold "set before play" items (a path, options and labels, and
whether the table has written that path yet). No path in this version creates them; their
creation is not specified in this version.

## 10. Information isolation (normative)

Every surface that sends room content to a participant, or to an AI-played actor other than
the Keeper, MUST receive it through a per-viewer projection the runtime computes before
transport; a client never filters. Viewers come in three grades: the **Keeper**; the **room
admin acting as themself**; and **player grade** — players, observers, and every AI-played
NPC or companion actor, the admin's own actors included.

| Content | Keeper | Room admin | Player grade |
|---|---|---|---|
| A lore entry | everything | a non-secret entry in full; a secret entry as its id, title, `enabled`, `constant` and source only | an entry that is on (after the overlay, §9) and not secret: its id, title and content; a secret entry, or one switched off, does not exist |
| The world card (§4.1) | everything | name, provenance, directive lengths, how many openings | the name |
| The tree | every leaf, flagged exposed or not; the exposure list | every leaf, unexposed ones flagged `hidden`; the exposure list; the pruned tree | exposed leaves and the pruned tree; nothing exposed means nothing |
| Typed variables | every variable | every variable, keeper-only ones flagged `hidden` | `player` variables only; a keeper-only variable leaves no trace, not even its id |
| The overlay (§9) | all | all | does not exist |
| Activation timers | all | nothing | nothing |

A lore listing for a player carries no trace of the overlay. Because a projection reads one
document, a runtime that keeps the overlay apart from the entries MUST record each entry's
effective switch beside it in the same commit as any write to the lore or to the overlay
(the reference's `syncLoreSwitches`), so an entry the admin switched off is never shown to a
player, not even for one turn. Labels are resolved for each
viewer's language. A player-grade lore assembly (§6) never contains a secret entry, and its
templates' `getwi` library leaves secret entries out.

The Keeper holds the full module truth. Restraint about keeper-only material in its narration
is a behavioural property of the runtime, outside the scope of this format. A panel's
`visible_when` is presentation, not secrecy ([panels.md](panels.md) §6).

## 11. From cards 2.0

Cards 3.0 reads the same SillyTavern cards and native bundles (`format_version` 1). What
changed:

- **Hook scripts** in a card (`extensions.loreweaver_hooks`, a bundle's `hooks`) are counted
  and reported, never installed or run. They still make a card a world card. Code reaches a
  room only as a pack's module ([pack.md](pack.md) §3).
- **Character import** writes a character (a generated sheet and the persona) and a seat,
  nothing else: no lore entry, no variable, no directive. 2.0 imported the character half's
  plain lore at player trust.
- **Pregens** are parsed and reported as not imported; the claimable cast of 2.0 has no
  replacement yet. Importing a card as an AI companion has none either.
- **The pack overlay file** (`format: loreweaver.lore-overlay/1`) is gone with the pack's
  `overlay:` entries; the room admin's `lore` commands remain (§9). A pack can no longer
  expose variable prefixes or declare setup items.
- **Standalone lorebooks** (a pack's `lorebooks`) are gone; lore arrives inside a card.
- **The keeper-only module brief** is replaced by the world card record (§4.1).
- **Subset-mode templates** are gone: a template that cannot run renders as nothing.
- **Defaults that changed:** a lore import reads trigger fields from an entry's
  `extensions` (2.0 ignored them), honours SillyTavern's `disable` and `order`, keeps a
  `groupWeight` of 0, and lays entries out by ascending priority; whole-word matching treats
  CJK letters as boundaries; YAML in declarations is 1.2; an over-long label makes a typed
  variable unusable instead of being dropped.
