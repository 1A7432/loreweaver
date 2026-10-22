# Loreweaver World Format — umbrella specification

**Version 2.0 · stable.** Every constituent document carries its own version and
stability label (§6).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 1. What LWF specifies

A **world** is a complete, runnable AI-RPG experience: rules, lore, characters, typed
game state, sandboxed logic, and optionally its own interface. LWF specifies:

1. the **container** that carries a world: `.lwpack` ([formats/pack.md](formats/pack.md));
2. the **content formats** inside it: cards and lorebooks, rulepacks, skills and hooks,
   and panels (the other documents in `formats/`), plus the presentation kit, prompt
   presets and prep scripts, specified in pack.md §2;
3. the **semantic requirements** a runtime must honor for that content to behave
   portably and safely: decomposition, isolation and sandbox rules (§4);
4. the **wire protocol** clients use to play against a runtime. It is a constituent
   standard maintained in the reference engine repository and published as typed
   definitions on npm as `loreweaver-protocol`.

LWF does **not** specify an implementation language, a look and feel, a model provider,
a hosting topology, or how a runtime's AI game master assembles its prompts and plays.

## 2. Terminology

- **Pack**: one `.lwpack` archive conforming to [formats/pack.md](formats/pack.md).
- **World card / character card**: the two halves of the card decomposition
  ([formats/cards.md](formats/cards.md)). A world card carries module machinery; a
  character card is a playable persona.
- **Keeper**: the runtime's AI game master (守秘人). It holds the full module truth.
- **Keeper role**: the privileged room role, authenticated by the transport. It is the
  trust anchor for everything that reprograms shared play. **Room admin**: the human who
  holds the keeper role for a room. A room admin is usually also a player.
- **Keeper-only**: visible only to keeper-role viewers and to the Keeper.
- **Player**: a participant without the keeper role. **Player-grade viewer**: any viewer
  without the keeper role, including an AI-played NPC or companion actor.
- **Runtime**: software that installs packs and runs worlds.
- **Authoring tool**: software that produces packs or their constituent artifacts.

## 3. Conformance classes

### 3.1 LWF Pack

An archive is a conforming pack if and only if it satisfies every MUST in
[formats/pack.md](formats/pack.md) and in each content format it carries.

### 3.2 LWF Runtime: Core

A Core runtime MUST:

- install packs with the full verification of pack.md §6.3, verifying before any write;
- parse and run the content formats it advertises, at minimum cards and lorebooks;
- enforce the card decomposition of cards.md §4–§5, including its keeper-role gate;
- honor `engine:` minimum versions, and refuse an install it cannot satisfy;
- keep installing separate from enabling (pack.md §6.5).

### 3.3 LWF Runtime: Faithful

A Faithful runtime additionally MUST meet the requirements below. This level exists so
that "runs LWF" can also mean "runs it *as a game*, not as improv theater".

- **Deterministic resolution.** Dice and rule checks are resolved by real code
  ([formats/rulepacks.md](formats/rulepacks.md) §5). A language model MUST NOT be able to
  fabricate, pre-write or override a mechanical outcome ("dice-first").
- **Validated state.** Typed variable writes, and every character-sheet write, are
  validated and clamped by code before they take effect (cards.md §2, rulepacks.md §9).
- **Information isolation.** Keeper-only material MUST be removed structurally, per
  recipient and before any transport, by a projection the runtime computes. A client
  never merely hides it. Keeper-only material includes secret lore, keeper-visibility
  variables, unexposed imported variables, overlays, keeper-audience panels and the
  other items of cards.md §8.
- **Sandboxed logic.** Pack-shipped code (hooks, templates, rules scripts, prep scripts,
  panel code) runs only inside the sandboxes of §4. A broken or hostile script degrades
  to an inert hook, a refused check or a skipped pack, never to a broken session.

The reference engine implements Faithful.

### 3.4 LWF Authoring Tool

An authoring tool MUST produce artifacts that validate under the same rules the runtime
enforces. A conforming builder MUST reject at build time anything a conforming runtime
would reject at install time. A conforming builder also MUST:

- stamp detected card kinds and refuse declared ones;
- generate the `files` inventory and the `trust` block, and refuse hand-written ones;
- fail the build on an expression outside its grammar.

## 4. Security floor (normative, all runtimes)

Packs are untrusted input from the network. Pack content is trusted *only* by the
operator's explicit decision, and player devices trust nobody. Accordingly:

