# Implemented: the model-call probe row, and same-round NPC voices that overlap

- **Problem:** the 2026-08-20 local play-test ran ~300 s a turn. Asked why, the only
  evidence was the tool probe, which records what the model ASKED FOR and nothing about
  what it cost: per-call latency had to be reverse-engineered from the gaps between tool
  clusters, and the session's 46 % cache-hit figure was every lane summed together — the
  Keeper lane's own hit rate, "which call is slow", "does the first round of a turn miss
  the cache" were all unanswerable. The same reconstruction showed the one structural
  waste the owner's constraints leave open: a round that voices two or three NPCs ran
  them strictly one after another (`speak_as_npc` writes, so it could never be
  `read_only`), 38 s each, though each line is voiced from its own record alone.
- **Verdict (owner, 2026-08-21):** models stay; tool calling stays the model's native
  dialect (no engine-side write channels); no pre-fetching into the prompt. Within those
  three, do the two things that are left: the per-call probe row, and executing
  independent NPC voices of one round together.
- **Shape:** `infra.model_call_trace` — a `lane_scope(...)` ContextVar the ASSEMBLER of
  each lane opens around its call (the iron-rule-5 assembler is the one that knows), and
  ONE row per LOGICAL call recorded inside `RetryingLLM.chat`, which every production
  path passes through: lane, room, round (the Keeper's, stamped as the loop advances —
  `finalizer` / `check` for the two other Keeper calls), wall-clock ms including retry
  sleeps, attempts, model, the provider's prompt / completion / cached token counts, and
  the error class when the call died. `agent.tool_trace` installs the sink with the tool
  probe (`tool: "model_call"`, same file, same reader); no trace, no sink, no cost.
  Concurrency: `@tool(concurrent_by="npc")` declares that two calls naming DIFFERENT
  values of that argument touch different documents; `_dispatch_and_record` splits a
  round's calls, in order, into runs of independent calls (`read_only` ones and keyed
  ones with distinct keys) and gathers each run; any other writer is a barrier and
  `companion_act` (a nested turn) always is. Recording, the conversation and the room's
  events keep CALL order; each concurrent call's NPC lines are captured per task
  (`agent.context.capture_npc_lines`) so they stay bound to the call that spoke them.
  `speak_as_npc`'s one shared write — the keeper-only `npc_intents` staging note — is a
  read-modify-write, so it takes a per-room lock; the voices overlap, the note does not.
- **Not changed, on purpose:** the round structure (read / bookkeeping / voice / narrate)
  — the bookkeeping rounds already batch four to five writes each, and a round carrying
  tool calls can never be the final reply; that is function calling's price, not a
  defect. No pre-read into the volatile tail: what the Keeper looks up mid-turn depends
  on dice not yet rolled, and guessing it pollutes attention. No cache "fix" before the
  probe has split the 46 % by lane. The hint words stay coarse; the probe row is
  operator-side and never reaches the wire.
- **Rule home:** `agent/loop.py` (THE MAP, concurrency invariant; `_concurrency_groups`),
  `agent/tools.py` (`concurrent_by`, `Toolset.concurrency_key`), `infra/model_call_trace.py`,
  `infra/llm_retry.py`, `agent/tool_trace.py`; `tests/agent/test_dispatch_guards.py`,
  `tests/infra/test_model_call_trace.py`. Decision record for the constraints:
  `docs/notes/rejected/` is not touched — the three constraints are an owner stance, recorded
  in the session notes, not a rejected mechanism.
- **Date:** 2026-08-21.
