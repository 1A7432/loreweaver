*English · [中文](cards.zh.md)*

# Cards: bringing SillyTavern cards and lorecards into a room

You have character cards and lorebooks made for SillyTavern, or you are writing a world
for Loreweaver. This page says what happens when a card comes into a room: what imports,
what actually runs, and where a card behaves differently because it now lives in a game
with real dice. The format behind it is [LWF cards](lwf/formats/cards.md); putting cards
in a pack is [authoring.md](authoring.md) §4.1.

One idea first: Loreweaver **splits every card** (拆卡). A SillyTavern "heavy card" fuses
a character with a whole world — variable schemas, templates, secret lore — because a
single-player frontend had nowhere else to put them. Here they are two halves:

- the **character half** — a name and a persona — which any player may import as their
  own character;
- the **world half** — lore, variable declarations, templates, the card's standing
  directives and openings — which only the room's admin imports, because it reprograms
  play for the whole table.

A card is never refused for being heavy: it is taken apart, and each import says by
count what it left behind.

## What imports

- **SillyTavern cards**, spec v1, v2 (`chara_card_v2`) and v3 (`chara_card_v3`), as JSON
  or as a PNG with a `chara` or `ccv3` text chunk; at most 16 MiB. Fields read: `name`,
  `description`, `personality`, `scenario`, `first_mes`, `mes_example`, `creator_notes`,
  `system_prompt`, `post_history_instructions`, `alternate_greetings`, `tags` and the
  `character_book`. Unknown fields are ignored, so a card from a newer SillyTavern still
  imports.
- **Lorebooks** travel as a card's `character_book`. Both the V2 field names and
  SillyTavern's native world-info names are read. A standalone lorebook file is not a
  card and imports nothing: put its entries in a card.
