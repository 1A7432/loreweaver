# Implemented: a companion is record + sheet — both or neither, on every door

- **Problem:** an AI companion is two rows in two facets with two different reset scopes —
  its `npc` RECORD (`npc_records`, `story`: in-play cast is session state) and its
  `sheet` document under a `companion:<id>` uid (`characters`, `chars`: the same
  investigators replay the same module). `.reset story` therefore deleted the record and
  kept the sheet: a party row the HUD still drew with `ai` flipped to False — it
  impersonated a real player — that `.companion delete` could no longer reach and
  `list_party_sheets` still counted. 968bd1b closed this ghost on the DELETE door
  ("removing a companion retires it whole"); the reset door was the other one. Two more
  holes in the same seam: `create_companion` wraps `create_npc`, which deliberately
  returns an EXISTING record on an exact name match, and then stamped
  `role="player_companion"` / `is_pc=True` onto it — so `add_companion` on a module NPC's
  name CONVERTED the villain, secret agenda and seeded knowledge included, into a
  party-side actor (the charcard `as companion` import rode the same path); and
  `retire_companion` ignored `delete_character`'s `False`, so a companion whose
  `stat_char` had been retargeted at a PLAYER's sheet lost its record while the sheet
  stayed put.
- **Verdict:** one invariant, enforced at both ends — a companion exists as record AND
  sheet, or not at all. No door may create half of one, convert someone else's record
  into one, or delete half of one.
- **Shape:** the reset half is a new facet, not a special case in the lifecycle:
  `RoomStateFacet` grew an `on_reset` hook beside `on_delete`, for disposal of a SLICE of
  a family another facet owns wholesale — which is exactly what a target list cannot
  name. `agent.kp_tools_companion` declares `companion_sheets` (story scope) and disposes
  its slice through `CharacterManager.delete_character`, so the roster row and the
  active-character pointer leave with the document and the owner check still stands;
  `reset_room_state` runs reset hooks BEFORE the target-list wipes, because a hook selects
  on the records those wipes are about to delete. The conversion half is a refusal in the
  cast WRITER (`agent.npc.KeeperNpcNameTakenError`), so every door — `add_companion`,
  `.party add`, a card imported `as companion` — refuses with one localized text, exactly
  like `PlayerNameReservedError`; `minted` in the rollback path is now exact, because
  "already there" can only mean "already a companion". `retire_companion` raises
  `CompanionSheetNotRemovedError` and deletes NOTHING when the sheet is not the
  companion's, and both doors name the sheet in the way so the keeper can repoint
  `stat_char`.
- **Not changed on purpose:** `create_npc` still hands back an existing record on an exact
  name match — that is the 2026-08-06 rule that keeps a fresh surface persona from
  shadowing seeded secrets, and it is what makes a companion re-add idempotent. The
  `characters` facet still keeps player sheets until `chars`. The reset hook TOLERATES a
  refused sheet delete (a bad `stat_char` does not fail the room's whole cleanup) while
  the keeper-facing delete door refuses loudly — a reset is a wipe with nothing to
  restore, a delete is one keeper asking for one thing.
- **Rule home:** `infra/room_facets.py` module docstring (what a slice is and why it is a
  hook); `agent/kp_tools_companion.py` (`retire_companion`, `_dispose_companion_sheets`);
  `agent/npc.py` (`KeeperNpcNameTakenError`); `tests/architecture/test_room_facets.py`
  pins the story-scope companion facet.
- **Date:** 2026-08-20.
