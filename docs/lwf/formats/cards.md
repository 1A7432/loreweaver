# LWF: cards, the world/character split (拆卡), and what players never see

**Version 2.0 · stable (additive-only).** Reference implementation: `core/charcard.py`,
`core/lorecard.py`, `core/card_split.py`, `core/worldbook.py`, `core/lore_overlay.py`,
`core/documents.py`, `core/mvu_compat.py` and `agent/kp_tools_charcard.py` in the
Loreweaver engine.

Terms: the **keeper role** is the privileged room role. The human who holds it is the
**room admin**. The **Keeper** is the runtime's AI game master. *Keeper-only* data is
data that only keeper-role viewers and the Keeper may receive. See [SPEC.md](../SPEC.md)
§2.

## 1. SillyTavern cards

A card is SillyTavern JSON, either as a file or embedded in a PNG. The file is at most
16 MiB.

- **JSON.** A file is read as JSON when its name ends in `.json` or its first non-blank
  byte is `{` or `[`. When `spec` is `chara_card_v2` or `chara_card_v3`, the card body
  is `data`. Otherwise the root object is the body.
- **PNG.** The runtime walks the PNG chunks and takes the first `tEXt`, `zTXt` or `iTXt`
  chunk whose keyword is `chara` or `ccv3`. Its text is base64 of the card JSON.
  Compressed chunk text MUST be inflated under a cap: the reference refuses more than
  4 MiB of inflated text (zlib-bomb defense).

**Fields consumed.** The runtime reads `name`, `description`, `personality`, `scenario`,
`first_mes`, `mes_example`, `creator_notes` (or `creator_notes_multilingual`),
`system_prompt`, `post_history_instructions`, `tags`, `character_book.entries`,
`alternate_greetings` (world import only, §5.2) and `extensions.loreweaver_hooks` (§4).
Unknown fields MUST be ignored, never rejected.

LWF adds one extension key, `extensions.loreweaver_hooks`: a list of hook-script
strings or `{code: "..."}` objects ([skills-hooks.md](skills-hooks.md)).

Reference: `core/charcard.py::parse_card_bytes`.

## 2. The native bundle (`*.lorecard.json`)

The native bundle is Loreweaver's own card format. It keeps what a SillyTavern card has
no safe place for: keeper-only lore, typed trackers, a claimable cast, per-entry
conditions, stable entry ids and hook scripts. A runtime recognizes it by content: a
UTF-8 JSON object whose `format` is `"loreweaver.card"`.

**Format version.** `format_version` is an integer, currently `1`. A consumer MUST refuse
a newer version, and accepts an older one only through a registered migration. Version 0
(the pre-freeze shape) has none and MUST be refused.

**Failure semantics.** Structural problems are fatal and the bundle is refused: not JSON,
the wrong `format`, an unsupported version, or a hard cap exceeded. Entry-level problems
are not fatal: a malformed lore entry, variable spec or pregen is skipped and reported as
a warning.

| Field | Meaning |
|---|---|
| `format`, `format_version` | Required, see above. |
| `name` | The card or module name. |
| `description`, `personality`, `scenario` | Prose. |
| `opening`, `alternate_openings` | The opening text and its alternatives (SillyTavern: `first_mes`, `alternate_greetings`). |
| `dialogue_examples`, `author_notes` | SillyTavern: `mes_example`, `creator_notes`. |
| `tags` | A list of strings; a bare string counts as one item. |
| `worldbook` | Lore entries, at most 200 (the room-import cap, §6). See below. |
| `variables` | Typed variable specs, at most 64 (the room variable cap). See below. |
| `pregens` | A claimable cast. Entries beyond 8 are dropped with a warning. See below. |
| `hooks` | Hook scripts: strings or `{code}` objects. A bare string counts as one script. |

**`worldbook[]` entries.** `content` is required: an empty one is skipped, and one over
16,000 characters fails the whole bundle. Optional fields:

- `id`: a stable, author-owned id (see [pack.md](pack.md) §7);
- `title`: defaults to `Untitled Lore`;
- `keys`, `secondary_keys`;
- `selective_logic`: one of `and_any` (default), `and_all`, `not_any`, `not_all`;
- `category`;
- `secret`, `constant`, `enabled` (default true);
- `priority`;
- `probability`: 0–100, default 100;
- `case_sensitive`, `match_whole_words`;
- `scan_depth`: 0–200;
- `position`: `before` or `after`;
- `sticky`, `cooldown`: 0–999; `delay`: 0–9999;
- `condition`: a condition expression (§7.1). A condition longer than 500 characters
  never fires and produces a warning.

**`variables[]` specs.** Each spec has these fields:

