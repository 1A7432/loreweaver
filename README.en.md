# Loreweaver

**A self-hosted, terminal-first AI Game Master for tabletop RPGs — world & story first.**

*[中文](README.md) · English*

Loreweaver runs a *game*, not a chat. Beneath the AI **Keeper** sits a real engine: a structured world (module, scenes, NPCs, clues, timeline, hidden truths), a deterministic rules core (real dice, success levels, rule-validated character sheets, a game clock, persistent session history), and a hard secrecy discipline that keeps the plot's secrets out of players' view. The Keeper narrates, adjudicates, and voices NPCs on top of that — but it never invents the dice.

You play it in a **game-style terminal UI**: one command drops you into a lobby — connect, build a character, sit down at the table. System-agnostic (**D&D 5e SRD** + **Call of Cthulhu 7e**), English + 中文 at runtime.

[![CI](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml/badge.svg)](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml) ![license](https://img.shields.io/badge/license-MIT-green) ![python](https://img.shields.io/badge/python-3.11%2B-blue) ![clients](https://img.shields.io/badge/clients-TypeScript%20%2F%20Bun-black)

> **Status — early & honest.** Loreweaver is young and built largely by one person with AI assistance. The deterministic engine (dice, rules, character math) and its offline test suite are solid, and the terminal client is the polished path. Networked multiplayer, the chat-platform adapters, and real-model Keeper quality are actively maturing — see the **[roadmap](docs/roadmap.md)** for what's ready and what isn't.

## Why it's different
Most tools are either **dice bots** (Avrae, SealDice — automation, no GM) or **persona-chat frontends** (SillyTavern — great characters, but no world, no causality, no rules). Loreweaver is the combination none of them have:

| | Real dice/rules | AI Game Master | Persistent world + story | AI party members |
|---|:---:|:---:|:---:|:---:|
| Dice bots | ✅ | ❌ | ❌ | ❌ |
| Persona-chat | ❌ | ~ | ❌ | ~ |
| **Loreweaver** | ✅ | ✅ | ✅ | ✅ |

The bet is that a real dice/rules core plus a knowledge-scoped model can *run* a module the way a human Keeper would. How well that bet pays off depends heavily on the model you bring (see [Model choice](#quickstart)) — that's the honest trade of a system-agnostic, bring-your-own-LLM design.

## How you play — the terminal lobby
Run one command and you land in a game menu, not a config file:

![The Loreweaver TUI — a real screenshot: Keeper narration, a dice check, the party roster](assets/tui-en.png)

- **Build a character four ways** — roll on the rulepack's formula, set stats by hand (with a live point-buy / skill-point budget), describe your character in prose and let the AI draft the sheet, or import a SillyTavern card. **Every path is checked against the rule system**: out-of-range or over-budget values are clamped by deterministic code, never left to the AI's word.
- **Keyboard *and* mouse**, a die-face cursor, a live "Keeper is thinking" spinner (so you can tell it's working, not frozen), and a party roster that folds open to full sheets.
- Keeper-only tools — mint invite keys, hot-swap the model, import a module — appear only when you connect with a keeper key.

Real dice, a persistent story, no browser needed. (There's a React web client too, and chat-platform adapters — see [Play surfaces](#play-surfaces).)

## Host a game for your friends (self-host, 3 steps)

The real way to play: you **self-host** and hand out a ticket + invite keys. **Your friends only install the client — no docs to read.** The default is **Iroh p2p (recommended)**: run one command on **your own machine** and friends dial in — **no domain, no TLS, no port-forward**.

**① You (host / Keeper) — start the server + grab your ticket & key**
```bash
python -m app --serve   # prints a p2p ticket (endpoint…) + the keeper key auto-minted on first boot
                        # (also written to iroh-ticket.txt / keeper-key.txt)
```
Run `loreweaver`; in the connect screen's **Ticket / host** field paste that ticket + the keeper key + a nickname.

**② You — create a room + mint one key per friend**
Main menu → **Rooms & invites** → enter a **room name + friend's name + role (player)** → mint a key and send it. ("Creating a room" is just minting a key for a new room name — no server access; mint a `keeper`-role key for a co-Keeper.)

**③ Friend (player) — one-line install + connect**
```bash
curl -fsSL https://1a7432.site/trpg/install.sh | bash   # Windows: irm https://1a7432.site/trpg/install.ps1 | iex
loreweaver     # connect screen: paste the ticket + the invite key you gave them + a nickname
```
Same table, sit down, play. No accounts — the invite key is the ticket in.

> **Transports**: **Iroh** (default · p2p · zero-config · **rich media (images/audio) rides this one only**, roadmap) vs **WebSocket** (`python -m app --serve --ws`, for domain+TLS always-on deployments and the **browser web client**; **text-only, no multimedia**). With a VPS, `--serve --ws` runs both; the web client is WS-only. Same protocol, different carrier — see [docs/protocol.md](docs/protocol.md).

## Highlights
- **AI Keeper via standard function-calling** — 60+ Keeper tools (dice, checks, sanity, sheets, module knowledge, notes, session reports, initiative). Bring any OpenAI-compatible or native model; the recommended default is **`deepseek-v4-pro` with thinking on**.
- **Deterministic core, generative surface** — dice/`d20`, CoC success levels, character math, **character-creation rule validation**, the content-censor matcher and permissions are real code; narration and NPCs are the model. A check rolls *first*, then the Keeper narrates the graded result. (The censor ships with an empty wordlist — **moderation is OFF by default** and, once configured, only screens the Keeper's own replies, not player input — see [Content moderation](docs/deploy.md#content-moderation).)
- **Rule-validated characters** — manual, rolled, AI-drafted, or imported, a sheet is always clamped to the rulepack's ranges and point budgets by deterministic code (`core/character_rules.py`) — the AI only proposes.
- **AI NPCs & AI party members** — knowledge-scoped sub-actors that play fair: each acts *only* on what it would actually know, built by construction from its own record and never the keeper's secret pool, so those actors can't metagame. Fill an empty seat with an AI companion that rolls its own dice.
- **One shared session, cross-transport** — a RoomHub can seat terminal and web players (and, once live-tested, chat-platform players) at the *same live table*.
- **Two command dialects, one roller** — EN Avrae/d20 (`/roll 4d6kh3`, `[[1d20+5]]`, `adv/dis`) and CN SealDice (`.ra 侦查`, `困难/极难`, `.st 力量50`).
- **Multi-vendor LLMs** — one env var switches provider: `deepseek`, `groq`, `openrouter`, `together`, `ollama`, `lmstudio`, … (OpenAI-compatible), `chatgpt` / `gpt-subscription` via an OpenAI-compatible proxy, or native `anthropic` / `gemini`.

## Quickstart
```bash
uv sync                                  # create .venv + install deps (dev tools included)

# Fastest look — offline, no API key (bundled demo Keeper + real seeded dice):
uv run python -m app --cli               # try  r 3d6+2 · /roll 4d6kh3 · .ra 侦查 · .setcoc 2

# A real Keeper — copy .env.example → .env and set your model, then:
uv run python -m app --cli               # natural-language turns now run a real Keeper
# (no uv? python3 -m venv .venv && . .venv/bin/activate && pip install -e ".[dev,anthropic,gemini]")
```
`.env` for a real Keeper (DeepSeek shown; any OpenAI-compatible or native provider works):
```
TRPG_LLM__PROVIDER=deepseek   TRPG_LLM__API_KEY=sk-…
TRPG_LLM__CHAT_MODEL=deepseek-v4-pro   TRPG_LLM__REASONING_EFFORT=max
```
> **Model choice matters.** The Keeper leans hard on tool-calling and instruction-following. A capable model (deepseek-v4-pro with thinking, a GPT-4-class model, or Claude) resolves checks with real dice via the tools and stays faithful to the module; a small/cheap model tends to narrate a check's outcome *without* rolling and to drift off-module. Switch live with `.model set <provider> [model]` — no restart.

**Play in the terminal UI (the real experience):**
```bash
uv run python -m app --tui-key add --room table --name me   # mint an invite key (copy it)
uv run python -m app --serve                                 # start the WebSocket server (:8787)
# in another terminal — the client opens on the connect screen:
cd clients/tui && bun install && bun run dev
```
Browser client instead: `cd clients/web && bun install && bun run dev`. No accounts — the host issues keys that bind players to a shared room.

**One-line install for players (no clone/build).** Installs `bun`, fetches the client, and drops a `loreweaver` launcher — one command:
```bash
curl -fsSL https://raw.githubusercontent.com/1A7432/loreweaver/main/clients/install.sh | bash   # Windows: irm https://raw.githubusercontent.com/1A7432/loreweaver/main/clients/install.ps1 | iex
loreweaver          # launch → in the connect screen, enter your Keeper's wss://… host + invite key
loreweaver update   # self-update to the latest client
```
Or host the built web client (`cd clients/web && VITE_WS_URL=wss://<your-host>/ws bun run build --base=/play/`) behind your reverse proxy for a zero-install browser table.

### Deploy (self-host)
```bash
./scripts/deploy.sh                 # Docker: docker compose up -d --build
./scripts/deploy.sh --bare-metal    # no Docker: venv + install + run
```
First run creates `.env` from `.env.example`. **The server auto-mints a keeper key on first boot** — grab it from `docker logs loreweaver` or `/data/keeper-key.txt`, connect with it, then mint more keys (and create rooms) right in the client's *Rooms & invites* screen — no server access needed. State (SQLite + keys) lives in the `/data` volume. Full guide — config, keys, persistence, reverse-proxy/TLS — in **[docs/deploy.md](docs/deploy.md)**.

## Play surfaces
| Surface | Status |
|---|---|
| **Terminal — OpenTUI** | ✅ **primary** — the game-style lobby above; local or networked |
| CLI (headless) | ✅ dev / quick trial / offline demo |
| Browser (web, React) | ✅ same open [WebSocket protocol](docs/protocol.md) |
| Discord · Telegram · QQ · Feishu | 🧪 adapters implemented, offline-unit-tested — **live bot connections not yet verified** |
| SSH | 🧪 experimental (not a current focus) |

Systems: **D&D 5e SRD** and **CoC 7e** ship as data-driven rulepacks (`rulepacks/*.yaml`) — add a system with no code change.

## Architecture
```
core/  deterministic engine   infra/  store · config · i18n · llm · embeddings · vector · providers
agent/ AI-Keeper brain + tools gateway/ platform-independent: commands · ops · hub · runner · director
net/   WebSocket server         adapters/ cli · discord · telegram · qq · feishu   clients/ protocol · tui · web · ssh
```
The engine scopes all state by a stable `chat_key`; the RoomHub adds live cross-transport broadcast. See **[CLAUDE.md](CLAUDE.md)** for the layer contracts, the iron rules (deterministic-vs-generative, dice-first, information isolation), and how to add a rulepack / adapter / provider / tool / client. The client wire format is **[docs/protocol.md](docs/protocol.md)**.

## Testing
```bash
uv run pytest -q                            # offline: FakeLLM/FakeEmbeddings + seeded dice, no network/keys
uv run ruff check core infra agent gateway net adapters app.py scripts
uv run python scripts/i18n_lint.py          # no hardcoded natural-language strings
cd clients/tui && bun install && bun test   # (clients: protocol · tui · web)
```
Tests are deterministic and offline. The self-play test drives the whole stack (upload → analyze → open → player action → **real seeded dice** check → report) with a **scripted** Keeper, and directly unit-tests the deterministic guarantees: the keeper/player knowledge split (secrets are stripped from the player pool *by construction*), sub-actor isolation (an NPC/companion prompt is assembled *only* from its own record), and real seeded dice. Because the offline Keeper is scripted, this proves the **pipeline and the de-identification are correct — it cannot prove a live model actually exercises good discretion**. That's measured separately by a **nightly real-model red-line gate** (`.github/workflows/redline-eval.yml`, schedule-only, never blocks a PR): it runs `scripts/playtest.py` and `scripts/longrun.py` in `--gate` mode against a cheap real model, scores every turn for leak rate (literal *and* paraphrase) and dice-first miss rate, and fails loudly — exit non-zero + an uploaded log artifact — if either exceeds a configurable threshold; it skips cleanly (not red) if no `EVAL_LLM_API_KEY` secret is configured. See [docs/roadmap.md](docs/roadmap.md) for more. CI (push/PR) runs Python (3.11 · 3.12) + the client packages and stays fully offline — no real-model calls happen there.

## Contributing
PRs and issues welcome. Before a PR, all of `uv run ruff check …`, `uv run python scripts/i18n_lint.py`, `uv run pytest -q` (and the relevant `bun test`) must pass. Keep the iron rules in [CLAUDE.md](CLAUDE.md) — especially **no hardcoded user-facing strings** (route through `infra.i18n` + `locales/`) and the **information-isolation** red lines. Only open, freely-distributable rule content (SRD / Miskatonic) may be added; bring your own modules at runtime. The **[roadmap](docs/roadmap.md)** lists where help is most useful.

## Security
Never commit secrets — `.env`, issued keys, SSH host keys, and databases are git-ignored (only `*.example.*` are tracked). Host-issued keys bind players to rooms; there is no account system.

There is no account system: keys are bearer tokens that bind a player to a room with a player or keeper role. For anything past a trusted group, run the server behind your own authentication and TLS (a reverse proxy) rather than open to the public internet — standard hygiene for any self-hosted service.

Found a vulnerability? Please open a private GitHub security advisory rather than a public issue.

## License & attribution
MIT — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Includes **D&D 5e SRD 5.1** material (CC-BY-4.0); Call of Cthulhu content is limited to open / Miskatonic Repository material. The gateway/adapter layer derives from **hermes-agent** (MIT, © 2025 Nous Research); the dice engine is **avrae/d20** (MIT); the CN command dialect, CoC success function, and skill-alias tables are re-implemented from **SealDice** (MIT); the terminal client uses **OpenTUI**. No copyrighted adventure text ships with this repo.

## Roadmap
See **[docs/roadmap.md](docs/roadmap.md)** for the full plan. The longer arc grows the world engine (generative world · living causal timeline · canon consistency), adds late-joiner catch-up and D&D Beyond sheet import, and live-tests the chat adapters end to end.
