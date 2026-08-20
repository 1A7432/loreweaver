*English · [中文](plugins.zh.md)*

# Loreweaver extensibility: plugins, skills & content packs

> Status: **contract** (updated 2026-08-07; wire protocol **2.1**). This document is what
> contributors build against. Authors have friendlier on-ramps: a start-to-finish tutorial in
> [authoring.md](authoring.md), card specifics in [cards.md](cards.md), hooks in
> [hooks.md](hooks.md).
>
> **Landed, and what each means:**
>
> | Layer | State |
> |---|---|
> | **A — data plugins** | rule systems, cards, lorebooks, module variables. `core/rulepacks.py` is a discovery-based data loader; since M16 a rulepack also owns **the tiers a check lands on, the sheet shape, the subsystems, the dot-commands it answers to and what to tell the Keeper**, so coc7/dnd5e/wod are ordinary packs and deleting a file removes the system |
> | **B.1 — KP skills** | `SKILL.md` loader, prompt-section binding, per-room `.skill enable`, mature-mode content gate |
> | **B.2 — `allowed-tools`** | extra tools that stay hidden until a skill asks for them (`@tool(gated=…)`); `romance-relationships` ships on it |
> | **B.3 — self-extension forges** | `generate_skill` / `generate_rulepack` / `generate_module`, each invisible until its forge skill is enabled. The rulepack forge writes the M16 `resolution:` / `subsystems:` / `expertise:` fields |
> | **B.4 — TUI management** | describe→generate on the KP-skills screen |
> | **C.1 — event hooks** | sandboxed `hooks.js` on the turn lifecycle, with declarative UI emission |
> | **C.2 — Python entry points** | **deferred** — the only layer that would run with server privileges |
> | **`.lwpack` packaging** | manifest v2: full file inventory, detection-truth card kinds, schema versions with migration slots; `gh:` release distribution |
> | **D — module UI panels (M15)** | tier 0/1/2 all landed: `ui/panels.yaml`, `.panels enable`, server-resolved `audience`, content-addressed tier-2 assets with a mandatory text-first fallback |
> | **M16 — rules externalization** | the core is rule-agnostic; `agent/` never names a system or compares a rank id, pinned by an architecture test |
> | **M17 — document model** | all room content is one `Document` type; every type's `project(doc, viewer)` is the one place everything passes through on its way out |
> | **M18 — campaign chronicle** | `chronicle` / `campaign_summary` / `thread` documents, the deterministic fold policy, `.recap` / `.chronicle` |
> | **M19 — the Stage Director** | the presentation kit (`ui/presentation.yaml`), the performance blocks (`letter` / `clipping` / `map_pin` / `title_card` / `image`), `visible_when` on any block, resource labels resolved per viewer — protocol 2.1 |

Loreweaver is a self-hosted, world/story-first AI Keeper — not a persona-chat
frontend. Its long-term leverage is being a **platform the community extends**,
not a codebase everyone forks. This document defines how.

## Guiding principle: adopt conventions, don't invent them

We deliberately **do not design bespoke formats** where a widely-used one
already exists. A contributor who has authored a SillyTavern card or a Claude
Code skill should be able to reuse what they know, and existing assets should
migrate with minimal friction. Concretely:

| Extension kind | Convention we follow | Why |
|---|---|---|
| Character cards | **SillyTavern Character Card V2/V3** (`chara_card_v2` / `chara_card_v3`) | Huge existing library; Loreweaver already parses it (`core/charcard.py`) |
| World info / lore | **SillyTavern World Info / lorebook** (`character_book` entries) | Cards embed it; already mapped to `core/worldbook.py` |
| KP skills | **Claude Code `SKILL.md`** (YAML frontmatter + Markdown + progressive disclosure + `allowed-tools`) | Familiar to agent-tooling authors; no new schema to learn |
| Rule systems | Loreweaver **rulepack YAML** (the one place with no external standard) | TTRPG dice/skill systems have no ST/CC analogue; documented below |
| LLM providers | OpenAI-compatible + a `PRESETS` entry (already data) | Standard OpenAI API surface |

Where we must define our own schema (rule systems, the plugin manifest), we keep
it minimal, declarative, and validated.

## The trust boundary (read this before proposing code execution)

Loreweaver runs on the operator's own machine with full privileges: the
filesystem, the LLM API key, the keystore, the network. A plugin inherits that
power. So the taxonomy is organized by **risk**, and we ship it in that order:

- **Data plugins (safe):** validated data, *no code execution*. Cards,
  lorebooks, rule systems, provider presets, locale packs.
- **Declarative skills (safe):** prompt text + a tool *allowlist* over existing
  built-in tools + optional data. No new code runs.
- **Code plugins (dangerous):** arbitrary Python. Last to ship, opt-in only,
  with a capability declaration and an explicit "trusted-source" warning.

A corollary that shapes Layer A: any declarative "formula" facility (e.g.
derived character stats) uses a **fixed set of building blocks — never `eval` of
an arbitrary string** — so a data plugin can never smuggle in code.

