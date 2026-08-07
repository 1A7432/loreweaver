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

The deterministic engine — dice, check ladders, character math, rule validation, the game clock — is
the solid core, covered by a deterministic, offline test suite. The **terminal (OpenTUI) client
remains primary**, connecting over **Iroh** p2p. The chat-platform adapters
(Discord/QQ/Telegram/Feishu/OneBot) were **removed deliberately** (2026-07-30): the project's UI
direction — declarative `ui` frames, live tracker panels, and a deeply customizable client-side
extension layer — is something plain-text chat platforms structurally cannot render, so clients
speak the open protocol instead.

**v1.0.0 shipped as the first stable release**, and development has continued past it on a
`1.0.1.dev*` line. Since then, four structural milestones landed:

- **Rules became data (M16).** A rule system is one file that owns its check ladder, sheet shape,
  subsystems, command dialect and expertise text. The core no longer knows what CoC is: an
  architecture test pins `agent/` to zero rule-system tokens, and deleting `rulepacks/coc7.yaml`
  removes CoC with no residue. Systems the DSL can't express drop to a sandboxed pure-function lane.
- **One document model (M17).** All room content — lore, NPCs, sheets, pregens, trackers, notes,
  knowledge pools — is one `Document` type, and every type's `project(document, viewer)` is the
  single wire chokepoint for information isolation. Five parallel secrecy mechanisms became one, and
  every per-store backup allowlist (a reliable source of drift bugs) is gone.
- **Long-campaign memory (M18).** Play is recorded as chronicle documents that fold into a rolling
  summary on a deterministic policy, so a campaign outlives its context window. `.recap` is the
  player-grade projection of the same documents.
- **A presentation layer (M19).** A Stage Director — a player-side, knowledge-scoped actor — stages
  story beats with declarative performance templates, audio cues and ref-constrained generated art,
  from a creative brief the module's author ships. Wire protocol 2.1.

Alongside those: deterministic module variables with a live tracker panel, full SillyTavern
compatibility for imported cards (MVU variable trees, the `<UpdateVariable>` text protocol, full EJS
in a QuickJS sandbox, ST worldbook trigger semantics), sandboxed event hooks that draw declarative
UI, `.lwpack` content packs distributed through Git releases, and the protocol SDK on npm
(`loreweaver-protocol`, whose `major.minor` tracks the wire protocol). On top of that sits the **card
split**: imports decompose an ST card into its character half (player-importable, machinery
structurally stripped) and its world half (keeper-only `.import … world`), packs label `world` vs
`character` cards with the label enforced by real detection, imported variable trees stay off player
panels until the keeper exposes them, and a module can ship its rules as a rulepack *patch*
(`extends: coc7` + deltas). Details: [plugins.md](plugins.md), [authoring.md](authoring.md),
[cards.md](cards.md), [hooks.md](hooks.md).

## Foundations — done

A hardening pass just landed the unglamorous things that have to be right before breadth is worth adding — the project now installs cleanly, behaves correctly, and is safer to run for a small group:

