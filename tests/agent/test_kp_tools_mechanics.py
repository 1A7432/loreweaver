"""Tests for agent.kp_tools_mechanics: CharacterTools, DiceTools, InitiativeTools.

Services are built fully offline per `docs/specs/M1.md` §6.3's determinism rule
(`FakeLLM`/`FakeEmbeddings`, no network; dice seeded via `core.dice_engine.seed_dice`).
Each test builds its own `Services` (backed by a fresh in-memory `Store`) so tests
never share state.
"""

from __future__ import annotations

import json
import random

from agent.context import AgentCtx
from agent.kp_tools_mechanics import _MADNESS_SYMPTOMS, CharacterTools, DiceTools, InitiativeTools
from agent.services import Services, build_services
from agent.tools import Toolset
from core.dice_engine import DiceRoller, coc_rank_label, seed_dice
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.i18n import I18n
from infra.llm import FakeLLM


def _build() -> tuple[Services, AgentCtx]:
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    ctx = AgentCtx(chat_key="cli:dm:t", user_id="u1")
    return services, ctx


# ---------------------------------------------------------------------------
# Toolset integration — 17 tools, none keeper_only, valid schemas
# ---------------------------------------------------------------------------


def test_toolset_collects_all_seventeen_tools_and_none_are_keeper_only():
    services, _ctx = _build()
    toolset = Toolset(CharacterTools(services), DiceTools(services), InitiativeTools(services))

    expected_names = {
        "create_character",
        "get_character_sheet",
        "update_character_skill",
        "update_character_attribute",
        "list_characters",
        "switch_character",
        "delete_character",
        "update_character_status",
        "roll_dice",
        "skill_check",
        "sanity_check",
        "skill_growth",
        "opposed_check",
        "hp_manager",
        "wod_check",
        "random_madness",
        "initiative_tracker",
    }
    assert len(expected_names) == 17
    assert set(toolset.names()) == expected_names

    schemas = toolset.schemas()
    assert len(schemas) == 17
    for name in expected_names:
        assert toolset.is_keeper_only(name) is False


async def test_dispatch_roll_dice_through_the_toolset_coerces_and_runs():
    services, ctx = _build()
    toolset = Toolset(DiceTools(services))

    seed_dice(5)
    result = await toolset.dispatch("roll_dice", ctx, {"expression": "1d6"})

    assert "🎲" in result


# ---------------------------------------------------------------------------
# CharacterTools
# ---------------------------------------------------------------------------


async def test_create_character_then_get_character_sheet_returns_the_sheet():
    services, ctx = _build()
    char_tools = CharacterTools(services)

    created = await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=True)
    assert "Vera" in created
    assert "COC7" in created

    sheet = await char_tools.get_character_sheet(ctx)
    assert "Vera" in sheet
    assert "STR" in sheet
    assert "HP" in sheet
    assert "SAN" in sheet


async def test_create_character_dnd5e_auto_generate_false_uses_defaults():
    services, ctx = _build()
    char_tools = CharacterTools(services)

    created = await char_tools.create_character(ctx, name="Thorin", system="dnd5e", auto_generate=False)
    assert "Thorin" in created
    assert "DND5E" in created

    sheet = await char_tools.get_character_sheet(ctx)
    assert "Thorin" in sheet
    assert "DnD5e" in sheet


async def test_get_character_sheet_without_a_character_returns_localized_error():
    services, ctx = _build()
    char_tools = CharacterTools(services)

    result = await char_tools.get_character_sheet(ctx)

    assert result == services.i18n.with_locale(ctx.locale).t("kp_tools.character.none")


async def test_update_character_skill_and_attribute_recompute_derived_stats():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)

    skill_result = await char_tools.update_character_skill(ctx, skill_name="spot hidden", value=70)
    assert "70" in skill_result
    sheet = await char_tools.get_character_sheet(ctx)
    assert "侦查: 70" in sheet

    attr_result = await char_tools.update_character_attribute(ctx, attribute="POW", value=80)
    assert "80" in attr_result
    sheet_after = await char_tools.get_character_sheet(ctx)
    assert "SAN: 80/80" in sheet_after
    assert "MP: 16/16" in sheet_after  # 80 // 5 == 16