- **Native cards** (`*.lorecard.json`, `"format": "loreweaver.card"`), Loreweaver's own
  format. It has what a SillyTavern card has no safe place for: keeper-only (`secret`)
  entries, typed variables, per-entry conditions and stable entry ids. A sample is in
  [authoring.md](authoring.md#41-cards-and-lore); the fields are
  [LWF cards](lwf/formats/cards.md) §2.

## How to import

A card is imported **as a world** (the room's admin) or **as a character** (any player).

- **From a client.** The terminal client and Loreweaver Studio upload the card file and
  run the import. Uploading needs the room's upload switch on (`.uploads on`, the admin's).
  Only the member who uploaded a file can import it.
- **From an enabled pack** (`kind` in the pack's manifest says which half the card is):

  ```
  .import world <pack> <card path>
  .import character <pack> <card path> [name]
  ```

  In Chinese, `.导入 世界 …` and `.导入 角色 …`. When a pack is installed from chat, its
  answer prints the import line for each world card it ships.
- **From the shell**, as the operator: `loreweaver import-world <room> <card-file>` brings
  a card in as a room's world.

The protocol side (upload, then `command.run import`) is [protocol.md](protocol.md) §11.6.

## What a world import brings

Only the room's admin can import a world, and the Keeper cannot do it as a tool. A world
import reads the whole original card:

- **Lore.** The full lorebook becomes the room's lore entries, with the admin's trust:
  `secret` entries stay keeper-only and `constant` entries are always on.
- **Variables.** `[InitVar]` entries (a title containing `[InitVar]`, brackets included:
  `initvar notes` is ordinary lore) seed the room's variable tree: JSON5-tolerant objects or YAML mappings, nested and CJK paths allowed,
  `[value, "description"]` leaves. They are data, not lore. A native card's typed
  `variables` become the room's typed variables.
- **For the Keeper.** The card's prose (description, personality, scenario, example
  messages, creator notes), its directives (`system_prompt`, `post_history_instructions`,
  with template code removed and `{{char}}` bound to the card's name) and its openings
  (`first_mes`, `alternate_greetings`) are kept for the Keeper. Players see the world's
  name, nothing more.
- **Re-importing** the same card replaces that card's lore and keeps the room's variable
  values: a top-level key the room already has keeps its value, so a re-import never
  resets progress. A *different* world card stacks beside the first (lorebook add-on
  cards work that way); to start clean, reset the room: `.reset all`, then `.reset confirm`.

The answer counts what came in and what did not: *Imported the world River Town: 2 lore
entries (0 secret), 1 variable declarations, 1 openings.* Not imported in 3.0: hook
scripts (3.0 has no hooks; they are counted, never run) and a native card's `pregens`.

Nothing is shortened to fit. An entry whose condition, title, a keyword or group name is
over its limit (500 characters for a condition, 200 for the others; at most 64 keywords),
or whose switches are written in a way Loreweaver does not read, is left out, and the answer
says how many and why: *3 lore entries were left out: a flag that is not true or false ×2,
condition too long ×1.* The rest of the card imports. Switches (`enabled`, `disable`,
`constant`, `selective`, `useProbability`, `caseSensitive`, `matchWholeWords`,
`groupOverride`) may be written `true`/`false`, `1`/`0` or `"true"`/`"false"`/`"1"`/`"0"`,
as SillyTavern files write them; `secret` must be `true` or `false`, and it is secret when
either the entry or its `extensions` says `true`. In a native card every switch is `true`
or `false`; a row written otherwise is skipped and the answer reports it.

## What a character import brings

Any player can import a card as their character. It writes **a character and a seat,
nothing else**, whatever the card holds: the card's name, its persona (description and
personality) as the character's background, and a sheet rolled for the room's rule
system. When the server has a model, the sheet leans toward a concept the model reads
from the persona, as `genchar` does; the model writes no numbers, and the rule system
places them. Without a model, or over the hourly cap shared with `genchar` (5 per
member), the sheet is rolled plainly and the answer says why.

Nothing of the world half comes along — no lore entries (not even plain ones), no
variables, no templates, no directives, no openings — and the answer lists it by count:

```
You now play River Town (CoC).
This is a world card: only its character came along; its world waits for the room admin's world import.
Left behind: variable declarations ×1, templates ×1, lore entries ×2, openings ×1.
```

## What runs

After a world import, the card's machinery runs, with code doing the bookkeeping.

- **Lore activation**, after SillyTavern's world-info rules: primary keys; secondary keys
  with all four logics (AND ANY, AND ALL, NOT ANY, NOT ALL); `probability`, rolled by
  code; case-sensitive and whole-word matching; `scan_depth`; `constant` entries;
  `position` (`before` and `after` order the one lore section; other positions sort with
  the rest); timed effects (`sticky`, `cooldown`, `delay`) counted in turns; inclusion
  groups (one member per group, picked by weight). When the server has an embedding model,
  an entry that recall finds relevant triggers as if a key had matched. A Keeper turn
  takes at most 12 entries and 12,000 characters of lore. Regex keys (`/…/`) match as the
  literal text.
- **Decorators.** `@@if <condition>` makes a condition; `@@activate` works like
  `constant`; `@@dont_activate` and render-only entries (`[RENDER:` titles, `@@render_*`,
  `@@iframe`, `@@message_formatting`) import disabled, and so does an entry that is nothing
  but status-bar residue. A `[GENERATE:…]` title prefix is removed.
- **Templates (EJS).** Lore entries may be EJS templates. They run as real JavaScript —
  the EJS library and lodash — in the room's worker thread, in a fresh context for each
  prompt assembly, at most 1 second per template and 3 seconds per assembly. The API is
  the ST-Prompt-Template one: `getvar`, `setvar`, `incvar`, `decvar`, `getwi` /
  `getWorldInfo` (an entry's content by title, disabled entries included), `activewi`,
  `injectPrompt`, `getchar`, `getchat`, `define`, `execvar`, `SafeGetValue`, `print`,
  `variables`, `stat_data`, lodash as `_`. Template writes are requests, applied by engine
  code afterwards (at most 64 per assembly). A template that fails renders as nothing,
  never as its source: raw template syntax never reaches the model. Greetings are rendered
  like lore before they are spoken.
- **Conditions** (`@@if`, a native `condition`) are read with Loreweaver's condition
  language first; a condition it cannot read is evaluated as JavaScript in the worker. An
  error means the entry stays out.
- **Macros.** `{{user}}` (the active player character), `{{char}}` (the card's name,
  bound at import), `{{time}}` / `{{date}}` (the game clock), `{{roll:XdY}}` (rolled by the
  dice engine), `{{random}}`, `{{pick}}`, `{{getvar::name}}`, `{{var:name}}`,
  `{{newline}}`, `{{trim}}`, `{{// comment}}`.
- **The MVU protocol.** The model may write `<UpdateVariable>` blocks with
  `_.set` / `_.insert` / `_.delete` / `_.add`; code parses them, applies them to the
  variable tree and removes them from what players see. A reply too long to check (over
  500,000 characters) that may hold a block is not shown at all; the turn fails and can be
  retried. The Keeper also has schema-checked
  tools onto the same tree.

## Variables, and what players see

The imported variable tree is module state, and heavy cards keep plot flags in it, so it
starts **fully hidden**: no leaf reaches a player until the room's admin exposes it.

```
.var list                    every variable; hidden ones are marked
.var expose town             players now see town and everything under it
.var hide town
```

A prefix exposes itself and its subtree, aligned on segments (`town` exposes
`town.flood`, not `town2`); `*` exposes everything. The admin's own view always shows the
whole tree, hidden leaves flagged. A native card's typed variable is visible to players
unless it says `"visibility": "keeper"`; any other spelling (`"Keeper"` included) is refused
with a warning, never made visible. Panels read variables through the `variables`
view, so a panel never shows a hidden leaf. Tell your players which prefixes to expose,
for example in the card's `notes` in your pack.

## Making a card's switches work

Some heavy cards ship an opening wizard: entries that arrive disabled with no keywords —
difficulty tiers, route variants — and a frontend script that turns the chosen one on.
Loreweaver imports the entries and runs no frontend script, so nothing turns them on. The
world import says so by count: *N lore entries are disabled and have no keywords*. The
room's admin turns them on, without touching the card:

- **See what is off:** `.lore list disabled`. `.lore list` marks entries `[off]`,
  `[secret]` and `[annotated]` (this room changed the file's answer).
- **Switch one by hand:** `.lore enable <title>`, `.lore disable <title>`.
- **Bind one to a variable:** `.lore bind <title> | <condition>`, for example
  `.lore bind Hard mode | town.flood >= 4`. The entry is in while the condition holds and
  out otherwise; three entries bound to three values of one variable behave like the
  card's radio buttons. `.lore unbind <title>` clears the condition; `.lore restore
  <title>` hands the entry back to the file.
- **Change a value:** `.var set <path> <value>`, `.var add <path> <delta>`.
- **A controller template works too:** an enabled entry can pull in a disabled one,
  `<%- getwi("Difficulty: " + getvar("config.difficulty")) %>`.

The switches are a keeper-only overlay stored beside the lore, never in it, so
re-importing a revised card keeps them. Loreweaver never guesses a variant: it does not
read titles for structure or group entries into families. In 3.0 a pack cannot ship these
switches for a card (2.x had an `overlay:` file); the room's admin sets them.

## What is different here

- **The dice are real.** `{{roll}}` and every check are rolled by the dice engine; a card
  cannot write an outcome into being.
- **Numbers are validated.** An imported character becomes a sheet of the room's rule
  system, held to its limits.
- **`{{time}}` and `{{date}}` are the game clock**, not the wall clock.
- **Randomness is reproducible.** `{{random}}`, `{{pick}}`, lore `probability` and a
  template's `Math.random` are seeded from the room and the turn: a retried turn draws the
  same values. A template's `Date` is fixed for the assembly.
- **`faker` returns empty strings**, and `@INJECT` positions by message index do nothing:
  Loreweaver assembles one prompt of its own.
- **Status bars and render entries** are disabled at import. Panels
  ([authoring.md](authoring.md#44-panels)) are how a pack draws interface in the client.

## The trust boundary

An imported file does not choose its own privileges.

- **The split is code, not a prompt.** A character import writes a character and a seat;
  it cannot add lore, seed variables or carry template code, however the card is phrased.
- **`secret` and `constant` are the admin's.** Only a world import keeps a secret entry
  or an always-on one. An entry whose `secret` is not `true` or `false` is never treated as
  public: it is kept away from players and left out of the import.
- **Entries are pinned to the importing room**, and their ids are regenerated, so a card
  cannot address another card's entries.
- **Secret stays secret.** Players' lore lists, panels and every other view are computed
  per viewer by the server; a secret entry, a keeper-only variable or an unexposed leaf is
  never in a player's. A template rendering for a player-grade reader cannot read a secret
  entry either.
- **Templates are code the admin chose to run.** They run in the room's worker with time
  limits and no access to the server's objects, but a context has no memory cap of its
  own: a world import is the admin's decision to run that card's templates, as in
  SillyTavern ("your box, your cards"). There is no switch that turns templates off.

## Not in 3.0

Hook scripts in cards (`extensions.loreweaver_hooks`, a native card's `hooks`) are
counted and reported, never run: code that reacts to a turn is a module in a pack
([sdk/README.md](../sdk/README.md)). Also gone: importing a card as an AI companion, a
native card's claimable `pregens`, standalone lorebook files, `.lore import`, and a
pack's `overlay:` file.
