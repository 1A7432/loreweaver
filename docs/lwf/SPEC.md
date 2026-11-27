# Loreweaver World Format — umbrella specification

**Version 3.0 · draft.** A breaking revision of LWF 2.0 (§8). Every constituent document
carries its own version and status (§9).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 1. What LWF specifies

A **world** is a complete, runnable AI-RPG experience: rules, lore, characters, typed game
state, code and, optionally, its own interface. LWF specifies:

1. the **container** that carries a world: the `.lwpack` archive and its manifest
   ([formats/pack.md](formats/pack.md));
2. the **content formats** inside it: cards, lore and room variables
   ([formats/cards.md](formats/cards.md)), rule packs
   ([formats/rulepacks.md](formats/rulepacks.md)), skills
   ([formats/skills.md](formats/skills.md)), panels
   ([formats/panels.md](formats/panels.md)) and the presentation kit
   ([formats/presentation.md](formats/presentation.md));
3. the **semantic requirements** a runtime must honour for that content to behave portably and
   safely: the card split, information isolation and the bounds on content code (§5).

LWF does **not** specify:

- the **wire protocol** clients use to play against a runtime. It is defined by the engine's
  [`docs/protocol.md`](../protocol.md), currently protocol **3.0**, and published as typed
  definitions on npm as `loreweaver-protocol`. Where an LWF document mentions what a client
  receives, the protocol document is the authority;
- the programming interface of a pack's modules: modules are written against the module SDK
  (`loreweaver/module`, `sdk/` in the reference repository), which this version does not
  specify;
- an implementation language, a look and feel, a model provider, a hosting topology, or how a
  runtime's Keeper assembles its prompts and plays.

## 2. Terminology

- **Pack**: one `.lwpack` archive conforming to [formats/pack.md](formats/pack.md).
- **Module**: code a pack bundles, run by a runtime in the rooms that enabled the pack.
- **World card / character card**: a card that carries world machinery, or one that does not
  ([formats/cards.md](formats/cards.md) §3).
- **Keeper**: the runtime's AI game master. It holds the full module truth.
- **Room admin**: a person holding the room's admin role. It is the trust anchor for
  everything that reprograms shared play; a room admin is usually also a player.
- **Operator**: whoever runs the runtime and installs packs on it.
- **Player**, **observer**: room members without the admin role; an observer does not play.
- **Player-grade viewer**: any viewer that is neither the Keeper nor a room admin acting as
  themself — players, observers, and every AI-played NPC or companion actor.
- **Keeper-only**: visible only to the Keeper (and, where a document says so, to a room admin).
- **Runtime**: software that installs packs and runs worlds. **Authoring tool**: software that
  produces packs or their constituent files. **Builder**: an authoring tool that turns a
  source tree into a pack.

## 3. Conformance classes

### 3.1 LWF Pack

An archive is a conforming pack if and only if it satisfies every MUST in
[formats/pack.md](formats/pack.md) and in each content format it carries.

### 3.2 LWF Runtime: Core

A Core runtime MUST:

- install packs with the full verification of pack.md §8, before any write;
- parse and import cards and their lore ([formats/cards.md](formats/cards.md) §1–§5);
- enforce the card split and its admin gate (cards.md §3–§4);
- honour `engine:` minimums and refuse an install it cannot satisfy (pack.md §7);
- keep installing separate from enabling, and give an id to its first claimant (pack.md §8).

### 3.3 LWF Runtime: Faithful

A Faithful runtime additionally MUST meet the requirements below. This level exists so that
"runs LWF" can also mean "runs it *as a game*, not as improv theatre".

- **Deterministic resolution.** Dice and checks are resolved by real code
  ([formats/rulepacks.md](formats/rulepacks.md) §4–§5). A language model MUST NOT be able to
  fabricate, pre-write or override a mechanical outcome ("dice-first").
- **Validated state.** Every write to a typed variable or to the variable tree, and every
  character-sheet write, is validated by code before it takes effect (cards.md §8,
  rulepacks.md §9).
- **Information isolation.** Keeper-only material MUST be removed structurally, per viewer and
  before any transport, by a projection the runtime computes; a client never merely hides it
  (cards.md §10, panels.md §2).
- **Bounded content code.** Content code runs only as §5 allows. A broken or hostile template
  degrades to an entry that renders nothing, a broken module to a failed call of its room;
  neither breaks the session or the runtime.

The reference engine implements Faithful.

### 3.4 LWF Authoring Tool

