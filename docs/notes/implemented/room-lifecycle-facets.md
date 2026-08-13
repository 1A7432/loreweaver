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
- **Open verdicts (recorded, not changed):** three families surfaced by the scan
  survive every reset today only because no cleanup list ever named them, and
  their facets say so in `survives_because` rather than pretending it was a
  decision: `scribe_whispers` (agent/scribe.py) and `director_images` /
  `director_pregen` (agent/stage_director.py). The whisper queue is read-and-
  cleared each prompt build, so at most a few lines can cross a reset; the
  director's pre-generation larder is session state, while its spend counter is
  arguably a room budget. Owner's call.
- **Also recorded:** `skills_enabled` surviving every scope is an explicit owner
  verdict (2026-08-13), not drift; `table_habits` survives because it describes
  the TABLE (the same people play the next session), not the campaign; the
  registered `media` document type is claimed by the media facet although
  nothing writes one today, so it cannot become an orphan later.
- **Rule home:** `infra/room_facets.py` module docstring (the contract);
  AGENTS.md "How to extend" (new room-scoped state declares a facet);
  `docs/defensive-patterns.md` entry 5 (why).
- **Date:** 2026-08-13 (spec approved) / 2026-08-14 (landed).
