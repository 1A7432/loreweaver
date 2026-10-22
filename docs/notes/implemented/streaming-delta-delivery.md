# Implemented: streaming deltas actually reach clients

- **Problem:** every live table showed the KP reply arriving as one late block.
  Three stacked causes found in the 2026-08-17 live sit: (1) the protocol
  client's validator table had no `narrative_delta` entry, so `isServerFrame`
  silently dropped every streaming frame in BOTH real clients (the offline WS
  tests talk raw websockets and never caught it); (2) the max-rounds finalizer —
  which produces the reply on every tool-heavy turn — never streamed through the
  gate; (3) xAI 400s a request carrying `tool_choice` with no `tools`, which is
  exactly the finalizer's shape, so on xai/supergrok the finalizer always failed
  into the deterministic fallback.
- **Verdict:** all three fixed (owner: "订阅和 API 路径都接流式输出").
  `loreweaver-protocol` 2.1.2 adds the validator (patch — wire format
  unchanged); the finalizer takes the gate; `OpenAILLM` omits `tool_choice`
  whenever `tools` is falsy (spec-correct on every OpenAI-compatible endpoint).
- **Reason:** the turns that take the longest are exactly the ones a player
  watches; a 2.5-minute silent wait was the live sit's worst finding.
- **Rule home:** `clients/protocol/src/client.ts` (validator table),
  `agent/loop.py::_run_max_rounds_finalizer`, `infra/llm.py::OpenAILLM.chat`.
- **Date:** 2026-08-17.

## Follow-up: one slice in flight at a time (2026-10-21)

- **Problem:** the 2026-10-21 Studio playtest showed three half-sentence KP
  bubbles, each with a live cursor, stacked above a finished reply. The gate
  scheduled every slice as its own free task. The Keeper had written a scene in
  a round that also made a bookkeeping call, so that round's draft was still
  open when the final round began to stream; the first slice of the final round
  closed it with an await, and the slices behind it, already running, saw the
  old round too — each closed the same draft again and opened a draft of its
  own. A slice of a tool round could likewise land behind the public tool event
  (dice, an NPC line) that had just closed its draft.
- **Decision:** the gate's tasks form a chain — a slice is published only after
  the previous one — and a tool round drains its slices before any tool runs.
  The draft bookkeeping in `gateway.turn` is unchanged; it was correct for
  slices that arrive one at a time.
- **Rule home:** `agent/loop.py::_ReplyStreamGate`, the tool-round branch of
  `agent/loop.py::_run_kp_turn_body`; pinned by
  `tests/gateway/test_turn_stream_drafts.py` and `tests/agent/test_loop_streaming.py`.