1. **Container safety.** Archive entry names MUST be validated against traversal and
   symlink entries MUST be rejected. Sizes and digests MUST be verified while streaming,
   and undeclared archive entries MUST fail the install (pack.md §6).
2. **Disclosure.** The runtime MUST disclose the pack's generated `trust` summary to
   whoever installs it (pack.md §6.6). Installing is the operator's informed decision;
   the format gates integrity, not taste.
3. **The keeper-role gate (拆卡).** Module machinery MUST enter a room only through a
   keeper-role import. Module machinery here means hook scripts, variable declarations,
   executable templates, keeper-only lore and card directives. A player-privileged import
   MUST strip that machinery structurally (cards.md §5.1), and SHOULD report what it
   stripped. The world import MUST NOT be invocable by the Keeper as a tool.
4. **Server-side sandboxes.** Hooks, templates, rules scripts and prep scripts execute
   in an interpreter that has all of these properties:
   - a hard memory cap;
   - a time limit per evaluation, armed before untrusted top-level code runs;
   - no host I/O and no host callables.

   Hooks and templates additionally get a fresh interpreter every turn, with no state
   shared across turns or rooms. An operator kill switch MUST disable hooks and
   full-mode templates together (skills-hooks.md §6).
5. **Client-side sandboxes.** Panel code delivered to player devices MUST run with an
   opaque origin, with no host access beyond the panel bridge and with **no network
   capability** ([formats/panels.md](formats/panels.md) §6). It loads only its own
   content-addressed assets.
6. **No central authority.** A pack MUST remain installable from a local file or a plain
   Git release. Conformance MUST NOT require any registry, account or phone-home.

## 5. Versioning and stability policy

**History.** LWF 1.0 (a draft dated 2026-07-30, never published) was superseded during
the format's pre-adoption window. The reference implementation broke several 1.0
formats on purpose before anyone else had adopted them:

- the pack manifest moved to `manifest_version: 2`, with a generated file inventory and
  detected card kinds;
- rule systems became pure data;
- the card split gained keeper-only lore, directives and the native bundle.

LWF 2.0 is the first published version, and it describes the formats exactly as the
reference implementation enforces them. There is no migration from 1.0 artifacts: the
reference refuses `manifest_version: 1` packs.

**From publication on:**

- Each constituent document versions independently (`MAJOR.MINOR`), with a status of
  **draft** or **stable**.
- **Stable means additive-only within a major version.** Existing fields never change
  meaning or type, and no new REQUIRED field is introduced. An artifact valid under
  `X.y` stays valid under every later `X.z`. Caps may be raised, never lowered.
- **Unknown fields.** Each document states which of its objects are *closed*. A
  consumer MUST reject an unknown key in a closed object, so that author typos fail at
  build time. It MUST ignore unknown keys elsewhere. Producers MUST NOT rely on unknown
  keys being preserved.
- **Forward compatibility** is explicit, never guessed. A consumer MUST refuse an
  artifact whose declared schema version is newer than the one it implements: a pack's
  `manifest_version`, a rulepack's `resolution.version`, a native bundle's
  `format_version`, a presentation kit's `version` or an overlay's `format`. A pack
  declares the runtime it needs through `engine:` minimums.
- **Breaking changes** require a new MAJOR version and an explicit migration note in the
  document. They SHOULD ship with a converter in a reference authoring tool.
- **Wire protocol.** The major version is the compatibility contract: a client and a
  server MUST agree on it. Minor versions within a major are additive, and a client
  ignores frame types and fields it does not recognize, with one exception: a field that
  gates rendering, such as `visible_when`, is never ignorable (panels.md §5.1).

## 6. Constituent documents

| Area | Document | Version |
|---|---|---|
| Container, presentation kit, presets, prep scripts | [formats/pack.md](formats/pack.md) | 2.0 stable |
| Cards, lorebooks, the world/character split, isolation | [formats/cards.md](formats/cards.md) | 2.0 stable |
| Rule systems | [formats/rulepacks.md](formats/rulepacks.md) | 2.0 stable |
| Skills, hooks, templates | [formats/skills-hooks.md](formats/skills-hooks.md) | 2.0 stable |
| Module UI panels | [formats/panels.md](formats/panels.md) | 1.0 stable |
| Wire protocol | engine `docs/protocol.md` + npm `loreweaver-protocol` | 2.5 stable |

Lorebooks: LWF accepts the SillyTavern lorebook shapes (`character_book`, or
`{entries: [...]}`) as they are. Their import trust rules (cards.md §6) apply identically
to embedded and standalone lorebooks.
