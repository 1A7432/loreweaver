# Implemented: whatever reaches the model is reconstructable from persisted state

- **Problem:** two model-visible inputs existed only in process memory. `hooks.js`
  injections were stashed on `ctx.extra` by the loop and read straight back by the
  prompt builder, so nothing about them survived the turn; and the worldbook's
  `{{random}}`/`{{pick}}` macros and its `probability` / inclusion-group rolls drew
  from an unseeded `random.Random()`. Undo replay, join replay, playtest forensics
  and the behavioural evals were all silently missing part of what the model saw.
- **Decision:** hook injections are written to a turn-indexed `room_state` ring in
  FULL text (owner 2026-08-13 — the volume is trivial beside the prompt they already
  ride in, and a hash tells a forensic reader that something was injected without
  telling them what), before prompt assembly. Every generator the assembler builds is
  seeded by `prompt_builder.turn_rng(chat_key, turn, stream)`.
- **Deviation from the spec, deliberate:** the spec said `derive(room_seed, turn)`.
  There is no room seed and this does not add one: the seed is derived from the chat
  key and the turn in flight, both already persisted, so replay-ability costs no new
  state. `stream` separates the macro lane from the worldbook lane, so adding a macro
  somewhere does not shift every probability roll after it.
- **Contract, not byte-identity worship:** `tests/architecture/test_prompt_replayability.py`
  scans the assembler for the three ways an input escapes persistence — unseeded
  randomness, the wall clock, and process-memory handoffs via `ctx.extra` — and each
  `ctx.extra` key must name the row a replay reads it back from, or carry a written
  exemption. Recorded exemptions: the current user message (it IS the input) and
  vector top-k ordering (semantically equivalent neighbours whose order can shift
  between index builds; pinning it would mean freezing the index).
- **Defect found and fixed on the way:** M23 WS2's overflow recovery re-assembles the
  prompt a second time within one turn, and the worldbook's sticky/cooldown/delay
  counter ticks once per injection pass — so the rebuild aged every sticky window
  twice. `build_system_prompt_parts` now takes `advance_timers`, and a rebuild is
  treated as the same turn seen again. A replay uses the same flag for the same reason.
- **Rule home:** `agent/prompt_builder.turn_rng` docstring (the seed);
  `agent/hook_runtime.record_hook_injections` docstring (the ring);
  `tests/architecture/test_prompt_replayability.py` (the enforced contract).
- **Date:** 2026-08-13 (spec approved) / 2026-08-14 (landed).

## Review follow-up (2026-08-14, adversarial pass)

The `ctx.extra` scan matched only the local alias `extra`, so `ctx.extra.get("key")`
would have bypassed the guard; it now matches any `.extra` attribute chain as well.
