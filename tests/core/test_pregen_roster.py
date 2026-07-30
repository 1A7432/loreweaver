"""Tests for core.pregen_roster — the claimable pre-generated cast.

Claims are exclusive and deterministic; the pristine imported sheet survives play (a
release discards the player's copy, the next claimant starts fresh); unclaimed pregens
never touch the shared party roster (the panel shows who is AT the table, not the cast).
"""

from __future__ import annotations

import pytest

from core.character_manager import CharacterManager, CharacterSheet
from core.pregen_roster import MAX_ROSTER_ENTRIES, PregenRoster, slug_for
from infra.store import Store

pytestmark = pytest.mark.asyncio


def _sheet(name: str = "理", hp: int = 10) -> CharacterSheet:
    sheet = CharacterSheet(name=name, system="CoC")
    sheet.attributes = {"HP": hp, "HPMAX": 10}
    return sheet


async def test_add_claim_release_lifecycle_is_exclusive_and_pristine():
    store = Store()
    characters = CharacterManager(store)
    roster = PregenRoster(store)
    chat = "room-cast"

    entry = await roster.add(chat, _sheet(), source="card:某模组")
    assert entry is not None and entry["claimed_by"] == ""
    # Unclaimed pregens stay OFF the shared party roster.
    assert await characters.get_party_roster(chat) == []

    status, sheet = await roster.claim(chat, "理", "p1", characters)
    assert status == "ok" and sheet is not None and sheet.name == "理"
    # The claim materialized under p1: saved, active, on the party roster.
    assert (await characters.get_character("p1", chat)).name == "理"
    assert [member["name"] for member in await characters.get_party_roster(chat)] == ["理"]

    # Exclusive: another player is refused; the claimer re-claiming is a no-op re-activate.
    assert (await roster.claim(chat, "理", "p2", characters))[0] == "taken"
    assert (await roster.claim(chat, "理", "p1", characters))[0] == "yours"

    # Play damages the copy; the pristine original is untouched.
    played = await characters.get_character("p1", chat, "理")
    played.attributes["HP"] = 1
    await characters.save_character("p1", chat, played)

    # Release: not the claimer -> refused; claimer -> copy discarded, slot free again.
    assert await roster.release(chat, "理", "p2", characters) == "not_yours"
    assert await roster.release(chat, "理", "p1", characters) == "ok"
    assert await characters.get_party_roster(chat) == []

    status, sheet = await roster.claim(chat, "理", "p2", characters)
    assert status == "ok" and sheet is not None
    assert sheet.attributes["HP"] == 10  # fresh from the pristine sheet, not p1's damage


async def test_keeper_force_release_and_error_statuses():
    store = Store()
    characters = CharacterManager(store)
    roster = PregenRoster(store)
    chat = "room-force"
    await roster.add(chat, _sheet("Ada"))

    assert await roster.release(chat, "Ada", "kp", characters) == "free"
    assert (await roster.claim(chat, "Ada", "p1", characters))[0] == "ok"
    # The keeper (force=True) releases anyone's claim.
    assert await roster.release(chat, "Ada", "kp", characters, force=True) == "ok"
    assert await roster.release(chat, "nobody", "kp", characters, force=True) == "unknown"
    assert (await roster.claim(chat, "nobody", "p1", characters))[0] == "unknown"


async def test_readd_refreshes_pristine_sheet_but_keeps_the_claim():
    store = Store()
    characters = CharacterManager(store)
    roster = PregenRoster(store)
    chat = "room-readd"
    await roster.add(chat, _sheet("理", hp=10))
    assert (await roster.claim(chat, "理", "p1", characters))[0] == "ok"

    # Module re-import: pristine refreshed, claim intact.
    refreshed = await roster.add(chat, _sheet("理", hp=8))
    assert refreshed is not None and refreshed["claimed_by"] == "p1"
    assert (await roster.claim(chat, "理", "p2", characters))[0] == "taken"
    pristine = await roster.pristine_sheet(chat, slug_for("理"))
    assert pristine is not None and pristine.attributes["HP"] == 8


async def test_name_matching_is_case_insensitive_and_roster_is_capped():
    store = Store()
    roster = PregenRoster(store)
    chat = "room-cap"
    await roster.add(chat, _sheet("Old Marlow"))
    found = await roster.find(chat, "old  MARLOW")
    assert found is not None and found["name"] == "Old Marlow"
    assert await roster.add(chat, _sheet("   ")) is None  # unusable name

    for index in range(MAX_ROSTER_ENTRIES + 3):
        await roster.add(chat, _sheet(f"extra-{index}"))
    assert len(await roster.entries(chat)) == MAX_ROSTER_ENTRIES
