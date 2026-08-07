"""Tests for core.sheets: the generic pack-declared sheet substrate (M16 stage B).

Everything here goes through the PUBLIC spec-driven API against the bundled
packs — no per-system code paths exist to test anymore; the packs' YAML is the
system-specific half.
"""

import pytest

from core.character_manager import CharacterSheet, get_hit_points
from core.rulepacks import load_rulepack
from core.sheets import (
    SheetSpecError,
    canonical_values,
    check_value,
    has_check_value,
    parse_sheet_section,
    refresh_sheet,
    sheet_value,
    set_sheet_value,
    wire_resources,
)


def test_sheet_value_reads_attributes_skills_and_derived():
    pack = load_rulepack("coc7")
    sheet = CharacterSheet("调查员", "CoC")
    sheet.attributes["STR"] = 65

    assert sheet_value(sheet, pack, "力量") == 65
    assert sheet_value(sheet, pack, "侦查") == 25
    # Derived slot recomputes from the DAG regardless of storage staleness.
    sheet.attributes["DEX"] = 80
    sheet.skills["闪避"] = 1  # stale copy...
    refresh_sheet(sheet, pack, preserve_trained=False)
    assert sheet_value(sheet, pack, "闪避") == 40


def test_set_sheet_value_routes_to_declared_storage_slots():
    pack = load_rulepack("coc7")
    sheet = CharacterSheet("调查员", "CoC")

    set_sheet_value(sheet, pack, "力量", 70)
    assert sheet.attributes["STR"] == 70

    set_sheet_value(sheet, pack, "信用评级", 45)
    assert sheet.skills["信用"] == 45  # skill_keys bridge

    set_sheet_value(sheet, pack, "自定义技能", 33)
    assert sheet.skills["自定义技能"] == 33


def test_set_attribute_refreshes_dependent_derived_slots():
    pack = load_rulepack("coc7")
    sheet = CharacterSheet("调查员", "CoC")

    set_sheet_value(sheet, pack, "敏捷", 90)
    assert sheet_value(sheet, pack, "闪避") == 45  # untrained dodge tracks DEX/2

    set_sheet_value(sheet, pack, "教育", 80)
    assert sheet_value(sheet, pack, "母语") == 80


def test_trained_derived_skill_survives_refresh():
    pack = load_rulepack("coc7")
    sheet = CharacterSheet("调查员", "CoC")
    sheet.skills["闪避"] = 60  # the player spent points on dodge

    refresh_sheet(sheet, pack)

    assert sheet.skills["闪避"] == 60


def test_refresh_clamps_current_vitals_and_initializes_missing_ones():
    pack = load_rulepack("coc7")
    sheet = CharacterSheet("调查员", "CoC")
    sheet.attributes["HP"] = 4  # wounded

    refresh_sheet(sheet, pack)
    assert sheet.attributes["HP"] == 4  # edits preserve the current pool

    sheet.attributes["CON"] = 30
    sheet.attributes["SIZ"] = 30
    refresh_sheet(sheet, pack)
    assert sheet.attributes["HPMAX"] == 6
    assert sheet.attributes["HP"] == 4

    refresh_sheet(sheet, pack, initialize_vitals=True)
    assert sheet.attributes["HP"] == 6  # creation re-derives the pools


def test_dnd_sheet_secondary_and_field_bridges():
    pack = load_rulepack("dnd5e")
    sheet = CharacterSheet("Kael", "DnD5e")
    sheet.attributes["DEX"] = 16
    refresh_sheet(sheet, pack, preserve_trained=False)

    assert sheet_value(sheet, pack, "护甲等级") == 13
    assert sheet_value(sheet, pack, "等级") == 1  # field_keys bridge
    set_sheet_value(sheet, pack, "等级", 5)
    assert sheet.level == 5
    refresh_sheet(sheet, pack)
    assert sheet_value(sheet, pack, "熟练加值") == 3

    hp, hp_max = get_hit_points(sheet)
    assert sheet_value(sheet, pack, "hp") == hp
    assert sheet_value(sheet, pack, "hpmax") == hp_max


def test_check_value_bridges_ability_checks_to_modifiers():
    pack = load_rulepack("dnd5e")
    sheet = CharacterSheet("Kael", "DnD5e")
    sheet.attributes["STR"] = 16
    refresh_sheet(sheet, pack, preserve_trained=False)

    # A STR check rolls the MODIFIER (+3), not the score.
    assert check_value(sheet, pack, "力量") == 3
    # Skill checks feed the skill's own (derived) value.
    assert check_value(sheet, pack, "运动") == 3

    coc = load_rulepack("coc7")
    investigator = CharacterSheet("调查员", "CoC")
    investigator.attributes["STR"] = 65
    # CoC has no bridge: an attribute check rolls the raw value.
    assert check_value(investigator, coc, "力量") == 65


