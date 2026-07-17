# AGENTS.md — contributor & AI-agent guide

Loreweaver is a self-hosted **AI Game Master / Keeper** for tabletop RPGs: a world/story-first engine (structured world + module + rules + persistent state), not a persona-chat frontend. Terminal-first over Iroh p2p, system-agnostic (D&D 5e SRD + CoC 7e), English-first with runtime `en`/`zh` i18n, MIT. This file orients humans and AI coding agents working in the repo — it is the single source of truth (CLAUDE.md just imports it). User-facing docs live in `README.md`; the open client protocol in `docs/protocol.md`; the extensibility contract in `docs/plugins.md`.

## Architecture (layers, each with one job)
- `core/` — **deterministic engine** (never AI-generated): `dice_engine` (on `d20`), `coc_rules` (ported `ResultCheckBase`), `character_manager`, `character_rules` (creation validation), `battle_report`, `game_clock`, `document_manager`, `module_initializer`, `prompt_sections`, `rulepacks` (data-driven rule systems), `skills` (SKILL.md loader), `relationships` (deterministic affection/desire tracks), `worldbook`, `charcard` (SillyTavern-card parser), `char_from_persona`.
- `infra/` — `store` (SQLite KV), `config` (pydantic-settings), `runtime_config` (hot overrides + credential book), `i18n`, `llm` (+`FakeLLM`, `Usage`/`parse_usage`), `embeddings` (+`FakeEmbeddings`), `vector`, `providers` (multi-vendor LLM factory).
- `agent/` — the AI-KP brain: `context` (`AgentCtx`), `tools` (`@tool` schema-gen + gating), `kp_tools*` (the Keeper tools), `forge` (self-extension generators: skill/rulepack/module from a description), `prompt_builder`, `loop` (function-calling loop), `services` (the wiring bundle), `npc`/`npc_actor`/`companion_actor` (knowledge-scoped actors).
- `gateway/` — platform-independent: `session`, `events`, `base_adapter`, `registry`, `runner`, `commands` (dual-dialect + slash), `ops` (rate-limit/censor/permissions), `hub` (the cross-transport RoomHub), `turn`, `member`, `rooms`, `render_chat`, `director`.
- `net/` — `session` (transport-agnostic SessionCore), `iroh_server` (p2p QUIC, the DEFAULT carrier), `tui_server` (WebSocket, offline-test/loopback only), `keystore`, `state`, `admin`, `room_backup`.
- `adapters/` — `cli` (maintained); `discord`, `qq_official`, `telegram`, `feishu`, and `onebot` are mock-tested **Experimental** adapters pending live-platform acceptance. OpenTUI remains the primary client.
- `clients/` — TypeScript: `protocol` (shared types + `WsClient`), `tui` (OpenTUI terminal — the primary client; `IrohClient` and the one-click host live here). Both speak `docs/protocol.md`.

## Iron rules / red lines (do not break)
1. **Deterministic vs generative split.** Dice, success levels, character math, random tables, permissions, censorship = real code. Narration / NPCs / flavor = the model. Never AI-ify the deterministic core.
2. **Dice-first.** A check rolls real dice, then narrates the outcome per the success level — never pre-write the result.
3. **Information isolation (anti-metagaming).** Player knowledge and each NPC/companion's private knowledge are scoped by construction: an NPC/companion actor is built from ONLY its own record + sheet (never the keeper pool). The main Keeper currently receives near-full module secrets so it can run the mystery; its instruction never to quote keeper-only material is a behavioral constraint measured by live-model evals, not a structural guarantee. Both the structural tests and behavioral gates are red lines; keep them green.
4. **English-first + i18n, no hardcoded natural language.** Identifiers/comments/commits in English. Every user-facing string goes through `infra.i18n` + `locales/{en,zh}/*.json` (client-side: the typed `tt()`/`messages` dict in `clients/tui/src/i18n.ts`, both languages). `scripts/i18n_lint.py` gates this. (CJK game-DATA — skill names, aliases — is exempt, like the existing data modules.)
5. **Single prompt injection.** The 6 prompt sections + world-lore assemble into one system prompt via `agent/prompt_builder.py`.

## Develop / test / run
```bash
uv sync --extra anthropic --extra gemini   # env + deps; the `dev` group (pytest/ruff) installs by default. (pip fallback: python3 -m venv .venv && . .venv/bin/activate && pip install -e ".[dev,anthropic,gemini]")
uv sync --extra discord --extra telegram --extra feishu  # optional SDK-backed Experimental adapters; QQ/OneBot use core deps
uv run pytest -q               # offline: FakeLLM/FakeEmbeddings + seed_dice, no network/keys
uv run ruff check core infra agent gateway net adapters app.py scripts
uv run python scripts/i18n_lint.py    # NO ARGS (passing a path wrongly scans .venv)
uv run python -m app --cli     # try it: r 3d6+2 / /roll 4d6kh3 / .ra 侦查 / .setcoc 2
uv run python -m app --doctor  # sanity-check locales/rulepacks/skills discovery
# clients: cd clients/<protocol|tui> && bun install && bun test
```
Tests are deterministic and offline. To run a real Keeper, set `TRPG_LLM__*` in `.env` (see `.env.example`).

## How to extend
- **Rule system** → add a `rulepacks/<system>.yaml` (defaults/derived/alias/st_show/set_keys + optional per-locale `display` names); no code change for data-driven parts.
- **KP skill** → a `skills/<id>/SKILL.md` (Claude-Code shape: YAML frontmatter `name`/`description`/`allowed-tools` + Markdown body); per-room enable via `.skill enable <id>`.
- **Platform adapter** → subclass `gateway/base_adapter.py:BaseAdapter`, translate payloads → `InboundMessage`, register a `PlatformEntry` at import. Mock the transport in tests.
- **LLM provider** → most vendors work via the OpenAI-compatible path + a `PRESETS` entry in `infra/providers.py`; add a native class (see `AnthropicLLM`/`GeminiLLM`) only for non-OpenAI APIs.
- **KP tool** → an `async def name(self, ctx, ...) -> str` decorated `@tool` on a provider class; add the provider to `agent/kp_tools.build_kp_toolset`. Flag secret-reading tools `keeper_only=True`; flag skill-unlocked tools `gated=True`.
- **Client** → build against `docs/protocol.md` (the versioned WS/Iroh protocol) + reuse `@loreweaver/protocol` types.

## Working conventions for AI agents
- **Parallelize leaves, serialize the merge.** Independent new modules can be built + tested in isolation concurrently; the wiring into shared files (`build_kp_toolset`, `services`, `commands`, `prompt_builder`) is one careful sequential pass.
- **Scope your test runs.** When others may be editing concurrently, run only your module's tests, not the whole suite.
- **NEVER foreground a blocking server** (`python -m app --serve`, a dev server) — it hangs. Verify via tests (they spin up ephemeral in-process servers); background + `timeout` + `kill` if you truly must.
- **After any change:** `uv run ruff check` + `uv run python scripts/i18n_lint.py` + `uv run pytest -q` (and the relevant `bun test`) must all pass.
