"""Tests for core.character_manager (ported from nekro_trpg_dice_plugin).

Migrates the DND-skill-modifier and party-roster-preservation regression
tests from ``nekro_trpg_dice_plugin/tests/test_core_fixes.py`` (adapted to
`infra.store.Store` + pytest-style async tests), and adds coverage for the
`Store`-backed round trip, active-character switching, and skill-alias
resolution that came with the port.
"""

import json
import sys
import types

import pytest

import core.character_manager as character_manager
from core.character_manager import CharacterManager, CharacterSheet
from infra.i18n import t
from infra.store import Store

# ---------------------------------------------------------------------------
# Migrated from nekro_trpg_dice_plugin/tests/test_core_fixes.py
# ---------------------------------------------------------------------------


def test_dnd_skill_modifier_maps_chinese_ability_names():
    """Chinese ability names used as skill input map to the right attribute."""
    manager = CharacterManager(Store(":memory:"))
    character = CharacterSheet("战士", "DnD5e")
    character.attributes["STR"] = 14  # modifier = +2
    character.attributes["DEX"] = 12  # modifier = +1

    # Standard skill names.
    assert manager.get_dnd_skill_modifier(character, "运动") == 2
    assert manager.get_dnd_skill_modifier(character, "体操") == 1

    # Chinese ability names used as skill input should map correctly.
    assert manager.get_dnd_skill_modifier(character, "力量") == 2
    assert manager.get_dnd_skill_modifier(character, "敏捷") == 1

    # Proficiency bonus at level 1 = +2.
    assert manager.get_dnd_skill_modifier(character, "运动", proficient=True) == 4
    assert manager.get_dnd_skill_modifier(character, "力量", proficient=True) == 4


def test_dnd_skill_modifier_unknown_skill_defaults_to_str():
    manager = CharacterManager(Store(":memory:"))
    character = CharacterSheet("战士", "DnD5e")
    character.attributes["STR"] = 10  # modifier = 0

    assert manager.get_dnd_skill_modifier(character, "不存在的技能") == 0


async def test_sync_party_roster_preserves_status_effects_without_explicit_update():
    store = Store(":memory:")
    manager = CharacterManager(store)
    character = CharacterSheet("调查员", "CoC")

    await manager.sync_party_roster("chat-a", character, status_effects=["中毒"])
    await manager.sync_party_roster("chat-a", character)

    roster_data = await store.get(user_key="", store_key="party_roster.chat-a")
    assert roster_data is not None
    roster = json.loads(roster_data)
    assert roster["调查员"]["status_effects"] == ["中毒"]


# ---------------------------------------------------------------------------
# New coverage added when porting onto infra.store.Store
# ---------------------------------------------------------------------------


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

    assert character.name == "default"
    assert character.system == "CoC"


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


async def test_get_party_roster_lists_synced_characters():
    store = Store(":memory:")
    manager = CharacterManager(store)

    await manager.sync_party_roster("chat-a", CharacterSheet("Alice", "CoC"))
    roster = await manager.get_party_roster("chat-a")

    assert len(roster) == 1
    assert roster[0]["name"] == "Alice"
    assert roster[0]["hp"] == 10
    assert roster[0]["hpMax"] == 10
    assert roster[0]["san"] == 50
    assert roster[0]["sanMax"] == 50
    assert roster[0]["mp"] == 10
    assert roster[0]["mpMax"] == 10


async def test_get_daily_luck_is_stable_and_persisted():
    store = Store(":memory:")
    manager = CharacterManager(store)

    first = await manager.get_daily_luck("u1")
    second = await manager.get_daily_luck("u1")

    assert first == second
    assert 1 <= first <= 100


def test_get_modifier_dnd_and_coc():
    dnd = CharacterSheet("战士", "DnD5e")
    dnd.attributes["STR"] = 16
    assert dnd.get_modifier("STR") == 3  # (16-10)//2

    coc = CharacterSheet("调查员", "CoC")
    coc.attributes["STR"] = 65
    assert coc.get_modifier("STR") == 65  # CoC modifier is the raw attribute value