def test_has_check_value_accepts_known_names_and_rejects_garbage():
    pack = load_rulepack("coc7")
    sheet = CharacterSheet("调查员", "CoC")

    assert has_check_value(sheet, pack, "侦查")
    assert has_check_value(sheet, pack, "力量")
    assert has_check_value(sheet, pack, "STR")
    sheet.skills["祖传菜刀"] = 40  # custom skill written via sheet edits
    assert has_check_value(sheet, pack, "祖传菜刀")
    assert not has_check_value(sheet, pack, "不存在的技能")


def test_wire_resources_lists_declared_meters():
    coc = load_rulepack("coc7")
    investigator = CharacterSheet("调查员", "CoC")
    meters = {entry["id"]: entry for entry in wire_resources(investigator, coc)}
    assert set(meters) == {"hp", "san", "mp"}
    assert meters["hp"] == {"id": "hp", "label": "HP", "value": 10, "max": 10}

    dnd = load_rulepack("dnd5e")
    fighter = CharacterSheet("Kael", "DnD5e")
    meters = {entry["id"]: entry for entry in wire_resources(fighter, dnd)}
    assert set(meters) == {"hp"}
    assert meters["hp"]["value"] == 8 and meters["hp"]["max"] == 8


def test_canonical_values_translate_storage_keys():
    pack = load_rulepack("coc7")
    sheet = CharacterSheet("调查员", "CoC")
    sheet.attributes["STR"] = 65
    sheet.skills["信用"] = 30

    values = canonical_values(sheet, pack)
    assert values["力量"] == 65
    assert values["信用评级"] == 30
    assert values["职业"] == ""  # field_keys expose meta fields


# --- M19 item 8: per-viewer resource labels ----------------------------------

_LOCALIZED_SHEET = {
    "label": "潮占者",
    "attributes": {"CHAO": 3, "CHAOMAX": 9},
    "resources": [
        {"id": "chao", "label": {"en": "Tide", "zh": "潮位"}, "value": "CHAO", "max": "CHAOMAX"},
        {"id": "plain", "label": "Ledger", "value": "CHAO", "max": "CHAOMAX"},
        {"id": "zh_only", "label": {"zh": "灯签"}, "value": "CHAO", "max": "CHAOMAX"},
    ],
}


def test_resource_labels_accept_a_string_or_a_locale_map():
    spec = parse_sheet_section("chaozhan", _LOCALIZED_SHEET)
    tide, plain, zh_only = spec.resources

    # A locale map resolves per viewer; a bare string is the author's own language,
    # stored under `en` so it still answers every viewer.
    assert (tide.label_for("zh"), tide.label_for("en"), tide.label_for(None)) == ("潮位", "Tide", "Tide")
    assert plain.labels == {"en": "Ledger"} and plain.label_for("zh") == "Ledger"
    # A pack that declared ONLY zh still shows text to an en viewer rather than a blank bar.
    assert zh_only.label_for("en") == "灯签"
    # Regional tags fall back to their base language.
    assert tide.label_for("zh-Hans") == "潮位"


def test_resource_label_errors_are_author_actionable():
    for bad in ({}, "", 7, {"zh": "  "}, [".."]):
        entry = {"id": "x", "label": bad, "value": "CHAO", "max": "CHAOMAX"}
        with pytest.raises(SheetSpecError, match="label"):
            parse_sheet_section("chaozhan", {**_LOCALIZED_SHEET, "resources": [entry]})


def test_wire_resources_resolves_labels_to_the_viewer_locale():
    class _Pack:
        sheet_spec = parse_sheet_section("chaozhan", _LOCALIZED_SHEET)

    class _Sheet:
        attributes = {"CHAO": 4, "CHAOMAX": 9}

    zh = {entry["id"]: entry["label"] for entry in wire_resources(_Sheet(), _Pack(), "zh")}
    en = {entry["id"]: entry["label"] for entry in wire_resources(_Sheet(), _Pack(), "en")}
    assert zh["chao"] == "潮位" and en["chao"] == "Tide"
    # Same room, same pack, two viewers, two readings — that is the whole point.
    assert zh["plain"] == en["plain"] == "Ledger"
