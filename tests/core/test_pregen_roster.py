"""Tests for core.pregen_roster — the claimable pre-generated cast.

Claims are exclusive and deterministic; the pristine imported sheet survives play (a
release discards the player's copy, the next claimant starts fresh); unclaimed pregens
never touch the shared party roster (the panel shows who is AT the table, not the cast).
"""

from __future__ import annotations

import pytest

from core.character_manager import CharacterManager, CharacterSheet
from core.documents import DocumentStore
from core.pregen_roster import (
    MAX_ROSTER_ENTRIES,
    pregen_add,
    pregen_claim,
    pregen_entries,
    pregen_find,
    pregen_pristine_sheet,
    pregen_release,
    slug_for,
)
from infra.store import Store

pytestmark = pytest.mark.asyncio


def _sheet(name: str = "理", hp: int = 10) -> CharacterSheet:
    sheet = CharacterSheet(name=name, system="CoC")
    sheet.attributes = {"HP": hp, "HPMAX": 10}
    return sheet


async def test_add_claim_release_lifecycle_is_exclusive_and_pristine():
    store = Store()
    characters = CharacterManager(store)
    docs = DocumentStore(store)
    chat = "room-cast"

    entry = await pregen_add(docs, chat, _sheet(), source="card:某模组")
    assert entry is not None and entry["claimed_by"] == ""
    # Unclaimed pregens stay OFF the shared party roster.
    assert await characters.get_party_roster(chat) == []

    status, sheet = await pregen_claim(docs, chat, "理", "p1", characters)
    assert status == "ok" and sheet is not None and sheet.name == "理"
    # The claim materialized under p1: saved, active, on the party roster.
    assert (await characters.get_character("p1", chat)).name == "理"
    assert [member["name"] for member in await characters.get_party_roster(chat)] == ["理"]

    # Exclusive: another player is refused; the claimer re-claiming is a no-op re-activate.
    assert (await pregen_claim(docs, chat, "理", "p2", characters))[0] == "taken"
    assert (await pregen_claim(docs, chat, "理", "p1", characters))[0] == "yours"

    # Play damages the copy; the pristine original is untouched.
    played = await characters.get_character("p1", chat, "理")
    played.attributes["HP"] = 1
    await characters.save_character("p1", chat, played)

    # Release: not the claimer -> refused; claimer -> copy discarded, slot free again.
    assert await pregen_release(docs, chat, "理", "p2", characters) == "not_yours"
    assert await pregen_release(docs, chat, "理", "p1", characters) == "ok"
    assert await characters.get_party_roster(chat) == []

    status, sheet = await pregen_claim(docs, chat, "理", "p2", characters)
    assert status == "ok" and sheet is not None
    assert sheet.attributes["HP"] == 10  # fresh from the pristine sheet, not p1's damage


async def test_keeper_force_release_and_error_statuses():
    store = Store()
    characters = CharacterManager(store)
    docs = DocumentStore(store)
    chat = "room-force"
    await pregen_add(docs, chat, _sheet("Ada"))

    assert await pregen_release(docs, chat, "Ada", "kp", characters) == "free"
    assert (await pregen_claim(docs, chat, "Ada", "p1", characters))[0] == "ok"
    # The keeper (force=True) releases anyone's claim.
    assert await pregen_release(docs, chat, "Ada", "kp", characters, force=True) == "ok"
    assert await pregen_release(docs, chat, "nobody", "kp", characters, force=True) == "unknown"
    assert (await pregen_claim(docs, chat, "nobody", "p1", characters))[0] == "unknown"


async def test_readd_refreshes_pristine_sheet_but_keeps_the_claim():
    store = Store()
    characters = CharacterManager(store)
    docs = DocumentStore(store)
    chat = "room-readd"
    await pregen_add(docs, chat, _sheet("理", hp=10))
    assert (await pregen_claim(docs, chat, "理", "p1", characters))[0] == "ok"

    # Module re-import: pristine refreshed, claim intact.
    refreshed = await pregen_add(docs, chat, _sheet("理", hp=8))
    assert refreshed is not None and refreshed["claimed_by"] == "p1"
    assert (await pregen_claim(docs, chat, "理", "p2", characters))[0] == "taken"
    pristine = await pregen_pristine_sheet(docs, chat, slug_for("理"))
    assert pristine is not None and pristine.attributes["HP"] == 8


async def test_name_matching_is_case_insensitive_and_roster_is_capped():
    store = Store()
    docs = DocumentStore(store)
    chat = "room-cap"
    await pregen_add(docs, chat, _sheet("Old Marlow"))
    found = await pregen_find(docs, chat, "old  MARLOW")
    assert found is not None and found["name"] == "Old Marlow"
    assert await pregen_add(docs, chat, _sheet("   ")) is None  # unusable name

    for index in range(MAX_ROSTER_ENTRIES + 3):
        await pregen_add(docs, chat, _sheet(f"extra-{index}"))
    assert len(await pregen_entries(docs, chat)) == MAX_ROSTER_ENTRIES
