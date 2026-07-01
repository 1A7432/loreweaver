"""Integration test for DEFECT 1 (dice notation): `CharacterManager.generate_character`
must work end-to-end with the REAL `core.dice_engine.DiceRoller` — i.e. `d20.roll` must
actually understand the SealDice-style formulas baked into
`core.character_manager.CharacterTemplate` (`"3d6x5"`, `"(2d6+6)x5"`, `"4d6k3"`).

`tests/core/test_character.py::test_generate_character_applies_template_and_defaults_name`
only exercises `apply_to_character` against a *faked* `DiceRoller`, so it can't catch a
`d20`-parser regression here; this test deliberately uses the real roller.
"""

from core.character_manager import CharacterManager, CharacterSheet
from core.dice_engine import seed_dice
from infra.store import Store

# Template names are the CharacterManager.templates registry keys (see
# `core/character_manager.py::CharacterManager.__init__`), not the human-readable
# `CharacterTemplate.name` values ("COC7标准" / "DND5E标准").
COC7_TEMPLATE_NAME = "coc7"
DND5E_TEMPLATE_NAME = "dnd5e"

# The nine CoC7 characteristics, all generated from dice formulas (`CharacterTemplate.
# get_coc7_template().attributes`): "3d6x5" (STR/CON/DEX/APP/POW/LUC) or "(2d6+6)x5"
# (SIZ/INT/EDU) - both are the SealDice-multiplication notation DEFECT 1 fixes.
COC7_CHARACTERISTICS = ["STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUC"]

# The six DnD5e ability scores, all generated via "4d6k3" (DEFECT 1's bare-keep notation).
DND5E_ABILITIES = ["STR", "DEX", "CON", "INT", "WIS", "CHA"]


def test_coc7_template_is_a_real_registered_template():
    """Sanity-check the template name this test relies on against the actual registry
    (`CharacterManager.templates`), so a future rename fails loudly here instead of
    silently making the rest of this test meaningless."""
    manager = CharacterManager(Store(":memory:"))
    assert COC7_TEMPLATE_NAME in manager.templates
    assert manager.templates[COC7_TEMPLATE_NAME].system == "CoC"


def test_generate_character_coc7_end_to_end_with_real_dice_roller():
    """`generate_character("coc7", ...)` must not raise, and must populate every CoC7
    characteristic with a positive value rolled via the real `DiceRoller` - proving the
    `roll_expression` SealDice-notation fix (DEFECT 1) makes real character generation
    work end to end (no faked/monkeypatched dice roller involved).
    """
    seed_dice(2026)
    manager = CharacterManager(Store(":memory:"))

    character = manager.generate_character(COC7_TEMPLATE_NAME, "Tester")

    assert isinstance(character, CharacterSheet)
    assert character.name == "Tester"
    assert character.system == "CoC"

    for attr in COC7_CHARACTERISTICS:
        value = character.attributes[attr]
        assert isinstance(value, int)
        assert value > 0, f"{attr} was not rolled (got {value!r})"
        # "3d6x5" ranges 15-90, "(2d6+6)x5" ranges 40-90 - either way, comfortably below 100.
        assert value < 100, f"{attr} looks unrolled/un-normalized (got {value!r})"

    # HPMAX/MPMAX (`CharacterTemplate.mapping`) depend on the dice-rolled characteristics
    # above, so a positive value here is further end-to-end proof the roll -> mapping
    # pipeline completed without raising. SANMAX is the CoC7e cap 99 - Cthulhu Mythos.
    assert character.attributes["SANMAX"] == 99 - character.skills["克苏鲁神话"]
    assert character.attributes["HPMAX"] > 0
    assert character.attributes["MPMAX"] > 0

    # A skill formula ("{DEX}/2") should likewise have evaluated against the rolled DEX.
    assert character.skills["闪避"] == character.attributes["DEX"] // 2


def test_generate_character_dnd5e_end_to_end_uses_keep_highest_three_of_four():
    """Same end-to-end proof for the other half of DEFECT 1: "4d6k3" must behave as
    "keep the highest 3 of 4" (3-18 per ability), not d20's native bare-"k3" reading
    ("keep dice whose face == 3"), which would frequently zero out an ability score.
    """
    seed_dice(2026)
    manager = CharacterManager(Store(":memory:"))

    character = manager.generate_character(DND5E_TEMPLATE_NAME, "Tester")

    assert isinstance(character, CharacterSheet)
    assert character.system == "DnD5e"

    for ability in DND5E_ABILITIES:
        value = character.attributes[ability]
        assert isinstance(value, int)
        assert 3 <= value <= 18, f"{ability} outside the 4d6-keep-highest-3 range (got {value!r})"