async def test_list_switch_and_delete_characters():
    services, ctx = _build()
    char_tools = CharacterTools(services)

    await char_tools.create_character(ctx, name="Alice", system="coc7", auto_generate=False)
    await char_tools.create_character(ctx, name="Bob", system="coc7", auto_generate=False)

    listed = await char_tools.list_characters(ctx)
    assert "Alice" in listed
    assert "Bob" in listed

    switch_result = await char_tools.switch_character(ctx, name="Alice")
    assert "Alice" in switch_result
    sheet = await char_tools.get_character_sheet(ctx)
    assert "Alice" in sheet

    delete_result = await char_tools.delete_character(ctx, name="Bob")
    assert "Bob" in delete_result

    listed_after = await char_tools.list_characters(ctx)
    assert "Bob" not in listed_after
    assert "Alice" in listed_after


async def test_update_character_status_persists_to_party_roster():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)

    result = await char_tools.update_character_status(ctx, status_effects=json.dumps(["Poisoned", "Afraid"]))
    assert "Poisoned" in result

    roster = await services.characters.get_party_roster(ctx.chat_key)
    assert len(roster) == 1
    assert roster[0]["name"] == "Vera"
    assert roster[0]["status_effects"] == ["Poisoned", "Afraid"]


async def test_update_character_status_invalid_json_returns_localized_error():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)

    result = await char_tools.update_character_status(ctx, status_effects="not-json")

    assert result == services.i18n.with_locale(ctx.locale).t("kp_tools.character.status.invalid")


async def test_update_character_status_without_a_character_returns_localized_error():
    services, ctx = _build()
    char_tools = CharacterTools(services)

    result = await char_tools.update_character_status(ctx, status_effects=json.dumps(["Poisoned"]))

    assert result == services.i18n.with_locale(ctx.locale).t("kp_tools.character.none")


# ---------------------------------------------------------------------------
# DiceTools — roll_dice / skill_check (COC + DND5E)
# ---------------------------------------------------------------------------


async def test_roll_dice_basic_result_contains_the_total():
    services, ctx = _build()
    dice_tools = DiceTools(services)

    seed_dice(1)
    expected = DiceRoller().roll_expression("3d6+2")

    seed_dice(1)
    result = await dice_tools.roll_dice(ctx, expression="3d6+2")

    assert str(expected.total) in result


async def test_roll_dice_invalid_expression_returns_localized_error():
    services, ctx = _build()
    dice_tools = DiceTools(services)

    result = await dice_tools.roll_dice(ctx, expression="not-a-dice-expression")

    assert "❌" in result


async def test_skill_check_without_a_character_returns_localized_error():
    services, ctx = _build()
    dice_tools = DiceTools(services)

    result = await dice_tools.skill_check(ctx, skill_name="侦查")

    assert result == services.i18n.with_locale(ctx.locale).t("kp_tools.character.none")


async def test_skill_check_on_a_seeded_skill_yields_deterministic_rank_and_a_real_roll():
    """"侦查" (Spot Hidden) is a fixed COC7 skill value (25) for a fresh character,
    independent of character-generation dice draws, so re-seeding right before the
    check makes the roll - and therefore the success rank - fully reproducible."""
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)

    seed_dice(1)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=True)

    seed_dice(777)
    expected = DiceRoller().roll_coc_check_with_bonus(25, bonus=0, penalty=0)
    expected_label = coc_rank_label(expected["rank"], I18n(locale="en"))

    seed_dice(777)
    text = await dice_tools.skill_check(ctx, skill_name="侦查")

    assert "Vera" in text
    assert "侦查" in text
    assert str(expected["final_roll"]) in text
    assert expected_label in text


