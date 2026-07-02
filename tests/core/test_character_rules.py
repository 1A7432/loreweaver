from core.character_manager import CharacterSheet
from core.character_rules import validate_sheet


def test_validate_coc_characteristics_clamps_to_roll_ranges_and_recomputes_maxima():
    # A default `CharacterSheet` already carries placeholder *current* vitals
    # (HP=10, MP=10, SAN=50) consistent with its default CON/SIZ/POW=50.
    # Bumping STR/SIZ/POW here must recompute the *maxima* (and clamp the
    # existing current values into their new range) without resetting the
    # current values up to the new maxima -- that was the bug.
    sheet = CharacterSheet("Boundary", "CoC")
    sheet.attributes["STR"] = 999
    sheet.attributes["SIZ"] = 1  # clamps up to the min (40) -> HPMAX shrinks below the old HP
    sheet.attributes["POW"] = 95

    clamped, violations = validate_sheet(sheet, "coc7")

    assert sheet.attributes["STR"] == 999
    assert clamped.attributes["STR"] == 90
    assert clamped.attributes["SIZ"] == 40
    assert clamped.attributes["POW"] == 90
    assert clamped.attributes["MPMAX"] == 18
    assert clamped.attributes["SANMAX"] == 99
    assert clamped.attributes["HPMAX"] == 9
    # Current values are preserved (not reset to the new maxima): MP/SAN stay
    # at their untouched placeholder default; HP clamps down since the new
    # HPMAX (9) is now below the old current HP (10).
    assert clamped.attributes["MP"] == 10
    assert clamped.attributes["SAN"] == 50
    assert clamped.attributes["HP"] == 9
    assert {violation.code for violation in violations} >= {"attribute_above_max", "attribute_below_min"}


def test_validate_coc_preserves_wounded_current_hp_mp_san_across_unrelated_edit():
    """`validate_sheet` is called on every skill/attribute edit, not just at
    creation -- it must never act as a mutator that silently heals a wounded
    character back to full HP/MP/SAN."""
    sheet = CharacterSheet("Wounded", "CoC")
    sheet.attributes.update({"CON": 60, "SIZ": 70, "POW": 60})
    sheet, _ = validate_sheet(sheet, "coc7")
    assert sheet.attributes["HPMAX"] == 13

    # The investigator has taken damage/SAN loss during play.
    sheet.attributes["HP"] = 3
    sheet.attributes["MP"] = 2
    sheet.attributes["SAN"] = 20

    # Simulate the KP editing an unrelated skill, which re-runs validate_sheet.
    sheet.skills["侦查"] = 40
    revalidated, _ = validate_sheet(sheet, "coc7")

    assert revalidated.attributes["HPMAX"] == 13
    assert revalidated.attributes["HP"] == 3
    assert revalidated.attributes["MP"] == 2
    assert revalidated.attributes["SAN"] == 20
    assert revalidated.skills["侦查"] == 40


def test_validate_coc_fresh_sheet_without_current_vitals_initializes_to_maxima():
    """A sheet with no current HP/MP/SAN yet (e.g. imported from a raw
    character card missing derived stats) initializes them: HP/MP to their
    maxima, SAN to CoC's starting-SAN rule of min(POW, SANMAX)."""
    sheet = CharacterSheet.from_dict(
        {
            "name": "Fresh",
            "system": "CoC",
            "attributes": {"CON": 60, "SIZ": 60, "POW": 70, "INT": 55, "EDU": 45},
            "skills": {},
        }
    )
    assert "HP" not in sheet.attributes
    assert "MP" not in sheet.attributes
    assert "SAN" not in sheet.attributes

    clamped, _ = validate_sheet(sheet, "coc7")

    assert clamped.attributes["HPMAX"] == 12
    assert clamped.attributes["HP"] == 12
    assert clamped.attributes["MPMAX"] == 14
    assert clamped.attributes["MP"] == 14
    assert clamped.attributes["SANMAX"] == 99
    assert clamped.attributes["SAN"] == 70  # min(POW=70, SANMAX=99), not SANMAX
    assert clamped.attributes["IDEA"] == 55
    assert clamped.attributes["KNOW"] == 45


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
