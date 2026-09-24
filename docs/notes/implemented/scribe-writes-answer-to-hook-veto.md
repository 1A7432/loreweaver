# Implemented: the Scribe does not overwrite what a hook booked

- **Problem:** in the 2026-09-24 《安土》 Studio run (grok-4.6), the Scribe overwrote the
  crossing ledger twice. March hour 3 rolled `8d10>=6 = [10, 8, 6, 4, 6, 2, 4, 10]`: five
  successes, no ones, a 齐速 hour worth 150. The hook booked `crossed_count` 325 → 475 and
  its inline ledger card showed 475; the stored value and the side panel read 450.
  `dice_rolled` fires after the reply, so the Keeper cannot read the hook's number that
  turn: it worked the hour out itself, as a 铺行 hour, and wrote "过环四百五十". The Scribe
  quoted that line as evidence and set the tracker to 450. The pack declares the ledger
  hook-owned while the column marches (`tool_use` + `denyTool` on `set_variable` /
  `adjust_variable`), but that veto was only ever asked about Keeper tool calls. Hour 6
  then booked 800 and finished the column (`column_state` → `done`); the Keeper wrote
  "七百七十五", and the Scribe wrote 775 again — this time past the pack's guard, which
  stops applying once the column is no longer marching.
- **Verdict (in-run, owner asleep, authority delegated for fixes that unblock play):** two
  rules, both in `agent/scribe.py`.
  1. A variable a hook wrote this turn is left alone by that turn's Scribe pass.
     `KPTurnResult.hook_writes` names every hook write of the turn, turn_start through
     variables_changed, and `gateway.turn` passes it to `run_scribe`.
  2. Every other op that passes the evidence gate is put to the room's `tool_use` hook,
     described as the `set_variable` / `adjust_variable` call it stands for, and dropped
     if a hook refuses it. Fails open like the Keeper's path; the hook engine is built only
     once an op has passed the evidence gate.
  The trace's `scribe` row gains `ops_vetoed`, counting both.
- **Reason:** hooks are deterministic code, and the Scribe is a model reading narration
  (iron rule #1). The reply-phase hooks run after the narration is final, so when the two
  disagree about a variable a hook wrote this turn, the narration is the stale one. Rule 1
  needs nothing from the pack and catches the case the pack's guard missed. Rule 2 honours
  a guard the pack declares on later turns, when a line of narration restates an old
  number. A keeper's own `.var` command is a person, not a model lane, and is not asked.
- **Not fixed here:** the Keeper still narrates a ledger number the hook has not booked
  yet. That is the pack's to solve (the hook could `narrate()` the booked line itself); it
  is the same root as the Keeper's root-value estimates in the same run.
- **Rule home:** `agent/scribe.py` (`run_scribe`, `_hook_refusal`), `agent/loop.py`
  (`KPTurnResult.hook_writes`), `gateway/turn.py`, `docs/plugins.md` (`tool_use` bullet);
  tests `tests/agent/test_scribe_hook_veto.py`, `tests/agent/test_scribe.py`,
  `tests/agent/test_loop_hooks.py`.
- **Date:** 2026-09-24.
