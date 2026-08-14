# M23 — Harness resilience: overflow self-healing, replayable prompts, lifecycle facets (APPROVED FOR EXECUTION)

Status: **approved by the owner 2026-08-13 — all four open questions resolved same day.
WS1–WS4 landed 2026-08-13/14** (WS4 86c5f2a, WS1 ea23cc2, WS2 696e58f, WS3 7631a64);
each carries a note in `docs/notes/implemented/`. Three things came out different from
the plan and are recorded where they landed rather than edited into the text below:

1. **WS3's seed** is derived from `(chat_key, turn)`, not from a stored `room_seed`.
   Both are already persisted, so replay-ability costs no new state.
2. **WS2's vendor table is per-ENDPOINT, not per-vendor.** Anthropic and the
   OpenAI-compatible wire are matched from current documentation. Gemini documents no
   context-overflow error at all and is deliberately left unclassified. OpenAI's
   documented body carries `code: None` on the EMBEDDINGS endpoint but
   `code: "context_length_exceeded"` on chat completions — the first reading of that
   generalised the wrong endpoint, and the correction (owner, 2026-08-14) is what lets
   the ChatGPT-subscription lane be matched at all: its errors carry no HTTP status, so
   only a code signal reaches them.
3. **The generation-time overflow is covered too** (owner, 2026-08-14). Claude 4.5 and
   later return 200 with `stop_reason: "model_context_window_exceeded"` instead of
   failing — a narration that stops mid-sentence on a call that "succeeded". It routes
   through the same recovery and the same once-per-turn guard, so the budget is
   unchanged. The vendors that fold "you hit the window" and "you hit the cap you set"
   into one reason code (OpenAI's `length`, Gemini's `MAX_TOKENS`, the Responses API's
   `max_output_tokens`) are deliberately not matched.

The three families the WS1 write-surface scan surfaced — `scribe_whispers` and the two
`director_images`/`director_pregen` keys — survived every reset only because no cleanup
list had ever named them. WS1 landed them unchanged and said so in their facets; the
owner ruled on 2026-08-14 that all three go with the story.
Provenance: patterns adapted from the DeepSeek Harness (dsh) architecture study
(2026-08-13); each workstream names the dsh mechanism it adapts and the local
evidence that motivates it. Facts below (file:line) were verified against HEAD
on 2026-08-13; re-verify line numbers at implementation time.

## Problem

Three recurring failure families, all with fresh scars:

1. **The usage meter lies, and when it lies a long campaign hits a wall.** The
   context-window table was once 16x wrong; streaming providers silently
   reported no usage (armed by M21, fixed 17ce768); estimated and real meters
   were compared as if commensurable (fixed in M22). Today a context-overflow
   error from the provider kills the player's turn outright: only the ChatGPT
   path even recognizes the error (`infra/llm_chatgpt.py:53-54`), every other
   provider path surfaces it as generic `loop.unavailable`
   (`agent/loop.py:365-391`), the turn is discarded, usage records zero
   (`gateway/turn.py:293-299` → `infra/usage_stats.py` early-return), so the
   meter does not move and the next turn hits the same wall. A stuck room can
   only be rescued by manual keeper surgery.
2. **Two model-visible inputs cannot be reconstructed from persisted state.**
   `hooks.js` injections enter the prompt from process memory only
   (`agent/loop.py:273` → `agent/prompt_builder.py:323`), and worldbook
   `{{random}}`/`{{pick}}` macros draw from an unseeded `random.Random()`
   (`agent/prompt_builder.py:402`). Undo replay, join replay, playtest
   forensics, and behavioral evals all silently lack what the model actually
   saw.
3. **Every lifecycle-ending operation keeps its own hand-enumerated cleanup
   list, and the lists drift.** August alone fixed three of this family
   (b23c450 reset vector orphans, 91b9ca4 admin reset outside the locked set,
   9069575 restore atomicity); this window's audit found one more live
   asymmetry (below). The cleanup knowledge lives in the operations instead of
   with the state owners.

## Design principles

