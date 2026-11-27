# Defensive patterns

Hard-won implementation rules. Read this before touching lifecycle, cleanup, locking, provider, or
replay code. Each entry names where it bit us; most were paid for in the 2.x Python server and are
restated here against 3.0's code (`server/src/`), where the reason still holds. The numbers are
stable: code cites them (`defensive pattern 6`), so a retired entry keeps its number.

1. **The room's lock is not reentrant, and the lifecycle does not take it.** 2.x deadlocked twice
   on its per-room turn lock: once when code already running under it took it again (the
   `.undo`/load family), once when a nested sub-turn would have. In 3.0 the room
   (`server/src/gateway/room.ts`) owns one lock (`infra/mutex.ts`, a plain queue): speech and
   commands run under it in arrival order, and nothing that runs under it takes it again. Undo, reset
   and import deliberately do NOT wait for it, and neither do the commands that wait on the network
   or act on the server (`pack install`, `model`, `imagegen`, `key`): making them wait "for safety"
   parks a destructive operation behind a model call, or a fetch behind every line of the table.
   The old generation's work in flight ends as stale by itself (entry 7) — never build
   cancel-and-wait.
2. **Replay reads the stored log, never a copy.** 2.x once replayed a retired cached blob on join and
   showed deleted content (fixed 91b9ca4). In 3.0 a join replays from the room's event log in the
   store (`room.eventsAfter`, `server/src/net/session.ts`), and replay and join happen in one
   uninterrupted stretch — the store is synchronous — so no live event can land between two replayed
   ones or be missed. Any new replay or export surface reads the store, in the same block as the join
   it serves.
3. **Vendor constants are re-verified, never propagated.** The context-window
   table was 16x wrong because a number traveled from a stale table into a
   recommendation unchecked. A vendor constant (window size, error code,
   limit) enters code only with a same-day check against the vendor's own
   docs and a test pinning the shape it arrives in, **and the check is
   per-endpoint, not per-vendor**. The worked example, including its own
   correction: OpenAI's documented context-overflow body carries
   `code: None` on the EMBEDDINGS endpoint and `code:
   "context_length_exceeded"` on chat completions, and the first reading
   generalised the wrong one for a day. When the docs do not say it, the entry
   does not exist. In 3.0, `server/src/infra/llm/presets.ts` (presets and context
   windows) and `errors.ts` (error classes) cite a page or the installed SDK per
   entry; for a model the table does not know, nothing is guessed from a
   similar name — the server falls back to a deliberately small window, says so
   at start-up (`context_window_unknown`), and the operator states the real one.
4. **Streaming usage is opt-in and silently absent.** Streaming providers
   only report usage when explicitly asked
   (`stream_options: { include_usage: true }`); the chronicle fold was inert on
   every streaming provider for exactly this reason (fixed 17ce768). Every
   OpenAI-compatible call in 3.0 streams and asks
   (`server/src/infra/llm/openai.ts`). Any meter fed from a stream needs a test
   against a fake that omits usage.
5. **Cleanup lists drift; the state owner must declare cleanup.** Reset,
   restore, and import each kept a private enumeration in 2.x, and they diverged
   three times in one month (b23c450, 91b9ca4, 9069575) plus a stale undo ring an
   import left behind. In 3.0 the knowledge sits with the data
   (`server/src/infra/lifecycle/declarations.ts`): a document type declares its
   lifecycle, a room-state key IS its declaration (the store's state methods take
   the key object, never a bare string), and an external storage — media, the
   vector index — declares one when it registers (`infra/lifecycle/storages.ts`).
   New room-scoped state is not done until its declaration says what each reset
   scope does to it, or why it survives every scope.
6. **"Truncated" is not one condition.** Every vendor has a way to end a
   response early, and they mean different things: Anthropic's
   `stop_reason: "model_context_window_exceeded"` is the window, while
   OpenAI's `finish_reason: "length"` and the Responses API's
   `incomplete_details.reason: "max_output_tokens"` document the CONFIGURED
   cap (the last one covers both causes under one code, so it cannot
   distinguish them). Folding helps the first and nothing else. Read the
   vendor's own definition before treating any of them as a size signal — and
   remember that a truncated reply arrives as a SUCCESS, so nothing downstream
   will flag it for you. 3.0 normalises only the reasons each vendor documents
   (`StopReason` in `server/src/infra/llm/types.ts`); everything else is
   `unknown`.
7. **Work after a turn is ordered by a chain, and ordering is not waiting.**
   The Scribe and the Stage Director run after the turn, outside the room's
   lock. Fire-and-forget in 2.x hid three races: same-room passes finishing out
   of model order, a destructive operation restoring a room that a still-running
   pass then wrote back into, and a pass's writes landing in no rewind boundary.
   Fixing order is cheap; making anything WAIT on that chain is not — the first
   2.x draft had the next turn park on the previous pass, which hauls the
   previous turn's Scribe + Director + image latency onto the next turn and
   hands the table the same delay one turn later. In 3.0
   (`server/src/gateway/chain.ts`): at most one pass runs per room, passes land
   in the order they were scheduled, and nothing ever waits for the chain. A
   destructive operation does not cancel or drain it either. A pass keeps the
   `RoomContext` it was scheduled with (`server/src/agent/context.ts`) and
   commits in ONE synchronous block through the writer of the turn it was
   scheduled on; a writer of a past generation is refused, so a pass whose room
   was undone, reset or replaced meanwhile writes nothing. Never fetch a fresh
   writer when a lane finishes, and never read a counter at commit time to
   decide which turn a write belongs to — the turn is the one captured at
   scheduling (2.x stamped late chronicle records with the wrong turn exactly
   this way).
8. **Cancel is not cleanup, and a close that returns a promise must be
   awaited.** 2.x's iroh server cancelled its tasks without awaiting them and
   called the endpoint's async `close()` without awaiting it, so the accept loop
   stayed live after shutdown. In 3.0 `IrohServer.close`
   (`server/src/net/iroh.ts`) closes every connection, awaits the endpoint's
   close, then awaits the accept loop; the server's own `close`
   (`server/src/cli/compose.ts`) awaits the transport, then the rooms, then
   closes the store. The same class of miss: a server that has said its last
   word (a fatal `error` frame) must give the peer time to read it before
   closing the connection — QUIC drops unsent data on close, and the client
   would see a dropped link where it should have read `bad_key`
   (`CLOSE_GRACE_MS`).
9. **A stop signal needs its own handler.** A process started with a shell `&`
   (which is also how an agent backgrounds one for a test) can inherit SIGINT as
   ignored; in 2.x a plain Ctrl-C or `kill -INT` then did nothing at all, and
   where SIGINT did fire, a second one could interrupt the close half-way. In 3.0
   `server/src/cli/main.ts` hooks SIGINT and SIGTERM to the same clean close and
   ignores a repeated signal while that close runs. When you test shutdown, start
   the process the way an operator does, and check how its SIGINT was
   inherited.
10. **A check read through a pipe reports the pipe's exit code.**
    `bun run check | tail` exits with `tail`'s status, so a red run reads green
    and gets pushed. Keep the full log in a file, read the exit code and the
    failure count, and verify in one call and commit in another.