- **Installable.** The wheel ships every package plus the runtime data (locales, rulepacks), so `pip install` works from a clean environment — not just from a source checkout.
- **Permission model.** The player/keeper distinction is now enforced on *every* command surface (it previously held only on the admin frames — a player key could run keeper-only commands over the terminal). Replies that expose secrets — a masked API key, keeper-only lore — are scoped to the caller, not broadcast to the room.
- **Character correctness.** Editing a skill/attribute no longer heals a wounded investigator, and creation derives the right starting vitals (full HP/MP, SAN = min(POW, SANMAX)); every stat-set path is clamped to the rulepack.
- **Honest moderation.** The content filter ships OFF with no bundled wordlist (configurable), and the docs say so plainly instead of implying built-in moderation.
- **Real-model red-line gate.** A nightly job runs a real model through the turn pipeline and fails on measured **leak rate** (verbatim *and* paraphrase sentinels for keeper secrets) or **dice-first misses** (a check that should have rolled, didn't). It is a regression signal for one model/run, not a permanent guarantee. (See [below](#offline-tests-vs-real-model-quality) for why this is separate from the offline suite.)
- **Transport + release housekeeping.** Iroh join timeouts, room-scoped Keeper key administration, owner-only local secret permissions where supported, verified release archives, stable/prerelease separation, CI on Python 3.11 *and* 3.12, and dead-code cleanup.
- **Chat adapters — built, then retired.** Five mock-tested platform adapters (Discord, official QQ, Telegram, Feishu, OneBot 11) were hardened to a respectable state and then deliberately deleted: the UI-extension direction (declarative frames, module-drawn panels) made text-chat rendering a dead end, and honest removal beats shipping a permanently second-class experience. The cross-transport RoomHub machinery they proved lives on under the CLI and protocol clients.

## Near-term

- **Multiplayer polish.** Now that the permission model is enforced, tighten the remaining networked-play rough edges (a real bot-loop guard, richer late-joiner state) so a room among trusted people is genuinely comfortable.
- **Companion client & card workbench.** The authoring half — building Loreweaver-native cards and content without hand-editing JSON — lives in [loreweaver-studio](https://github.com/1A7432/loreweaver-studio), now public: an eleven-stage wizard, SillyTavern export for tavern release, and a preset-import mirror. It is earlier than this repository and is catching up to the 2.x formats.
- **A flagship module.** The formats are only worth as much as the first serious thing built on them. One is in development, co-designed with the panel/presentation layers so that layer has a real consumer rather than a hypothetical one.

## The bigger arc — the world engine

The differentiator is a world *beneath* the adventure, not just a chat with dice. The long direction:

- **A deeply customizable UI extension layer.** The reason the chat adapters died: modules and hooks should be able to DRAW their interface — declarative `ui` frames today (meters, badges, choices), richer module-defined panels and client-side extension points next — so a world ships not just rules and lore but its own table dressing. Protocol clients (the TUI, the companion desktop client) are the rendering targets.
- **Deeper worldbook:** a generative world (not only keyword/vector-retrieved lore), a **living causal timeline** where events have consequences that propagate, and **canon consistency** so the Keeper can't contradict established facts.
- **Late-joiner catch-up:** a player who joins mid-campaign is caught up on what their character *would* know — without leaking what they wouldn't.
- **D&D Beyond sheet import**, alongside the existing SillyTavern-card path.
- **Broader prebuilt coverage** beyond the current Windows x64, macOS arm64, and Linux x64/arm64 matrix.

## A question we closed, and how

**Where do the Keeper's secrets live?** For a while this was an open fork. The Keeper's system prompt
carries the module's keeper pool in near-full, and keeper-only tools hand secrets back verbatim, so
anti-metagaming on the Keeper's own side is *discipline* — an instruction not to quote keeper
material — rather than a structural guarantee. The alternative was to keep secrets out of the base
prompt and have the Keeper pull them on demand, so the model only ever holds the one secret it just
reasoned about.

**We decided not to.** A Keeper that does not hold the whole truth cannot run a mystery: it
foreshadows nothing, mis-paces reveals, and contradicts itself two sessions later. Scoping the
Keeper's own knowledge trades the thing the product is for a leak-surface reduction that behavioural
evaluation can address directly. So the split is permanent and deliberate:

- **Structural, for everyone else.** Players, NPCs, companions and the Stage Director receive
  projections and nothing else. That is enforced by construction and by sentinel tests.
- **Behavioural, for the Keeper alone.** It sees the module. It is instructed not to quote it. That
  instruction is *measured*, nightly, against a real model — never claimed as a guarantee.

The honest statement is the one in the README and in [deploy.md](deploy.md#data-flow-and-trust-boundaries),
and it stays there: green CI means the engine is correct, not that the Keeper is discreet.

## Offline tests vs. real-model quality

Worth stating plainly, because green CI is easy to over-read: the offline suite is deterministic and uses a *scripted* Keeper. It rigorously proves the deterministic machinery — the keeper/player knowledge redaction, the sub-actor prompt isolation, real seeded dice, the command surface — and it will catch a regression in any of those. It **cannot** prove that a live model refrains from leaking a secret it is shown, or that it rolls before it narrates; those are model-behavior properties, and they are exactly what the real-model red-line gate (now running nightly) exists to measure. Read "CI is green" as *the engine is correct*, not *the Keeper is good*.

## How to help

Pick anything above, or anything marked 🧪 in the [README](../README.md). Before a PR, `uv run ruff check …`, `uv run python scripts/i18n_lint.py`, and `uv run pytest -q` (plus the relevant `bun test`) must pass, and the iron rules in [AGENTS.md](../AGENTS.md) — no hardcoded user-facing strings, the deterministic-vs-generative split, and the information-isolation red lines — must hold.