- `id`: lowercased, with spaces and hyphens turned into `_`. It is 1–64 characters: ASCII
  `[a-z0-9_]`, plus any non-ASCII character that is not a separator or control.
- `kind`: `number`, `bool`, `text` or `enum`.
- `labels`: `{locale: text}`, each label at most 50 characters.
- `visibility`: `player` (the default) or `keeper`.
- `minimum`, `maximum`: integers, `number` only.
- `options`: `enum` only. A non-empty list, at most 20 options of at most 50 characters
  each, unique case-insensitively.
- `default`.
- `setup`: true marks a choice the table must make before play (§7).

Every value written to a typed variable is validated and clamped: numbers are integers
kept inside their bounds, text is truncated to 200 characters, and enums are matched
case-insensitively. A room holds at most 64 typed variables. Reference:
`core/modvars.py::build_spec`, `validate_value`.

**`pregens[]` entries.** Each entry is
`{name (≤60 chars), concept or blurb (≤200), notes (≤400), skills?: {canonical name: integer}}`,
with at most 32 skills. The runtime builds each sheet deterministically from the target
rule system's defaults plus these overrides, then validates it against the rulepack.

Reference: `core/lorecard.py::parse_lorecard_bytes`.

## 3. The two halves

A SillyTavern "heavy card" fuses two artifacts into one file. LWF keeps them apart:

- the **character half**: persona prose, plain personal lore and a rules-validated
  sheet. Any participant may import it;
- the **world half**, or *world machinery*: hook scripts, variable declarations,
  executable templates and keeper-only lore. It reprograms play for the whole table, so
  only the keeper role may import it.

A card's **directives**, `system_prompt` and `post_history_instructions`, are standing
prompt text, not machinery. They do not make a card a world card. They follow the world
half on import, though: only a world import carries them (§5).

## 4. Machinery detection (normative)

A card **carries world machinery** if and only if at least one of the following holds:

1. **Hooks.** The card has at least one non-empty hook script. Scripts are read from the
   first location that holds a list: the root `hooks` list, then
   `data.extensions.loreweaver_hooks` when `data.extensions` is a mapping, otherwise the
   root `extensions.loreweaver_hooks`.
2. **Variable declarations.** At least one lore entry is a declaration entry, or (native
   bundles only) the bundle declares at least one valid typed variable spec. A lore entry
   is a declaration entry when one of these holds:
   - its `title` (else `comment`, else `name`) contains `initvar`, case-insensitively;
   - that title, with spaces removed and lowercased, contains `[initialvariables]`;
   - its content opens with an `@@initial_variables` decorator line.
3. **Executable templates.** At least one EJS span (`<%` … `%>`, any variant) occurs in
   `description`, `personality`, `scenario`, `first_mes`, `mes_example`, `creator_notes`,
   or in the content of a lore entry that is neither a declaration entry nor secret. An
   unclosed `<%` counts as a span running to the end of the text.
4. **Keeper-only lore.** At least one lore entry has `secret: true`.

Detection MUST be deterministic code, never delegated to a model. Builders and runtimes
MUST use the same predicate: it decides the pack's `kind` stamp ([pack.md](pack.md)
§2.1) and what a character import strips (§5.1).

Declaration bodies are variable trees: JSON5-tolerant objects (comments, trailing
commas, single quotes, unquoted keys), with YAML block mappings accepted as an
alternative. Leaves may be `[value, "description"]` pairs, and nested CJK paths are
allowed.

Reference: `core/card_split.py::split_card`, `card_hook_codes`,
`is_variable_declaration_entry`; `core/mvu_compat.py::parse_initvar`.

## 5. Import semantics (normative)

### 5.1 Character import

Any participant may import the character half of a card they uploaded, or of a card
named by a confined pack-relative reference ([pack.md](pack.md) §7). Importing from an
arbitrary server-side path, and importing as an AI-played companion, require the keeper
role.

Before anything touches room state, the runtime MUST structurally strip the card:

- remove every declaration entry and every secret entry from the lorebook;
- remove every EJS span from the prose fields and from the remaining lore content;
- blank both directive fields;
- drop the hook scripts and the directive keys from the stored raw document.

It MUST NOT install hooks, seed the room's shared variable tree, define typed variables
or register pregens from a character import. It SHOULD itemize what it stripped in its
reply. The remaining lore imports with player trust (§6). The resulting sheet MUST
validate against the active rulepack ([rulepacks.md](rulepacks.md) §9).

### 5.2 World import

World import requires the keeper role. The gate MUST be a deterministic privilege
check, and MUST NOT be invocable by the Keeper as a tool. A world import reads the
**original** card, both halves:

