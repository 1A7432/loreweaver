# Loreweaver roadmap

Loreweaver is young and built largely by one person with AI assistance. This is the honest forward plan — where the project is focused now, the bigger arc after, and one open design question worth deciding in the open. For the layer contracts and iron rules, see [CLAUDE.md](../CLAUDE.md).

## Where things stand

The deterministic engine — dice (on `d20`), CoC/DnD success levels, character math, rule validation, the game clock — is the solid core, covered by a deterministic, offline test suite. The terminal (OpenTUI) client is the polished path; the React web client speaks the same [protocol](protocol.md). The chat-platform adapters (Discord · Telegram · QQ · Feishu) are implemented and offline-unit-tested but **not yet verified against a live platform**. SSH is experimental.

## Recent focus — foundations

Getting the base right so the project installs cleanly, behaves correctly, and is safe to run for a small group: `pip`-installable packaging, uniform enforcement of the player/keeper permission distinction across every command surface, character-sheet edit correctness, configurable (and honestly documented) content moderation, and a first real-model red-line evaluation. The unglamorous things that have to be right before breadth is worth adding.

## Near-term

- **Real-model red-line evaluation in CI.** The offline suite proves the deterministic machinery with a *scripted* Keeper (see [below](#offline-tests-vs-real-model-quality)); a real model's discretion needs its own measurement. A nightly job runs a real (cheap) model through the turn pipeline and gates on two metrics: **leak rate** (verbatim *and* paraphrase sentinels for keeper secrets) and **dice-first compliance** (a check that should have rolled, did). This is the only automated guardian of the two claims the whole project rests on.
- **Live-test one chat adapter end to end.** Pick one (QQ is the most complete) and drive it against the real platform until it genuinely works; keep the others marked experimental rather than implying they're done.

## The bigger arc — the world engine

The differentiator is a world *beneath* the adventure, not just a chat with dice. The long direction:

- **Deeper worldbook:** a generative world (not only keyword/vector-retrieved lore), a **living causal timeline** where events have consequences that propagate, and **canon consistency** so the Keeper can't contradict established facts.
- **Late-joiner catch-up:** a player who joins mid-campaign is caught up on what their character *would* know — without leaking what they wouldn't.
- **D&D Beyond sheet import**, alongside the existing SillyTavern-card path.
- **CI release artifacts** so a version is a downloadable, installable thing.

## An open design question — where do the Keeper's secrets live?

Today the Keeper's system prompt carries the module's keeper pool in (near) full, and keeper-only tools hand secrets back to the model verbatim; anti-metagaming on the Keeper side is therefore *discipline* (a "don't quote this to players" instruction) plus the deterministic keeper/player pool split — strong for the sub-actors (built only from their own record), softer for the Keeper itself.

An alternative is to keep secrets *out* of the base prompt and have the Keeper pull them on demand through tools, so the model only ever holds the specific secret it just reasoned about. That trades some prompt convenience and latency for a smaller leak surface. This is a real architectural fork worth deciding deliberately rather than drifting into — input welcome.

## Offline tests vs. real-model quality

Worth stating plainly, because green CI is easy to over-read: the offline suite is deterministic and uses a *scripted* Keeper. It rigorously proves the deterministic machinery — the keeper/player knowledge redaction, the sub-actor prompt isolation, real seeded dice, the command surface — and it will catch a regression in any of those. It **cannot** prove that a live model refrains from leaking a secret it is shown, or that it rolls before it narrates; those are model-behavior properties, and they are exactly what the near-term real-model evaluation exists to measure. Read "CI is green" as *the engine is correct*, not *the Keeper is good*.

## How to help

Pick anything above, or anything marked 🧪 in the [README](../README.md). Before a PR, `uv run ruff check …`, `uv run python scripts/i18n_lint.py`, and `uv run pytest -q` (plus the relevant `bun test`) must pass, and the iron rules in [CLAUDE.md](../CLAUDE.md) — no hardcoded user-facing strings, the deterministic-vs-generative split, and the information-isolation red lines — must hold.
