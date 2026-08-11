"""F12 regression: a folded chronicle's vector point is room-owned like any other.

`agent.chronicle` indexes folded records with the worldbook payload scheme
(`collection` + `namespace`), so `net.room_backup.room_vector_points` selects
them through its `{"namespace": chat_key}` query. Before the fix the ownership
predicate recognised exactly ONE namespace-scoped collection by name
("worldbook") and fell through to the chat-key branch for every other, so a
chronicle point read as ambiguously owned and every room-wide vector path
raised `ValueError("vector point has conflicting room ownership")` once a room
had folded even once: export, backup snapshot/restore, room delete, `.reset all`.

Every test here folds for real (FakeLLM + FakeEmbeddings, offline) and asserts
the indexed point exists BEFORE exercising a backup path, so none of them can
pass vacuously by silently indexing nothing. The last two are the positive
controls: a point that genuinely names two rooms still fails closed, and a point
missing its lane's own scope field is still not treated as room-owned.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent.chronicle import CHRONICLE_COLLECTION, CHRONICLE_DOC_TYPE, maybe_fold_chronicle
from agent.context import AgentCtx
from agent.history import DEFAULT_HISTORY_KEY, append_turn
from agent.services import build_services
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM, assistant_text
from net.keystore import Keystore
from net.room_backup import (
    _vector_payload_owned_by_room,
    chat_key_for_room,
    delete_room_data,
    export_room,
    import_room,
    reset_room_state,
    room_vector_points,
)

ROOM = "arkham"
FOREIGN_ROOM = "dunwich"
FILLER = "the party mapped another flooded gallery of the drowned archive without incident "
WINDOW = 2000


def _services(tmp_path: Path):
    """Chronicle-enabled services on a private data dir (the suite-wide conftest
    turns the fold OFF; this file is ABOUT it, like `tests/agent/test_chronicle.py`)."""
    settings = Settings(locale="en", data_dir=str(tmp_path))
    llm = FakeLLM(responder=lambda messages, tools: assistant_text("Previously: the party entered the archive."))
    services = build_services(settings, llm=llm, embeddings=FakeEmbeddings(64))
    services.settings.chronicle.enabled = True
    return services


async def _seed_and_fold(services, chat_key: str) -> list[dict]:
    """Drive one real fold, then return the chronicle vector points it indexed."""
    await services.store.state_set(chat_key, "chronicle_turn", "20")
    for turn in range(1, 13):
        await services.documents.put(
            chat_key,
            CHRONICLE_DOC_TYPE,
            f"c{turn:05d}",
            {
                "text": f"turn{turn} " + FILLER,
                "keeper": "",
                "turn": turn,
                "pcs": [],
                "scene": "",
                "folded": False,
                "tokens": 100,
            },
        )
        # A fold is priced in the replayed transcript its watermark retires, so these
        # turns have to actually be on the room's history path for one to run.
        await append_turn(
            services,
            chat_key,
            DEFAULT_HISTORY_KEY,
            user_message=f"turn{turn}: " + FILLER,
            reply=FILLER,
            turn=turn,
        )
    meter = {
        "last": {"prompt": 1200, "completion": 0, "cache_hit": 0, "cache_miss": 0, "context_window": WINDOW},
        "session": {"prompt": 1200, "completion": 0, "cache_hit": 0, "cache_miss": 0, "turns": 1},
    }
    await services.store.state_set(chat_key, "usage_stats", json.dumps(meter))

    outcome = await maybe_fold_chronicle(AgentCtx(chat_key=chat_key, user_id="kp", locale="en"), services)
    assert outcome.entries_folded > 0, "control: the fold must actually run, or nothing is indexed"

    indexed = await services.vector_db.vector_store.dump(filter={"collection": CHRONICLE_COLLECTION})
    assert indexed, "control: folded records must reach the vector index"
    assert {point["payload"]["namespace"] for point in indexed} == {chat_key}
    return indexed


async def test_export_room_survives_a_folded_chronicle(tmp_path):
    services = _services(tmp_path)
    keystore = Keystore()
    keystore.add(room=ROOM, name="Keeper", role="keeper")
    chat_key = chat_key_for_room(ROOM)
    indexed = await _seed_and_fold(services, chat_key)

    result = await export_room(services, keystore, ROOM, "chronicle.json")

    assert result["vector_points"] == len(indexed)
    snapshot = json.loads(Path(result["path"]).read_text(encoding="utf-8"))
    exported = [
        point for point in snapshot["vector_points"] if point["payload"].get("collection") == CHRONICLE_COLLECTION
    ]
    assert {point["id"] for point in exported} == {point["id"] for point in indexed}


async def test_room_snapshot_and_restore_round_trip_keeps_the_chronicle_points(tmp_path):
    """The backup-snapshot path (`_capture_room_state` under export/import) and the
    import-side ownership check both accept the chronicle lane."""
    services = _services(tmp_path)
    keystore = Keystore()
    keystore.add(room=ROOM, name="Keeper", role="keeper")
    chat_key = chat_key_for_room(ROOM)
    indexed = await _seed_and_fold(services, chat_key)

    exported = await export_room(services, keystore, ROOM, "roundtrip.json")
    restored = await import_room(services, keystore, Path(exported["path"]).name, expected_room=ROOM)

    assert restored["vector_points"] == len(indexed)
    live = await room_vector_points(services, chat_key)
    assert {point["id"] for point in live} == {point["id"] for point in indexed}
    payloads = {point["id"]: point["payload"] for point in live}
    for point in indexed:
        assert payloads[point["id"]] == point["payload"], "restore preserves the chronicle payload verbatim"


async def test_delete_room_data_removes_the_folded_chronicle_points(tmp_path):
    services = _services(tmp_path)
    keystore = Keystore()
    keystore.add(room=ROOM, name="Keeper", role="keeper")
    chat_key = chat_key_for_room(ROOM)
    indexed = await _seed_and_fold(services, chat_key)

    result = await delete_room_data(services, keystore, ROOM)

    assert result["vector_points"] == len(indexed)
    assert await services.vector_db.vector_store.count(filter={"collection": CHRONICLE_COLLECTION}) == 0


async def test_reset_all_clears_the_folded_chronicle_points(tmp_path):
    services = _services(tmp_path)
    keystore = Keystore()
    keystore.add(room=ROOM, name="Keeper", role="keeper")
    chat_key = chat_key_for_room(ROOM)
    indexed = await _seed_and_fold(services, chat_key)

    result = await reset_room_state(services, chat_key, scope="all", keystore=keystore)

    assert result["vector_points"] == len(indexed)
    assert await services.vector_db.vector_store.count(filter={"collection": CHRONICLE_COLLECTION}) == 0
    assert await services.documents.list(chat_key, CHRONICLE_DOC_TYPE) == []


async def test_a_point_naming_two_rooms_still_fails_closed(tmp_path):
    """Positive control: the fix must widen the lane, not disable the guard."""
    services = _services(tmp_path)
    keystore = Keystore()
    keystore.add(room=ROOM, name="Keeper", role="keeper")
    chat_key = chat_key_for_room(ROOM)
    foreign_key = chat_key_for_room(FOREIGN_ROOM)
    await _seed_and_fold(services, chat_key)
    await services.vector_db.vector_store.upsert(
        [
            (
                "conflicted:0",
                [0.1] * 64,
                {"collection": CHRONICLE_COLLECTION, "namespace": chat_key, "chat_key": foreign_key},
            )
        ]
    )

    with pytest.raises(ValueError, match="conflicting room ownership"):
        await export_room(services, keystore, ROOM, "conflicted.json")
    with pytest.raises(ValueError, match="conflicting room ownership"):
        await delete_room_data(services, keystore, ROOM)
    with pytest.raises(ValueError, match="conflicting room ownership"):
        await reset_room_state(services, chat_key, scope="all", keystore=keystore)

    remaining = await services.vector_db.vector_store.dump(filter={"namespace": chat_key})
    assert "conflicted:0" in {point["id"] for point in remaining}, "a conflicted point is neither exported nor erased"


@pytest.mark.parametrize(
    ("payload", "owned"),
    [
        ({"collection": "chronicle", "namespace": "OWNER", "entry_id": "c00001"}, True),
        ({"collection": "worldbook", "namespace": "OWNER", "entry_id": "l1"}, True),
        ({"chat_key": "OWNER", "document_id": "doc", "chunk_index": 0}, True),
        # A future namespace-scoped collection inherits the contract, no name list.
        ({"collection": "bestiary", "namespace": "OWNER", "entry_id": "b1"}, True),
        # Foreign owner in either lane.
        ({"collection": "chronicle", "namespace": "FOREIGN", "entry_id": "c00001"}, False),
        ({"chat_key": "FOREIGN", "document_id": "doc"}, False),
        # Two rooms named at once — fail closed (also through nested metadata).
        ({"collection": "chronicle", "namespace": "OWNER", "chat_key": "FOREIGN"}, False),
        ({"chat_key": "OWNER", "meta": {"namespace": "FOREIGN"}}, False),
        # Missing the lane's own scope field: unattributed, never assumed ours.
        ({"collection": "chronicle", "entry_id": "c00001"}, False),
        ({"collection": "worldbook", "chat_key": "OWNER", "entry_id": "l1"}, False),
        ({"namespace": "OWNER", "document_id": "doc"}, False),
        ({"document_id": "doc", "chunk_index": 0}, False),
    ],
)
def test_ownership_predicate_lanes(payload, owned):
    chat_key = chat_key_for_room(ROOM)
    foreign_key = chat_key_for_room(FOREIGN_ROOM)
    resolved = {
        key: {"OWNER": chat_key, "FOREIGN": foreign_key}.get(value, value)
        if isinstance(value, str)
        else {inner_key: {"OWNER": chat_key, "FOREIGN": foreign_key}.get(inner, inner) for inner_key, inner in value.items()}
        if isinstance(value, dict)
        else value
        for key, value in payload.items()
    }
    assert _vector_payload_owned_by_room(resolved, chat_key) is owned
