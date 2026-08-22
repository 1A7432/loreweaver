# Implemented: ordered Scribe chain, next-turn wait, lifecycle cancel, snapshot refresh

- **Problem:** the post-turn Scribe was a bare `asyncio.create_task` per player
  turn. Same-room passes could finish out of LLM order; the next Keeper prompt
  could `pop_whispers` before the previous write; `.undo` / `.reset` / import /
  delete / `.save load` could restore or wipe a room a still-running pass then
  wrote back; and `run_kp_turn` photographed the turn boundary *before* the
  pass, so tracker / habit / chronicle / whisper / Director writes sat in no
  correct rewind snapshot. `except Exception` around the pass would also have
  treated a lifecycle cancel as a logged bookkeeping failure.
- **Decision:** one in-process coordinator (`agent/scribe_coord.py`) owns a
  per-room chain. Three operations, three homes — not a copy in every command:
  `gateway.turn` *schedules* after the reply has already streamed; `run_kp_turn`
  *waits* (non-companion) before prompt assembly; `agent.undo.restore` and
  `net.room_backup` reset/import/delete *cancel-and-drain* before they mutate.
  A completed pass refreshes the snapshot named by the *current* chronicle
  counter, and only if no later external turn has begun. Room delete and
  `.reset all` drop the slot. `CancelledError` always propagates.
- **Reason:** the wait cannot live at the transport choke point. That path also
  admits destructive commands, which must cancel rather than wait for a slow
  LLM, and the choke point must not learn command names (the turn pipeline no
  longer does). Companion sub-turns skip both wait and schedule — they re-enter
  the turn flow inside the same player turn and they advance the counter, which
  is why a refresh must not write `result.turn`. The coordinator stays in
  `agent/` so the prompt site and undo do not grow a gateway/net reverse
  import.
- **Rule home:** `agent/scribe_coord.py` module docstring; AGENTS.md per-turn
  budget paragraph (the lane outside the lock); `docs/defensive-patterns.md`
  entry 7.
- **Date:** 2026-08-22.
