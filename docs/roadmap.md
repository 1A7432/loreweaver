*English · [中文](roadmap.zh.md)*

# Loreweaver roadmap

Loreweaver is young and built largely by one person with AI assistance. This is the honest forward plan — where the project is focused now, the bigger arc after, and one design question we argued in the open and then closed. For the layer contracts and iron rules, see [AGENTS.md](../AGENTS.md).

## The ambition

The goal is not "an AI stand-in for a game master" — it is to be **the engine and the open standard
for AI-run tabletop RPGs**. Powerful coding agents are everywhere; competent RPG agents barely
exist, and the formats a world would need to travel in do not exist at all. Every layer here — real
dice and hard rules, a Keeper that acts through tool calls, sub-actors that know only what they
should, an extension ecosystem growing along SKILL.md and SillyTavern conventions — points the same
way: making "running a world well" a first-class agent capability, on formats nobody has to ask
permission to use.

## Where things stand

The deterministic engine — dice, check tiers, character math, rule validation, the game clock — is
the solid core, covered by a deterministic, offline test suite. The **terminal (OpenTUI) client
remains primary**, connecting over **Iroh** p2p. The chat-platform adapters
(Discord/QQ/Telegram/Feishu/OneBot) were **removed deliberately** (2026-07-30): the project's UI
direction — declarative `ui` frames, live tracker panels, and a deeply customizable client-side
extension layer — is something plain-text chat platforms structurally cannot render, so clients
speak the open protocol instead.

**v1.0.0 shipped as the first stable release**, and development has continued past it on a
`1.0.1.dev*` line. Since then, seven structural milestones landed:

- **Rules became data (M16).** A rule system is one file, and it owns everything about itself: the
  tiers a check can land on, what a sheet looks like, which subsystems exist, which dot-commands it
  answers to, and what to tell the Keeper about running it. The core no longer knows what CoC is —
  a test fails if the word turns up anywhere in `agent/` — and deleting `rulepacks/coc7.yaml` removes
  CoC with nothing left behind. A system the DSL can't express gets a sandboxed script instead.
- **One document model (M17).** All room content — lore, NPCs, sheets, pregens, trackers, notes,
  knowledge pools — is one `Document` type, and everything on its way out goes through that type's
  `project(document, viewer)`. Five separate secrecy mechanisms became one, and the per-store backup
  allowlists (a dependable source of drift bugs) are gone.
- **Long-campaign memory (M18).** Play is recorded as chronicle documents that fold into a rolling
  summary on a deterministic policy, so a campaign outlives its context window. `.recap` is the
  player-grade projection of the same documents.
- **A presentation layer (M19).** A Stage Director — a player-side, knowledge-scoped actor — stages
  story beats with declarative performance templates, audio cues and ref-constrained generated art,
  from a creative brief the module's author ships. Wire protocol 2.1.
- **A disciplined turn (M20).** The prompt keeps a byte-stable head so provider caching actually
  pays; tools split into prep and play phases so a content pack cannot bloat a live turn; the
  table's own habits become procedural memory; and a turn can be undone — `.undo` rewinds the whole
  room, not just the chat.
- **Memory that writes itself (M21–M22).** The Scribe — the watcher that already reads every turn —
  now writes the chronicle line itself, at zero extra model calls, so the campaign record no longer
  depends on the Keeper remembering to write it. Underneath, the context-window arithmetic the fold
  relies on was re-verified against every vendor's own documentation, after a stale table was
  caught inflating one window sixteenfold.
- **A harness that recovers (M23 — [spec published](specs/M23-harness-resilience.md)).** A campaign
  that outgrows the context window no longer loses the player's turn: the provider's own refusal is
  the signal, and the engine folds and re-sends once, only if the fold actually freed something. A
  reply the model cut off at the limit stops counting as a finished turn. Whatever reaches the model
  can be rebuilt from what is saved, so an undo, a late joiner's replay and a post-mortem all see
  what the model saw. And every kind of room state declares what a reset, delete, import and export
  should do with it — the build fails if any state has nobody answering for it, which is what three
  "the reset forgot something" fixes in one month were asking for. Decisions taken and rejected live
  in [docs/notes/](notes/).

Alongside those: deterministic module variables with a live tracker panel, full SillyTavern
compatibility for imported cards (MVU variable trees, the `<UpdateVariable>` text protocol, full EJS
in a QuickJS sandbox, ST worldbook trigger semantics), sandboxed event hooks that draw declarative
UI, `.lwpack` content packs distributed through Git releases, and the protocol SDK on npm
(`loreweaver-protocol`, whose `major.minor` tracks the wire protocol). On top of that sits the **card
split**: imports decompose an ST card into its character half (player-importable, machinery
machinery removed by the importer) and its world half (keeper-only `.import … world`), packs label
cards `world` or `character` and the build checks that label against what the card actually contains, imported variable trees stay off player
panels until the keeper exposes them, and a module can ship its rules as a rulepack *patch*
(`extends: coc7` + deltas). Details: [plugins.md](plugins.md), [authoring.md](authoring.md),
[cards.md](cards.md), [hooks.md](hooks.md).

## Foundations — done

A round of unglamorous work just landed — the things that have to be right before adding anything new is worth doing. The project now installs cleanly, behaves correctly, and is safer to run for a small group:

