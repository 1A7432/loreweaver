*English · [中文](cards.zh.md)*

# Bring your SillyTavern cards

You have a folder of character cards and lorebooks. This page tells you what happens
when you drop them into Loreweaver: what imports, what actually runs, and where a
card behaves differently because it now lives inside a game with real dice. It is
written for card authors and card users; the full specification behind it
is [plugins.md](plugins.md).

The one-sentence summary: **cards and lorebooks import as-is — no conversion step —
and the variable / template / trigger machinery your card relies on runs**, inside
an engine that rolls real dice and validates every number.

One concept to hold onto first: Loreweaver **splits every card** (拆卡). An ST "heavy
card" fuses a character with a whole world — hook scripts, variable schemas,
executable templates — because single-player ST had nowhere else to put them. Here
those are two artifacts: the **character half** (persona, memory, abilities, a sheet)
that any player may import, and the **world half** (the machinery) that only the
room's Keeper imports, because it reprograms play for the whole table. Your card
isn't rejected either way — it's decomposed.

## What imports

- **Character cards** — SillyTavern **V2/V3** (`chara_card_v2` / `chara_card_v3`),
  as JSON or as a PNG with the embedded `chara` chunk. Fields consumed: `name`,
  `description`, `personality`, `scenario`, `first_mes`, `mes_example`,
  `system_prompt`, `post_history_instructions`, `alternate_greetings`, `tags`,
  `creator`, `character_version`, `character_book`, `extensions`. Unknown fields
  are ignored, never rejected — a card from a newer ST build still imports.
- **Lorebooks** — the card's embedded `character_book`, or a standalone lorebook
  JSON. Both the V2 `character_book` field names and ST-native world-info names map.
- **MVU variables** — `[InitVar]` / `[InitialVariables]` / `@@initial_variables`
  entries are consumed at **world import** into a per-room variable tree
  (JSON5-tolerant, nested CJK paths, `[value, "description"]` leaves). They are
  treated as data, not lore — they don't occupy prompt budget, and **re-importing a
  card never resets a room's variable progress**.
- **Hooks** — a card may carry `extensions.loreweaver_hooks`: sandboxed JavaScript
  on the turn lifecycle, installed at **world import**. That's Loreweaver's own
  extension point (the Tavern Helper idea, engine-validated); see [hooks.md](hooks.md).

## How to import

- **In the terminal client:** character creation offers four paths — roll, manual,
  AI draft, or **import a card**. Whichever path, the resulting sheet is validated
  against the rule system; a card whose numbers don't fit the rulepack gets fixed
  numbers, not a free pass.
- **By command:** `.import <card file> [coc7|dnd5e] [pc|companion|world]`.
  - `pc` (any player, via a room attachment) and `companion` (Keeper-only) take the
    **character half**. If the card also carries world machinery, the import strips
    it and tells you exactly what was stripped — the card still works as a
    character, and the message points the Keeper at the world half.
  - `world` (**Keeper-only**) imports the whole module in one step: the machinery
    half — full lorebook with Keeper trust, `[InitVar]` seeded, hooks installed —
    AND the character half, which lands on the room's **pre-generated roster** as a
    claimable, rule-validated PC. Players pick their character with `.pc list` /
    `.pc claim <name>` (claims are exclusive; `.pc release` frees the slot and the
    next claimant starts from the pristine sheet). For an AI-played version of the
    same character, `.import <file> companion` still works.
  - Importing from a server-side path (rather than a room attachment) is Keeper-only
    in every mode. Standalone lorebooks: `.lore import <file>` (Keeper-only).
- **As part of a pack:** cards and lorebooks travel inside `.lwpack` content packs —
  `python -m app --install gh:owner/repo` — alongside skills, rulepacks and assets
  (see [plugins.md](plugins.md)).

## What actually runs