@pytest.mark.parametrize(
    ("level", "expected"),
    [(1, 2), (4, 2), (5, 3), (8, 3), (9, 4), (12, 4), (16, 5), (17, 6), (20, 6)],
)
def test_get_dnd_proficiency_bonus_by_level(level, expected):
    manager = CharacterManager(Store(":memory:"))
    assert manager.get_dnd_proficiency_bonus(level) == expected


def test_coc_sheet_computes_derived_skills_from_attributes():
    character = CharacterSheet("调查员", "CoC")
    assert character.skills["闪避"] == character.attributes["DEX"] // 2
    assert character.skills["母语"] == character.attributes["EDU"]


def test_character_sheet_to_dict_from_dict_round_trip():
    original = CharacterSheet("调查员", "CoC")
    original.attributes["STR"] = 70
    original.notes = "left-handed"

    restored = CharacterSheet.from_dict(original.to_dict())

    assert restored.name == original.name
    assert restored.system == original.system
    assert restored.attributes["STR"] == 70
    assert restored.notes == "left-handed"


def test_recompute_dnd_derived_fields_uses_abilities_and_removes_legacy_copies():
    character = CharacterSheet("Fighter", "DnD5e")
    character.attributes.update(
        {
            "STR": 16,
            "DEX": 14,
            "CON": 12,
            "INT": 10,
            "WIS": 12,
            "CHA": 8,
            "护甲等级": 99,
            "先攻修正": 99,
            "速度": 99,
        }
    )

    character_manager.recompute_dnd_derived(character)

    assert character.skills["运动"] == 3
    assert character.skills["体操"] == 2
    assert character.skills["隐匿"] == 2
    assert character.secondary_attributes["先攻修正"] == 2
    assert character.secondary_attributes["护甲等级"] == 12
    assert character.secondary_attributes["被动感知"] == 11
    assert character.secondary_attributes["载重"] == 240
    assert character.secondary_attributes["负重"] == 160
    assert character.secondary_attributes["熟练加值"] == 2
    for duplicate in ("护甲等级", "先攻修正", "速度", "载重", "负重", "熟练加值", "被动感知"):
        assert duplicate not in character.attributes


def test_dnd_hp_storage_migrates_legacy_current_and_max():
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


async def test_dnd_party_roster_keeps_current_and_max_hp_distinct():
    store = Store(":memory:")
    manager = CharacterManager(store)
    character = CharacterSheet("Fighter", "DnD5e")
    character_manager.set_hit_points(character, current=8, maximum=12, allow_raise_max=True)

    await manager.sync_party_roster("chat-dnd", character)

    roster = (await manager.get_party_roster("chat-dnd"))[0]
    assert roster["HP"] == "8/12"
    assert roster["hp"] == 8
    assert roster["hpMax"] == 12


def test_character_sheet_default_name_is_empty_string():
    # The constructor itself never hardcodes a language for the default name;
    # callers that need a display placeholder use the character.default_name
    # i18n key (see test_generate_character_defaults_name_via_i18n below).
    assert CharacterSheet().name == ""


def test_generate_character_unknown_template_raises_localized_error():
    manager = CharacterManager(Store(":memory:"))

    with pytest.raises(ValueError, match="tmpl-does-not-exist"):
        manager.generate_character("tmpl-does-not-exist")


def test_generate_character_applies_template_and_defaults_name(monkeypatch):
    """End-to-end generate_character/apply_to_character, using a stand-in for
    core.dice_engine.DiceRoller (ported separately per M0 spec §2) that matches
    its contract: an instance with `.roll_expression(expr, is_check=False).total`.
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
    assert character.system == "CoC"
    assert character.attributes["STR"] == 30  # from the faked dice roll
    # SANMAX cap = 99 - Cthulhu Mythos (0) -> 99 (NOT POW, which is 30 here). Mapping applied.
    assert character.attributes["SANMAX"] == 99
