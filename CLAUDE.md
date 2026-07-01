# CLAUDE.md — contributor & AI-agent guide

Loreweaver is a self-hosted **AI Game Master / Keeper** for tabletop RPGs: a world/story-first engine (structured world + module + rules + persistent state), not a persona-chat frontend. Discord-first, system-agnostic (D&D 5e SRD + CoC 7e), English-first with runtime `en`/`zh` i18n, MIT. This file orients humans and AI coding agents working in the repo. (User-facing docs live in `README.md`; the open client protocol in `docs/protocol.md`.)

## Architecture (layers, each with one job)
- `core/` — **deterministic engine** (never AI-generated): `dice_engine` (on `d20`), `coc_rules` (ported `ResultCheckBase`), `character_manager`, `battle_report`, `game_clock`, `document_manager`, `module_initializer`, `prompt_sections`, `rulepacks`, `worldbook`, `charcard` (SillyTavern-card parser), `char_from_persona`.
- `infra/` — `store` (SQLite KV), `config` (pydantic-settings), `i18n`, `llm` (+`FakeLLM`), `embeddings` (+`FakeEmbeddings`), `vector`, `providers` (multi-vendor LLM factory).
- `agent/` — the AI-KP brain: `context` (`AgentCtx`), `tools` (`@tool` schema-gen), `kp_tools*` (the Keeper tools), `prompt_builder`, `loop` (function-calling loop), `services` (the wiring bundle), `npc`/`npc_actor`/`companion_actor` (knowledge-scoped actors).
- `gateway/` — platform-independent: `session`, `events`, `base_adapter`, `registry`, `runner`, `commands` (dual-dialect + slash), `ops` (rate-limit/censor/permissions), `hub` (the cross-transport RoomHub), `turn`, `member`, `rooms`, `render_chat`, `director`.
- `net/` — `tui_server` (WebSocket), `keystore`, `state`.
- `adapters/` — `cli`, `discord`, `telegram`, `qq_official`, `feishu`, `onebot`.
- `clients/` — TypeScript: `protocol` (shared), `tui` (OpenTUI terminal), `web` (React), `ssh` (ssh2 + Bun PTY). All speak `docs/protocol.md`.

## Iron rules / red lines (do not break)
1. **Deterministic vs generative split.** Dice, success levels, character math, random tables, permissions, censorship = real code. Narration / NPCs / flavor = the model. Never AI-ify the deterministic core.
2. **Dice-first.** A check rolls real dice, then narrates the outcome per the success level — never pre-write the result.
3. **Information isolation (anti-metagaming).** Keeper/module secrets, and each NPC/companion's private knowledge, are scoped by construction — the Keeper must never quote keeper-only material to players, and an NPC/companion actor is built from ONLY its own record + sheet (never the keeper pool). This is enforced by red-line tests; keep them green.
4. **English-first + i18n, no hardcoded natural language.** Identifiers/comments/commits in English. Every user-facing string goes through `infra.i18n` + `locales/{en,zh}/*.json`. `scripts/i18n_lint.py` gates this. (CJK game-DATA — skill names, aliases — is exempt, like the existing data modules.)
5. **Single prompt injection.** The 6 prompt sections + world-lore assemble into one system prompt via `agent/prompt_builder.py`.

## Develop / test / run
```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -e ".[dev,anthropic,gemini]"
pytest -q                      # offline: FakeLLM/FakeEmbeddings + seed_dice, no network/keys
ruff check core infra agent gateway net adapters app.py scripts
python scripts/i18n_lint.py    # NO ARGS (passing a path wrongly scans .venv)
python -m app --cli            # try it: r 3d6+2 / /roll 4d6kh3 / .ra 侦查 / .setcoc 2
# clients: cd clients/<protocol|tui|web|ssh> && bun install && bun test   (web: bun run test)
```
Tests are deterministic and offline. To run a real Keeper, set `TRPG_LLM__*` in `.env` (see `.env.example`).

## How to extend
- **Rule system** → add a `rulepacks/<system>.yaml` (five-part: defaults/defaultsComputed/alias/st.show/set.keys); no code change for data-driven parts.
- **Platform adapter** → subclass `gateway/base_adapter.py:BaseAdapter`, translate payloads → `InboundMessage`, register a `PlatformEntry` at import. Mock the transport in tests.
- **LLM provider** → most vendors work via the OpenAI-compatible path + a `PRESETS` entry in `infra/providers.py`; add a native class (see `AnthropicLLM`/`GeminiLLM`) only for non-OpenAI APIs.
- **KP tool** → an `async def name(self, ctx, ...) -> str` decorated `@tool` on a provider class; add the provider to `agent/kp_tools.build_kp_toolset`. Flag secret-reading tools `keeper_only=True`.
- **Client** → build against `docs/protocol.md` (the versioned WS protocol) + reuse `@trpg-kp/protocol` types.

## Working conventions for AI agents
- **Parallelize leaves, serialize the merge.** Independent new modules can be built + tested in isolation concurrently; the wiring into shared files (`build_kp_toolset`, `services`, `commands`, `prompt_builder`) is one careful sequential pass.
- **Scope your test runs.** When others may be editing concurrently, run only your module's tests, not the whole suite.
- **NEVER foreground a blocking server** (`python -m app --serve`, a dev server) — it hangs. Verify via tests (they spin up ephemeral in-process servers); background + `timeout` + `kill` if you truly must.
- **After any change:** `ruff check` + `python scripts/i18n_lint.py` + `pytest -q` (and the relevant `bun test`) must all pass.
