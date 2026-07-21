"""Regression tests for `CharacterManager.get_character` corrupt/absent-row handling.

Guards the SILENT CHARACTER WIPE fix: `get_character` must raise
`CharacterDataError` when a stored row is present but unreadable (or the store
read fails), rather than degrading to a blank sheet that a later save would
persist over the real character. A *genuinely absent* row must still resolve to
a usable default sheet so creation flows keep working.

Offline, in-memory `Store`; no network. Async tests run under the suite's
asyncio auto mode (see the sibling `test_character.py`).
"""

import json

import pytest

from core.character_manager import CharacterDataError, CharacterManager, CharacterSheet
from infra.store import Store


async def test_absent_row_still_yields_a_usable_default_sheet():
    manager = CharacterManager(Store(":memory:"))

    sheet = await manager.get_character("u1", "chat-a", "Nobody")

    assert isinstance(sheet, CharacterSheet)
    assert sheet.name == "Nobody"


async def test_corrupt_row_raises_character_data_error_not_a_blank_sheet():
    store = Store(":memory:")
    manager = CharacterManager(store)
    character = CharacterSheet("调查员", "CoC")
    character.attributes["STR"] = 65
    await manager.save_character("u1", "chat-a", character)

    # Corrupt (truncate) the stored JSON row in place.
    await store.set(user_key="u1", store_key="characters.chat-a.调查员", value='{"name": "调查员", "sy')

    with pytest.raises(CharacterDataError) as excinfo:
        await manager.get_character("u1", "chat-a", "调查员")
    assert excinfo.value.char_name == "调查员"


async def test_store_read_failure_raises_character_data_error():
    store = Store(":memory:")
    manager = CharacterManager(store)

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("store unavailable")

    # Force the row read to fail (a resolved char_name path, so the active-name
    # lookup is skipped and the failure surfaces on the row read).
    store.get = _boom  # type: ignore[method-assign]

    with pytest.raises(CharacterDataError):
        await manager.get_character("u1", "chat-a", "调查员")


async def test_valid_row_round_trips_without_raising():
    store = Store(":memory:")
    manager = CharacterManager(store)
    character = CharacterSheet("调查员", "CoC")
    character.attributes["STR"] = 65
    await manager.save_character("u1", "chat-a", character)

    loaded = await manager.get_character("u1", "chat-a", "调查员")
    assert loaded.attributes["STR"] == 65
    # And the stored row remains valid JSON.
    raw = await store.get(user_key="u1", store_key="characters.chat-a.调查员")
    assert json.loads(raw)["name"] == "调查员"