- **Lore.** The full lorebook imports with keeper trust (§6): `secret` and `constant` are
  honored.
- **Variables.** Declaration entries seed the room's imported variable tree. Existing
  values win, so a re-import never resets progress. Declaration entries are not stored as
  lore.
- **Typed variables.** A native bundle's typed variable specs are defined as typed
  variables. Its `setup: true` specs become pending set-before-play items (§7).
- **Hooks.** Hook scripts are installed room-wide. A re-import replaces that card's
  scripts and never stacks them. A room runs at most 16 scripts in total.
- **Keeper-only brief.** The card's prose (description, scenario, opening, alternate
  openings) and its directives are copied into a keeper-only module brief. Directives are
  prepared deterministically: EJS spans removed, `{{original}}` dropped, and `{{char}}`
  bound to the card name.
- **Cast.** The character half SHOULD land on a claimable pregen roster when it has a
  persona (non-empty `personality`; for SillyTavern cards, a non-empty `first_mes`
  also counts). A native bundle's `pregens` SHOULD land there too. Claims are exclusive,
  and a release restores the pristine sheet.
- **Overlay.** When the card is imported from an installed pack home and the pack
  declares an overlay for it, the overlay is applied (§7).

Reference: `agent/kp_tools_charcard.py::import_world_card`,
`agent/hook_runtime.py::install_room_hooks`, `core/module_brief.py`.

## 6. Lorebook import trust

These rules apply to a card's embedded lorebook and to standalone lorebooks alike. An
imported file never chooses its own privileges.

- **Scope is pinned** to the importing room, and imported entry ids are always
  regenerated, so a file cannot address or overwrite another file's entries.
- **`secret`** is honored only on a keeper-role import. On any other import a secret
  entry MUST be dropped, never imported as public lore.
- **`constant`** is honored only on a keeper-role import, and forced off otherwise.
- **Re-import.** A keeper-role re-import of the same source first removes the entries
  that source wrote before, so it replaces rather than stacks. Player imports are always
  additive, so a crafted card cannot displace a module's lore.
- **Caps.** One import holds at most 200 entries, and a larger import is refused. An
  entry over 16,000 characters of content is skipped and reported.
- **Templates.** `{{char}}` (also `<char>` and `<BOT>`) binds statically to the card name
  at import. `{{user}}` stays dynamic.
- **Decorators.** A leading `@@if <expr>` decorator becomes the entry's condition.
- **Disabled on import.** These entries import disabled, so they never reach a prompt:
  entries with `@@dont_activate`; render-only entries (`[RENDER:` titles, or the
  `@@render_before`, `@@render_after`, `@@iframe` or `@@message_formatting` decorators);
  and entries whose content is pure frontend-template residue. A `[GENERATE:…]` title
  prefix is removed.

**Field aliases.** The runtime honors these entry fields, under their V2 and their
SillyTavern world-info names:

- `keys` / `key`;
- `secondary_keys` / `keysecondary`, ignored when `selective` is false;
- `selective_logic` / `selectiveLogic`, with integer codes 0 = and_any, 1 = not_all,
  2 = not_any, 3 = and_all;
- `content`, `comment` / `title` / `name`, `category`;
- `priority` / `insertion_order`;
- `enabled`;
- `position`: `before_char` / `after_char` / `0` / `1`;
- `case_sensitive` / `caseSensitive`, `match_whole_words` / `matchWholeWords`,
  `scan_depth` / `scanDepth`;
- `probability`, honored unless `useProbability` is false;
- `sticky`, `cooldown`, `delay`;
- `group`, `group_weight` / `groupWeight`.

A runtime that activates lore SHOULD honor ST trigger semantics: all four
secondary-key logics, `probability` rolled by real code, timed effects counted against
a per-room turn counter, and inclusion groups (one member per group per activation,
picked by weight). A condition MUST fail closed: an entry whose condition errors or
cannot be evaluated is not injected.

Reference: `core/worldbook.py::import_entries`, `_normalize_import_entry`.

## 7. The lore overlay (keeper-only annotation)

An imported entry is stored faithfully and is never rewritten. A room's **overlay** is a
separate keeper-only document. It says, per entry **title**, what the effective
`enabled` and `condition` are. Titles are the key because ids regenerate on every
import.

- **One effective state.** A runtime MUST compute an entry's effective state in exactly
  one place, and every activation path MUST use it: keyword matching, semantic recall and
  template-driven activation. An overlay `enabled` of true or false overrides the file,
  and an absent one leaves the file's value. A non-empty overlay `condition` replaces the
  file's condition.
- **Re-import.** A re-import replaces the lore and leaves the overlay untouched. Overlay
  titles that the new version no longer carries are reported as stale.
