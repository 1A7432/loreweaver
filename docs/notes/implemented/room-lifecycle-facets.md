# Implemented: room-lifecycle facets — cleanup is declared by the state's owner

- **Problem:** `.reset` (three scopes), room delete, room import and room export
  each carried a private, hand-written list of what to clean, and the lists
  drifted from the code that wrote the state. August 2026 fixed three of these
  (b23c450 reset vector orphans, 91b9ca4 an admin reset outside the locked set,
  9069575 a non-atomic restore); the M23 audit found a fourth — `import_room`
  left the undo ring intact, so `.undo` could rewind THROUGH a `.save load`
  back into the room's pre-import life.
- **Decision:** each family of room state is declared as a `RoomStateFacet` by
  the module that WRITES it — what it owns (document types, `room_state` keys
  and prefixes, vector lanes, whole storages), the lightest `.reset` scope that
  kills it, and, when it survives every scope, why. The four operations ask the
  registry instead of remembering. An architecture test scans the real write
  surface (every resolvable `state_set` key, every registered document type,
  every `*_COLLECTION` constant) and fails the build on state no facet claims.
- **Reason:** the knowledge lived in the operations and belonged with the
  state. Registration and disposal now sit in the same file, so forgetting is a
  red build rather than a playtest discovery. Export and import became one rule:
  a storage the manifest does not carry MUST be cleared on import, which is what
  makes the undo-ring bug structurally unrepeatable rather than merely fixed.
- **Scope limit (deliberate):** WS1 inverted OWNERSHIP only. The registry
  answers *what*; `net/room_backup.py` still answers *order* and *atomicity*,
  and its segmented transactions and failure compensation are unchanged — the
  one addition is that the newly-added ring clear is compensated like every
  other leg. A golden table in `tests/net/test_room_lifecycle.py` pins the three
  reset scopes against the four frozensets the registry replaced, key for key.
- **What the scan caught, and what the owner did with it:** three families
  survived every reset only because no cleanup list had ever named them —
  `scribe_whispers` (agent/scribe.py) and `director_images` / `director_pregen`
  (agent/stage_director.py). WS1 landed them unchanged, with their facets saying
  so verbatim rather than pretending it had been a decision; the owner then ruled
  on 2026-08-14 that **all three go with the story**. A fresh session no longer
  opens with the last session's scribe notes, reuses its portraits, or inherits
  its image bill. `tests/net/test_room_lifecycle.py` keeps them in a set of their
  own, so the golden tables stay an honest record of what the code used to do.
- **Also recorded:** `skills_enabled` surviving every scope is an explicit owner
  verdict (2026-08-13), not drift; `table_habits` survives because it describes
  the TABLE (the same people play the next session), not the campaign; the
  registered `media` document type is claimed by the media facet although
  nothing writes one today, so it cannot become an orphan later.
- **Rule home:** `infra/room_facets.py` module docstring (the contract);
  AGENTS.md "How to extend" (new room-scoped state declares a facet);
  `docs/defensive-patterns.md` entry 5 (why).
- **Date:** 2026-08-13 (spec approved) / 2026-08-14 (landed).

## Review follow-up (2026-08-14, adversarial pass)

- The turn-lock disposal was dead on its only production path: the destructive admin
  frames run INSIDE the room's turn lock, so `delete_room_data`'s in-op disposal always
  declined. `net/session.py` now disposes right after the lock releases (wire-level
  regression test in `tests/net/test_admin.py`); the in-op path still serves direct
  callers.
- The write-surface scan skipped every `state_set_if_values` call site (keyword-only
  signature vs a positional-argument filter); it now walks the `expected`/`updates`
  pairs.
- `import_room`'s undo-ring restore joined the attempt-every-leg rollback discipline
  instead of riding behind the other legs in one `try`.

## Checkpoint replacement (2026-08-22)

WS1 inverted ownership and made an uncarried storage clear on import. It did not
change the carried-storage write from upsert-merge to replacement, and history
stayed out of the capture/rollback snapshot. That follow-through is
`docs/notes/implemented/room-import-checkpoint-replacement.md`.

## M23 tail cleanups (2026-08-14, same batch)

Three small closure items from the post-M23 review, landed together on `m23-tail`:

- **usage_stats read sites use the shared constant.** The writer already named the
  `room_state` key `USAGE_STATS_KEY`; the two readers (`agent.chronicle`'s fold trigger,
  `net.state`'s HUD payload) still used the bare literal. Both now import the constant —
  no behaviour change.
- **the `media` document type in `.reset all` is a pinned post-M23 increment.** The
  golden tables in `tests/net/test_room_lifecycle.py` stay an honest copy of pre-M23
  behaviour, which never wiped the registered `media` type. The media facet claims it at
  `reset_scope="all"`, so the new behaviour is pinned as `POST_M23_ALL_DOC_TYPES`
  beside `POST_M23_STORY_KEYS`, not folded into the golden tables.
- **whole-table storages admit exactly one claimant.** The `storages` field means two
  things — a whole-table wipe for `history`/`snapshots`/`media`, a residency annotation
  for `documents`/`room_state`/`vectors` — and the field note now says so. The registry
  rejects a second claimant of a whole-table storage at construction, and
  `tests/architecture/test_room_facets.py` pins each wipe's single current owner
  (`conversation`, `undo_ring`, `room_media`).