An authoring tool MUST produce artifacts that validate under the rules a runtime enforces. A
conforming builder MUST refuse at build time anything a conforming runtime would refuse at
install time, and MUST:

- bundle each module, with everything it imports, into one JavaScript file (pack.md §3);
- check every card's declared `kind` against the card (pack.md §4.1);
- read only the files the manifest names, never through a symbolic link or outside the source
  tree, and produce the same bytes from the same source tree (pack.md §5).

## 4. Rules shared by every format

- **YAML.** Every YAML file LWF defines (manifest, rule packs, skill front matter, panels, the
  presentation kit; and the YAML route of a variable declaration) is read as YAML 1.2, core
  schema, with no merge keys, at most 2,000,000 characters, and these refused: anchors and
  aliases; duplicate keys; the key `__proto__`; and a mapping whose integer-like keys
  (`0`, `7`, `42`, below 2^32 − 1) do not come first in ascending order — the order of a
  mapping is meaning, and such a mapping is a list in disguise.
- **Text** is counted in Unicode code points unless a document says otherwise.
- **A value over its cap is refused, never cut**, unless a document names an exception (the
  lore import of [formats/cards.md](formats/cards.md) §5.2 cuts titles, keys and conditions).
- **Closed objects.** Each document says which of its objects are closed. A consumer MUST
  reject an unknown key in a closed object, so that a typo fails at build time, and MUST
  ignore unknown keys elsewhere. Producers MUST NOT rely on unknown keys being preserved.
- **Localized text** is a plain string (read as English) or a mapping with `en` and/or `zh`.

## 5. Security floor (normative, all runtimes)

Packs and cards are untrusted input from the network. Pack content is trusted only by the
operator's explicit decision, and player devices trust nobody.

1. **Container safety.** Archive entry names MUST be validated against traversal and unsafe
   names, symbolic-link entries MUST be rejected, sizes MUST be enforced while inflating, and
   undeclared code MUST fail the install (pack.md §5).
2. **Disclosure.** Before installing, the runtime MUST show whoever installs a trust card
   computed from the validated content, so it cannot understate what the pack ships
   (pack.md §8). Installing is an informed decision; the format gates integrity, not taste.
3. **The admin gate (拆卡).** World machinery — variable declarations, templates, keeper-only
   lore, typed variables — MUST enter a room only through a room admin's world import, a
   deterministic privilege check that MUST NOT be offered to the Keeper as a tool. A
   character import MUST take only the character half, structurally, and SHOULD report what
   it left behind (cards.md §3–§4).
4. **Modules.** A module is real code: a runtime runs it unsandboxed, so installing a pack that
   has modules is the decision to run its code, and the trust card MUST say so first. What a
   runtime owes is fault isolation: a module that throws or hangs costs its room a call, not
   the runtime (pack.md §3).
5. **Templates in lore.** A template MUST run away from the runtime's own state, with no host
   I/O and no host callables, in a context that does not outlive one prompt assembly; its time
   MUST be bounded per template and per assembly; a failure renders as nothing (cards.md §7.1).
   This version does not require a memory bound.
6. **Pages.** Panel pages delivered to clients MUST run with an opaque origin, no host access
   beyond the panel bridge and **no network capability** (panels.md §7).
7. **No central authority.** A pack MUST remain installable from a local file or a plain Git
   release. Conformance MUST NOT require any registry, account or phone-home.

## 6. Versioning and stability

**History.** LWF 1.0 (a draft dated 2026-07-30) was never published. LWF 2.0 was the first
published version. LWF 3.0 is a breaking revision made with the reference engine's rewrite: no
2.x pack, rule pack with a script, or hook is run by a 3.0 runtime (§8).

**Policy.**

- Each constituent document versions independently (`MAJOR.MINOR`), with a status of
  **draft** or **stable**. A draft may still change incompatibly.
- **Stable means additive-only within a major version.** Existing fields never change meaning
  or type, and no new required field is introduced. An artifact valid under `X.y` stays valid
  under every later `X.z`. Caps may be raised, never lowered.
- **Forward compatibility** is explicit, never guessed. A consumer MUST refuse an artifact
  whose declared schema version it does not implement: a pack's `manifest_version`, a rule
  pack's `resolution.version`, a native bundle's `format_version`, a presentation kit's
  `version`. A pack declares the runtime it needs through `engine:` minimums.
- **Breaking changes** require a new major version and a migration section in the document.
- **The wire protocol** is versioned by [`docs/protocol.md`](../protocol.md), not by LWF. A
  pack names the protocol it needs in `engine.protocol` (pack.md §7).

