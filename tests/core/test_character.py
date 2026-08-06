"""Tests for core.character_manager: the pack-driven CharacterSheet container
and the document-backed manager (CRUD, roster, aliases, generation).

The per-system derived-math regression coverage lives in
tests/core/test_rulepacks.py (DAG baselines) and tests/core/test_sheets.py
(the generic sheet substrate); this file covers the storage/lifecycle layer.
"""

import json
import sys
import types

import pytest

import core.character_manager as character_manager
from core.character_manager import CharacterManager, CharacterSheet
from infra.i18n import t
from infra.store import Store


async def test_sync_party_roster_preserves_status_effects_without_explicit_update():
    store = Store(":memory:")
    manager = CharacterManager(store)
    character = CharacterSheet("调查员", "CoC")

    await manager.sync_party_roster("chat-a", character, status_effects=["中毒"])
    await manager.sync_party_roster("chat-a", character)

    roster_data = await store.state_get("chat-a", "party_roster")
    assert roster_data is not None
    roster = json.loads(roster_data)
    assert roster["调查员"]["status_effects"] == ["中毒"]


async def test_get_save_character_round_trip_via_store():
    store = Store(":memory:")
    manager = CharacterManager(store)
    character = CharacterSheet("调查员", "CoC")
    character.attributes["STR"] = 65
    character.notes = "left-handed"

    await manager.save_character("u1", "chat-a", character)
    loaded = await manager.get_character("u1", "chat-a", "调查员")

    assert loaded.name == "调查员"
    assert loaded.system == "CoC"
    assert loaded.attributes["STR"] == 65
    assert loaded.notes == "left-handed"


async def test_active_character_switch():
    store = Store(":memory:")
    manager = CharacterManager(store)

    alice = CharacterSheet("Alice", "CoC")
    bob = CharacterSheet("Bob", "CoC")
    await manager.save_character("u1", "chat-a", alice)
    await manager.save_character("u1", "chat-a", bob)  # saving also activates

    # Bob was saved last, so is active by default.
    active = await manager.get_character("u1", "chat-a")
    assert active.name == "Bob"

    await manager.set_active_character("u1", "chat-a", "Alice")
    active = await manager.get_character("u1", "chat-a")
    assert active.name == "Alice"


def test_skill_alias_resolution():
    manager = CharacterManager(Store(":memory:"))
    character = CharacterSheet("调查员", "CoC")

    assert manager.find_skill_by_alias(character, "侦察") == "侦查"
    assert manager.get_skill_value(character, "侦察") == character.skills["侦查"]
    assert manager.get_attribute_value(character, "STR") == character.attributes["STR"]
    # Unknown skill/attribute names fall back to 0, not KeyError.
    assert manager.get_skill_value(character, "不存在的技能") == 0
    assert manager.get_attribute_value(character, "不存在的属性") == 0


async def test_get_character_returns_default_sheet_when_none_saved():
    manager = CharacterManager(Store(":memory:"))

    character = await manager.get_character("u1", "chat-a")

    # The not-found placeholder carries no system: creation flows always set one.
    assert character.name == "default"
    assert character.system == ""


async def test_list_characters_returns_saved_characters():
    store = Store(":memory:")
    manager = CharacterManager(store)
    await manager.save_character("u1", "chat-a", CharacterSheet("Alice", "CoC"))
    await manager.save_character("u1", "chat-a", CharacterSheet("Bob", "CoC"))

    characters = await manager.list_characters("u1", "chat-a")

    assert {c["name"] for c in characters} == {"Alice", "Bob"}


async def test_delete_character_removes_from_list():
    store = Store(":memory:")
    manager = CharacterManager(store)
    await manager.save_character("u1", "chat-a", CharacterSheet("Alice", "CoC"))

    deleted = await manager.delete_character("u1", "chat-a", "Alice")

    assert deleted is True
    assert await manager.list_characters("u1", "chat-a") == []


async def test_get_party_roster_lists_pack_declared_resources():
    store = Store(":memory:")
    manager = CharacterManager(store)

    await manager.sync_party_roster("chat-a", CharacterSheet("Alice", "CoC"))
    roster = await manager.get_party_roster("chat-a")

    assert len(roster) == 1
    assert roster[0]["name"] == "Alice"
    meters = {entry["id"]: entry for entry in roster[0]["resources"]}
    assert meters["hp"]["value"] == 10 and meters["hp"]["max"] == 10
    # Sanity cap follows the rulebook DAG: 99 - Cthulhu Mythos, current = POW.
    assert meters["san"]["value"] == 50 and meters["san"]["max"] == 99
    assert meters["mp"]["value"] == 10 and meters["mp"]["max"] == 10


async def test_get_daily_luck_is_stable_and_persisted():
    store = Store(":memory:")
    manager = CharacterManager(store)

    first = await manager.get_daily_luck("u1")
    second = await manager.get_daily_luck("u1")

    assert first == second
    assert 1 <= first <= 100


def test_coc_sheet_computes_derived_skills_from_attributes():
    from core.rulepacks import load_rulepack
    from core.sheets import sheet_value

    character = CharacterSheet("调查员", "CoC")
    pack = load_rulepack("coc7")
    # Untrained derived skills are not persisted in `skills`; they recompute
    # through the DAG on read.
    assert "闪避" not in character.skills
    assert sheet_value(character, pack, "闪避") == character.attributes["DEX"] // 2
    assert sheet_value(character, pack, "母语") == character.attributes["EDU"]