Imported cards don't just contribute prose — the machinery runs, with deterministic
code doing the bookkeeping. (Everything below describes the **world half**, live after
a Keeper's `.import <file> world`; a character import carries none of it.)

- **Worldbook trigger semantics.** Primary `keys`; `secondary_keys` with all four
  selective logics (AND ANY / AND ALL / NOT ANY / NOT ALL); `probability` — rolled
  by real code, not narrated; case-sensitive and whole-word matching; `scan_depth`
  windows; `position` ordering buckets; timed effects — `sticky`, `cooldown`,
  `delay` — against a per-room turn counter; inclusion groups (weighted, one member
  per group per turn); budgeted insertion.
- **The MVU protocol, end-to-end.** Your card's scaffolding entries import as normal
  lore, the model emits `<UpdateVariable>` blocks, and the engine parses them with
  real code — all five ops (`set` / `insert` / `delete` / `add` / `move`) — applies
  them to the variable tree, and strips the blocks from what players see. The
  schema-checked tool calls (`set_stat` / `adjust_stat` / `get_stat`) are the
  preferred channel onto the same tree.
- **Full EJS — real JavaScript.** With the `ejs` extra installed (on by default),
  worldbook and card content renders through the official EJS library + lodash in an
  embedded QuickJS sandbox: loops, functions, `await`, lodash chains, arbitrary-JS
  `@@if` conditions, `setvar`/`incvar` (buffered, applied by engine code after
  rendering), `getwi`/`activewi`, `injectPrompt`, `execvar`. Same trust model as
  SillyTavern itself: your box, your cards.
- **Macros.** `{{user}}` (the active PC, resolved at render time), `{{char}}`,
  `{{time}}` / `{{date}}`, `{{roll:XdY}}`, `{{random}}`, `{{pick}}`, `{{newline}}`,
  `{{// comments}}`, `{{getvar::}}` / `{{var:}}`.
- **The tracker panel is Keeper-curated.** Your card's tree is module state, and heavy
  cards routinely keep hidden plot flags in it — so leaves reach NO player panel until
  the Keeper exposes them: `.var expose <prefix|*>` puts a path (and its subtree) on
  the party's panel, `.var hide` takes it off, `.var list` shows the whole tree with
  visibility markers. The Keeper's own panel always shows everything (hidden leaves
  flagged). Tell your users which prefixes to expose — or ship that line in your
  pack's card `notes`.

## What's different here (read this before debugging)

Loreweaver is a game engine, not a chat frontend. The differences all follow from
that:

- **The dice are real.** `{{roll:XdY}}` is rolled by the dice engine; checks resolve
  through rules code. A card cannot pre-write an outcome ("the attack hits") into
  being — the engine rolls first, the model narrates the result.
- **Character numbers validate.** An imported card becomes a real sheet in the
  active rule system (CoC 7e or D&D 5e SRD), checked against the rulepack and held to its limits.
- **`{{char}}` is bound at import** — a card's character identity doesn't drift.
  `{{user}}` stays dynamic (whoever the active PC is at render time).
- **`{{time}}` / `{{date}}` are the game clock**, not the wall clock. Your
  "midnight" fires when it's midnight *in the story*.
- **`faker` is stubbed** (returns empty strings, logs a warning) — nondeterministic
  flavor text conflicts with reproducible sessions and is rarely load-bearing.
- **`@INJECT` message-index positioning is inert.** Loreweaver assembles one system
  prompt through its own prompt builder; there is no client-side message array to
  index into.
- **Status-bar / render entries import disabled.** `[RENDER:*]`, `@@render_*`,
  `@@iframe` are frontend features with no server-side meaning; those entries are
  kept but disabled so they never pollute a prompt. The replacements are the
  built-in tracker panel and [hooks](hooks.md) `emitUI` — which draws meters,
  badges and choice buttons in the actual client.
- **Without the `ejs` extra** (or with `TRPG_ENABLE_FULL_EJS=false`, or when a
  template throws), rendering falls back to a safe EJS subset: `<% if / else %>`
  chains, `<%= %>` outputs, `getvar()` / `variables.path` reads, `{{getvar::}}`
  macros, `@@if` conditions. The subset is **read-only** (template `setvar` is a
  no-op there), and fail-safe either way: raw template syntax never reaches the
  model.
- **Sandbox facts** (full mode): one fresh interpreter per turn — no cross-turn or
  cross-room state; hard memory cap and a per-eval time cap (an infinite loop times
  out instead of hanging the server); zero host I/O; buffered template writes capped
  per turn.

## The import trust boundary

An imported file doesn't get to pick its own privileges:

- **The card split is structural.** A player's character import cannot install hooks,
  seed the variable tree, or land executable templates — the machinery is stripped by
  deterministic code before anything touches room state, not filtered by a prompt.
  Only the Keeper's `world` import carries it in.
- **Scope is pinned** to the importing room — a card can't write global lore.
- **`constant` is forced off** for imported entries, for everyone. An always-on
  entry would let any card permanently occupy the prompt; imported lore activates
  by keyword and budget like everything else.
- **`secret` is honored only when a Keeper does the import** — an untrusted card
  cannot mint keeper-only lore.
- **Entry ids are regenerated**, so a card can't address (and overwrite) another
  card's entries.
- **Re-importing replaces** that card's hooks and entries rather than stacking
  duplicates — and, as above, never resets variable progress.

With full EJS enabled, world content runs code in the sandbox described above — that
is the point, and it is the operator's informed call: "your box, your cards" is the
**Keeper's** stance about the Keeper's own table, which is exactly why the world half
goes through the Keeper's hands. If you would rather nothing executed at all, set
`TRPG_ENABLE_FULL_EJS=false` or skips the `ejs` extra.