async def test_skill_check_records_a_real_skill_check_into_battle_report_when_session_active():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)
    await services.battles.start_session(ctx.chat_key, "Test Session")

    seed_dice(42)
    await dice_tools.skill_check(ctx, skill_name="侦查")

    record = await services.battles.generator.get_current_session(ctx.chat_key)
    assert record is not None
    assert len(record.skill_checks) == 1
    assert record.skill_checks[0]["skill"] == "侦查"
    assert record.skill_checks[0]["char_name"] == "Vera"


async def test_skill_check_does_not_record_or_crash_without_an_active_session():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)

    seed_dice(9)
    result = await dice_tools.skill_check(ctx, skill_name="侦查")

    assert result
    assert await services.battles.generator.get_current_session(ctx.chat_key) is None


async def test_roll_dice_records_into_battle_report_when_session_active():
    services, ctx = _build()
    dice_tools = DiceTools(services)
    await services.battles.start_session(ctx.chat_key)

    seed_dice(3)
    await dice_tools.roll_dice(ctx, expression="1d6")

    record = await services.battles.generator.get_current_session(ctx.chat_key)
    assert record is not None
    assert len(record.dice_rolls) == 1
    assert record.dice_rolls[0]["expression"] == "1d6"


async def test_skill_check_dnd5e_uses_get_dnd_skill_modifier_against_dc():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    # Default DnD5e attributes are all 10 -> ability modifier 0 for every skill.
    await char_tools.create_character(ctx, name="Thorin", system="dnd5e", auto_generate=False)

    seed_dice(9)
    expected = DiceRoller().roll_expression("1d20", is_check=True)

    seed_dice(9)
    result = await dice_tools.skill_check(ctx, skill_name="运动", dc=10)

    assert "Thorin" in result
    assert f"{expected.total}" in result
    assert "DC 10" in result


# ---------------------------------------------------------------------------
# DiceTools — sanity_check / skill_growth / opposed_check / hp_manager / wod_check / random_madness
# ---------------------------------------------------------------------------


async def test_sanity_check_requires_the_coc_system():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Thorin", system="dnd5e", auto_generate=False)

    result = await dice_tools.sanity_check(ctx, success_loss="1", failure_loss="1d6")

    assert "COC7" in result


async def test_sanity_check_updates_san_deterministically():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)  # SAN starts at 50

    seed_dice(11)
    expected_check = DiceRoller().roll_coc_check(50)
    expected_loss = 50 if expected_check["rank"] == -2 else 0  # loss expressions are both "0" below
    expected_san = max(0, 50 - expected_loss)

    seed_dice(11)
    result = await dice_tools.sanity_check(ctx, success_loss="0", failure_loss="0")

    assert f"{expected_san}/50" in result
    sheet = await char_tools.get_character_sheet(ctx)
    assert f"SAN: {expected_san}/50" in sheet


async def test_skill_growth_deterministic_outcome():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)  # "会计" starts at 5

    seed_dice(6)
    expected_roll = random.randint(1, 100)
    expected_growth = random.randint(1, 10) if expected_roll > 5 else None

    seed_dice(6)
    result = await dice_tools.skill_growth(ctx, skill_name="会计")

    if expected_growth is None:
        assert "No growth" in result
    else:
        expected_new = min(100, 5 + expected_growth)
        assert f"{expected_new}" in result
        assert "Success" in result


async def test_skill_growth_maxed_skill_reports_no_growth_needed():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)
    await char_tools.update_character_skill(ctx, skill_name="会计", value=100)

    result = await dice_tools.skill_growth(ctx, skill_name="会计")

    assert "100" in result
    assert "maxed" in result.lower() or "无需成长" in result


async def test_opposed_check_deterministic_outcome():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)  # "侦查" starts at 25

    seed_dice(8)
    r1 = random.randint(1, 100)
    r2 = random.randint(1, 100)

    seed_dice(8)
    result = await dice_tools.opposed_check(ctx, skill1="侦查", skill2="聆听", skill2_value=60)

    assert str(r1) in result
    assert str(r2) in result
    assert "侦查" in result and "聆听" in result


