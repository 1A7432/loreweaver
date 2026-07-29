# Loreweaver extensibility: plugins, skills & content packs

> Status: **design** (2026-07-04). Layer A (rule-system management) has **landed**
> (`core/rulepacks.py` is a discovery-based, data-driven loader; coc7/dnd5e migrated
> behavior-identical). Layer B.1 (KP skills — SKILL.md loader, prompt binding,
> per-room enable, mature-mode content gate) has **landed**. Layer B.2
> (`allowed-tools` toolset-gating enforcement + the `romance-relationships`
> skill + coc7 intimate aliases) has **landed**. Layer B.3a (the skill-generation
> engine — a gated `generate_skill` tool + the `skill-forge` skill that authors a
> new SKILL.md from a description and installs it to a user data-dir) has
> **landed**. Layer B.3b (the rulepack + module generators — gated
> `generate_rulepack`/`generate_module` tools + the `rule-forge`/`module-forge`
> skills; a rulepack installs as a flat `<id>.yaml` to a user data-dir the same
> way skills do, a module installs PER-ROOM through the existing
> upload/analysis pipeline) has **landed**; B.4 (TUI management pages with a
> describe→generate button) is next. Layer C (code plugins) is deferred. This
> document is the contract contributors build against.

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
derived character stats) uses a **fixed primitive vocabulary — never `eval` of
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
```

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

The two built-ins (`coc7`, `dnd5e`) are migrated to this format with **identical
behavior** and serve as reference packs.

### A.2 Character cards — SillyTavern V2/V3

Loreweaver already imports SillyTavern cards (`core/charcard.py` →
`char_from_persona.py` → the `import_character` KP tool). We formalize this as
the card-plugin contract: a `chara_card_v2` / `chara_card_v3` JSON (or PNG with
the `chara` tEXt chunk). Fields consumed: `name, description, personality,
scenario, first_mes, mes_example, system_prompt, post_history_instructions,
alternate_greetings, tags, creator, character_version, character_book,
extensions`. Unknown fields are ignored, not rejected — forward-compatible with
V3 additions.

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
`set_variable`/`adjust_variable`. Every write is validated and clamped by real code
(iron rule #1); the current values are folded into the KP prompt each turn, and the
player-visible subset ships to clients on the `state` frame (protocol v1.6) for the
TUI's tracker panel. Keeper-only variables are filtered inside the engine and never
reach a transport (iron rule #3, structural). This is state, not code: nothing here
executes, so it stays firmly in Layer A's risk class.

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
regenerated) applies unchanged in both modes. With full EJS enabled, imported cards run
code in the sandbox described above — that is the point; operators who want the
data-only Layer A posture set `TRPG_ENABLE_FULL_EJS=false` or skip the `ejs` extra.

### A.5 Other data packs

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

Skills and cards can now carry BEHAVIOR, not just data and prompts — sandboxed JavaScript
handlers on the turn lifecycle (`core.hooks` + `agent.hook_runtime`), the same runtime idea
as the community's Tavern Helper scripts, on the same trust stance as full EJS (the
operator's content, the operator's box):

- **Where they live**: a `hooks.js` next to a skill's `SKILL.md` (active while the skill is
  enabled for the room — the existing `.skill enable` flow is the on/off switch), or a card's
  `extensions.loreweaver_hooks` list (installed at import; re-importing a card replaces its
  scripts rather than stacking).
- **API**: `on("turn_start"|"reply_ready"|"dice_rolled"|"variables_changed", handler)`, the
  full variable bridge (`getvar`/`setvar`/`variables`/`stat_data`, lodash as `_`), and the
  effect emitters `inject(text)` (adds a section to this turn's keeper prompt),
  `narrate(text)` (appends to the player-visible reply), `rewriteReply(text)`, `log(text)`.
- **Contract (iron rule #1)**: hooks REQUEST effects; deterministic engine code validates,
  caps, and applies them — `setvar` on a declared module variable goes through kind/bounds
  validation, everything else lands in the MVU tree. One sandboxed interpreter per turn
  (memory/time-capped, no host I/O), `variables_changed` fires at most once per turn so hook
  cascades terminate by construction, and any failure — broken script, infinite loop, missing
  `ejs` extra — degrades to "hooks inert (logged)", never to a broken turn.
  `TRPG_ENABLE_FULL_EJS=false` switches this off along with every other sandboxed-JS surface.

### C.2 Python entry-point plugins (still deferred)

For genuinely new *server code* (KP tools, adapters, providers, exotic derived computers) we
will use Python **entry points** (`loreweaver.plugins`), so `pip install loreweaver-plugin-x`
registers it. That layer runs with SERVER privileges — unlike C.1's sandbox — so it stays
opt-in and last, and requires: a capability declaration, explicit operator enablement (off by
default), a prominent "runs untrusted code with server privileges" warning, and failure
isolation. Until C.2 ships, code contributions go through normal in-tree PRs.

---

## Discovery, manifest & versioning

- **Discovery dirs:** in-repo (`rulepacks/`, `skills/`) and a user data dir
  (so a plugin need not live inside the checkout).
- **Manifest:** each plugin self-describes (`id` = directory/file stem, `names`
  aliases, `type`, optional `version`, `requires`). Data plugins reuse their
  native self-description (a rulepack's `names`, a card's `spec`/`character_version`,
  a skill's frontmatter) rather than a separate wrapper where possible.
- **Versioning:** the tool API, the wire protocol (`docs/protocol.md`), and the
  skill schema are versioned. A plugin declaring an incompatible requirement is
  skipped with a clear message — never silently half-loaded.

## Migration guide (bringing existing assets)

- **From SillyTavern:** character cards (V2/V3) and lorebooks work as-is via
  `import_character` / the worldbook. No conversion.
- **From Claude Code:** a `SKILL.md` skill ports by keeping its frontmatter +
  body; wire its `allowed-tools` to Loreweaver's toolset names and set
  `scope`/`systems`. Scripts that assume a shell/agent runtime become Layer-C
  code plugins (later) or are re-expressed as `allowed-tools` + data.

## Roadmap & status

1. **Layer A — rule-system management** — **landed** (discovery-based loader +
   hybrid derived stats; coc7/dnd5e migrated behavior-identical; a new pure-data
   system is now just a YAML file).
2. **Layer B.1 — KP skills** — **landed**: `SKILL.md` loader (`core/skills.py`),
   prompt-section binding (`agent/prompt_builder.py`), per-room enable (`.skill`
   command), and the mature/explicit content gate that lifts the output censor;
   `mature-mode` shipped as the first built-in skill.
3. **Layer B.2 — `allowed-tools` enforcement** — **landed**: a `gated: bool`
   marker on `@tool` (independent of `keeper_only`), additive gating in
   `agent.tools.Toolset` (`schemas(unlocked)`/`dispatch(..., unlocked)` expose
   and allow a gated tool only when its name is in the room's unlocked set),
   and `core.skills.unlocked_tools_for` unioning enabled skills' `allowed-tools`
   for `agent.loop.run_kp_turn` to pass in. `romance-relationships` shipped as
   the second built-in skill, backed by coc7 intimate-vocabulary aliases
   (魅惑/媚惑/勾引/风情 → 取悦, 调情/撩拨 → 话术, 洞察情感/察言观色/共情/同理心 →
   心理学) and, since the deterministic relationship-tracks feature landed, its
   own `allowed-tools: [adjust_relationship, set_relationship,
   get_relationships]` gating the `agent.kp_tools_relationships` tool trio
   (backed by `core.relationships`: clamped, persisted 好感/情欲 tracks folded
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
   anything. **B.4 next**: TUI management pages with a describe→generate
   button.
5. **Content-pack formalization** — expose the existing ST card/lorebook import
   under the unified discovery/manifest.
6. **Layer C — code plugins** — deferred; entry points + trust model.
