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
   docs and a test pinning the shape it arrives in.
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