A second corollary: **one bad pack must never brick startup.** Discovery catches
and skips a malformed plugin (mirroring `infra.runtime_config`'s "an unusable
persisted override falls back to baseline instead of raising").

---

## Layer A — Content & data plugins

Dropping a file into a discovery directory makes it available; no code change,
no redeploy of the core.

### A.1 Rule systems (`rulepacks/<id>.yaml`)

The one format with no external standard, so we document it fully. A rulepack is
pure data describing a TTRPG system's sheet + checks. Discovery scans
`rulepacks/*.yaml`; the filename stem is the system `id`.

```yaml
# rulepacks/<id>.yaml
names: [coc, coc7, "call of cthulhu"]   # resolution aliases (+ the id + set_keys)
set_keys: [coc, coc7]                    # what `.set…` accepts to select it
defaults:   { 力量: 50, ... }            # starting attributes/skills (name -> value)
alias:      { 力量: [str, STR, ...] }    # canonical -> [aliases] for skill resolution
st_show:    { top: [...], itemsPerLine: 4 }  # sheet display layout
creation_constraints: { ... }            # roll formulas / point-buy / ranges
derived:                                 # HYBRID derived stats — see below
  DB:   { computer: coc_db }             #  (a) named code computer (built-ins / exotic)
  闪避: { half_of: 敏捷 }                #  (b) declarative primitive (pure data)
display:                                 # OPTIONAL presentation-only localized names
  en: { 侦查: Spot Hidden, ... }         #  locale -> canonical -> display name
sheet:                                   # the sheet shape (attributes/vitals/resources…)
  resources:                             #  the meters clients draw as bars
    - {id: hp,  label: HP,               #   a bare string = your own language
       value: HP, max: HPMAX}
    - {id: chao, label: {en: Tide, zh: 潮位},   # a locale map = one bar, every table
       value: CHAO, max: CHAOMAX}
```

`sheet.resources[].label` is resolved for each viewer as it is sent, so a room with an `en`
and a `zh` player shows each of them their own reading of the same bar. A bare string
is not a mistake — abbreviations like HP/SAN/MP read the same everywhere — but any
label that is a real WORD should ship a locale map.

`display` never affects resolution — canonical keys stay the single identity in
sheets/aliases/derived; check output renders `display_name(canonical, locale)`
and falls back to the canonical key for unmapped names/locales.

**Derived stats are hybrid** (both paths, so a new system *can* be pure data but
an exotic one *may* use code):

- `{computer: <name>}` — a registered Python computer (`_NAMED_COMPUTERS`), for
  built-ins (CoC's damage-bonus table) or systems too gnarly for the DSL.
- `{computer_group: <system_id>}` — reuse another system's whole generated set.
- Declarative primitives (safe, no eval): `{copy_of: <stat>}`, `{half_of:
  <stat>}`, `{floor_div: {of: <stat>, by: N}}`, `{sum_ranges: {of: [<stats>],
  ranges: [[lo, hi, value], ...], else: <value>}}`.

The three bundled systems (`coc7`, `dnd5e`, `wod`) are ordinary packs in this format and serve as
the reference for what the format can express. "Rules are data" has a literal acceptance test: remove
`rulepacks/coc7.yaml` from a deployment and CoC is gone, with no residue in the engine.

**Rule BEHAVIOUR is pack data too (M16).** Since the rules externalization a pack does not just
declare a sheet; it declares how a check resolves, which subsystems exist, what dot-commands it
answers to, and what the Keeper is told about running it. `agent/` never names a system and never
compares a rank id — it reads the flags only — so a pack can invent its own names for things without
touching code.

```yaml
resolution:
  version: 1
  roll: 1d100                # any dice expression: 2d20kh1, 4dF, 5d6!, {pool}d10>=8
  target: skill              # skill | attribute | dc | none | <expression>
  compare: "<="
  params:   {deng: {min: 1, max: 9, default: 3}}   # pool parameters, supplied by the check tool
  modifiers:                 # named, composable roll transforms
    bonus:   {tens_reroll: keep_lowest}
    penalty: {tens_reroll: keep_highest}
  difficulties: {hard: {target: "floor(target / 2)"}, …}
  ranks:                     # ORDERED ladder; first match wins; the flags are declared BY THE PACK
    - {id: crit,   when: "roll == 1",      success: true, critical: true, tier: 5}
    - {id: hard,   when: "roll <= target && roll <= floor(raw_target / 2)", success: true, tier: 3}
    - {id: fail,   tier: 1}                #  a rank with no `when:` is the fallback
  margin: successes
  variants:  {xipu_night: {ranks: [...]}}  # house ladders, selected with `.rule <variant>`
subsystems:  {sanity: {...}, luck: {...}, growth: {...}, opposed: {}, random_madness: {tables: {...}}}
commands:    {ra: {action: check}, sc: {tool: sanity}, xipu: {action: make_char}}
expertise:   {en: "…", zh: "…"}           # what the Keeper is told about running this system
labels:      {en: {crit: [Critical Success], …}, zh: {crit: [大成功], …}}
```

Expression names are a closed set — `roll`, `dice` (indexable `dice1`, `dice2`, …), `target`
(difficulty-adjusted), `raw_target` (before difficulty), `modifier`, `successes`, `ones` — and are
validated **statically at load**, so a misspelling fails the pack build with a pointable diagnostic
rather than crashing on someone's first check. Inside a `difficulties.*.target` expression `target`
is the RAW value; inside a rank's `when:` it is the adjusted one.

**Evolution discipline:** the DSL never grows syntax for one system. A system it cannot express uses
the script lane (`resolution: {script: resolver.js}`, and `subsystems: {<name>: {script: flow.js}}`
for flows) — QuickJS, the same trust lane as `hooks.js`: the engine pre-rolls the declared dice and
passes values in, and the script returns nothing but a verdict, or an effect described in a fixed
set of terms the engine owns. The engine then checks that, holds it inside the allowed range, and
applies it. Randomness and state never leave the engine. The trust card discloses it as `has_rules_script`, re-verified at install. Only a
pattern recurring across two or three script-lane systems is promoted into DSL syntax.

A worked, buildable example of all of the above: [authoring.md](authoring.md) §2–§3.

**Rules may couple to worlds** (`extends:`): a module that needs bespoke rules ships a
rulepack that *patches* a base system instead of rewriting it — `extends: coc7` plus only
the deltas. Resolution is a deterministic deep-merge (child wins; mappings merge
recursively; an explicit `null` deletes an inherited key; lists replace wholesale), chains
resolve through grandparents (capped at 4), and cycles/unknown bases fail the parse. A
patch needs its own new id — discovery never lets a user file shadow a built-in's id. Inside
an `.lwpack`, `extends:` resolves against the pack's own bundled rulepacks first, then this
host's discovery dirs, so a world can carry base + patch together.

### A.2 Character cards — SillyTavern V2/V3

Loreweaver already imports SillyTavern cards (`core/charcard.py` →
`char_from_persona.py` → the `import_character` KP tool). We formalize this as
the card-plugin contract: a `chara_card_v2` / `chara_card_v3` JSON (or PNG with
the `chara` tEXt chunk). Fields consumed: `name, description, personality,
scenario, first_mes, mes_example, system_prompt, post_history_instructions,
alternate_greetings, tags, creator, character_version, character_book,
extensions`. Unknown fields are ignored, not rejected — forward-compatible with
V3 additions.

**The card split (拆卡).** An ST "heavy card" fuses two artifacts that Loreweaver keeps
separate: the CHARACTER (persona, memory, abilities, a sheet) and the WORLD (hook scripts,
`[InitVar]` variable schemas, executable EJS — machinery that reprograms the whole room).
That fusion is upstream's single-player architecture, not a design to preserve, so import
decomposes every card deterministically (`core.card_split`):

- **Character import** (`.import <file> [pc|companion]`) takes only the character half.
  World machinery is *removed by the importer itself* — hooks are not installed, declaration entries
  are neither stored nor consumed, EJS spans are removed from prose and lore — and the
  result message itemizes exactly what was stripped. This is what a player may self-import
  into a shared room.
- **World import** (`.import <file> world`, keeper-only, deliberately not a model tool)
  brings in BOTH halves as module content: the machinery — full lorebook with keeper trust
  (secrecy flags honored), `[InitVar]` seeded into the room's variable tree, hooks installed
  room-wide — and the character half, which joins the room's pre-generated roster
  (`core.pregen_roster`) as a claimable, rule-validated PC (`.pc list/claim/release`;
  claims are exclusive, releases restore the pristine sheet). One keeper import ships a
  module's world AND its cast; an AI-played companion remains a separate
  `.import <file> companion`.

The boundary is the room's trust boundary, not a capability cut: "author freedom over
gatekeeping" is the *operator's* stance about the operator's own box, and the keeper is the
operator of the room. Everything that reprograms shared play — skills (`.skill enable`),
hooks, variable schemas, rules — goes through the keeper's hands; nothing a player uploads
has no way to execute anything or change shared state.

### A.3 World info / lore — SillyTavern lorebook

A card's embedded `character_book`, or a standalone lorebook, maps to
`core/worldbook.py`. Entry fields honored: `keys` (primary), `secondary_keys`,
`content`, `comment`, `constant`, `selective`, `insertion_order`, `enabled`,
`position`, `case_sensitive`, `priority`, `extensions`. Activation is
keyword-in-recent-context with budgeted insertion — the ST model — so an
existing lorebook works unchanged.

### A.4 Module variables (deterministic trackers)

The engine exposes a declared-variable surface (`core.modvars`, inspired by the
SillyTavern community's MVU variable framework — same idea, but function-calling +
schema validation instead of a parsed text protocol): the Keeper (or a module, via its
setup instructions) declares named trackers with `define_variable` — kind
(`number`/`bool`/`text`/`enum`), optional bounds, a per-locale display label, and a
`visibility` of `player` or `keeper` — then updates them with
`set_variable`/`adjust_variable`. Every write is checked by real code and held inside its declared range
(iron rule #1); the current values are folded into the KP prompt each turn, and the
player-visible subset ships to clients on the `state` frame for the
TUI's tracker panel. Keeper-only variables are filtered inside the engine and never
reach a transport (iron rule #3, structural). This is state, not code: nothing here
executes, so it stays firmly in Layer A's risk class.

An **imported card's MVU tree** gets the same discipline from the other direction: it is
opaque module state (heavy cards routinely keep hidden plot flags in it), so its leaves
reach NO player panel by default. The keeper chooses what to show, with `.var expose
<prefix|*>` / `.var hide <prefix>` / `.var list`; keeper connections see the unexposed
remainder flagged `hidden: true` on their own frames, players never see it at all.

### A.5 SillyTavern MVU & EJS compatibility (imported cards)

Cards built on the community's MVU variable framework (MagVarUpdate) and the
ST-Prompt-Template EJS extension import and RUN, within a documented subset:

- **`[InitVar]` / `[InitialVariables]` / `@@initial_variables` entries** are consumed
  at import into a per-room variable tree (`core.mvu_compat`, JSON5-tolerant parse,
  nested CJK paths, `[value, "description"]` leaves; re-import never resets progress) —
  they are data, not lore, and are not stored as entries.
- **The MVU text protocol works end-to-end**: the card's own scaffolding entries import
  as normal lore, the model emits `<UpdateVariable>… _.set('path', old, new)…</UpdateVariable>`
  blocks, and `agent.loop` parses them with deterministic code (all five ops:
  set/insert/delete/add/move), applies them to the tree, and strips the blocks from the
  player-visible narration — the upstream extension's contract, with real code doing the
  bookkeeping. Tool calls (`set_stat`/`adjust_stat`/`get_stat`) are the preferred,
  schema-checked channel onto the same tree.
- **Full EJS — real JavaScript** (`core.ejs_full`, on by default when the `ejs` extra is
  installed; `TRPG_ENABLE_FULL_EJS=false` disables): worldbook/card content runs through
  the vendored official EJS library + lodash inside an embedded QuickJS sandbox — loops,
  functions, `await`, lodash chains, arbitrary-JS `@@if` conditions, template
  `setvar`/`incvar` (buffered, applied to the MVU tree by deterministic code after
  rendering), `getwi`/`activewi` over a preloaded room snapshot, `injectPrompt`/
  `getPromptsInjected`, `execvar`. This is the same trust model SillyTavern itself ships:
  self-hosted, your cards, your box — extensibility and author freedom over gatekeeping.
  The sandbox guardrails are crash protection, not restriction: hard memory cap, per-eval
  time cap (an infinite loop times out instead of hanging the server), zero host I/O, one
  fresh interpreter per turn (no cross-turn/cross-room state), and a cap on buffered
  template writes.
- **EJS subset fallback** (`core.ejs_lite` over `core.condexpr`'s closed expression
  grammar) renders when the `ejs` extra is missing, the flag is off, or a template
  errors: `<% if/else if/else %>` blocks, `<%= %>`/`<%- %>` outputs,
  `getvar()`/`variables.path`/`stat_data.path` reads, `{{getvar::}}`/`{{var:}}` macros,
  `@@if` → the entry's `condition` field, `<#escape-ejs>` passthrough. Subset rendering
  is READ-ONLY (template `setvar` is a no-op there) and fail-safe either way: raw
  template syntax never reaches the LLM.
- **ST worldbook trigger semantics** import and run: secondary keys with all four
  selective logics (AND ANY / AND ALL / NOT ANY / NOT ALL), `probability` (rolled by real
  code), case-sensitive and whole-word matching, `scan_depth` windows, `position`
  ordering buckets, timed effects (`sticky`/`cooldown`/`delay` against a per-room turn
  counter that only the injection path advances), and inclusion groups (weighted, one
  member per group per turn). Both the V2 `character_book` and ST-native world-info
  field names map.
- **Macros**: `{{getvar::}}`/`{{var:}}`, `{{user}}` (the active PC, resolved at render
  time), `{{char}}` (bound statically at card import — a card's char never changes),
  `{{time}}`/`{{date}}` (the GAME clock), `{{random}}`/`{{pick}}`, `{{newline}}`,
  `{{// comments}}`, and `{{roll:XdY}}` — rolled by the real dice engine, never
  narrated into existence (iron rule #2).
- **Still stubbed/inert even in full mode**: `faker` (stub returning empty strings, with
  a warning — nondeterministic flavor, rarely load-bearing), `@INJECT` message-index
  positioning, and render-time UI (`[RENDER:*]`, `@@render_*`, `@@iframe` status bars —
  frontend features with no meaning server-side; those entries import disabled so they
  never pollute a prompt, and the TUI's tracker panel shows the variable tree instead).

The import trust boundary (scope pinning, constant stripped, secret keeper-gated, ids
regenerated) applies unchanged in both modes — and everything in this section describes
what runs after a **keeper world-import** (see the card split in A.2): a player's
character import carries none of this machinery in the first place. With full EJS
enabled, world content runs code in the sandbox described above — that is the point;
operators who want the data-only Layer A posture set `TRPG_ENABLE_FULL_EJS=false` or
skip the `ejs` extra.

### A.6 Prompt presets and other data packs

**Keeper-style prompt presets ride packs as first-class content.** A preset is a
SillyTavern completion-preset JSON file (the 预设 format ST users already trade);
declare it under `contents.presets` and the build validates it with the same parser
`.preset import` uses. Install lands each file in the shared preset store
(`data_dir/presets/<id>.json`, id = the sanitized filename stem), so `.preset list`
sees it immediately — but nothing turns on by itself: a room folds a preset's style
text into its prompt only when its keeper runs `.preset enable <id>`
(install ≠ enable, as everywhere else). The trust card discloses the shipped count
(`presets: N`). `.preset import` also understands pack-relative references
(`.preset import <packId>/presets/x.json`) for cherry-picking a preset a pack ships
only as a plain asset.

The fold honors the preset's GEOMETRY, not just its text: segments split into four
bands at the three anchors that have an honest engine counterpart — text before any
marker joins the stable style layer, text around `worldInfoBefore`/`worldInfoAfter`
brackets the world-lore section, and text after `chatHistory` (ST's
position-critical slot) lands late in the per-turn state message, the closest
standing text to generation. A preset with no markers folds exactly as before. The
other five ST anchors only advance the split; they map to nothing, deliberately —
play experience outranks 1:1 SillyTavern reproduction.

Provider presets (`infra/providers.py:PRESETS`) and locale packs
(`locales/{lang}/*.json`) are already data; they join the same discovery/manifest
pattern.

---

## Layer B — KP skills (Claude Code `SKILL.md`)

A **skill** packages a *play style* — combat refereeing, mystery clue-tracking,
romance/relationship dynamics, a horror tone — as a declarative bundle a keeper
enables per room. We adopt the **Claude Code skill format verbatim in shape** so
skill authors reuse what they know:

```
skills/<skill-id>/
  SKILL.md            # YAML frontmatter + Markdown instructions
  references/…        # loaded on demand (progressive disclosure)
  assets/…            # tables, worldbook snippets, etc.
```

```markdown
---
name: romance-relationships
description: >
  Enable when the campaign centers on romance/intimacy: tracks attraction and
  tension, prompts consent beats, resolves seduction as social checks.
allowed-tools: [skill_check, kp_note, update_character_status]   # gates the toolset
name-zh: 恋爱与关系             # optional localized display metadata for skill
description-zh: >              # lists; the English fields stay the fallback
  为以浪漫/亲密为核心的战役开启：追踪吸引与张力，将诱惑作为社交检定判定。
metadata:
  scope: room                 # per-room toggle (keeper-enabled)
  systems: [coc7]             # applicable rule systems (optional)
  content-rating: mature      # informs the mature-mode gate
---

# Romance & relationships

<Markdown instructions injected as a KP prompt section>
```

**Mapping onto Loreweaver's existing architecture** (no new runtime primitives):

| SKILL.md piece | Loreweaver mechanism |
|---|---|
| `description` | relevance/enable hint shown to the keeper (and, later, retrieval) |
| Markdown body | a `core.prompt_sections`-style block folded into the system prompt |
| `allowed-tools` | restricts the `agent.tools.Toolset` for that room |
| `references/*` | progressive-disclosure data, fetched on demand |
| `metadata.scope: room` | a per-room enable flag (like `.mature` / `bot_enabled`) |
| `metadata.content-rating` | ties into the mature-mode content gate |

Progressive disclosure means the top `SKILL.md` is cheap to advertise; heavy
reference material loads only when the skill actually fires — the same token
discipline CC skills use.

**Dogfood:** the first two built-in skills are `mature-mode` (content/tone gate
+ censor bypass) and `romance-relationships` — proving the interface on real
features rather than a toy.

---

## Layer C — Behavior plugins

### C.1 Event hooks (landed)

> Author-facing reference — events, API, caps, failure semantics, a worked
> example: **[hooks.md](hooks.md)**. This section states the contract.

Skills and cards can now carry BEHAVIOR, not just data and prompts — sandboxed JavaScript
handlers on the turn lifecycle (`core.hooks` + `agent.hook_runtime`), the same runtime idea
as the community's Tavern Helper scripts, on the same trust stance as full EJS (the
operator's content, the operator's box):

- **Where they live**: a `hooks.js` next to a skill's `SKILL.md` (active while the skill is
  enabled for the room — the existing `.skill enable` flow is the on/off switch), or a card's
  hook scripts — a native bundle's top-level `hooks: [...]` list (format v1), or an imported
  ST-shaped card's `extensions.loreweaver_hooks` (installed by the KEEPER's
  `.import <file> world` — a card with hooks is a world card, see the split in A.2;
  re-importing replaces its scripts rather than stacking).
- **API**: `on("turn_start"|"reply_ready"|"dice_rolled"|"variables_changed"|"clock_advanced"|"tool_use", handler)`, the
  full variable bridge (`getvar`/`setvar`/`variables`/`stat_data`, lodash as `_`), and the
  effect emitters `inject(text)` (adds a section to this turn's keeper prompt),
  `narrate(text)` (appends to the player-visible reply), `rewriteReply(text)`, `log(text)`,
  and `emitUI(blocks, opts?)` — declarative UI blocks (meter/stat/badge/text/divider/choices)
  clients render as `ui` frames, e.g.
  `emitUI([{kind:"meter", label:"Fear", value:3, min:0, max:10}], {panel:"sidebar", id:"hud"})`;
  see `docs/protocol.md` for the block schema. Emitted UI is PLAYER-VISIBLE authorial output
  (the same trust stance as `narrate`) — never emit keeper-only secrets into it.
- **`tool_use` + `denyTool(reason)` (M20)**: a handler receives `{tool, arguments}` BEFORE a
  Keeper tool call runs and may refuse it — `on('tool_use', c => { if (c.tool === 'game_clock')
  denyTool('time is frozen in this scene'); })`. The reason is fed back to the model through
  the same block-with-reason path the engine's own end-of-turn checks use, so there is one
  mechanism for "refused, here is why" rather than two. **Refusal FAILS OPEN**: a handler that
  throws, or a script that hits the QuickJS time limit, allows the call. Every hook failure is
  internally harmless today (a broken handler loses its effects and the turn continues), and
  that property had to survive contact with the critical path — a hook that cannot run does
  not get to stop the game.
  With module UI panels (Layer D) there is additionally `emitPanel(panelId, payload)` — an
  opaque JSON payload (≤ 32 KB, ≤ 20 per turn) for one pack-declared panel, delivered as a
  `panel_event` ONLY to viewers whose manifest contains that panel. The same
  trust stance applies, with one sharpening: a payload for an `audience: all` panel reaches
  players — keeper secrets go, if anywhere, into `audience: keeper` panels only.
- **Contract (iron rule #1)**: hooks REQUEST effects; deterministic engine code validates,
  caps, and applies them — `setvar` on a declared module variable goes through kind/bounds
  validation, everything else lands in the MVU tree. One sandboxed interpreter per turn
  (memory/time-capped, no host I/O), `variables_changed` fires at most once per turn so hook
  a cascade cannot keep going, and any failure — broken script, infinite loop, missing
  `ejs` extra — degrades to "hooks inert (logged)", never to a broken turn.
- **`globalThis` lives for ONE turn — the mistake worth naming.** "One interpreter per turn"
  means the interpreter is *rebuilt* every turn, so a counter kept in a JS variable resets
  every turn. It does not error; it just never advances, which is the worst way for a bug to
  behave. A 2026-08-07 play-test lost a whole session's meter to exactly this:

  ```js
  // WRONG — reads 1/40 forever, in silence.
  on('turn_start', () => {
    globalThis.__turns = (globalThis.__turns || 0) + 1;
    emitUI([{kind: 'meter', label: 'Tide sense', value: globalThis.__turns, min: 0, max: 40}])
  })

  // RIGHT — the engine owns durable state; the hook asks for it.
  on('turn_start', () => {
    incvar('tide_sense', 1);                       // checked, kept in range, PERSISTED
    emitUI([{kind: 'meter', label: 'Tide sense', value: Number(getvar('tide_sense')) || 0,
             min: 0, max: 40}])
  })
  ```

  This is not a workaround for the sandbox's lifetime — it IS iron rule #1. Anything that has
  to survive a turn is real state, and real state belongs to the deterministic engine. (Declare
  the variable in your module so it gets bounds and a label; an undeclared name still persists,
  as an MVU leaf.)
  `TRPG_ENABLE_FULL_EJS=false` switches this off along with every other sandboxed-JS surface.

### C.2 Python entry-point plugins (still deferred)

For genuinely new *server code* (KP tools, adapters, providers, exotic derived computers) we
will use Python **entry points** (`loreweaver.plugins`), so `pip install loreweaver-plugin-x`
registers it. That layer runs with SERVER privileges — unlike C.1's sandbox — so it stays
opt-in and last, and requires: a capability declaration, explicit operator enablement (off by
default), a prominent "runs untrusted code with server privileges" warning, and failure
isolation. Until C.2 ships, code contributions go through normal in-tree PRs.

### C.3 Prep-phase scripts — plan-then-apply bulk setup (M20 F)

Setting a module up can be forty near-identical tool calls: seeding a cast from a
list, defining a family of variables, importing lore in bulk. A **prep script** is a
small JavaScript file that PLANS that work instead of performing it:

```js
// prep/setup.js — runs in the QuickJS sandbox; `plan` is the ONLY callable.
const guards = ["门房老周", "巡夜的李七", "更夫赵三"];
for (const name of guards) {
  plan("add_npc", { name: name, concept: "夜里见过五层的人" });
}
plan("define_variable", { var_id: "floor_seen", kind: "number", minimum: 0, maximum: 3 });
```

The contract, and why it is safe to hand a keeper:

- **A script can only `plan(tool, argsObject)`.** The sandbox exposes no other
  callable and no engine state — it cannot call a tool, read the room, or reach the
  network; it emits an operation list and stops. Limits: 20 000 chars of script,
  200 operations, 8 KB of arguments per operation, 1 s of CPU.
- **The engine applies each planned call through the ordinary tool path** — the same
  argument validation, `keeper_only` marking, gated-skill unlock check and prep-phase
  check a model-issued call gets, because it IS that code.
- **Validated whole, applied in order.** A plan naming a tool the room cannot reach
  applies NOTHING (never half of itself); an operation failing at apply time stops
  the run there, and earlier operations stand.
- **Preview is free.** `run_prep_plan` with `apply: false` shows the full operation
  list and touches nothing. Prep phase only (`.phase prep`); keeper commands like
  `.import … world` and `.var expose` are structurally unreachable — they are
  commands, not tools, so a plan cannot name them.

**Shipping one with a pack**: declare it under `contents.prep` (`.js`, conventionally
in `prep/`). It installs into the pack home and the keeper invokes it by reference —
`run_prep_plan(script_ref="<packId>/prep/setup.js")` — previewing first, exactly like
inline script text. The trust card counts shipped scripts (`prep scripts: N`); they
NEVER run automatically, at install or any other time. Build checks are static
(extension, size cap, UTF-8) so packs build identically on machines without the
optional QuickJS extra; syntax errors surface at preview.

## Layer D — Module UI panels (M15; engine half landed)

Modules dress the table: a pack ships its own interface — HUDs, case boards, maps —
rendered by protocol clients. This is the presentation direction that replaced the retired
chat adapters. The wire contract lives in `docs/protocol.md` ("Module UI panels", protocol
2.1); the authoring walkthrough is `docs/authoring.md`. The layer is three tiers, by authoring
effort and risk:

- **Tier 0 — declarative blocks** (Layer C.1's `emitUI`): meter/stat/badge/text/
  divider/choices/image, emitted per turn by hooks. Every client renders them natively.
- **Tier 1 — declarative panels** (landed with M15a): a pack declares NAMED panels in
  `ui/panels.yaml` (`contents.panels` in `pack.yaml`) — layouts of Tier-0 blocks with
  live variable bindings (`{$var: id}` against the viewer's own `state.variables`,
  `repeat` over an id prefix) plus `slot` (`sidebar`/`tray`/`modal`) and `audience`
  (`all`/`player`/`keeper`, resolved SERVER-side). Pure data; renders on every client,
  the TUI included.

  **Pictures without a tier-2 page.** A handout — a portrait set, a rubbing, a printed
  letter — is one `image` block, not a hand-written HTML panel:

  ```yaml
  - {kind: image, src: assets/wen-portraits.png,
     caption: {en: The Wen portraits, zh: 温府画像组},
     alt: {en: Three hanging scrolls}}
  ```

  `src` is a pack-relative path to a file your pack ships (PNG/JPEG/WebP/GIF/SVG); the
  build folds it into the same content-addressed asset pipeline as tier-2 code, and the
  manifest carries its hash. Authors never write hashes, and a panel can never point at
  a picture from outside its own pack. Text-first clients show the caption line.

  **Value-gating a block: `visible_when`.** `{$var}` hides a block when its variable is
  absent; `visible_when` hides it based on the VALUE:

  ```yaml
  - {kind: text, text: {en: The survey is open., zh: 巡视开始了。}, visible_when: "day >= 46"}
  - {kind: badge, label: {zh: 已警觉}, visible_when: "stage === 2 && !alerted"}
  ```

  It is evaluated by the CLIENT, against that viewer's own `state.variables` — values
  move at runtime, so nothing else is possible. That makes every client an
  implementation of the same grammar, so the grammar is deliberately tiny: comparisons,
  `&& || !`, literals, and bare variable ids. **Arithmetic, `getvar()`, any function
  call and `a[0]` are refused at build time** — each is somewhere two clients could
  quietly disagree, and a silent disagreement about visibility is a spoiler. Need
  `day >= -1`? Write `day < 0` the other way round.

  Two rules to author by:

  - **A player panel's `visible_when` may only reference PLAYER-VISIBLE variables.** The
    condition string itself ships with your pack — every viewer's client holds it — so a
    keeper-only tracker named in a player panel's condition is a leak of that tracker's
    NAME even though its value never arrives. (The value genuinely does not: hidden
    variables are dropped before evaluation, so the block simply never shows.) It ships
    WHOLE, so the compared literal leaks with it too — `visible_when: "mvu.内部.真凶 === '顾晚棠'"`
    hands every player the answer, however innocuous the variable name reads. Gate on a
    player-visible consequence, never on the secret itself.
  - **Undecidable means hidden.** A condition that errors, or names something absent in
    a way it cannot compare, hides its block — never shows it. Write conditions that
    read correctly when the variable is missing.
- **Tier 2 — sandboxed custom views** (pack format + wire landed; the rich-client host
  ships with the studio): real HTML/JS/CSS in a locked-down iframe for interactive maps
  and bespoke sheets. `entry:` marks a panel tier 2; it must declare every asset it
  ships (folded into the pack's content-addressed asset pipeline at build) and an
  explicit tier-1 `fallback` (or `fallback: null`) for text-first clients.

The rules that make this safe are the same iron rules, extended to UI:

- **拆卡, extended:** panels enter a room only via a keeper's `.panels enable <packId>`
  of an installed pack (install ≠ enable). Players cannot upload panels.
- **A panel acts as the player viewing it:** inbound it sees only that viewer's
  filtered variables (a `$var` that does not resolve drops the whole block — when in doubt it shows
  nothing); outbound (`panel_intent`) it can send only what that player could type — `roll`
  intents go through the real dice engine as that player.
- **Keeper panels never reach players:** `audience` is resolved into per-viewer
  manifests before anything is sent, so a keeper-only panel simply never appears in a
  player's manifest.
- **No new privilege surface:** panels render and collect intent; every judgment stays
  server-side, and keeper-only actions stay on the command surface.

Keeper commands: `.panels` / `.panels list` (anyone), `.panels enable|disable <packId>`
(keeper). Hooks address panels with `emitPanel("<packId>/<panelId>", payload)` (C.1).

### The presentation kit — giving your module a Stage Director (M19)

Panels are the table's instruments. The **presentation kit** is the creative brief for
the actor that plays them: the Stage Director (演出导演) wakes on story BEATS — a scene
changing, an act turning over, a handout appearing, a critical spike — and decides what
the table SEES and HEARS. It never narrates, never rolls, never touches keeper
knowledge; it picks a form and fills it from what the players have already read.

Ship `ui/presentation.yaml` and declare it under `contents.presentation` (one per pack):

```yaml
version: 2
generation: allow            # or `pack_only` — see 宁缺毋滥 below
templates: [title_card, letter]      # optional: the performance shapes the Director may
                                     # stage, from image/title_card/letter/clipping/text
                                     # (omitted = all; two packs in one room intersect)
style:
  keywords: {en: "ink wash, muted indigo, 1925 coastal China", zh: "水墨, 靛青, 一九二五浙东"}
  banned: [text overlays, modern clothing]
  palette: ["#16232e", wet slate blue, lantern amber]   # optional: hex or color words,
                                     # ride every generated image and the Director's brief
subjects:                    # what may be pictured, and how
  - id: gu-wantang
    kind: npc                # npc | location | item
    name: {en: Gu Wantang, zh: 顾晚棠}
    ref: assets/gu-wantang.png          # the 定妆 (fixed-portrait) REFERENCE image
    prompt: "a woman in her thirties, plain dark coat, wet hair"
audio:                       # the cues the Director may call for
  - {id: chao-yong, layer: bgm, asset: assets/chao-yong.mp3, title: 潮涌}
```

Three rules carry the image discipline, and the first two are structural — not requests
the model can ignore:

- **Ref-mandatory (定妆).** A subject with no `ref` is never generated. Consistency, not
  plumbing, is the hard part of AI art in a module: your reference image and style
  keywords ride *every* request, and a subject you did not license simply cannot be
  asked for. Declare a subject without a `ref` when you want it nameable in a caption
  but never drawn.
- **宁缺毋滥.** `generation: pack_only` is your veto — the Director stages with your own
  art and nothing else. No operator setting overrides it. In a room running two
  modules, one `pack_only` silences generation for the room.
- **慢菜先备.** The Director warms subjects it expects to want soon, so a beat serves
  art cooked during the quiet turns before it. You do not configure this; naming
  subjects is what makes it possible.

Everything a kit references rides the same content-addressed asset pipeline as panel
code, and the trust card discloses both the subject count and whether the module may
spend the operator's image budget at all. A `ref` must be an image and a cue must be
audio, checked at build: refs may be `png` / `jpg` / `jpeg` / `webp` / `gif` / `svg`,
cues `mp3` / `ogg` / `wav` / `flac` / `m4a` / `aac`. The type comes from the file
EXTENSION via a table the engine owns, so a pack builds the same way on every machine. Rooms opt in with the SAME
`.panels enable <packId>` that admits your panels — presentation is the module dressing
the table, not a second switch. Operator-side knobs (which model, per-room image caps)
are `TRPG_DIRECTOR__*`; a room whose enabled modules ship no kit never wakes a Director,
so this costs nothing until an author asks for it.

---

## Discovery, manifest & versioning — the `.lwpack` format (landed)

- **Discovery dirs:** in-repo (`rulepacks/`, `skills/`) and the user data dirs
  (`data_dir/skills`, `data_dir/rulepacks`), so a plugin never has to live inside
  the checkout. A built-in id always wins over a user-dir file with the same id.
- **One shippable unit:** a whole work — skills + rulepacks + cards + lorebooks +
  media assets — travels as ONE self-contained **`.lwpack`**: a zip with a root
  `pack.yaml` manifest (`core/pack.py`). Authors run `python -m app --pack <src-dir>`;
  users run `python -m app --install <ref> [--yes]`. No "install plugin X first"
  instructions, no image-host/OSS links for assets.
- **From the table, too:** a keeper with no shell on the box runs `.pack install
  <ref>` in the room. Same refs, same install function (`gateway/pack_install.py`
  serves both doors). On a remote table install IS enable, and enable means
  PLAYABLE: the command throws every switch the pack ships — its panels and
  presentation kit, its KP skills, and its world card when the pack ships exactly
  one (which also pins the pack's character system). The terminal's per-item
  confirmation has no honest wire equivalent and a keeper who typed the ref has
  already made the trust decision, so the reply carries the trust card and one
  plain risk line instead of a checklist. The single thing it will not decide is
  WHICH module, when a pack ships several world cards — that is a fork, not a
  confirmation, and the reply names each as the `.import <ref> world` that loads
  it. A skill whose id a BUILT-IN already claims is enabled like any other (owner
  verdict 2026-08-20: the keeper typed the ref), and the reply names it, because a
  built-in always wins discovery — so the copy the room runs is the built-in, never
  the pack's. Keeper-only, naturally: it writes to the server's data dir.
- **Git IS the registry:** an install ref is a local path, an `https://` direct
  link, or `gh:owner/repo[@tag]` — resolved through the GitHub API to that
  release's `*.lwpack` asset (`@tag` pins a release; without it, latest) by
  `infra/pack_source.py`. The API call is anonymous unless `GITHUB_TOKEN` /
  `GH_TOKEN` is set, which lifts the per-IP anonymous rate limit a shared host
  hits as a 403. The credential is scoped by TWO rules, not one hostname check:
  it rides only on the release-metadata request the engine composes itself (a
  caller-named `https://api.github.com/...` ref is fetched anonymously, so a
  keeper's `.pack install` can never spend the server's PAT), and a redirect
  that leaves the host — or merely downgrades to `http` on it — drops it
  (`urllib` forwards headers across hosts by default, and the asset lane
  redirects off-host by design). There is deliberately no central package
  registry.
- **Install ≠ enable** (the CLI layering): `--install` from a shell lands content
  and turns nothing on — skills land in the user skill dir and rulepacks in the
  user rulepack dir, discoverable immediately, but a room still opts in via
  `.skill enable <id>`. A rulepack is discoverable but does not become the room's
  system; create a character on that system (the pack must declare a `make_char`
  word) or name the system on import. The in-room `.pack install` is the
  deliberate exception above: a keeper installing INTO a room has named the room
  as well as the pack, so the same act enables it there. Cards,
  lorebooks and assets land under `data_dir/packs/<id>@<version>/` for the
  existing in-room import flows (`.import`, `.module`) to consume; re-installing
  the same `id@version` replaces that pack dir wholesale, never merges. A running
  server picks up an install another process made — the desktop client shells out
  to the CLI — without a restart: skill and rulepack discovery re-check their
  directories' signature (`core.skills` / `core.rulepacks`) — each directory's own
  mtime, plus every manifest's name, mtime AND size, so a rewrite inside one
  timestamp tick still counts as a change — so both a NEW id and an id UPGRADED in
  place resolve, and `.skill list` sees it too. The dot-command dialect words a
  rulepack declares heal the same way one layer up: a word no command claims makes
  the router re-check discovery and rebuild its table (throttled, since any typo is
  such a word), and installing from the table rebuilds it on the spot — so a
  bundled rulepack's `make_char` word works in the next breath, from either door.
- **Trust card, not a gate:** before installing, the CLI prints the pack's
  auto-generated `trust` summary — skill/rulepack/card/lorebook counts, whether
  sandboxed hooks JS or EJS templates ship, asset megabytes — then asks for
  confirmation (`--yes` skips; non-interactive runs require it). The same stance
  as full EJS: the operator's box, the operator's informed call.
- **Integrity & confinement (red line):** this is the one place untrusted archive
  bytes reach the disk, so install verifies BEFORE writing anything — every
  content file re-parses through the real engine parsers
  (`core.skills.parse_skill_text`, the rulepack loader, `core.charcard`), every
  asset's bytes must match its manifest sha256, the archive may contain nothing
  undeclared, entry names are validated against traversal (zip-slip), symlink
  entries are rejected, and entry counts/sizes are hard-capped. Builds are
  byte-deterministic (sorted entries, fixed zip timestamps, stable manifest
  dump), so a pack's sha256 is reproducible from its source tree.
- **Dependencies:** flat and vendored — a pack ships everything it needs; there
  is no inter-pack dependency resolution. `engine` declares MINIMUM versions
  only (no range syntax); an unmet minimum refuses the install with a clear,
  localized message.

### `pack.yaml` fields

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | lowercase slug (`[a-z0-9-]`, ≤64) — names the `packs/<id>@<version>` install dir |
| `version` | yes | semver `MAJOR.MINOR.PATCH` (optional `-pre`/`+build` suffix) |
| `name`, `description` | yes | a plain string, or an `{en, zh}` mapping |
| `authors` | yes | list of non-empty strings |
| `license` | yes | SPDX id or a short name |
| `engine` | no | minimum versions: `protocol` (wire protocol) and/or `server` — minimum-compare only |
| `contents.skills` | no | skill DIRECTORIES (`skills/<id>`), each exactly `SKILL.md` + optional `hooks.js` |
| `contents.rulepacks` | no | rulepack YAML files (`rulepacks/<id>.yaml`) |
| `contents.cards` | no | SillyTavern cards (PNG or JSON) **or native bundles** (`*.lorecard.json`, dispatched to the native parser by content sniff so their machinery is detected honestly): a plain path, or a `{path, notes: {en, zh}}` mapping to attach install notes. The 拆卡 `kind` is **detected, never declared**: build stamps `character`/`world` into the built manifest from the real payload (hooks/`[InitVar]`/EJS/`secret` lore/typed specs ⇒ `world`, keeper-imported via `.import <file> world`), and install re-checks the stamp against detection |
| `contents.lorebooks` | no | lorebook JSON (ST `character_book` / `{entries: [...]}` shapes) |
| `contents.panels` | no | panels YAML files (`ui/panels.yaml`) declaring module UI panels (Layer D) — ≤ 16 panels per pack; a tier-2 panel's `entry`/`assets` files and every tier-1 `image`/`map_pin` `src` are folded into the pack asset pipeline at build (sha256'd, code payload ≤ 2 MB per panel) |
| `contents.presentation` | no | the presentation kit (`ui/presentation.yaml`, one per pack) — the Stage Director's creative brief; its 定妆 references and audio cues join the same asset pipeline, and the trust card discloses whether the module may generate images |
| `contents.presets` | no | keeper-style prompt presets (ST completion-preset `.json`), validated at build with the real preset parser; install lands them in the shared `data_dir/presets/` store under their sanitized filename stem (two files sanitizing to one id fail the build). Disclosed on the trust card; per-room opt-in via `.preset enable <id>` |
| `contents.prep` | no | prep-phase plan scripts (`.js`, Layer C.3): bulk setup a keeper runs by reference through `run_prep_plan(script_ref="<packId>/<path>")` — previewed whole before anything applies, never run automatically. Statically checked at build (extension, the sandbox's 20 000-char cap, UTF-8); counted on the trust card |
| `assets` | no | media files: `path` + optional `title`/`license`/`tags`/`mime`; `sha256`/`size`/`mime` are FILLED IN at pack time (a hand-declared `sha256` must match the file) |
| `trust` | forbidden in source | GENERATED at pack time (counts incl. `panels`, `has_hooks`, `has_ejs`, `has_rules_script`, `asset_bytes`); a hand-written block fails the build. Install RE-DERIVES it from the archive with the same detectors and rejects a mismatch — a hand-assembled pack cannot understate what it ships |
| `files` | forbidden in source | GENERATED at pack time (manifest v2): the complete archive inventory — every member except the manifest itself with its `sha256`/`size`. Install verifies SET EQUALITY plus per-file integrity, so the declaration is exactly the shipped byte set and nothing undeclared can ride along |
| `manifest_version` | no (source) | manifest schema version; omitted means current (2). A built archive always carries it explicitly. Older versions upgrade through registered migrations; unknown/newer versions refuse cleanly |

Full example — a source tree's `pack.yaml`:

```yaml
id: blackmoor
version: 1.2.0
name:
  en: Blackmoor Lighthouse
  zh: 黑沼灯塔
description:
  en: A haunted-lighthouse mystery for 2-4 investigators.
  zh: 一个 2-4 名调查员的闹鬼灯塔谜团。
authors: [ada]
license: CC-BY-4.0
engine:
  protocol: "2.1"   # minimum wire protocol this pack's hooks/panels rely on
contents:
  skills: [skills/omen-engine]      # a dir holding SKILL.md (+ hooks.js)
  rulepacks: [rulepacks/pulp.yaml]  # full systems, or patches (`extends: coc7` + deltas)
  cards:
    - cards/investigator.png        # a clean persona -> detected `character` (player-importable)
    - path: cards/keeper.png        # hooks/[InitVar]/EJS ride here -> detected `world` at build
      notes:
        en: Import last, after enabling the omen-engine skill.
        zh: 最后导入，先启用 omen-engine 技能。
  lorebooks: [lorebooks/manor.json]
assets:
  - path: assets/theme.mp3
    title: Lighthouse Theme
    license: CC0-1.0
    tags: [bgm]
```

`--pack` validates everything with the real parsers (a bad skill/rulepack/card
means no pack), rewrites the manifest with the computed integrity (`files`
inventory) + detected card kinds + trust fields, and emits
`<id>-<version>.lwpack`.

**Stable content ids & cross-pack references.** A native bundle's worldbook
entries may carry a stable `id`; together with the pack id it forms the
cross-pack reference handle `<pack-id>#<entry-id>` (e.g.
`blackmoor#lighthouse-keeper`) — how a serialized module's later installment
references the shared world's canonical entries instead of copying them. Ids
are author-owned and must stay stable across versions; the studio generates
them on export. (The reference RESOLVER is future work; the handles are the
part that must exist from day one.)

**Native bundle format v1** (`*.lorecard.json`, `format: "loreweaver.card"`,
`format_version: 1`): native-optimal field names — `opening`,
`alternate_openings`, `dialogue_examples`, `author_notes` — plus top-level
`hooks: [...]`, typed `variables`, per-entry `condition`/`secret`/`id`.
`format_version` is the schema version: older documents upgrade through
registered migrations (v0, the pre-freeze provisional shape, deliberately has
none), newer ones refuse cleanly. `--install` shows the trust card,
verifies, lands the files, and prints a localized "what landed + how to enable
it" summary.

## Migration guide (bringing existing assets)

- **From SillyTavern:** character cards (V2/V3) and lorebooks work as-is via
  `import_character` / the worldbook. No conversion. The card-author's guide —
  what imports, what runs, what differs — is **[cards.md](cards.md)**.
- **From Claude Code:** a `SKILL.md` skill ports by keeping its frontmatter +
  body; wire its `allowed-tools` to Loreweaver's toolset names and set
  `scope`/`systems`. Scripts that assume a shell/agent runtime become Layer-C
  code plugins (later) or are re-expressed as `allowed-tools` + data.

## Roadmap & status

*(The status table at the top of this document is the summary; this section records what each item
actually shipped as, for anyone reading the code.)*

1. **Layer A — rule-system management** — **landed** (discovery-based loader +
   hybrid derived stats; a new pure-data system is just a YAML file). **Extended by M16**: a
   rulepack now also owns `resolution:` (the compiled check tiers + the QuickJS script lane),
   `sheet:` (pack-declared sheet shapes; derived values are never persisted), `subsystems:`
   (engine-generic behavior templates, pack-parameterized), `commands:` (the dot-commands it answers to,
   which materializes the room's KP toolset — a wod room simply has no `sanity_check`),
   `expertise:` and `labels:`. `tests/architecture/` pins `agent/` to zero rule-system tokens.
2. **Layer B.1 — KP skills** — **landed**: `SKILL.md` loader (`core/skills.py`),
   prompt-section binding (`agent/prompt_builder.py`), per-room enable (`.skill`
   command), and the mature/explicit content gate that lifts the output censor;
   `mature-mode` shipped as the first built-in skill.
3. **Layer B.2 — `allowed-tools` enforcement** — **landed**: a `gated: bool`
   marker on `@tool` (independent of `keeper_only`), extra tools added in
   `agent.tools.Toolset` (`schemas(unlocked)`/`dispatch(..., unlocked)` expose
   and allow a gated tool only when its name is in the room's unlocked set),
   and `core.skills.unlocked_tools_for` unioning enabled skills' `allowed-tools`
   for `agent.loop.run_kp_turn` to pass in. A second filter of the same family
   rides alongside it (M20 B): `prep_only: bool` marks a bulk / low-frequency
   tool — module-grade NPC authoring, imports, exports, defining a variable —
   which a room's `play` phase drops and its `prep` phase carries. The axis is
   bulk vs improvisational, not "prep-type work": improvising an NPC mid-scene
   is ordinary play, so the light `sketch_npc` counterpart is available in both.
   `agent/tool_phase.py` decides a room's phase (a keeper's `.phase` pin first,
   otherwise the room's own module-init state), and unmarked tools are visible
   in both phases so a new tool is never silently unreachable. A third filter of
   the same family: `needs: str` names a ROOM CAPABILITY a tool cannot work
   without (today only `"module_pool"`, the knowledge pool a `--module` text
   upload builds). A module imported as a WORLD CARD has no pool — its lore is
   worldbook entries — so those tools are dropped there rather than offered and
   refused; `agent.tool_phase.room_capabilities` recomputes per turn, so a room
   that uploads a module mid-session gets them back by itself.
   `romance-relationships` shipped as
   the second built-in skill, backed by coc7 intimate-vocabulary aliases
   (魅惑/媚惑/勾引/风情 → 取悦, 调情/撩拨 → 话术, 洞察情感/察言观色/共情/同理心 →
   心理学) and, since the deterministic relationship-tracks feature landed, its
   own `allowed-tools: [adjust_relationship, set_relationship,
   get_relationships]` gating the `agent.kp_tools_relationships` tool trio
   (backed by `core.relationships`: bounded, persisted 好感/情欲 tracks folded
   into the main KP prompt by `agent.prompt_builder`).
4. **Layer B.3 — self-extension generators** — **landed**: three gated
   `generate_*` tools in `agent.forge`/`agent.kp_tools_forge`, each invisible
   until its own forge skill (`skill-forge`/`rule-forge`/`module-forge`) is
   enabled for a room. `generate_skill` (B.3a) authors a `SKILL.md` and installs
   it to a user skills data-dir; `generate_rulepack` (B.3b) authors a rulepack
   YAML (validated through the same safe derived-stat DSL Layer A uses) and
   installs it as a flat `<id>.yaml` to a user rulepacks data-dir, both never
   shadowing a built-in id; `generate_module` (B.3b) authors a module/scenario
   document and installs it PER-ROOM through the EXISTING upload/analysis
   pipeline (`agent.kp_tools_knowledge.DocumentTools.upload_document`) rather
   than a new one. All three validate-before-write and never `eval`/`exec`
   anything. **B.4 — landed**: the TUI KP-skills screen toggles skills per room
   and generates a brand-new one from a one-line description.
5. **Content-pack formalization** — **landed** as the `.lwpack` format (see
   "Discovery, manifest & versioning" above): `core/pack.py` +
   `infra/pack_source.py` + the `--pack`/`--install` CLI bundle cards, lorebooks,
   skills, rulepacks and assets into one integrity-verified zip with Git-release
   distribution.
6. **Layer C.1 — event hooks** — **landed**: sandboxed `hooks.js` on the turn
   lifecycle with declarative UI emission (see C.1 above; author
   reference in [hooks.md](hooks.md)).
7. **Layer D — module UI panels (M15)** — **landed**, all three tiers: `ui/panels.yaml` +
   `contents.panels`, `.panels enable <packId>` room admission, server-resolved `audience`,
   `{$var}` bindings and `repeat`, the static `image` block, block-level `visible_when`
   (client-evaluated, grammar refused at build outside a tiny portable subset —
   `tests/fixtures/visible_when_vectors.json` is the shared conformance table), and
   content-addressed tier-2 assets with a mandatory text-first `fallback`.

   Template INSTANTIATION — a panel's blocks plus one viewer's variables becoming the
   blocks that viewer sees — now has a shared table of its own,
   `tests/fixtures/panel_template_vectors.json`. Every rule lives there as a row: which
   binding miss drops a whole block and which drops one field, how `repeat` filters
   before it caps, what an invalid badge tone does, how a `map_pin` clamps its
   coordinates, which locale wins. The same rows run through the engine
   (`tests/core/test_panel_template_vectors.py`, over the pure
   `core.panels.resolve_panel_blocks` the `.panel` text fallback is built on) and through
   the reference client (`clients/tui/src/panelTemplates.vectors.test.ts`), so a rule that
   moves on either side breaks both suites. A panel is instantiated per viewer in every
   client AND on the server; a second client proves itself against this file.
8. **M16 — rules externalization** — **landed**: the compiled `RuleSystem` + the neutral
   `CheckOutcome`/`Rank` contract; ROLL (engine) → INTERPRET (pack, pure) → APPLY (engine); the
   old per-system modules deleted outright.
9. **M17 — the document model** — **landed**: one `Document` meta-type for all room content, with
   a per-type `project(document, viewer)` as the single place everything passes through, for iron rule #3.
   Every per-store manager and every backup allowlist is gone. A handout-class feature is a type +
   schema + projection away, with no new store keys and no new wire filter.
10. **M18 — the campaign chronicle** — **landed**: `chronicle` / `campaign_summary` / `thread`
    documents, the deterministic fold policy (0.60 trigger → 0.40 floor, 0.85 emergency, a 4-turn
    no-future lag window), folded records joining the embedding index, and the projection dividend —
    `.recap` is the player-grade view of the same documents, with the keeper's annotations gone.
11. **M19 — the Stage Director** — **landed**: `ui/presentation.yaml` + `contents.presentation`,
    the performance blocks, image generation that refuses to run without a reference image, the
    author's `pack_only` veto, audio cues, and a room-lifetime image budget. It only wakes for a
    module that asks for it: a room whose modules ship no kit never starts a Director. `tests/architecture/test_director_isolation.py` is what pins its
    knowledge scoping.
12. **Layer C.2 — Python entry-point plugins** — **deferred**; entry points + trust
    model. The only layer that would run with server privileges, so it stays last and opt-in.