async def test_hp_manager_add_sub_and_show():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)  # HP starts at 10/10

    sub_result = await dice_tools.hp_manager(ctx, action="sub", value=4)
    assert "6/10" in sub_result

    add_result = await dice_tools.hp_manager(ctx, action="add", value=2)
    assert "8/10" in add_result

    show_result = await dice_tools.hp_manager(ctx, action="show")
    assert "8/10" in show_result

    unknown_result = await dice_tools.hp_manager(ctx, action="bogus")
    assert "❌" in unknown_result


async def test_hp_manager_without_a_character_returns_localized_error():
    services, ctx = _build()
    dice_tools = DiceTools(services)

    result = await dice_tools.hp_manager(ctx, action="show")

    assert result == services.i18n.with_locale(ctx.locale).t("kp_tools.character.none")


async def test_wod_check_result_shape():
    services, ctx = _build()
    dice_tools = DiceTools(services)

    seed_dice(4)
    result = await dice_tools.wod_check(ctx, pool_size=5, difficulty=6)

    assert "WoD" in result
    assert "5d10" in result


async def test_random_madness_returns_a_symptom_from_the_requested_table():
    services, ctx = _build()
    dice_tools = DiceTools(services)

    result = await dice_tools.random_madness(ctx, madness_type="long")

    assert any(symptom in result for symptom in _MADNESS_SYMPTOMS["long"])


# ---------------------------------------------------------------------------
# InitiativeTools
# ---------------------------------------------------------------------------


async def test_initiative_tracker_add_list_and_next():
    services, ctx = _build()
    initiative_tools = InitiativeTools(services)

    added_alice = await initiative_tools.initiative_tracker(ctx, action="add", name="Alice", initiative=15)
    assert "Alice" in added_alice
    added_bob = await initiative_tools.initiative_tracker(ctx, action="add", name="Bob", initiative=20)
    assert "Bob" in added_bob

    listed = await initiative_tools.initiative_tracker(ctx, action="list")
    # Higher initiative (Bob, 20) sorts before lower (Alice, 15).
    assert listed.index("Bob") < listed.index("Alice")

    next_result = await initiative_tools.initiative_tracker(ctx, action="next")
    assert "Bob" in next_result

    cleared = await initiative_tools.initiative_tracker(ctx, action="clear")
    assert "✅" in cleared
    empty = await initiative_tools.initiative_tracker(ctx, action="list")
    assert empty == services.i18n.with_locale(ctx.locale).t("kp_tools.initiative.empty")


async def test_initiative_tracker_add_uses_active_character_and_rolls_dice_when_omitted():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    initiative_tools = InitiativeTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)

    seed_dice(2)
    expected = DiceRoller().roll_expression("1d100")

    seed_dice(2)
    result = await initiative_tools.initiative_tracker(ctx, action="add")

    assert "Vera" in result
    assert str(expected.total) in result


async def test_initiative_tracker_unknown_action_returns_localized_error():
    services, ctx = _build()
    initiative_tools = InitiativeTools(services)

    result = await initiative_tools.initiative_tracker(ctx, action="bogus")

    assert "❌" in result


# ---------------------------------------------------------------------------
# Locale wiring — kp_tools.json is consulted per-ctx locale
# ---------------------------------------------------------------------------


async def test_output_is_localized_per_ctx_locale():
    services, _ctx = _build()
    ctx_en = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="en")
    ctx_zh = AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="zh")
    char_tools = CharacterTools(services)

    result_en = await char_tools.get_character_sheet(ctx_en)
    result_zh = await char_tools.get_character_sheet(ctx_zh)

    assert result_en == services.i18n.with_locale("en").t("kp_tools.character.none")
    assert result_zh == services.i18n.with_locale("zh").t("kp_tools.character.none")
    assert result_en != result_zh
    assert "角色卡" in result_zh
