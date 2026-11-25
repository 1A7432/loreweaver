# Implemented: `narrate()` in a `turn_start` handler reaches the table

- **Problem:** `docs/hooks.md` promised that `narrate(text)` appends to the player-visible
  reply with no per-event carve-out, but `agent.loop.run_kp_turn` read only a `turn_start`
  outcome's writes, state writes, UI, panel events and injections; its `narrations` were
  collected by `HookEngine.fire` and then dropped, silently.
- **Verdict (owner):** honour it. `turn_start` narrations keep their caps (8 × 2,000 chars
  per dispatch), are held from the start of the turn and appended to the reply first among
  hook narrations, with the same join as every other phase, at the start of the reply
  phases (`_run_reply_hooks`) — so `reply_ready` reads them in `event.reply` and
  `rewriteReply` still replaces everything. Every path that delivers and persists a reply
  carries them (a normal final round, a reply the end-of-turn checks corrected, the
  max-rounds finalizer and its deterministic fallback, an empty model reply); the
  provider-failure return, which delivers no turn, carries none.
- **Reason:** one rule for one emitter. Appending at the reply phases rather than where
  the event fired keeps hook text out of the end-of-turn checks (a hook's own roll line is
  not the Keeper's forged roll) and out of the `<UpdateVariable>` parse, and gives the
  narration the treatment `dice_rolled`'s already has: not streamed, part of the final
  `narrative` frame that replaces the draft, persisted as the turn's reply, read by the
  Scribe and the chronicle. `inject()` stays `turn_start`-only; `rewriteReply()` and
  `denyTool()` in `turn_start` remain without effect.
- **Rule home:** `agent/loop.py` (THE MAP steps 2 and 10, `_run_reply_hooks`);
  `docs/hooks.md` events list and emitter table; `docs/lwf/formats/skills-hooks.md` §4;
  tests `tests/agent/test_loop_hooks.py`.
- **Date:** 2026-11-25.
