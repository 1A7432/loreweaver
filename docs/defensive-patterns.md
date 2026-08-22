# Defensive patterns

Hard-won implementation rules (instituted by M23 WS4). Read this before
touching lifecycle, cleanup, locking, provider, or replay code. Each entry
names where it bit us; the fix commit is the proof it was paid for.

1. **The per-room turn lock is not reentrant, and it has two deadlock
   shapes.** (a) Code already running under the transport choke points
   (`net/session.py`, `gateway/runner.py`) must never re-acquire
   `hub.turn_lock` — the `.undo`/`.save`-load command family deadlocked
   exactly this way (fixed 2026-08-13). (b) `run_kp_turn` and the companion
   director deliberately do NOT take the lock; adding it "for safety"
   self-deadlocks every nested companion/director sub-turn. Rule home: the
   AGENTS.md per-turn budget paragraph.
2. **Replay reads the history tree, never a cached blob.** Join replay once
   read a retired blob and replayed deleted content (fixed 91b9ca4). Any new
   replay/export surface derives from `agent/history.load_chain` +
   `trim_folded`.
3. **Vendor constants are re-verified, never propagated.** The context-window
   table was 16x wrong because a number traveled from a stale table into a
   recommendation unchecked. A vendor constant (window size, error code,
   limit) enters code only with a same-day check against the vendor's own
   docs and a test pinning the shape it arrives in, **and the check is
   per-endpoint, not per-vendor**. M23 WS2 is the worked example, including
   its own correction: OpenAI's documented context-overflow body carries
   `code: None` on the EMBEDDINGS endpoint and `code:
   "context_length_exceeded"` on chat completions, and the first reading
   generalised the wrong one for a day. Gemini documents no context-overflow
   error at all, so that lane is left unclassified rather than guessed. When
   the docs do not say it, the entry does not exist; `infra/llm_errors.py`
   cites a page and a date per entry, and names the lanes it deliberately does
   not cover.
4. **Streaming usage is opt-in and silently absent.** Streaming providers
   only report usage when explicitly asked
   (`stream_options={"include_usage": True}`); the chronicle fold was inert on
   every streaming provider for exactly this reason (fixed 17ce768). Any
   meter fed from a stream needs a test against a fake that omits usage.
5. **Cleanup lists drift; the state owner must declare cleanup.** Reset,
   restore, and import each kept a private enumeration, and they diverged
   three times in one month (b23c450, 91b9ca4, 9069575) plus the stale undo
   ring `import_room` left behind (M23 WS1). New room-scoped state is not
   done until its lifecycle facet says how it resets, restores, deletes, and
   exports.
6. **"Truncated" is not one condition.** Every vendor has a way to end a
   response early, and they mean different things: Anthropic's
   `stop_reason: "model_context_window_exceeded"` is the window, while
   OpenAI's `finish_reason: "length"`, Gemini's `finishReason: MAX_TOKENS`
   and the Responses API's `incomplete_details.reason: "max_output_tokens"`
   all document the CONFIGURED cap (the last one covers both causes under one
   code, so it cannot distinguish them). Folding helps the first and nothing
   else. Read the vendor's own definition before treating any of them as a
   size signal — and remember that a truncated reply arrives as a SUCCESS, so
   nothing downstream will flag it for you.
7. **The Scribe is outside the turn lock; order is a coordinator, not a hope.**
   Fire-and-forget hid bookkeeping latency and also hid four races: same-room
   passes finishing out of LLM order, the next prompt popping whispers that
   had not been written, undo/reset/import/delete restoring a room a still-
   running pass then wrote back, and the end-of-turn snapshot being taken
   *before* the pass so its writes sat in no rewind boundary. The per-room
   chain lives in `agent/scribe_coord.py`. Wait at the keeper-lane prompt
   site (`run_kp_turn`, not the transport choke point — that path also
   admits destructive commands, which must cancel rather than wait, and
   must not learn command names). Cancel-and-drain at the mutation entries
   (`agent.undo.restore`, `net.room_backup` reset/import/delete). Refresh
   the snapshot named by the *current* chronicle counter, never the player
   turn's `result.turn` (companion sub-turns have already photographed the
   later indexes). `CancelledError` is not an operational failure and is
   never folded into `except Exception`. Room delete and `.reset all` drop
   the in-process slot.
