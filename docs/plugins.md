*English · [中文](plugins.zh.md)*

# Extending Loreweaver

> The extensibility contract for Loreweaver 3.0 (wire protocol 3.0, pack manifest 3). How
> to make a pack, step by step, is [authoring.md](authoring.md); cards are
> [cards.md](cards.md); writing a module is [sdk/README.md](../sdk/README.md). The formats
> are specified in [LWF](lwf/SPEC.md), and the wire in [protocol.md](protocol.md).

Loreweaver is a world- and story-first AI Keeper, not a persona-chat frontend. It is meant
to be a platform the community extends, not a codebase everyone forks. This document says
what can be extended, how it reaches a server, and what the server trusts.

## Guiding principle: adopt conventions, don't invent them

Where the community already has a format, Loreweaver reads it:

| Need | Convention adopted |
|---|---|
| Characters, lorebooks | SillyTavern character cards V1/V2/V3 (JSON and PNG) and their `character_book` |
| Card variables and templates | MagVarUpdate's `[InitVar]` and `<UpdateVariable>`; ST-Prompt-Template's EJS API |
| Instructions for the Keeper | Claude Code's `SKILL.md` (YAML front matter and a Markdown body) |
| Distribution | Git releases: a `.lwpack` attached to a release is installable as `gh:owner/repo` |

What has no convention is Loreweaver's own, specified openly in LWF: the native card,
rule packs, panels, the presentation kit, the pack container and the module contract.

## What can be extended

Everything reaches a server in a **pack**, one `.lwpack` archive with a `pack.yaml`
manifest (manifest 3: [pack.md](lwf/formats/pack.md)).

