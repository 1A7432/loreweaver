"""Shallow undo (M20 D): turn-boundary snapshots, and the rewind that uses them.

`agent/history.py` makes rewinding the CONVERSATION a pointer move. That is a necessary
condition, and the first draft of this design mistook it for a sufficient one. Verified
2026-08-10: `core.documents` has a `schema_version` but no revision history, `room_state`
is a bare `(room, key)` table with no history column, and `grep undo` across the engine
returned nothing. A turn's tool calls write documents (NPC records, modvars, the MVU tree,
sheets), room_state (clock, scene, relationship tracks) and chronicle entries. Rewinding
only the conversation leaves both halves self-consistent and the whole a hallucination.

So a snapshot is taken at each turn boundary, covering exactly the half that is not
append-only: **`room_state` (including the history leaf pointer) and `documents`.** The
history tree is deliberately excluded — it only ever grows, its rewind is the leaf pointer
that IS in the snapshot, and copying the largest table in the schema once per turn per
room would buy nothing.

## Why the depth cap is the chronicle's lag window

Undo reaches back at most `chronicle.lag_turns` turns. This is not a compromise made to
keep the ring small: a real table rewinds the last thing that happened ("wait, I shouldn't
have opened that door"), not twenty minutes ago. Capping inside the lag window makes the
fold conflict **structurally impossible** — those turns have not been folded into
`campaign_summary` yet — so "does a deep branch rebuild the summary" is a question that
never needs answering.

The cap therefore DERIVES from the setting and is never a literal 4. An operator who
lowers `TRPG_CHRONICLE__LAG_TURNS` would otherwise be able to undo across the fold
watermark, breaking the exact invariant the cap exists to guarantee.
"""

from __future__ import annotations

import json
import logging

from agent.history import DEFAULT_HISTORY_KEY, leaf_at_or_before, leaf_key
from agent.services import Services
from infra.room_facets import STORAGE_SNAPSHOTS, RoomStateFacet

logger = logging.getLogger(__name__)


def undo_depth(services: Services) -> int:
    """How many turns back an undo may reach — the chronicle's no-future lag window."""
    return max(1, int(services.settings.chronicle.lag_turns))


async def capture(services: Services, chat_key: str, turn: int) -> None:
    """Snapshot the room's non-append-only half at a turn boundary. Never raises.

    Best-effort on purpose: a snapshot that fails costs an undo, while a snapshot that
    raises costs the turn. The ring keeps `undo_depth` entries, so the oldest thing that
    can be restored is exactly the oldest thing that may be.
    """
    try:
        payload = json.dumps(
            {
                "room_state": await services.store.state_list(chat_key),
                "documents": await services.store.doc_list(chat_key),
            },
            ensure_ascii=False,
        )
        await services.store.snapshot_put(chat_key, turn, payload, keep=undo_depth(services))
    except Exception:  # noqa: BLE001 — see docstring
        logger.warning("turn-boundary snapshot failed for %s at turn %s", chat_key, turn, exc_info=True)


async def available_turns(services: Services, chat_key: str) -> list[int]:
    """Turns this room can be rewound to, newest first."""
    try:
        return await services.store.snapshot_turns(chat_key)
    except Exception:  # noqa: BLE001
        return []


async def restore(services: Services, chat_key: str, turn: int, *, history_key: str = DEFAULT_HISTORY_KEY) -> bool:
    """Rewind the room to the end of `turn`. True if a snapshot was found and applied.

    Both halves move together or neither does: documents and room_state are replaced from
    the snapshot, and the history leaf is set from the snapshot's own copy of the pointer
    — so the conversation the Keeper replays and the state its tools read are the same
    moment by construction, not by coincidence. The join-replay event lane
    (`gateway.turn.record_turn_events`) rides room_state and is written the moment each
    roll happens, so the snapshot of turn N already holds turn N's own rolls and none of
    the abandoned future's — restoring it is exactly right.

    The abandoned turns are still in the tree. Playing forward from here appends children
    to the restored leaf, which is how a branch happens: nothing was deleted to make room
    for it.
    """
    # A Scribe still in flight would write the abandoned future back over this
    # restore. Cancel-and-drain first; the pass is the one lane outside the
    # turn lock, so holding that lock is not enough.
    from agent.scribe_coord import scribe_runtime

    await scribe_runtime.quiesce(chat_key)
    raw = await services.store.snapshot_get(chat_key, turn)
    if raw is None:
        return False
    payload = json.loads(raw)
    state_rows = payload.get("room_state") or []
    documents = payload.get("documents") or []

    # The RAW rows go back verbatim, bypassing `DocumentStore.put`'s validate/stamp path:
    # this is a restore of bytes that were already validated on the way in, and re-running
    # `validate_write` here would rewrite `meta.modified` on every document in the room.
    # One transaction for both halves — per-row `doc_put`/`state_set` each commit on
    # their own, so a failure mid-restore used to leave documents deleted but only
    # partially re-inserted: the docstring's "or neither does", made real by the store.
    await services.store.replace_room_content(chat_key, documents=documents, state=state_rows)

    # Belt and braces on the one pointer the whole rewind hangs on: a snapshot taken before
    # the leaf key existed (or a room whose history was adopted later) must still land on
    # the right message rather than on whatever the tree's newest branch happens to be.
    if not await services.store.state_get(chat_key, leaf_key(history_key)):
        restored_leaf = await leaf_at_or_before(services, chat_key, history_key, turn)
        await services.store.state_set(chat_key, leaf_key(history_key), restored_leaf or "")
    return True


# --- Room lifecycle (M23 WS1) -----------------------------------------------
ROOM_FACETS = (
    RoomStateFacet(
        name="undo_ring",
        owner="agent.undo",
        reset_scope="story",
        export_exempt_because=(
            "the ring is a within-session rewind buffer, not room content; a loaded save "
            "starts a fresh rewind horizon, and a ring that crossed that boundary would "
            "let `.undo` resurrect pre-import state"
        ),
        storages=frozenset({STORAGE_SNAPSHOTS}),
    ),
)
