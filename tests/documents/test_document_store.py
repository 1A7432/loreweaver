"""DocumentStore substrate: CRUD, insertion order, provenance, validation.

Includes the M17 DoD demonstration: a handout-class feature is one `type` +
schema + projection away — no new store keys, no new wire filter, no new
backup entries (`test_handout_class_feature_is_one_type_away`).
"""

from __future__ import annotations

import pytest

from core.documents import (
    _REGISTRY,
    KEEPER_VIEWER,
    PLAYER_VIEWER,
    Document,
    DocumentStore,
    DocumentType,
    DocumentValidationError,
    Viewer,
    project,
    register_document_type,
)
from infra.store import Store

ROOM = "tui_room1"


@pytest.fixture()
def docs() -> DocumentStore:
    return DocumentStore(Store(":memory:"))


@pytest.mark.asyncio
async def test_put_get_roundtrip_and_meta_stamps(docs: DocumentStore) -> None:
    await docs.put(ROOM, "note", "clue_log", {"category": "clue_log", "content": "the tide"})
    doc = await docs.get(ROOM, "note", "clue_log")
    assert doc is not None
    assert doc.data["content"] == "the tide"
    assert doc.schema_version == 1
    assert doc.meta["created"] > 0 and doc.meta["modified"] >= doc.meta["created"]
    assert doc.source == ""

    await docs.put(ROOM, "note", "clue_log", {"category": "clue_log", "content": "the tide turns"})
    updated = await docs.get(ROOM, "note", "clue_log")
    assert updated is not None
    assert updated.data["content"] == "the tide turns"
    assert updated.meta["created"] == doc.meta["created"], "created survives updates"


@pytest.mark.asyncio
async def test_list_preserves_insertion_order_across_updates(docs: DocumentStore) -> None:
    for name in ("alpha", "beta", "gamma"):
        await docs.put(ROOM, "npc", f"npc_{name}", {"name": name})
    # Updating an early document must NOT move it to the back.
    await docs.put(ROOM, "npc", "npc_alpha", {"name": "alpha", "status": "wounded"})
    names = [doc.data["name"] for doc in await docs.list(ROOM, "npc")]
    assert names == ["alpha", "beta", "gamma"]


@pytest.mark.asyncio
async def test_rooms_and_types_are_isolated(docs: DocumentStore) -> None:
    await docs.put(ROOM, "note", "a", {"category": "a", "content": "room one"})
    await docs.put("tui_room2", "note", "a", {"category": "a", "content": "room two"})
    await docs.put(ROOM, "lore", "a", {"title": "a", "content": "lore"})

    assert len(await docs.list(ROOM, "note")) == 1
    assert len(await docs.list(ROOM)) == 2
    await docs.delete_type(ROOM, "note")
    assert await docs.get(ROOM, "note", "a") is None
    assert (await docs.get("tui_room2", "note", "a")) is not None
    await docs.delete_room(ROOM)
    assert await docs.list(ROOM) == []


@pytest.mark.asyncio
async def test_provenance_source_survives_owner_edits(docs: DocumentStore) -> None:
    """`meta.source` is load-bearing for serialized-module diff updates: a pack
    entry keeps its provenance through native edits unless explicitly re-sourced."""
    await docs.put(ROOM, "lore", "e1", {"title": "pier", "content": "v1"}, source="harbor-pack#pier")
    await docs.put(ROOM, "lore", "e1", {"title": "pier", "content": "keeper-edited"})
    doc = await docs.get(ROOM, "lore", "e1")
    assert doc is not None and doc.source == "harbor-pack#pier"


@pytest.mark.asyncio
async def test_validate_write_rejects_with_violations(docs: DocumentStore) -> None:
    def _validate(doc: Document, services: object) -> list[str]:
        return [] if doc.data.get("category") else ["category is required"]

    original = _REGISTRY["note"]
    register_document_type(
        DocumentType(name="note", schema_version=1, project=original.project, validate_write=_validate)
    )
    try:
        with pytest.raises(DocumentValidationError):
            await docs.put(ROOM, "note", "bad", {"content": "no category"})
        await docs.put(ROOM, "note", "good", {"category": "log", "content": "fine"})
    finally:
        register_document_type(original)


@pytest.mark.asyncio
async def test_singleton_helpers(docs: DocumentStore) -> None:
    await docs.put_singleton(ROOM, "scene", {"name": "The pier", "focus": "the crates"})
    doc = await docs.get_singleton(ROOM, "scene")
    assert doc is not None and doc.data["name"] == "The pier"
    with pytest.raises(ValueError):
        await docs.get_singleton(ROOM, "npc")


@pytest.mark.asyncio
async def test_handout_class_feature_is_one_type_away(docs: DocumentStore) -> None:
    """M17 DoD: adding a per-member-reveal feature takes ONE registered type
    whose projection honors `grants` — the storage table, the wire chokepoint
    (`project()`), and document-generic backup/reset all pick it up for free."""

    def _project_handout(doc: Document, viewer: Viewer) -> dict | None:
        if viewer.is_keeper:
            return dict(doc.data)
        if viewer.member_id is not None and viewer.member_id in doc.grants:
            return dict(doc.data)
        return None

    assert "handout" not in _REGISTRY
    register_document_type(DocumentType(name="handout", schema_version=1, project=_project_handout))
    try:
        await docs.put(ROOM, "handout", "torn_letter", {"text": "meet me at the light"}, grants=("uid_alice",))
        doc = await docs.get(ROOM, "handout", "torn_letter")
        assert doc is not None

        assert project(doc, Viewer(role="player", member_id="uid_alice")) is not None
        assert project(doc, Viewer(role="player", member_id="uid_bob")) is None
        assert project(doc, PLAYER_VIEWER) is None
        assert project(doc, KEEPER_VIEWER) is not None
    finally:
        _REGISTRY.pop("handout", None)