| Extension | What it is | Data or code | In a room |
|---|---|---|---|
| **Card** (`cards`) | A SillyTavern card or a native `*.lorecard.json`: lore, variables, templates, a persona | Data; lore entries may be EJS templates | Imported by the room's admin (world) or a player (character) — [cards.md](cards.md) |
| **Rule pack** (`rulepacks`) | A rule system as YAML: sheet shape, how checks roll and grade, derived stats, subsystems, commands; usually a patch (`extends: coc7`) | Data | Server-wide; a room picks one with `rule system` — [rulepacks.md](lwf/formats/rulepacks.md) |
| **Skill** (`skills`) | `SKILL.md`: text the Keeper reads while the skill is on, and the gated tools it unlocks | Data | Enabled per room with `skill enable` — [skills.md](lwf/formats/skills.md) §1 |
| **Panel** (`panels`) | Interface beside the story, fed by views; a template, or a self-contained HTML page with a template fallback | Data (a page runs only in a client's sandboxed frame) | On when the pack is enabled; `panels disable` per panel — [panels.md](lwf/formats/panels.md) |
| **Presentation kit** (`presentation`) | What the Stage Director may show and play: style, subjects with reference pictures, audio cues | Data | Joins the room's kit and audio library when the pack is enabled — [pack.md](lwf/formats/pack.md) §4.2 |
| **Module** (`modules`) | TypeScript or JavaScript against `loreweaver/module`: event handlers, commands, per-viewer views, characters, the clock | **Code** | Loads in the room's worker when the pack is enabled — [sdk/README.md](../sdk/README.md) |

Built in: the rule systems `coc7`, `dnd5e` and `wod`, and the skills `image-gen`,
`mature-mode` and `romance-relationships`.

## Data and code

Loreweaver keeps one line clear: **dice, success levels, character math, permissions and
secrecy are code; narration is the model.** Every extension sits on one side of it.

- **Data** is validated as a whole before it is installed: every rule pack must compile,
  every skill and card must parse, every panels file must pass the panels checks, every
  picture must be the file its extension says. A rule pack expresses mechanics in a
  closed expression language; nothing in a rule pack runs as code.
- **A module is code.** It answers the engine through **effects** — facts, variable
  writes, dice rolls, UI blocks — which the engine validates, caps and applies; a module
  never calls the engine. Dice the table should trust go through `fx.roll`, the engine's
  roller.
- **Templates are content code.** EJS in lore entries runs as JavaScript in the room's
  worker thread, with time limits, a fixed clock and seeded randomness. Its writes are
  requests the engine applies.

## The trust model

**A module runs as ordinary code in the server's process, with no sandbox.** It can use
the filesystem, the network and anything it bundles. What the server guarantees is fault
isolation: a module that throws or hangs costs its room a call, never the server and
never another module. Installing a pack with modules is the decision to run its code.

So:

- **Only an operator or a room admin installs.** The operator installs from the shell
  (`loreweaver install <ref>` shows the trust card; `--yes` installs). A room's admin
  installs from chat (`pack install <ref>`), which also enables the pack in that room.
  One installer, the same checks. A room admin who installs a pack decides what code the
  server runs: give admin keys only to people you would trust with the server.
- **The trust card comes first.** Before anything is written, the server computes a
  summary of the validated content and shows it: whether the pack runs code and which
  modules (file, size, sha256), its rule systems, skills and the tools they unlock, cards
  and the world machinery each carries, panels and the views they read, the kit, assets,
  and what was ignored. It is computed, so it cannot understate what the pack ships.
- **Install is not enable.** Installing from the shell changes no room. A room's admin
  enables a pack (`pack enable <id>`), and only that room gets its modules, kit, panels,
  skills and cards.
- **No package step.** A module's dependencies are bundled into it at build time; nothing
  is fetched or installed on the server when a pack is installed.
- **An archive is a security boundary.** Paths are confined (no `..`, no absolute paths,
  no links, no device names), sizes are capped while inflating, and the only code a pack
  may carry is its declared module bundles: any other script file refuses the pack.
- **Templates are the admin's choice.** A card's templates run only after the room's
  admin imports it as a world, as in SillyTavern: your table, your cards.

## Information isolation

Players must not learn what their characters have not. In 3.0 that is structural:

- **Views are computed per viewer by the server.** Clients never filter. A secret lore
  entry, a keeper-only variable, an unexposed leaf of an imported variable tree, and a
  world card's prose and directives are never in a player's views.
- **A module view is computed per viewer by the module** (`for(who, room)`): return only
  what that viewer may see. The server forwards it to that viewer only.
- **A panel shows only its viewer's views.** `visible_when` hides a block; it is not
  secrecy — the block reaches every viewer the panel is listed to. `audience: admin`, or
  reading an `admin/*` view, keeps a panel to admins.
- **The card split is code.** A player's character import writes a character and a seat,
  nothing else; world machinery reaches a room only through the admin's world import,
  which the Keeper cannot invoke.
- **Keeper machinery stays the Keeper's.** A module command with `role: "keeper"` is never
  listed to players; the Keeper runs it with its `run_command` tool, and the room's admin
  can run it to repair a mistake.

The Keeper itself holds the whole truth of a world by design: a game master who learns the
answer late cannot foreshadow. Keeping keeper-only material out of its narration is a
behaviour, checked by live-model evaluations.

## Names and order

- **Ids are kept by their first claimant.** A pack's rule systems and skills join the
  server's; the built-ins come first, then installed packs in install order. A later
  pack's rule system or skill with a taken id is not loaded, and the install names it.
- **Module ids are per room.** A module's commands and views are named `<module>/<name>`.
  Two packs enabled in one room cannot both have a module with the same id
  (`module_id_taken`). Modules of a room are called in the order their packs were enabled.
- **Panels** are named `<pack>/<panel>`, audio cues `<pack>/<cue>`.

## Versions

- A pack says `manifest_version: 3`; a 3.0 server refuses 1 and 2.
- `engine: { protocol, server }` are minimum versions; a server that is older refuses the
  install (`engine_too_old`). There are no dependencies between packs: a pack ships
  everything it needs, and a rule pack may extend only a built-in system or one in its own
  pack.
- Installing a new version of a pack replaces the old one; rooms that have it enabled
  reload and play the new version, and its modules start from their saved state.
- The client protocol is versioned separately ([protocol.md](protocol.md)); the protocol
  package `loreweaver-protocol` follows it.

## Not in 3.0

2.x had these; 3.0 does not:

- **`hooks.js`** turn-lifecycle scripts, in skills or in cards, and the QuickJS sandbox
  they ran in. A `hooks.js` in a pack is ignored and reported; hook scripts in a card are
  counted and never run. Code that reacts to a turn is a module.
- **Prep scripts** and the prep phase; **prompt presets**; **lorebooks** as a separate
  pack kind (lore travels in cards); a pack's lore **overlay** file.
- The **rules-script lane** in rule packs; a rule pack that needs it does not load.
- The **forge** (generating skills, rule packs or modules from a description), **dev
  rooms** with live reload, and the **lint** command: an author rebuilds and reinstalls
  ([authoring.md](authoring.md) §2).
- **AI companions** and a native card's claimable **pregens**.
- Server plugins of any other kind: a module is the one way to add code.
