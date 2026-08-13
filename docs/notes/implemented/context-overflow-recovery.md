# Implemented: the provider's refusal is the fold's second trigger

- **Problem:** the usage meter has been wrong three times (a 16x-wrong window table,
  a streaming lane that reported no usage at all, estimated and measured readings
  compared as if commensurable). Each time, a long campaign hit a wall the meter
  could not see: a context-overflow error killed the turn, the turn recorded zero
  usage, so the meter did not move and the next turn hit the same wall. Only the
  ChatGPT path even recognised the error; every other provider surfaced it as a
  generic `loop.unavailable`. A stuck room needed manual keeper surgery.
- **Decision:** an overflow error becomes a recovery trigger. `agent/loop.py` catches
  it, runs a fold that takes NO meter reading (`agent.chronicle.fold_for_overflow`),
  and re-sends the call ONCE — if and only if the fold actually folded records. No
  progress, no retry, so a fold/refuse ping-pong is structurally impossible rather
  than merely unlikely. The overflow is written into `usage_stats` even though the
  call reported nothing, so the next turn's pressure trigger has evidence.
- **Reason:** pressure-triggered folding stays primary; this fires exactly when the
  meter failed, which is the one moment the meter cannot be consulted about it.
- **Budget:** the retry is the only new model call — per KP turn 20 → 21, whole player
  turn ~148 → ~155 (7 KP-turn instances). The recovery fold is NOT a new term: it
  spends what is left of the same ≤3 batches the routine fold has (`batches_spent`),
  which `tests/agent/test_context_overflow_recovery.py` pins.
- **Vendor verification (the part that cannot be delegated to memory):** every entry
  in the classifier was checked against the vendor's own current documentation on
  2026-08-14, and the check changed the design twice.
  - **OpenAI**: the documented body carries `'code': None`. The widely-repeated
    `context_length_exceeded` is NOT what the platform returns, so this lane is matched
    on the documented message clause ("maximum context length is N tokens") and on
    nothing else.
  - **Anthropic**: documented outright — 400 `invalid_request_error`, "prompt is too
    long", on every model.
  - **Gemini**: its error reference documents no context-overflow error at all, so
    Gemini is NOT classified. A guessed message shape here is precisely the vendor
    constant that travels from memory into code and turns out to be wrong.
  - **DeepSeek** (and the other OpenAI-compatible vendors): seven documented codes,
    none about context length. Matched only if they emit the OpenAI message.
- **Known gap, deliberately not closed here:** on Claude 4.5 and later, an input that
  fits but whose GENERATION runs into the window returns 200 with
  `stop_reason: "model_context_window_exceeded"`. That is a truncated reply on the
  success path, not an error, and it needs handling where replies are read rather than
  an entry in an error classifier.
- **Rule home:** `infra/llm_errors.py` module docstring (the table and its citations);
  AGENTS.md per-turn budget paragraph (the ceiling);
  `docs/defensive-patterns.md` entry 3 (why constants get re-verified).
- **Date:** 2026-08-13 (spec approved) / 2026-08-14 (landed).
