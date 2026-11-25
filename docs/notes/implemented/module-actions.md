# Implemented: module actions — hooks answer the Keeper within the turn

- **Problem:** a hook could not answer the Keeper inside a turn. `dice_rolled` and the
  other reply-phase events fire after the narration is final, so the Keeper narrated
  numbers the hook had not booked yet — the open item "Not fixed here" in
  [scribe-writes-answer-to-hook-veto.md](scribe-writes-answer-to-hook-veto.md) (the
  《安土》 crossing ledger: hook booked 475, Keeper said 450). The rulepack script-flow
  lane takes no arguments and cannot read or write room state, so it was no substitute.
- **Verdict (owner):** hook scripts register `defineAction(name, spec, handler)`; the room's
  actions reach the Keeper as ONE dynamic tool, `module_action(action, args)`, offered only
  when the turn's hook engine has ≥ 1 action and dispatched after the `tool_use` veto. Per
  call the engine refreshes the variable and private-state views from the store, pre-rolls
  the declared dice with the real dice engine, runs the handler, and applies its effects at
  once through the existing hook paths (`setvar` joins the turn's `hook_writes`); the return
  value is the tool result. A failed handler applies nothing. Every dispatch also gains
  `event.seed`, derived from persisted inputs like `turn_rng`. Caps live in `core/hooks.py`.
  This closes the scribe-veto note's open item: a pack books the hour in an action and the
  Keeper narrates the booked line.
- **Reason:** iron rules #1 and #2 hold unchanged — the hook still only requests effects
  that deterministic code validates and applies, and the dice are the engine's, rolled
  before the handler runs. Replayability, stated against the code rather than assumed: the
  live loop persists only the player line and the final reply (`agent.history`), never the
  in-turn tool chatter, so an action's result — like every tool result — is not part of
  persisted history and is outside `tests/architecture/test_prompt_replayability.py`'s
  scope (that contract covers the prompt assembler, which this does not touch). The result
  is a pure function of the store at call time, `args`, `event.seed` (persisted inputs
  only) and the engine's dice; the dice are the one non-replayable input, exactly as for
  every other dice tool.
- **Rule home:** `core/hooks.py` (module docstring, `MAX_ACTION*`, `HookEngine.run_action`,
  `hook_seed`), `agent/hook_actions.py` (tool schema, dispatch, per-turn effects),
  `agent/loop.py` (`_dispatch_one`, the drain before the reply phases); author contract
  `docs/hooks.md` "Module actions", `docs/lwf/formats/skills-hooks.md` §3–§4; tests
  `tests/core/test_hooks.py`, `tests/agent/test_hook_actions.py`,
  `tests/architecture/test_tool_phase_budget.py`.
- **Date:** 2026-11-25.
