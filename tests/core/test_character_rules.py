from core.character_manager import CharacterSheet
from core.character_rules import validate_sheet


def test_validate_coc_characteristics_clamps_to_roll_ranges_and_recomputes_vitals():
    sheet = CharacterSheet("Boundary", "CoC")
    sheet.attributes["STR"] = 999
    sheet.attributes["SIZ"] = 1
    sheet.attributes["POW"] = 95

    clamped, violations = validate_sheet(sheet, "coc7")

    assert sheet.attributes["STR"] == 999
    assert clamped.attributes["STR"] == 90
    assert clamped.attributes["SIZ"] == 40
    assert clamped.attributes["POW"] == 90
    assert clamped.attributes["MP"] == 18
    assert clamped.attributes["MPMAX"] == 18
    assert clamped.attributes["SAN"] == 90
    assert {violation.code for violation in violations} >= {"attribute_above_max", "attribute_below_min"}


def test_validate_coc_skills_clamps_and_marks_budget_overrun():
    sheet = CharacterSheet("Skillful", "CoC")
    sheet.skills["侦查"] = 999
    sheet.skills["图书馆"] = 90
    sheet.skills["心理学"] = 90
    sheet.skills["医学"] = 90
    sheet.skills["法律"] = 90
    sheet.skills["历史"] = 90
    sheet.skills["会计"] = 90

    clamped, violations = validate_sheet(sheet, "coc7")

    assert clamped.skills["侦查"] == 90
    assert any(violation.code == "skill_above_max" and violation.path == "skills.侦查" for violation in violations)
    budget = next(violation for violation in violations if violation.code == "coc_skill_budget_exceeded")
    assert budget.original > budget.limit


def test_validate_dnd_abilities_clamp_to_rolled_range_without_point_buy_false_positive():
    sheet = CharacterSheet("Roller", "DnD5e")
    sheet.attributes.update({"STR": 20, "DEX": 18, "CON": 16, "INT": 14, "WIS": 12, "CHA": 10})

    clamped, violations = validate_sheet(sheet, "dnd5e")

    assert clamped.attributes["STR"] == 18
    assert any(violation.code == "ability_above_max" and violation.path == "abilities.STR" for violation in violations)
    assert not any(violation.code == "dnd_point_buy_budget_exceeded" for violation in violations)


def test_validate_dnd_marks_point_buy_budget_overrun_when_all_scores_are_point_buy_scores():
    sheet = CharacterSheet("Buyer", "DnD5e")
    sheet.attributes.update({key: 15 for key in ("STR", "DEX", "CON", "INT", "WIS", "CHA")})

    clamped, violations = validate_sheet(sheet, "dnd5e")

    assert all(clamped.attributes[key] == 15 for key in ("STR", "DEX", "CON", "INT", "WIS", "CHA"))
    budget = next(violation for violation in violations if violation.code == "dnd_point_buy_budget_exceeded")
    assert budget.original == 54
    assert budget.limit == 27