- **No inference.** A runtime MUST NOT derive overlay entries from titles, group entries
  into families, or pick variants automatically. An overlay entry exists because the
  room admin wrote it or because an installed pack shipped it.

**The overlay file.** A pack can ship an overlay as data ([pack.md](pack.md) §2.1). The
file is YAML, at most 256,000 bytes, and is closed at every level:

```yaml
format: loreweaver.lore-overlay/1        # required, exact
entries:                                 # title -> override, at most 200
  "Difficulty: hard": {condition: 'config.difficulty == "hard"'}
  "Reply template": {enabled: false}
setup:                                   # set-before-play choices, at most 64
  - {path: config.difficulty, options: [easy, normal, hard], labels: {en: Difficulty}}
expose: [config]                         # variable prefixes published to players
```

- **Entries.** An override has `enabled` (a boolean) and/or `condition` (§7.1). A
  condition without `enabled` implies `enabled: true`, because a binding on an entry that
  stays disabled could never fire.
- **Setup.** An item has `path` (required, unique), `options` (at most 20 scalars) and
  `labels` (`{locale: text}`, each at most 50 characters). An item stays pending until
  the table writes that path. Its default value does not count as a choice.
- **Expose.** At most 32 prefixes are kept. A prefix starting with `*` MUST be refused:
  only a room admin acting at the table may expose the whole tree.
- **Application.** A runtime applies a pack overlay only when the room admin
  world-imports the card **from that pack's home**. The same card imported from an
  attachment gets no overlay. A character import MUST NOT read an overlay.

### 7.1 Condition expressions

Conditions use the closed expression grammar of [rulepacks.md](rulepacks.md) §3, at
most 500 characters, with no function calls except `getvar('<path>')`. Names resolve
against the room's typed variables and its imported variable tree.

- An **overlay condition** MUST be validated against this grammar when it is written,
  and MUST NOT fall back to a JavaScript evaluator.
- A lore entry's **own** condition, from `@@if` or a native `condition`, is evaluated
  with this grammar first. A runtime that runs full-mode templates
  ([skills-hooks.md](skills-hooks.md) §7) MAY evaluate a condition the grammar cannot
  parse inside the template sandbox.

Either way, evaluation fails closed.

Reference: `core/lore_overlay.py::apply`, `parse_overlay_file`.

## 8. Information isolation (normative)

Every consumer that sends room content to a participant, or to an AI actor that is not
the Keeper, MUST receive it through a per-viewer projection computed by the runtime
before transport. A client never filters. A **player-grade** viewer is any viewer
without the keeper role, including an AI-played NPC or companion actor.

A player-grade consumer MUST NEVER receive:

1. a lore entry marked `secret`, in whole or in part;
2. a typed variable with `visibility: keeper`, neither its value nor its spec, and so not
   its name either;
3. a leaf of the imported variable tree that is not under an exposed prefix;
4. the room's lore overlay document, any part of it;
5. a keeper-only module brief, including the card directives it carries;
6. a pregen's pristine sheet before that pregen is claimed;
7. keeper notes, and the keeper half of a module knowledge pool;
8. another actor's private record. An NPC or companion actor sees its own record in full
   and every other record at player grade, as listed in the reference projections.

**Variable exposure.** The imported variable tree starts fully hidden. Exposure is a
keeper-role action over path prefixes. A prefix exposes itself and its dotted subtree,
segment-aligned: `hero` exposes `hero.mood` but not `hero2`. `*` exposes everything. The
only path that publishes leaves without a room admin typing it is a pack overlay's
explicit `expose` list, applied by a world import (§7), and its prefix count is
disclosed before install ([pack.md](pack.md) §4.2). Keeper-role viewers receive the
hidden remainder flagged `hidden: true`.

Two clarifications:

- Hooks see the keeper view of variables ([skills-hooks.md](skills-hooks.md) §4), and
  their emitted output is player-visible. Authors MUST NOT emit keeper-only material.
- A panel's `visible_when` gate is presentation, not secrecy ([panels.md](panels.md)
  §5). Secrecy is the projection above, plus a panel's `audience`.

The Keeper itself holds the full module truth. Restraint about keeper-only material in
its narration is a behavioral property of the runtime, outside the scope of this format.

Reference: `core/documents.py` (`project` and the per-type projections),
`core/mvu_compat.py::path_is_exposed`, `core/module_brief.py::project_brief`.

## 9. Templates and macros

Card and lore text may embed EJS templates and SillyTavern macros. Their semantics,
including the rule that raw template syntax never reaches a model, are specified in
[skills-hooks.md](skills-hooks.md) §7. Executable templates count as world machinery
(§4).