- **The provider's error is the one meter that cannot lie.** Pressure-triggered
  folding stays primary; overflow errors become a recovery trigger that works
  exactly when the meter failed. (dsh: compaction's dual trigger.)
- **Whatever reaches the model must be reconstructable from persisted room
  state.** Not byte-identical replay worship — an explicit, tested contract
  with a short exemption list. (dsh: "model-visible means logged", enforced by
  a runtime invariant.)
- **Cleanup is declared by the state's owner, not remembered by each
  operation.** Registration and disposal live together; an architecture test
  makes unclaimed state a red build, so forgetting is a compile-time event,
  not a playtest discovery. (dsh: reversible effects + completeness guards.)
- **Rejected proposals are repo assets.** Multi-lane agent development already
  re-proposed an owner-rejected fix once (chronicle-dup, k3 lane); verdicts
  must be greppable by every lane, not private to one assistant's memory.

## Workstream 1 — Room-lifecycle facet registry (order: first)

**Shape.** A `RoomStateFacet` is declared by the module that OWNS a family of
state: its name, the document types, `room_state` keys and prefixes, vector
collections, and media it owns, plus `on_reset(scope)`, `on_restore`,
`on_delete`, and `on_export` hooks. The chronicle facet lives with the
chronicle code, the skills facet in `gateway/ops`, vector facets with their
writers. `reset_room_state`, `delete_room_data`, `import_room`, `restore`, and
the room **export** path (owner: include export, approved) walk the registry
instead of hardcoded `_RESET_*` tables (`net/room_backup.py`).

**Hard constraint.** The registry answers WHAT to clean; the four operations
keep answering ORDER and ATOMICITY. The existing segmented transactions and
failure compensation (`net/room_backup.py:1212-1234` family) are preserved
verbatim; a facet hook runs inside the segment the operation assigns it to.

**Owner verdicts recorded.**
- `skills_enabled` surviving every reset scope is DELIBERATE — it is a room
  setting, same family as keys/bindings (owner 2026-08-13). The facet declares
  it `settings: survives all resets` so the architecture test stops flagging it.
- Export coverage is in scope (owner 2026-08-13): the export manifest becomes
  facet-derived, closing the same drift class on the backup path.

**Bundled fixes (verified real this window).**
- `import_room` does not clear the undo snapshot ring (reset clears at
  `net/room_backup.py:1159`, delete at `:1200`, import nowhere): after
  `.save load`, `.undo` can resurrect pre-import state across the save
  boundary. Import must clear the ring in the same transaction segment that
  replaces `room_state`.
- `RoomHub._turn_locks` are lazily created per session key and never removed
  (`gateway/hub.py:198-202`); room deletion now disposes them.

**Explicit non-bugs (do NOT "fix"; the audit initially flagged both).**
- `restore` leaving the history tree alone is by design: the tree is
  append-only and rewind is the leaf-pointer move already inside the snapshot
  (`agent/undo.py` module docstring).
- Undo cannot orphan chronicle vectors: undo depth is capped inside the
  chronicle lag window, and only FOLDED records join the embedding index; the
  two sets cannot intersect.

**Acceptance.**
- An architecture test scans the actual write surface (all `state_set` keys,
  all document types, all vector payload collections) and diffs it against
  facet claims; unclaimed state fails the build. Exemptions are a named list
  with a reason per entry.
- The behavior of `.reset story/chars/all` is byte-for-byte unchanged for
  every key in today's tables (golden test over a populated fake room).
- Import-then-undo cannot cross the import boundary (regression test).

## Workstream 2 — Context-overflow recovery fold (order: second)

**Shape.**
1. A unified provider-error classifier (new `infra/llm_errors.py`, or an
   extension of `infra/llm_retry.py`) maps each vendor's native
   context-overflow error to one category. **Vendor error shapes are verified
   against current official docs per provider as an explicit implementation
   step** — no constant enters the table from memory or third-party summaries;
   each entry ships with a test built from a captured/documented error body.
   Matching is strict: when unsure, do NOT classify as overflow (the fallback
   is today's behavior, never a wrong fold).
2. `agent/loop.py` error branch: on overflow, run the emergency fold through a
   new entry point that does not require a meter reading (fold by batch, not
   by fullness — the meter may read zero here). The recovery fold draws from
   the SAME per-turn fold budget (`_FOLD_MAX_BATCHES_PER_TURN`, currently 3).
   Retry the model request ONCE if and only if the fold made progress (records
   actually folded); a no-progress fold keeps the original error. This is the
   dsh loop guard: no progress, no retry, structurally no ping-pong.
3. Overflow occurrences are recorded in `usage_stats` even when usage is zero,
   so the next turn's pressure trigger has evidence.

**Budget (owner: approved exceeding, update the docs).** The retry adds at
most one model call per KP turn on the disaster path. Recovery folds share the
existing ≤3 fold budget, so the only new term is the retry: per-KP-turn
worst case 20 → 21, whole-player-turn worst case ~148 → ~155 (seven KP-turn
instances: 1 main + 6 companion-nested). Update the AGENTS.md budget paragraph
(name the new term explicitly) and `tests/agent/test_turn_call_budget.py`;
re-derive the arithmetic against the current formula at implementation time
rather than trusting this paragraph.

**Acceptance.**
- FakeLLM raising a synthetic overflow on a room above the fold floor: the
  player receives a normal narrated turn (one fold batch + one retry visible
  in the call log), history persists.
- Same error on a room already at the fold floor: today's localized error,
  exactly one model call, no retry.
- A non-overflow 400 (content refusal) never triggers a fold (classifier
  strictness test per provider).

## Workstream 3 — Replayable-prompt side records (order: third, parallelizable)

**Shape.**
1. Hook injections are written — **full text** (owner 2026-08-13; volume is
   trivial and forensics value is high) — to a turn-indexed `room_state` ring
   before prompt assembly, in the style of scribe whispers, then consumed as
   today.
2. The worldbook macro RNG becomes deterministic:
   `random.Random(derive(room_seed, turn))` at `agent/prompt_builder.py:402` —
   the same persisted state replays the same expansion.
3. An architecture test enumerates `prompt_builder`'s input sources; each must
   either name its persisted source or appear in an explicit exemption list
   with a written rationale. Initial exemptions: vector top-k ordering
   (semantically equivalent retrieval; byte-stability not worth the cost) and
   the current user message (it IS the input). Future prompt sections must
   answer "how does this replay?" to get past CI.

**Acceptance.** A room restored from persisted state re-assembles a prompt
whose non-exempt segments are byte-identical to the original turn's (extends
`tests/agent/test_prompt_cache_layout.py`'s stable-head test to the
reconstructable subset of the volatile tail).

## Workstream 4 — Decision records in-repo (no window slot; rides the first PR)

**Shape.** `docs/notes/{implemented,rejected}/` — two states only (dsh's four
are overweight here). Five-line entries: problem / verdict / reason / date.
Seed batch ships without owner pre-review (owner 2026-08-13): sole-active
mechanism deletion, chronicle-dup fix rejection, platform adapters never
return, KP full knowledge permanent, 拆卡 doctrine stands, the
restraint-purity (限制洁癖) warning. Plus `docs/defensive-patterns.md` seeded
with paid-for lessons: both turn_lock deadlock shapes, join replay reads the
history tree, vendor constants are re-verified never propagated, the streaming
usage trap, reset/restore cleanup asymmetry (the WS1 disease).

**Rule (add two lines to AGENTS.md):** a non-trivial change carries a new or
updated note in the same PR; rejected/ is checked before proposing a mechanism
in its territory.

## Ordering and estimate

WS1 (3d, includes export coverage and bundled fixes) → WS2 (2d, vendor
verification is its own step) → WS3 (1d, parallelizable with WS2) → WS4 rides
the first PR (0.5d seed). Everything is offline-testable: constructed provider
error bodies, FakeLLM-injected overflow, golden reset tables, facet-diff
architecture tests.
