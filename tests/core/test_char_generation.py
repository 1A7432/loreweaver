"""Integration test for dice notation: `CharacterManager.generate_character`
must work end-to-end with the REAL `core.dice_engine.DiceRoller` — i.e. `d20.roll`
must actually understand the SealDice-style formulas the packs declare in
`creation_constraints.attributes[*].roll` (`"3d6x5"`, `"(2d6+6)x5"`, `"4d6kh3"`).

`tests/core/test_character.py` exercises generation against a *faked* DiceRoller,
so it can't catch a `d20`-parser regression; this test deliberately uses the
real roller.
"""

from core.character_manager import CharacterManager, CharacterSheet
from core.dice_engine import seed_dice
from core.rulepacks import load_rulepack
from core.sheets import sheet_value
from infra.store import Store

# The nine CoC7 characteristics, all generated from pack-declared dice formulas:
# "3d6x5" (STR/CON/DEX/APP/POW/LUC) or "(2d6+6)x5" (SIZ/INT/EDU).
COC7_CHARACTERISTICS = ["STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUC"]

# The six DnD5e ability scores, all generated via "4d6kh3".
DND5E_ABILITIES = ["STR", "DEX", "CON", "INT", "WIS", "CHA"]


def test_coc7_pack_declares_creation_rolls_for_every_characteristic():
    """Sanity-check the pack data this test relies on: every characteristic
    declares a creation roll, so a future rename fails loudly here instead of
    silently making the rest of this test meaningless."""
    pack = load_rulepack("coc7")
    rules = pack.creation_constraints["attributes"]
    for attr in COC7_CHARACTERISTICS:
        assert rules[attr].get("roll"), f"{attr} lost its creation roll"


def test_generate_character_coc7_end_to_end_with_real_dice_roller():
    """`generate_character("coc7", ...)` must not raise, and must populate every
    CoC7 characteristic with a positive value rolled via the real `DiceRoller` —
    proving the SealDice-notation support makes real generation work end to end.
    """
    seed_dice(2026)
    manager = CharacterManager(Store(":memory:"))

    character = manager.generate_character("coc7", "Tester")

    assert isinstance(character, CharacterSheet)
    assert character.name == "Tester"
    assert character.system == "coc7"

    for attr in COC7_CHARACTERISTICS:
        value = character.attributes[attr]
        assert isinstance(value, int)
        assert value > 0, f"{attr} was not rolled (got {value!r})"
        # "3d6x5" ranges 15-90, "(2d6+6)x5" ranges 40-90 - either way, below 100.
        assert value < 100, f"{attr} looks unrolled/un-normalized (got {value!r})"

    # The derived maxima depend on the dice-rolled characteristics, so correct
    # values here prove the roll -> derived-DAG pipeline completed.
    pack = load_rulepack("coc7")
    assert character.attributes["SANMAX"] == 99 - character.skills.get("克苏鲁神话", 0)
    assert character.attributes["HPMAX"] > 0
    assert character.attributes["MPMAX"] > 0

    # A derived skill should likewise have evaluated against the rolled DEX.
    assert sheet_value(character, pack, "闪避") == character.attributes["DEX"] // 2


def test_generate_character_dnd5e_end_to_end_uses_keep_highest_three_of_four():
    """Same end-to-end proof for the bare-keep notation: "4d6kh3" must behave as
    "keep the highest 3 of 4" (3-18 per ability), not a face-match reading which
    would frequently zero out an ability score.
    """
    seed_dice(2026)
    manager = CharacterManager(Store(":memory:"))

    character = manager.generate_character("dnd5e", "Tester")

    assert isinstance(character, CharacterSheet)
    assert character.system == "dnd5e"

    for ability in DND5E_ABILITIES:
        value = character.attributes[ability]
        assert isinstance(value, int)
        assert 3 <= value <= 18, f"{ability} outside the 4d6-keep-highest-3 range (got {value!r})"
