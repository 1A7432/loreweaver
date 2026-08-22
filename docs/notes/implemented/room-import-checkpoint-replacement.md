# Implemented: room import is a full checkpoint replacement

- **Problem:** `import_room` upserted the snapshot's KV / documents / `room_state`
  / media and only deleted legacy aliases of incoming vector ids. Live rows the
  snapshot did not name survived a `.save load`. History was already
  delete-then-append, but `_capture_room_state` / `_rollback_room_state` omitted
  the tree, so a later-leg failure restored documents/state/vectors/media/keys
  and left chat history on the imported snapshot.
- **Verdict:** a load replaces every exportable storage. Success leaves the
  target room identical to the snapshot on documents, `room_state`, history,
  vectors, media, and room-owned KV bindings. Failure rolls every mutated
  storage — including history — back to the pre-import capture. Foreign
  `bound_room.*` protection, media staged/created compensation, attempt-every-leg
  rollback, and the undo-ring clear/restore stay as they were. Bearer keys stay
  restore-only: they are identity, not campaign content, and a newer live key
  is not erased.
- **Reason:** a named save is a whole-room checkpoint. Merge semantics make
  "the room after load" a mixture of two lives; a failed load that keeps the
  new history is the same tear in the other direction.
- **Rule home:** `net/room_backup.py` (`import_room`, `_replace_room_*`,
  `_rollback_room_state`); AGENTS.md lifecycle paragraph (`room_backup` owns
  order and atomicity).
- **Date:** 2026-08-22.
