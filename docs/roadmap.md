*English · [中文](roadmap.zh.md)*

# Loreweaver roadmap

Loreweaver is young and built largely by one person with AI assistance. This is the honest forward plan — where the project is focused now, the bigger arc after, and one open design question worth deciding in the open. For the layer contracts and iron rules, see [CLAUDE.md](../CLAUDE.md).

## The ambition

The goal is not "an AI stand-in for a game master" — it is to be **the Claude Code of the RPG domain**. Powerful coding agents are everywhere; competent RPG agents barely exist. Every layer here — real dice and hard rules, a Keeper that acts through tool calls, sub-actors that know only what they should, an extension ecosystem growing along SKILL.md and SillyTavern conventions — points the same way: making "running a world well" a first-class agent capability.

## Where things stand

The deterministic engine — dice (on `d20`), CoC/DnD success levels, character math, rule validation, the game clock — is the solid core, covered by a deterministic, offline test suite. The **terminal (OpenTUI) client remains primary**, connecting over **Iroh** p2p. The chat-platform adapters (Discord/QQ/Telegram/Feishu/OneBot) were **removed deliberately** (2026-07-30): the project's UI direction — declarative `ui` frames, live tracker panels, and a deeply customizable client-side extension layer — is something plain-text chat platforms structurally cannot render, so clients speak the open protocol instead.

**v1.0.0 is out as the first stable release**, and the module-facing surface has filled in since the hardening pass below: deterministic module variables with a live TUI tracker panel, full SillyTavern compatibility for imported cards (MVU variable trees, the `<UpdateVariable>` text protocol, full EJS in a QuickJS sandbox, ST worldbook trigger semantics), sandboxed event hooks (`hooks.js`) that can draw declarative protocol-v1.7 UI frames, `.lwpack` content packs distributed through Git releases, and the protocol SDK on npm (`loreweaver-protocol`). On top of that sits the **card split**: imports decompose an ST card into its character half (player-importable, machinery structurally stripped) and its world half (keeper-only `.import … world` — hooks, variable schemas, keeper lore), packs label `world` vs `character` cards with the label enforced by real detection, imported variable trees stay off player panels until the keeper exposes them, and a module can ship its rules as a rulepack *patch* (`extends: coc7` + deltas). Details: [plugins.md](plugins.md), [cards.md](cards.md), [hooks.md](hooks.md).

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
- **Companion client & card workbench — going public.** The engine half of native authoring has landed: typed trackers (`core.modvars`) instead of raw MVU trees, and imported SillyTavern cards that actually run (full EJS, trigger semantics — see [plugins.md](plugins.md)). The authoring half — building Loreweaver-native cards and content without hand-editing JSON — is implemented on the creation side in a companion desktop client and card workbench, which are being prepared for public release; opening them up is the near-term work.

## The bigger arc — the world engine

The differentiator is a world *beneath* the adventure, not just a chat with dice. The long direction:

- **A deeply customizable UI extension layer.** The reason the chat adapters died: modules and hooks should be able to DRAW their interface — declarative `ui` frames today (meters, badges, choices), richer module-defined panels and client-side extension points next — so a world ships not just rules and lore but its own table dressing. Protocol clients (the TUI, the companion desktop client) are the rendering targets.
- **Deeper worldbook:** a generative world (not only keyword/vector-retrieved lore), a **living causal timeline** where events have consequences that propagate, and **canon consistency** so the Keeper can't contradict established facts.
- **Late-joiner catch-up:** a player who joins mid-campaign is caught up on what their character *would* know — without leaking what they wouldn't.
- **D&D Beyond sheet import**, alongside the existing SillyTavern-card path.
- **Broader prebuilt coverage** beyond the current Windows x64, macOS arm64, and Linux x64/arm64 matrix.

## An open design question — where do the Keeper's secrets live?

Today the Keeper's system prompt carries the module's keeper pool in (near) full, and keeper-only tools hand secrets back to the model verbatim; anti-metagaming on the Keeper side is therefore *discipline* (a "don't quote this to players" instruction) plus the deterministic keeper/player pool split — strong for the sub-actors (built only from their own record), softer for the Keeper itself.

An alternative is to keep secrets *out* of the base prompt and have the Keeper pull them on demand through tools, so the model only ever holds the specific secret it just reasoned about. That trades some prompt convenience and latency for a smaller leak surface. This is a real architectural fork worth deciding deliberately rather than drifting into — input welcome.

## Offline tests vs. real-model quality

Worth stating plainly, because green CI is easy to over-read: the offline suite is deterministic and uses a *scripted* Keeper. It rigorously proves the deterministic machinery — the keeper/player knowledge redaction, the sub-actor prompt isolation, real seeded dice, the command surface — and it will catch a regression in any of those. It **cannot** prove that a live model refrains from leaking a secret it is shown, or that it rolls before it narrates; those are model-behavior properties, and they are exactly what the real-model red-line gate (now running nightly) exists to measure. Read "CI is green" as *the engine is correct*, not *the Keeper is good*.

## How to help

Pick anything above, or anything marked 🧪 in the [README](../README.md). Before a PR, `uv run ruff check …`, `uv run python scripts/i18n_lint.py`, and `uv run pytest -q` (plus the relevant `bun test`) must pass, and the iron rules in [CLAUDE.md](../CLAUDE.md) — no hardcoded user-facing strings, the deterministic-vs-generative split, and the information-isolation red lines — must hold.
