# Implemented: gateway/commands/ package, model-call lanes, adapters gate, core/ without the model

- **Problem:** a whole-repo review (2026-08-19) found the structural debt concentrated,
  not spread: `gateway/commands.py` at 4.1k lines held three unrelated subsystems in one
  class, every new verb opened it AND taught `gateway/turn.py` another command name;
  three `core/` modules held an `LLMClient` (so "core/ = deterministic" was true of the
  dice and false of the directory); iron rule #5's letter ("no other module may put text
  into the model's context") was wider than the architecture, which rightly has six
  callers; and the chat-adapter rejection was enforced by a markdown note alone.
- **Verdict (owner, same day):** split the commands file by domain; do the three cheap
  structural wins; the "1000-line file = blocker" rule is NOT repo policy (ruled twice
  that day) — file size is a symptom to read, not a gate. `agent/loop.py` is left alone
  on purpose: it is the most paid-for code in the repo (locks, retries, overflow recovery)
  and a split there buys readability at the risk of the turn; not now.
- **Shape:**
  - `gateway/commands/` — `types` (CommandSpec/CommandCtx/CommandReply), `router` (the
    spec table, alias resolution, dispatch, `.help`), and nine domain MIXINS composed
    into `CommandRouter` exactly the way `agent.kp_tools` composes tool providers:
    `checks` / `sheet` / `rules` / `rooms` / `cast` / `world` / `panels` / `media` / `llm`.
    Pure relocation: every handler body, helper and vocabulary constant kept its text;
    cross-module helpers became explicit imports (no cycles; `rooms` owns the privilege
    helpers everyone gates on). Tests monkeypatch a helper where it is DEFINED
    (`gateway.commands.llm.flow_for`), not on the package.
  - The turn pipeline no longer recognizes any command by name: `.room` declares
    `private_reply=True` (its reply carries the join key) and the last
    `canonical == "..."` clause in `gateway/turn.py` is gone.
  - `bot_enabled` has ONE reader, `gateway.ops.bot_setting` (tri-state) — the hub turn's
    `is_bot_enabled` (unset = on) and the runner's per-platform default both derive from
    it; `.bot on/off` writes through `set_bot_enabled`.
  - `module_initializer`, `document_manager`, `char_from_persona` moved to `agent/`.
  - `tests/architecture/test_model_call_lanes.py`: every `.chat()` call site names its lane
    (keeper / scoped-actor / memory / authoring / plumbing); the KEEPER lane is exactly
    `agent/loop.py` with exactly one assembler import (`agent.prompt_builder`); `core/`
    makes no model calls. Iron rule #5 in AGENTS.md now says this.
  - `tests/architecture/test_no_platform_adapters.py`: `adapters/` holds `cli/` only; no
    production module imports a platform SDK.
- **Rule home:** AGENTS.md (architecture bullets for `gateway/commands/`, `agent/`; iron
  rule #5); the two architecture tests; `gateway/commands/__init__.py` (where to patch).
- **Date:** 2026-08-19.
