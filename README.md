# Loreweaver

**A self-hosted AI Game Master / Keeper for tabletop RPGs — world & story first.**

Loreweaver runs a *game*, not a chat. It keeps a structured world (module, scenes, NPCs, clues, timeline, hidden truths), a deterministic rules engine (real dice, success levels, character sheets, a game clock, a persistent session log), and a function-calling **AI Keeper** that narrates, adjudicates, and runs NPCs on top of it — while a hard secrecy discipline keeps the plot's secrets out of players' view. Discord-first, system-agnostic (**D&D 5e SRD** + **Call of Cthulhu 7e**), English-first with runtime `en`/`zh` i18n.

[![CI](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml/badge.svg)](https://github.com/1A7432/loreweaver/actions/workflows/ci.yml) ![license](https://img.shields.io/badge/license-MIT-green) ![python](https://img.shields.io/badge/python-3.11%2B-blue) ![clients](https://img.shields.io/badge/clients-TypeScript%20%2F%20Bun-black) ![status](https://img.shields.io/badge/tests-511%20passing-brightgreen)

## Why it's different
Competitors are either **dice bots** (Avrae, SealDice, Dice Maiden — automation, no GM) or **persona-chat frontends** (SillyTavern — great characters, but no world, no causality, no rules). Loreweaver's wedge is the combination none of them have:

| | Real dice/rules | AI Game Master | Persistent world + story | Cross-platform table | AI party members |
|---|:---:|:---:|:---:|:---:|:---:|
| Dice bots | ✅ | ❌ | ❌ | ~ | ❌ |
| Persona-chat | ❌ | ~ | ❌ | ❌ | ~ |
| **Loreweaver** | ✅ | ✅ | ✅ | ✅ | ✅ |

## Highlights
- **AI Keeper via standard function-calling** — 60+ Keeper tools (dice, checks, sanity, character sheets, module knowledge, notes, session reports, initiative). Bring any OpenAI-compatible or native model.
- **Deterministic core, generative surface** — dice/`d20`, ported CoC success levels, character math, censorship and permissions are real code; narration/NPCs/flavor are the model. Checks roll *first*, then narrate.
- **One shared session, any platform** — a RoomHub lets a Discord player, a QQ player, and a terminal/web/SSH player sit at the **same live table**. Bind a channel to a room with `.room`.
- **Four terminal/web frontends** — a headless CLI, an [OpenTUI](https://opentui.com) terminal client, a **browser web app** (React), and **rich SSH** (`ssh you@host` → the full TUI, zero install), all speaking one open [WebSocket protocol](docs/protocol.md).
- **AI NPCs & AI party members** — knowledge-scoped sub-actors that **play fair**: they act on only what they'd actually know (never the keeper pool), so no metagaming by construction. Fill an empty seat with an AI companion that rolls real dice on its own sheet.
- **Import SillyTavern cards** — `import_character` parses a `.png`/`.json` character card, auto-generates a rule-legal sheet for the module's system, and drops it in as your PC or an AI companion; the card's `character_book` seeds the worldbook.
- **Two command dialects, one roller** — EN Avrae/d20 (`/roll 4d6kh3`, `[[1d20+5]]`, `adv/dis`) and CN SealDice (`.ra 侦查`, `困难/极难`, `b/p`, `.st 力量50`), plus native Discord/Telegram slash commands.
- **Multi-vendor LLMs** — one env var switches provider: `deepseek`, `groq`, `openrouter`, `together`, `ollama`, `lmstudio`, … (OpenAI-compatible presets) or native `anthropic` / `gemini`.

## Quickstart
```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e .            # add [anthropic,gemini] extras only if you use those native providers

# 1) Offline — no API key needed (bundled demo Keeper + deterministic dice):
python -m app --cli                     # REPL: try  r 3d6+2  /roll 4d6kh3  .ra 侦查  .setcoc 2
python -m app --cli --script tests/fixtures/selfplay_en.txt   # offline AI-KP self-play demo

# 2) Real AI Keeper — copy .env.example → .env and set your model:
#    TRPG_LLM__PROVIDER=deepseek   TRPG_LLM__API_KEY=sk-...   TRPG_LLM__CHAT_MODEL=deepseek-chat
python -m app --cli                     # natural-language turns now run a real Keeper
```
**Networked / multiplayer:** `scripts/tui_demo.sh` mints a key + starts the server and prints the connect line; then in another terminal `cd clients/tui && bun install && bun run dev -- connect --host ws://127.0.0.1:8787/ --key <key>`. Browser: `cd clients/web && bun install && bun run dev`. SSH: see `clients/ssh/README.md`. No registration — the deployer issues keys that bind players to a shared room.

## Play surfaces & systems
| Surface | Status | Notes |
|---|---|---|
| CLI (headless) | ✅ | dev / self-test / no-credential trial |
| Terminal (OpenTUI) | ✅ | local or networked; DF-16 theme, live dice ticker, HP/SAN bars |
| Browser (web) | ✅ | React + Vite, same protocol |
| SSH | ✅ | `ssh key@host` → full TUI, zero install, public-key auth |
| Discord | ✅ | flagship, slash-first |
| Telegram | ✅ | slash via setMyCommands |
| QQ (official bot) | ✅ | subscribes **`GROUP_MESSAGE_CREATE`** (full group messages) + per-group proactive mode |
| Feishu / Lark | ✅ | |

Systems: **D&D 5e SRD** and **CoC 7e** ship as data-driven rulepacks (`rulepacks/*.yaml`); add a system with no code. Live 4-platform bot connections need credentials (adapter tests are offline mocks).

## Architecture
```
core/  deterministic engine   infra/  store·config·i18n·llm·embeddings·vector·providers
agent/ AI-KP brain + tools     gateway/ platform-independent: commands·ops·hub·runner·director
net/   WebSocket server         adapters/ cli·discord·telegram·qq·feishu     clients/ protocol·tui·web·ssh
```
The engine scopes all state by a stable `chat_key`; the RoomHub adds live cross-transport broadcast. See **[CLAUDE.md](CLAUDE.md)** for the layer contracts, iron rules (deterministic-vs-generative, dice-first, information isolation), and how to add a rulepack / adapter / provider / tool / client. The client wire format is **[docs/protocol.md](docs/protocol.md)**.

## Testing
```bash
pytest -q                                   # ~511 offline tests (FakeLLM/FakeEmbeddings, seeded dice)
ruff check core infra agent gateway net adapters app.py scripts
python scripts/i18n_lint.py                 # no hardcoded natural-language strings
cd clients/<protocol|tui|web|ssh> && bun install && bun test   # (web: bun run test)
```
The self-play test drives the whole stack (upload → analyze → open → player action → **real seeded dice** check → report) and asserts the Keeper **never leaks** hidden module secrets. CI runs Python (3.12) + all four client packages.

## Contributing
PRs and issues welcome. Before opening a PR: `ruff check`, `python scripts/i18n_lint.py`, and `pytest -q` must pass (plus the relevant `bun test`). Keep the iron rules in [CLAUDE.md](CLAUDE.md) — especially **no hardcoded user-facing strings** (use `infra.i18n` + `locales/`) and the **information-isolation** red lines. Only open, freely-distributable rule content (SRD / Miskatonic) may be added; bring your own modules at runtime.

## Security
Never commit secrets — `.env`, issued keys, SSH host keys, and databases are git-ignored (only `*.example.*` are tracked). Deployer-issued keys bind players to rooms; there is no account system. Found a vulnerability? Please open a private security advisory on GitHub rather than a public issue.

## License & attribution
MIT — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Includes material from the **D&D 5e SRD 5.1** (CC-BY-4.0); Call of Cthulhu content is limited to open / Miskatonic Repository material. The gateway/adapter layer is derived from **hermes-agent** (MIT, © 2025 Nous Research); the dice engine is **avrae/d20** (MIT); the CN command dialect, COC success function and skill-alias tables are re-implemented from **SealDice** (MIT); the terminal client uses **OpenTUI**. No copyrighted adventure text ships with this repo.

## Roadmap
Worldbook depth (generative worlds · living causal timeline · canon consistency) · richer chat cards & late-joiner replay · character-sheet import from D&D Beyond · deck-draw tables · CI release artifacts.
