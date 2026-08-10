"""The replayed conversation history, as an append-only tree (M20 D).

Before this, `chat_history` was one JSON list in `room_state`, overwritten every turn.
Rewinding it meant rewriting it, and a rewrite is a thing you cannot take back. Now each
message is a row naming its parent, and "where the conversation is" is a single pointer:
**a rewind is a pointer move, and a branch costs nothing** — the abandoned turns stay on
disk, simply not on the current path.

The loop reads the chain from the leaf and writes two records per turn (the player's
message and the final reply), so the wire layout M20 A depends on is unchanged: the same
messages, in the same order, byte-identical between folds.

**Conversation is only half of a room's state**, and that is why this module is not the
whole of Stage D. A turn's tool calls also write documents (NPC records, modvars, the MVU
tree, sheets), room_state (clock, scene, relationship tracks) and chronicle entries.
Rewinding only the conversation produces the worst kind of inconsistency: both halves
self-consistent, the whole a hallucination. `agent/undo.py` carries the other half.
"""

from __future__ import annotations

import json
import logging
import uuid

from agent.services import Services

logger = logging.getLogger(__name__)

DEFAULT_HISTORY_KEY = "chat_history"

# Where the current leaf lives, per history key. It rides `room_state` on purpose: it is
# the one part of the history that CHANGES, so it is the one part a turn-boundary snapshot
# must capture — restoring the snapshot restores the pointer, and the tree is untouched.
LEAF_SUFFIX = "_leaf"


def leaf_key(key: str) -> str:
    return f"{key}{LEAF_SUFFIX}"


async def load_chain(services: Services, chat_key: str, key: str) -> list[dict]:
    """The messages on the current path, oldest first, in wire shape.

    Uncapped by design (M20 A2): between folds this list only grows, which is what makes
    the replayed prefix byte-stable turn over turn. `trim_folded` is the sole place it
    shrinks.
    """
    leaf = await services.store.state_get(chat_key, leaf_key(key))
    records = await services.store.history_chain(chat_key, key, leaf)
    return [{"role": record["role"], "content": record["content"], "_lw_turn": record["turn"]} for record in records]


async def append_turn(
    services: Services, chat_key: str, key: str, *, user_message: str, reply: str, turn: int
) -> str:
    """Append this turn's player message and final reply; return the new leaf id.

    Only these two are persisted — never the intermediate tool chatter — so replayed
    history stays lean across turns.
    """
    parent = await services.store.state_get(chat_key, leaf_key(key))
    first = uuid.uuid4().hex
    second = uuid.uuid4().hex
    await services.store.history_append(
        chat_key,
        key,
        [
            {"id": first, "parent_id": parent, "turn": turn, "role": "user", "content": user_message},
            {"id": second, "parent_id": first, "turn": turn, "role": "assistant", "content": reply},
        ],
    )
    await services.store.state_set(chat_key, leaf_key(key), second)
    return second


async def leaf_at_or_before(services: Services, chat_key: str, key: str, turn: int) -> str | None:
    """The leaf the path had at the END of `turn` — where an undo to that turn lands.

    `None` when nothing on the path is that old, which reads as "rewind to empty" and is
    the honest answer for undoing a room's first turn.
    """
    leaf = await services.store.state_get(chat_key, leaf_key(key))
    for record in reversed(await services.store.history_chain(chat_key, key, leaf)):
        if int(record.get("turn", 0) or 0) <= turn:
            return str(record["id"])
    return None


async def trim_folded(services: Services, chat_key: str, key: str, chain: list[dict], folded_through: int) -> list[dict]:
    """Drop the turns the chronicle has already folded into its rolling summary.

    THE truncation point (M20 A2), and idempotent: it keys off the summary's cumulative
    watermark rather than what this turn's fold happened to consume, so a manual
    `.chronicle fold` is honoured on the next turn just as a routine one is.

    The records are NOT deleted — the tree is append-only, and the fold watermark can only
    move forward, so simply not replaying them is the whole operation.
    """
    if folded_through <= 0:
        return chain
    return [message for message in chain if int(message.get("_lw_turn", 0) or 0) > folded_through]


async def migrate_legacy_blob(services: Services, chat_key: str, key: str) -> bool:
    """Adopt a pre-M20 `room_state` history blob into the tree, once. True if it ran.

    Zero backward compatibility is the standing sanction, and this is not compatibility —
    it is the one-way door itself. A room mid-campaign whose history simply vanished would
    lose the thread it is in the middle of, and the conversion is a dozen lines that delete
    themselves the moment they run.
    """
    raw = await services.store.state_get(chat_key, key)
    if not raw:
        return False
    try:
        legacy = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        legacy = []
    await services.store.state_set(chat_key, key, "")
    if not isinstance(legacy, list) or not legacy:
        return False
    records = []
    parent: str | None = await services.store.state_get(chat_key, leaf_key(key))
    for message in legacy:
        if not isinstance(message, dict):
            continue
        record_id = uuid.uuid4().hex
        records.append(
            {
                "id": record_id,
                "parent_id": parent,
                "turn": int(message.get("_lw_turn", 0) or 0),
                "role": str(message.get("role", "")),
                "content": str(message.get("content", "")),
            }
        )
        parent = record_id
    if not records:
        return False
    await services.store.history_append(chat_key, key, records)
    await services.store.state_set(chat_key, leaf_key(key), parent)
    logger.info("adopted %d legacy history messages for %s into the append-only tree", len(records), chat_key)
    return True