## 7. Conformance vectors

A second implementation proves itself against shared tables, not prose. This repository
holds these:

| File | Covers | Status |
|---|---|---|
| `clients/protocol/src/v3/panels.vectors.json` | Panel template instantiation (panels.md §6) | **3.0 contract**: every implementation MUST produce exactly the blocks it lists. |
| `clients/protocol/src/condexpr.vectors.json` | The portable subset of the expression language: values, and expressions a build must refuse (panels.md §5.1, rulepacks.md §3) | Shared by the server's evaluator and the client's; a contract for the subset. |
| `server/test/fixtures/reference/st_*.jsonl` | SillyTavern card parsing and the split, lore import, activation, macros, decorators, declarations, the update block, the tree, templates | Recorded from the 2.6 engine. |
| `server/test/fixtures/reference/rules_*`, `sheets_*`, `dice_*` | Rule packs, checks, subsystems, sheets, dice | Recorded from the 2.6 engine. |

The `server/test/fixtures/reference/` tables (described in their `README.md`, digested in
`MANIFEST.json`) are a record of the 2.6 engine, not a 3.0 contract by themselves: the
reference's 3.0 tests replay them and pin every deliberate departure in the test files beside
them (`server/test/core/card/`, `worldbook/`, `variables/`, `resolution/`, `rulepacks/`,
`sheets/`, `subsystems/`, `dice/`). A row those tests supersede does not describe 3.0;
`st_ejs_lite.jsonl` and `rules_script_lane.jsonl` describe features 3.0 removed, and
`keeper_prompt_2_6.*.json` is not a format. **No shared vectors exist yet** for the pack
manifest and archive, the native bundle's 3.0 behaviour, the world and character imports, the
lore overlay, skills or the presentation kit.

## 8. From LWF 2.0

| 2.0 | 3.0 | Replacement |
|---|---|---|
| Pack `manifest_version: 2`, generated `files` and `trust` blocks | `manifest_version: 3`; the runtime computes the trust card | pack.md §10 |
| Skill and card hooks (`hooks.js`, `extensions.loreweaver_hooks`, a bundle's `hooks`) | Not run; reported as ignored or unsupported | Pack modules (pack.md §3), with a different API |
| Prep scripts (`prep`) | Refused (`unsupported_kind`) | None |
| Prompt presets (`presets`) | Refused (`unsupported_kind`) | None; a world card's own directives still reach the Keeper (cards.md §4.1) |
| Standalone lorebooks (`lorebooks`) | Refused (`unsupported_kind`) | Lore inside a card |
| A card's pack overlay file (`loreweaver.lore-overlay/1`) | Not part of a pack | The room admin's `lore` commands (cards.md §9); none for exposure or setup items |
| The rules-script lane (`resolution.script`, `script` subsystems) | Refused (`SCRIPT_UNSUPPORTED`) | None |
| Derived `computer` / `computer_group` | Refused (`UNSUPPORTED_COMPUTER`) | Formulas |
| Pregenerated casts (`pregens`) | Parsed, not imported | None yet |
| Importing a card as a companion | Not available | None yet |
| Character import with plain lore | Name, persona and a generated sheet only | — |
| Subset-mode templates, the hook/template kill switch | Removed | A failing template renders nothing |
| Panels 1.0 (variable bindings, `ui_manifest`) | Panels 3.0 (views, commands) | panels.md §9 |
| Presentation kit in pack.md §4.2 | Its own document | presentation.md |
| Protocol 2.5 | Protocol 3.0 | Not part of LWF ([`docs/protocol.md`](../protocol.md)) |

## 9. Constituent documents

| Area | Document | Version |
|---|---|---|
| Container, modules, archive, assets, installing | [formats/pack.md](formats/pack.md) | 3.0 draft |
| Cards, lore, room variables, the split, isolation | [formats/cards.md](formats/cards.md) | 3.0 draft |
| Rule systems | [formats/rulepacks.md](formats/rulepacks.md) | 3.0 draft |
| Skills | [formats/skills.md](formats/skills.md) | 3.0 draft |
| Panels | [formats/panels.md](formats/panels.md) | 3.0 draft |
| Presentation kit | [formats/presentation.md](formats/presentation.md) | 3.0 draft |
| Wire protocol (not LWF) | [`docs/protocol.md`](../protocol.md), npm `loreweaver-protocol` | 3.0 |