def test_fresh_sheet_initializes_pack_declared_vitals():
    character = CharacterSheet("调查员", "CoC")
    assert character.attributes["HP"] == character.attributes["HPMAX"] == 10
    assert character.attributes["MP"] == character.attributes["MPMAX"] == 10
    # Starting SAN follows the declared start expr: min(POW, SANMAX).
    assert character.attributes["SAN"] == 50
    assert character.attributes["SANMAX"] == 99


def test_character_sheet_to_dict_from_dict_round_trip():
    original = CharacterSheet("调查员", "CoC")
    original.attributes["STR"] = 70
    original.notes = "left-handed"

    restored = CharacterSheet.from_dict(original.to_dict())

    assert restored.name == original.name
    assert restored.system == original.system
    assert restored.attributes["STR"] == 70
    assert restored.notes == "left-handed"


def test_sheet_meta_fields_round_trip_via_fields_dict():
    original = CharacterSheet("调查员", "CoC")
    original.occupation = "记者"
    original.age = 34

    data = original.to_dict()
    assert data["fields"]["occupation"] == "记者"
    assert data["fields"]["age"] == 34

    restored = CharacterSheet.from_dict(data)
    assert restored.occupation == "记者"
    assert restored.age == 34


def test_hp_field_system_migrates_legacy_current_and_max():
    legacy = CharacterSheet("Fighter", "DnD5e").to_dict()
    legacy.pop("hp_current", None)
    legacy.pop("hp_max", None)
    legacy["secondary_attributes"]["生命值"] = 8
    legacy["secondary_attributes"]["生命值上限"] = 12

    restored = CharacterSheet.from_dict(legacy)

    assert restored.hp_current == 8
    assert restored.hp_max == 12
    assert "生命值" not in restored.secondary_attributes
    assert "生命值上限" not in restored.secondary_attributes
    serialized = restored.to_dict()
    assert serialized["hp_current"] == 8
    assert serialized["hp_max"] == 12


def test_set_hit_points_preserves_max_through_damage_heal_and_explicit_raise():
    character = CharacterSheet("Fighter", "DnD5e")
    character_manager.set_hit_points(character, current=12, maximum=12, allow_raise_max=True)

    assert character_manager.set_hit_points(character, delta=-4) == (8, 12)
    assert character_manager.set_hit_points(character, delta=3) == (11, 12)
    assert character_manager.set_hit_points(character, delta=99) == (12, 12)
    assert character_manager.set_hit_points(character, current=15, allow_raise_max=True) == (15, 15)


async def test_hp_field_party_roster_keeps_current_and_max_hp_distinct():
    store = Store(":memory:")
    manager = CharacterManager(store)
    character = CharacterSheet("Fighter", "DnD5e")
    character_manager.set_hit_points(character, current=8, maximum=12, allow_raise_max=True)

    await manager.sync_party_roster("chat-dnd", character)

    roster = (await manager.get_party_roster("chat-dnd"))[0]
    meters = {entry["id"]: entry for entry in roster["resources"]}
    assert meters["hp"]["value"] == 8
    assert meters["hp"]["max"] == 12


def test_character_sheet_default_name_is_empty_string():
    # The constructor itself never hardcodes a language for the default name;
    # callers that need a display placeholder use the character.default_name
    # i18n key (see test_generate_character_defaults_name_via_i18n below).
    assert CharacterSheet().name == ""


def test_unknown_system_sheet_is_bare_storage():
    sheet = CharacterSheet("Stranger", "not-a-system")
    assert sheet.attributes == {}
    assert sheet.skills == {}
    assert sheet.field_values() == {}


def test_generate_character_unknown_system_raises_localized_error():
    manager = CharacterManager(Store(":memory:"))

    with pytest.raises(ValueError, match="tmpl-does-not-exist"):
        manager.generate_character("tmpl-does-not-exist")


def test_generate_character_rolls_creation_constraints_and_defaults_name(monkeypatch):
    """End-to-end generate_character, using a stand-in for
    core.dice_engine.DiceRoller that matches its contract: an instance with
    `.roll_expression(expr, is_check=False).total`. Every attribute declaring
    a creation roll gets the rolled value; derived slots recompute from them.
    """

    class _FakeRollResult:
        def __init__(self, total):
            self.total = total

    class _FakeDiceRoller:
        def roll_expression(self, expression, is_check=False):
            return _FakeRollResult(total=30)

    fake_module = types.ModuleType("core.dice_engine")
    fake_module.DiceRoller = _FakeDiceRoller
    monkeypatch.setitem(sys.modules, "core.dice_engine", fake_module)

    manager = CharacterManager(Store(":memory:"))
    character = manager.generate_character("coc7")

    assert character.name == t("character.default_name")
    assert character.system == "coc7"
    assert character.attributes["STR"] == 30  # from the faked dice roll
    # SANMAX cap = 99 - Cthulhu Mythos (0) -> 99 (NOT POW, which is 30 here).
    assert character.attributes["SANMAX"] == 99
    # Starting SAN = min(POW, SANMAX) = 30; HP = (CON+SIZ)//10 = 6, initialized full.
    assert character.attributes["SAN"] == 30
    assert character.attributes["HP"] == character.attributes["HPMAX"] == 6


def test_generate_character_accepts_display_style_system_names():
    manager = CharacterManager(Store(":memory:"))
    character = manager.generate_character("DnD5e", "Kael")
    assert character.system == "dnd5e"
    assert set(character.attributes) >= {"STR", "DEX", "CON", "INT", "WIS", "CHA"}
    assert all(3 <= character.attributes[key] <= 18 for key in ("STR", "DEX", "CON", "INT", "WIS", "CHA"))