- **It installs.** The wheel carries every package plus the runtime data (locales, rulepacks), so `pip install` works in a clean environment, not only from a git clone.
- **Permissions.** The player/keeper split is now checked on *every* command, not only on the admin frames — a player key used to be able to run keeper-only commands from the terminal. Replies that carry secrets, like a masked API key or keeper-only lore, go to whoever asked instead of to the whole room.
- **Character numbers.** Editing a skill or attribute no longer quietly heals a wounded investigator, character creation works out the right starting HP/MP/SAN, and every path that writes a stat is held to the rulepack's limits.
- **Honest moderation.** The content filter ships switched off, with no word list, and the docs say so plainly rather than implying there is moderation built in.
- **A nightly run against a real model.** It plays real turns and fails if too many keeper secrets come out — quoted or reworded — or if too many checks are narrated without being rolled. It tells you about one model on one night; it is not a standing guarantee. (See [below](#offline-tests-vs-real-model-quality) for why this is separate from the offline suite.)
- **Transport and release housekeeping.** Iroh join timeouts, Keeper keys that can only administer their own room, secret files restricted to their owner where the filesystem allows it, release archives with verified checksums, stable and prerelease kept apart, CI on Python 3.11 *and* 3.12, and dead code removed.
- **Chat adapters — built, then retired.** Five platform adapters (Discord, official QQ, Telegram, Feishu, OneBot 11) were taken to a respectable state, with mock tests, and then deleted on purpose: once the interface direction became declarative frames and module-drawn panels, plain-text chat was a dead end, and removing them beats shipping a permanently second-class experience forever. The cross-transport RoomHub they proved out is still there, under the CLI and the protocol clients.

## Near-term

- **Multiplayer polish.** With permissions now enforced, smooth off the remaining rough edges of networked play — a real guard against bot loops, more of the state a late joiner needs — so a room among people who trust each other is genuinely comfortable.
- **Companion client & card workbench.** The authoring half — building Loreweaver-native cards and content without hand-editing JSON — lives in [loreweaver-studio](https://github.com/1A7432/loreweaver-studio), now public: an eleven-stage wizard, SillyTavern export for tavern release, and a preset-import mirror. It is earlier than this repository and is catching up to the 2.x formats.
- **A flagship module.** The formats are only worth as much as the first serious thing built on them. One is in development, co-designed with the panel/presentation layers so that layer has a real consumer rather than a hypothetical one.

## The bigger arc — the world engine

What sets this apart is the world *underneath* the adventure, not a chat with dice bolted on. The long direction:

- **A deeply customizable UI extension layer.** The reason the chat adapters died: modules and hooks should be able to DRAW their interface — declarative `ui` frames today (meters, badges, choices), richer module-defined panels and client-side extension points next — so a world ships not just rules and lore but its own table dressing. Protocol clients (the TUI, the companion desktop client) are the rendering targets.
- **Deeper worldbook:** a generative world (not only keyword/vector-retrieved lore), a **living causal timeline** where events have consequences that propagate, and **canon consistency** so the Keeper can't contradict established facts.
- **Catching up a late arrival:** someone who joins halfway through gets told what their character *would* already know — and nothing their character wouldn't.
- **D&D Beyond sheet import**, alongside the existing SillyTavern-card path.
- **Prebuilt binaries for more platforms** than today's Windows x64, macOS arm64 and Linux x64/arm64.

## A question we closed, and how

**Where do the Keeper's secrets live?** This was a real fork in the road for a while. The Keeper's
system prompt carries almost all of the module's keeper-only material, and keeper-only tools hand
secrets back word for word — so on the Keeper's own side, the thing stopping a spoiler is an
instruction not to quote that material, not the shape of the code. The alternative was to keep secrets out of the base
prompt and have the Keeper pull them on demand, so the model only ever holds the one secret it just
reasoned about.

**We decided not to.** A Keeper that doesn't know the whole truth cannot run a mystery: it plants no
foreshadowing, mistimes its reveals, and contradicts itself two sessions later. Rationing the
Keeper's own knowledge would trade away the thing the product is for, in exchange for a smaller leak
risk that testing against real models can address directly. So the split is permanent and deliberate:

- **For everyone else, it is the code.** Players, NPCs, companions and the Stage Director get a
  filtered view and nothing else. Tests exist purely to catch it if that ever stops being true.
- **For the Keeper alone, it is behaviour.** It sees the module. It is told not to quote it. That
  instruction is *tested* nightly against a real model, and never claimed as a guarantee.

The honest statement is the one in the README and in [deploy.md](deploy.md#data-flow-and-trust-boundaries),
and it stays there: green CI means the engine is correct, not that the Keeper is discreet.

## Offline tests vs. real-model quality

Worth saying plainly, because a green CI badge is easy to read too generously. The offline suite is deterministic and uses a *scripted* Keeper. It proves the mechanical half properly — that keeper material is kept out of player material, that each NPC is built only from its own record, that the dice are real and seeded, that the commands do what they say — and it will catch any of those breaking. It **cannot** prove that a live model keeps quiet about a secret it has been shown, or that it rolls before it narrates. Those are things a model does, and they are exactly what the nightly run against a real model is there to measure. Read "CI is green" as *the engine is correct*, not *the Keeper is good*.

## How to help

Pick anything above, or anything marked 🧪 in the [README](../README.md). Before a PR, `uv run ruff check …`, `uv run python scripts/i18n_lint.py`, and `uv run pytest -q` (plus the relevant `bun test`) must pass, and the iron rules in [AGENTS.md](../AGENTS.md) must hold: no user-facing string is hardcoded, anything the code should decide is never handed to the model, and information isolation is never broken.
