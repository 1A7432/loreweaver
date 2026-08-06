"""Regression tests for `CharacterManager.get_character` corrupt/absent-document handling.

Guards the SILENT CHARACTER WIPE fix: `get_character` must raise
`CharacterDataError` when a stored sheet document is present but unreadable (or
the document read fails), rather than degrading to a blank sheet that a later
save would persist over the real character. A *genuinely absent* document must
still resolve to a usable default sheet so creation flows keep working.

Offline, in-memory `Store`; no network. Async tests run under the suite's
asyncio auto mode (see the sibling `test_character.py`).
"""

import pytest

from core.character_manager import CharacterDataError, CharacterManager, CharacterSheet
from infra.store import Store


async def test_absent_document_still_yields_a_usable_default_sheet():
    manager = CharacterManager(Store(":memory:"))

    sheet = await manager.get_character("u1", "chat-a", "Nobody")

    assert isinstance(sheet, CharacterSheet)
    assert sheet.name == "Nobody"


async def test_corrupt_document_raises_character_data_error_not_a_blank_sheet():
    store = Store(":memory:")
    manager = CharacterManager(store)
    character = CharacterSheet("调查员", "CoC")
    character.attributes["STR"] = 65
    await manager.save_character("u1", "chat-a", character)

    # Corrupt (truncate) the stored data column in place, below the typed layer.
    await store.doc_put(
        "chat-a", "sheet", "调查员", schema_version=1, data='{"name": "调查员", "sy', meta="{}", grants="[]"
    )

    with pytest.raises(CharacterDataError) as excinfo:
        await manager.get_character("u1", "chat-a", "调查员")
    assert excinfo.value.char_name == "调查员"


async def test_document_read_failure_raises_character_data_error():
    store = Store(":memory:")
    manager = CharacterManager(store)

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("store unavailable")

    # Force the document read to fail (a resolved char_name path, so the
    # active-name lookup is skipped and the failure surfaces on the read).
    store.doc_get = _boom  # type: ignore[method-assign]

    with pytest.raises(CharacterDataError):
        await manager.get_character("u1", "chat-a", "调查员")


async def test_valid_document_round_trips_without_raising():
    store = Store(":memory:")
    manager = CharacterManager(store)
    character = CharacterSheet("调查员", "CoC")
    character.attributes["STR"] = 65
    await manager.save_character("u1", "chat-a", character)

    loaded = await manager.get_character("u1", "chat-a", "调查员")
    assert loaded.attributes["STR"] == 65
    # And the stored document carries the owner uid alongside the sheet fields.
    doc = await manager.documents.get("chat-a", "sheet", "调查员")
    assert doc is not None and doc.data["owner"] == "u1" and doc.data["name"] == "调查员"
