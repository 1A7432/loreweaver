# Loreweaver

**An open-source AI Game Master. You bring the players — it runs the game.**

*[中文](README.md) · English*

Every group has players; almost no group has someone who wants to *run* the game. That's the seat Loreweaver fills: it reads the module, remembers the world, plays every NPC, and keeps the secrets. You sit down and say what you do.

The difference from "chatting with an AI" is simple: **the dice are real.** Checks, damage, sanity — rolled by code, resolved by the rules. The AI turns outcomes into story. It can invent atmosphere; it can't invent numbers.

Call of Cthulhu 7e and D&D 5e (SRD), English and Chinese, with the server running on your own machine.

[![CI](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml/badge.svg)](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml) ![license](https://img.shields.io/badge/license-MIT-green) ![python](https://img.shields.io/badge/python-3.11%2B-blue) ![clients](https://img.shields.io/badge/clients-TypeScript%20%2F%20Bun-black)

> **Honestly:** this is a young project, built mostly by one person with AI help. The dice-and-rules core is the solid part — a full offline test suite watches it — and the terminal client is comfortable now. Networked multiplayer and Keeper quality on real models are still being polished; the [roadmap](docs/roadmap.md) says plainly what works and what doesn't.

## Why it's different

Today's tools come in two kinds. Dice bots (Avrae, SealDice): great dice, nobody runs the game. Roleplay chat (SillyTavern): great characters, but no rules, no world, and you can never fail. Loreweaver fills in what both are missing:

| | Real dice/rules | AI Game Master | Persistent world + story | AI party members |
|---|:---:|:---:|:---:|:---:|
| Dice bots | ✅ | ❌ | ❌ | ❌ |
| Persona-chat | ❌ | ~ | ❌ | ~ |
| **Loreweaver** | ✅ | ✅ | ✅ | ✅ |

Fair warning: how well the AI runs a table depends a lot on the model you plug in. A good one rolls honestly and follows the module; a cheap one likes to talk instead of roll. See [Quickstart](#quickstart) for advice.

## How you play

One command drops you in a game lobby — no config files:

![The Loreweaver TUI — a real screenshot: Keeper narration, a dice check, the party roster](assets/tui-en.png)

- **Four ways to build a character** — roll it, fill it in by hand (the UI stops you when you're over budget), describe your character in a sentence and let the AI draft the sheet, or drop in a SillyTavern card. Whichever way, the rules get the last word — an illegal stat doesn't go through, no matter what the AI says.
- **Keyboard and mouse both work.** A spinner shows while the Keeper thinks, so you're never staring at a frozen screen; the top bar carries the scene, in-game time, real time and token spend; if you drop, the client reconnects on its own.
- Minting invites, swapping models and importing modules are the Keeper's business — those pages only appear when you connect with a keeper key.

## Host a game for your friends

You run the server on your own computer and send out a ticket + invite keys. Friends install a client and they're in. No domain, no certificates, no port forwarding.

**① You (the Keeper) — start the server**
```bash
python -m app --serve   # prints a p2p ticket + a keeper key (also saved to iroh-ticket.txt / keeper-key.txt)
```
Then run `loreweaver` and paste the ticket + keeper key on the connect screen.

**② Make a room, send out invites**
Main menu → **Rooms & invites** → room name + friend's name → mint a key and send it over. Naming a room *is* creating it; mint a keeper-role key if you want a co-GM.

**③ Your friends — install and join**
```bash
curl -fsSL https://1a7432.site/trpg/install.sh | bash   # Windows: irm https://1a7432.site/trpg/install.ps1 | iex
loreweaver     # paste the ticket + their invite key, pick a nickname
```
No sign-ups. The invite key is the whole ceremony.

> The ticket lives on the server and survives restarts — share it once, it keeps working. Dropped clients reconnect on their own. Images and audio will ride the same p2p channel later ([roadmap](docs/roadmap.md)); protocol details in [docs/protocol.md](docs/protocol.md).

## Highlights

- **The AI actually runs the game — it doesn't just talk about it.** Rolling dice, checking sheets, taking notes, advancing the clock: all real engine operations, 60+ Keeper tools in total. Bring any OpenAI-compatible or native model; `deepseek-v4-pro` with thinking on is the recommended default.
- **NPCs can't peek at the script.** Every NPC and AI party member knows only what it should — the plot's secrets are simply out of their reach, so they couldn't spoil it if they tried. Short a player? An AI companion takes the seat, with its own sheet and its own dice.
- **Ask for it in plain words.** A new rule system, a new play style, a new module — describe it on the management page and the Keeper writes it, checks it, and installs it on the spot. Everything it produces is a standard format (SillyTavern cards, lorebooks, SKILL.md, YAML rule packs), so your existing collection moves right in. Details in [docs/plugins.md](docs/plugins.md).
- **Romance has a ledger too.** With the romance skill on, affection and desire are actual numbers — kept by code, not by the AI's mood.
- **Both command dialects work** — Chinese SealDice style (`.ra 侦查`, `.st 力量50`) and English Avrae style (`/roll 4d6kh3`, `adv/dis`), one dice engine underneath.
- **Content filtering is off by default.** Your table, your rules. If you do turn it on, it screens only the Keeper's output, never player input ([docs](docs/deploy.md#content-moderation)).

## Quickstart
```bash
uv sync                                  # create the env + install deps

# Offline taste first — no API key (bundled demo Keeper + real dice):
uv run python -m app --cli               # try  r 3d6+2 · /roll 4d6kh3 · .ra 侦查 · .setcoc 2

# A real Keeper: copy .env.example to .env, set your model, run again:
uv run python -m app --cli
# (no uv? python3 -m venv .venv && . .venv/bin/activate && pip install -e ".[dev,anthropic,gemini]")
```
`.env` looks like this (DeepSeek shown; any OpenAI-compatible or native provider works):
```
TRPG_LLM__PROVIDER=deepseek   TRPG_LLM__API_KEY=sk-…
TRPG_LLM__CHAT_MODEL=deepseek-v4-pro   TRPG_LLM__REASONING_EFFORT=max
```
> **Don't cheap out on the model.** The Keeper works by calling tools: a strong model (deepseek-v4-pro with thinking, GPT-4-class, Claude) really rolls and follows the module; a bargain model tends to *say* "you succeed" without rolling, and to wander off the plot. Switch live in-game with `.model set <provider> [model]` — no restart.

**The terminal UI (the real experience):**
```bash
uv run python -m app --serve   # start the p2p server — prints a ticket + a keeper key
# in another terminal:
cd clients/tui && bun install && bun run dev
```
Paste the ticket + key into the connect screen. Or skip all of it: click **Host locally** on the connect screen and it does the above for you.

**One-line install for players (no clone, no build):**
```bash
curl -fsSL https://raw.githubusercontent.com/1A7432/loreweaver/main/clients/install.sh | bash   # Windows: irm https://raw.githubusercontent.com/1A7432/loreweaver/main/clients/install.ps1 | iex
loreweaver          # launch, paste the ticket + invite key your Keeper sent you
loreweaver update   # self-update the client
```

### Run an always-on server (optional)
Most tables are hosted p2p from a laptop (above). For a 24/7 game, pick any box:
```bash
uv sync && uv run python -m app --serve   # keep it up with systemd — see docs/deploy.md
```
First run creates `.env` and mints a keeper key (printed, and saved to `keeper-key.txt`). Connect with it; minting keys and creating rooms all happen in the client afterwards. State (SQLite + keys) lives next to the process. Full guide in **[docs/deploy.md](docs/deploy.md)**.

## Play surfaces
| Surface | Status |
|---|---|
| **Terminal — OpenTUI** | ✅ **primary** — the game-style lobby above; local or networked p2p (Iroh) |
| CLI (headless) | ✅ dev / quick trial / offline demo |

Systems: **D&D 5e SRD** and **CoC 7e** ship as data-driven rulepacks (`rulepacks/*.yaml`) — add a system with no code change. (Chat-platform adapters — Discord/Telegram/QQ/Feishu — exist in-tree but are unmaintained and untested against live platforms; see the [roadmap](docs/roadmap.md).)

## Architecture
```
core/  deterministic engine   infra/  store · config · i18n · llm · embeddings · vector · providers
agent/ AI-Keeper brain + tools gateway/ platform-independent: commands · ops · hub · runner · director
net/   Iroh p2p + session core  adapters/ cli (chat adapters in-tree, unmaintained)   clients/ protocol · tui
```
The engine scopes all state by a stable `chat_key`; the RoomHub adds live cross-transport broadcast. See **[CLAUDE.md](CLAUDE.md)** for the layer contracts, the iron rules (deterministic-vs-generative, dice-first, information isolation), and how to add a rulepack / adapter / provider / tool / client. The client wire format is **[docs/protocol.md](docs/protocol.md)**.

## Testing
```bash
uv run pytest -q                            # offline: FakeLLM + seeded dice, no network/keys
uv run ruff check core infra agent gateway net adapters app.py scripts
uv run python scripts/i18n_lint.py          # no hardcoded user-facing strings
cd clients/tui && bun install && bun test   # clients (protocol · tui)
```
Tests are deterministic and offline. A self-play test drives the whole pipeline with a scripted Keeper (upload → analyze → open the table → player action → real seeded dice → session report), and the hard guarantees — secrets never enter the player pool, an NPC is assembled only from its own record — each have dedicated red-line tests.

Offline tests prove the pipeline; whether a *live* model behaves is measured separately, by a nightly real-model check (`.github/workflows/redline-eval.yml`): a cheap real model scores every turn, and the run fails loudly if the leak rate or the "narrated a check without rolling" rate crosses a threshold. Schedule-only, never blocks a PR; skips cleanly when no `EVAL_LLM_API_KEY` is configured. CI (push/PR) runs Python 3.11/3.12 + the client packages, fully offline.

## Contributing
PRs and issues welcome. Before a PR, get these green: `uv run ruff check …`, `uv run python scripts/i18n_lint.py`, `uv run pytest -q` (and the relevant `bun test`). Keep the iron rules in [CLAUDE.md](CLAUDE.md) — especially: user-facing text goes through i18n, and the information-isolation lines don't break. Only open, freely-distributable rule content (SRD / Miskatonic) may be added; bring your own modules at runtime. The **[roadmap](docs/roadmap.md)** lists where help is most useful.

## Security
Never commit secrets — `.env`, issued keys, SSH host keys, and databases are git-ignored (only `*.example.*` are tracked).

There is no account system: an invite key is a bearer pass that binds a player to a room, with a player or keeper role. Past a trusted circle, put your own authentication and TLS in front rather than facing the open internet — standard hygiene for anything self-hosted.

Found a vulnerability? Please open a private GitHub security advisory rather than a public issue.

## License & attribution
MIT — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Includes **D&D 5e SRD 5.1** material (CC-BY-4.0); Call of Cthulhu content is limited to open / Miskatonic Repository material. The gateway/adapter layer derives from **hermes-agent** (MIT, © 2025 Nous Research); the dice engine is **avrae/d20** (MIT); the CN command dialect, CoC success function, and skill-alias tables are re-implemented from **SealDice** (MIT); the terminal client uses **OpenTUI**. No copyrighted adventure text ships with this repo.

## Roadmap
See **[docs/roadmap.md](docs/roadmap.md)** for the full plan. Further out: a world engine that grows (generative world, a living causal timeline, canon consistency), catch-up for late joiners, D&D Beyond sheet import, and live end-to-end testing of the chat adapters.
