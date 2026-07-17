"""Tests for agent.kp_tools_mechanics: CharacterTools, DiceTools, InitiativeTools.

Services are built fully offline per `docs/specs/M1.md` §6.3's determinism rule
(`FakeLLM`/`FakeEmbeddings`, no network; dice seeded via `core.dice_engine.seed_dice`).
Each test builds its own `Services` (backed by a fresh in-memory `Store`) so tests
never share state.
"""

from __future__ import annotations

import json
import random

import pytest

from agent.context import AgentCtx
from agent.kp_tools_mechanics import _MADNESS_SYMPTOMS, CharacterTools, DiceTools, InitiativeTools
from agent.services import Services, build_services
from agent.tools import Toolset
from core.coc_rules import DEFAULT_COC_RULE, DIFFICULTY_REGULAR, result_check_base
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
# Toolset integration — 18 tools, none keeper_only, valid schemas
# ---------------------------------------------------------------------------


def test_toolset_collects_all_eighteen_tools_and_none_are_keeper_only():
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
        "spend_luck",
        "sanity_check",
        "skill_growth",
        "opposed_check",
        "hp_manager",
        "wod_check",
        "random_madness",
        "initiative_tracker",
    }
    assert len(expected_names) == 18
    assert set(toolset.names()) == expected_names

    schemas = toolset.schemas()
    assert len(schemas) == 18
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
    # Editing POW in-play recomputes MPMAX (80//5=16) but PRESERVES the current MP
    # and SAN — raising a characteristic must never restore spent magic/sanity.
    # (Starting SAN = min(POW, SANMAX) is set at CREATION; here Vera was created at
    # POW 50, so SAN stays 50/99.)
    assert "MP: 10/16" in sheet_after
    assert "SAN: 50/99" in sheet_after


async def test_update_character_tools_clamp_rule_violations_before_saving():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)

    attr_result = await char_tools.update_character_attribute(ctx, attribute="POW", value=999)
    assert "90" in attr_result
    assert "attribute_above_max" in attr_result
    character = await services.characters.get_character(ctx.uid(), ctx.chat_key)
    assert character.attributes["POW"] == 90
    # Raising POW recomputes MPMAX (POW//5 -> 18) but PRESERVES the current MP —
    # an in-play attribute edit never restores spent magic.
    assert character.attributes["MPMAX"] == 18
    assert character.attributes["MP"] == 10

    skill_result = await char_tools.update_character_skill(ctx, skill_name="spot hidden", value=999)
    assert "90" in skill_result
    assert "skill_above_max" in skill_result
    character = await services.characters.get_character(ctx.uid(), ctx.chat_key)
    assert character.skills["侦查"] == 90


async def test_update_dnd_attribute_recomputes_derived_fields_and_routes_hp_edits():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    await char_tools.create_character(ctx, name="Fighter", system="dnd5e", auto_generate=False)
    character = await services.characters.get_character(ctx.uid(), ctx.chat_key)
    character.hp_current = 8
    character.hp_max = 12
    await services.characters.save_character(ctx.uid(), ctx.chat_key, character)

    await char_tools.update_character_attribute(ctx, attribute="DEX", value=14)
    await char_tools.update_character_attribute(ctx, attribute="HP", value=10)

    updated = await services.characters.get_character(ctx.uid(), ctx.chat_key)
    assert updated.secondary_attributes["先攻修正"] == 2
    assert updated.secondary_attributes["护甲等级"] == 12
    assert updated.skills["体操"] == 2
    assert (updated.hp_current, updated.hp_max) == (10, 12)
    assert "HP" not in updated.attributes


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
    assert all(member.get("name") != "Bob" for member in await services.characters.get_party_roster(ctx.chat_key))
    assert "Alice" in listed_after


async def test_switch_character_refuses_sheets_the_caller_does_not_own():
    """The AI KP runs in the acting player's ctx; switching that player's active sheet to a
    character owned by ANOTHER user (a companion/NPC) silently hijacks the player's character
    — observed in live play when the KP wanted a companion to act."""
    services, ctx = _build()
    char_tools = CharacterTools(services)
    await char_tools.create_character(ctx, name="Alice", system="coc7", auto_generate=False)

    other = AgentCtx(chat_key=ctx.chat_key, user_id="companion:shenmo", platform=ctx.platform, locale=ctx.locale)
    await char_tools.create_character(other, name="Shadow", system="coc7", auto_generate=False)

    result = await char_tools.switch_character(ctx, name="Shadow")
    active = await services.characters.get_character(ctx.user_id, ctx.chat_key)
    assert active.name == "Alice"
    assert "Shadow" not in result or "失败" in result or "not" in result.lower()


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
    assert ctx.dice_payloads == [
        {
            "kind": "roll",
            "expr": "3d6+2",
            "rolls": expected.rolls,
            "total": expected.total,
            "modifier": expected.modifier,
            "critical_success": expected.is_critical_success(),
            "critical_failure": expected.is_critical_failure(),
        }
    ]


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
    # The default (en) locale renders the rulepack display name, not the canonical key.
    assert "Spot Hidden" in text
    assert "侦查" not in text
    assert str(expected["final_roll"]) in text
    assert expected_label in text
    payload = ctx.dice_payloads[-1]
    assert payload["kind"] == "check"
    assert payload["expr"] == "Spot Hidden"
    assert payload["rolls"] == [expected["final_roll"]]
    assert payload["total"] == expected["final_roll"]
    assert payload["target"] == 25
    assert payload["effective_target"] == 25
    assert payload["rank"] == expected["rank"]
    assert payload["success"] == expected["success"]
    assert payload["difficulty"] == expected["difficulty"]
    assert payload["bonus"] == 0
    assert payload["penalty"] == 0

    seed_dice(777)
    zh_text = await dice_tools.skill_check(
        AgentCtx(chat_key="cli:dm:t", user_id="u1", locale="zh"), skill_name="spot hidden"
    )
    assert "侦查" in zh_text  # zh keeps the canonical key even for an en alias input


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


async def test_coc_bonus_check_records_raw_and_candidate_tens_metadata():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)

    seed_dice(23)
    await dice_tools.skill_check(ctx, skill_name="侦查", bonus=1)

    record = await services.battles.generator.get_current_session(ctx.chat_key)
    assert record is not None
    check = record.skill_checks[0]
    assert check["bonus"] == 1
    assert check["penalty"] == 0
    assert check["raw_roll"] == check["roll"]
    assert isinstance(check["base_roll"], int)
    assert len(check["extra_tens"]) == 1
    assert isinstance(check["final_tens"], int)
    assert check["difficulty"] == 1
    assert check["rule"] == 0


async def test_skill_check_auto_starts_recording_without_an_active_session():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)

    seed_dice(9)
    result = await dice_tools.skill_check(ctx, skill_name="侦查")

    assert result
    record = await services.battles.generator.get_current_session(ctx.chat_key)
    assert record is not None
    assert len(record.skill_checks) == 1


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


async def test_dnd_skill_check_records_structured_advantage_and_critical_fields():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Thorin", system="dnd5e", auto_generate=False)

    seed_dice(19)
    await dice_tools.skill_check(ctx, skill_name="运动", bonus=1, dc=10, proficient=True)

    record = await services.battles.generator.get_current_session(ctx.chat_key)
    assert record is not None
    check = record.skill_checks[0]
    assert check["target"] == 10
    assert isinstance(check["success"], bool)
    assert len(check["advantage_rolls"]) == 2
    assert check["disadvantage_rolls"] == []
    assert check["raw_roll"] in check["advantage_rolls"]
    assert isinstance(check["is_critical"], bool)
    payload = ctx.dice_payloads[-1]
    assert payload["kind"] == "check"
    assert payload["expr"] == "Athletics"
    assert payload["rolls"] == check["advantage_rolls"]
    assert payload["total"] == check["roll"]
    assert payload["target"] == 10
    assert payload["effective_target"] == 10
    assert payload["rank"] == check["rank"]
    assert payload["success"] == check["success"]
    assert payload["bonus"] == 1
    assert payload["penalty"] == 0


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
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)  # SAN starts at 50/99

    seed_dice(11)
    expected_check = DiceRoller().roll_coc_check(50)
    expected_loss = 50 if expected_check["rank"] == -2 else 0  # loss expressions are both "0" below
    expected_san = max(0, 50 - expected_loss)

    seed_dice(11)
    result = await dice_tools.sanity_check(ctx, success_loss="0", failure_loss="0")

    assert f"{expected_san}/99" in result
    sheet = await char_tools.get_character_sheet(ctx)
    assert f"SAN: {expected_san}/99" in sheet


async def test_sanity_check_records_roll_rank_and_structured_loss():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)

    before = await services.characters.get_character(ctx.uid(), ctx.chat_key)
    assert before is not None
    seed_dice(5)
    await dice_tools.sanity_check(ctx, success_loss="1", failure_loss="1d6")

    record = await services.battles.generator.get_current_session(ctx.chat_key)
    assert record is not None
    check = record.skill_checks[0]
    assert check["skill"] == "SAN"
    assert check["target"] == before.attributes["SAN"]
    assert check["success"] == (check["rank"] >= 1)
    assert check["loss_expr"] in {"1", "1d6"}
    assert check["san_before"] == before.attributes["SAN"]
    assert check["san_after"] == check["san_before"] - check["loss"]
    payload = ctx.dice_payloads[-1]
    assert payload["kind"] == "sanity"
    assert payload["expr"] == "SAN"
    assert payload["rolls"] == [check["roll"]]
    assert payload["total"] == check["roll"]
    assert payload["target"] == check["san_before"]
    assert payload["effective_target"] == check["san_before"]
    assert payload["rank"] == check["rank"]
    assert payload["success"] == check["success"]
    assert payload["loss"] == check["loss"]
    assert payload["remaining"] == check["san_after"]


async def test_spend_luck_atomically_adjusts_latest_own_check_without_reroll(monkeypatch):
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)
    await services.battles.add_skill_check(
        ctx.chat_key,
        ctx.uid(),
        "Vera",
        "侦查",
        50,
        55,
        success=False,
        rank=-1,
        raw_roll=55,
        difficulty=1,
        rule=0,
    )
    await services.battles.add_skill_check(
        ctx.chat_key,
        "another-player",
        "Harvey",
        "聆听",
        40,
        90,
        success=False,
        rank=-1,
        raw_roll=90,
        difficulty=1,
        rule=0,
    )

    def unexpected_roll(*_args, **_kwargs):
        raise AssertionError("Luck spending must not roll dice")

    monkeypatch.setattr(services.dice, "roll_expression", unexpected_roll)
    monkeypatch.setattr(services.dice, "roll_coc_check", unexpected_roll)
    monkeypatch.setattr(services.dice, "roll_coc_check_with_bonus", unexpected_roll)

    result = await dice_tools.spend_luck(ctx, points=6)

    character = await services.characters.get_character(ctx.uid(), ctx.chat_key)
    record = await services.battles.generator.get_current_session(ctx.chat_key)
    assert record is not None
    own_check, other_check = record.skill_checks
    assert character.attributes["LUC"] == 44
    assert own_check["raw_roll"] == 55
    assert own_check["roll"] == 49
    assert own_check["adjusted_roll"] == 49
    assert own_check["luck_spent"] == 6
    assert own_check["luck_adjusted"] is True
    assert own_check["rank"] == 1
    assert own_check["success"] is True
    assert other_check["roll"] == 90
    assert record.player_stats[ctx.uid()]["successful_checks"] == 1
    assert ctx.dice_payloads[-1]["total"] == 49
    assert ctx.dice_payloads[-1]["raw_roll"] == 55
    assert result == services.i18n.with_locale(ctx.locale).t(
        "kp_tools.dice.luck.success",
        points=6,
        before="Failure",
        after="Success",
        luck=44,
    )


async def test_spend_luck_rejects_insufficient_pool_without_partial_update():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)
    await services.battles.add_skill_check(
        ctx.chat_key,
        ctx.uid(),
        "Vera",
        "侦查",
        50,
        55,
        success=False,
        rank=-1,
        raw_roll=55,
        difficulty=1,
        rule=0,
    )
    character_key = f"characters.{ctx.chat_key}.Vera"
    session_key = f"session_record.{ctx.chat_key}.current"
    before_character = await services.store.get(user_key=ctx.uid(), store_key=character_key)
    before_session = await services.store.get(store_key=session_key)

    result = await dice_tools.spend_luck(ctx, points=51)

    assert result == services.i18n.with_locale(ctx.locale).t(
        "kp_tools.dice.luck.insufficient", points=51, luck=50
    )
    assert await services.store.get(user_key=ctx.uid(), store_key=character_key) == before_character
    assert await services.store.get(store_key=session_key) == before_session
    assert ctx.dice_payloads == []


async def test_spend_luck_conflict_leaves_character_and_check_unchanged(monkeypatch):
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)
    await services.battles.add_skill_check(
        ctx.chat_key,
        ctx.uid(),
        "Vera",
        "侦查",
        50,
        55,
        success=False,
        rank=-1,
        raw_roll=55,
        difficulty=1,
        rule=0,
    )
    character_key = f"characters.{ctx.chat_key}.Vera"
    session_key = f"session_record.{ctx.chat_key}.current"
    before_character = await services.store.get(user_key=ctx.uid(), store_key=character_key)
    before_session = await services.store.get(store_key=session_key)

    async def always_conflict(*_args, **_kwargs):
        return False

    monkeypatch.setattr(services.store, "set_rows_if_values", always_conflict, raising=False)

    result = await dice_tools.spend_luck(ctx, points=6)

    assert result == services.i18n.with_locale(ctx.locale).t("kp_tools.dice.luck.conflict")
    assert await services.store.get(user_key=ctx.uid(), store_key=character_key) == before_character
    assert await services.store.get(store_key=session_key) == before_session
    assert ctx.dice_payloads == []


async def test_spend_luck_rejects_sanity_and_non_coc_checks():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)
    await services.battles.add_skill_check(
        ctx.chat_key,
        ctx.uid(),
        "Vera",
        "SAN",
        50,
        60,
        success=False,
        rank=-1,
        raw_roll=60,
        difficulty=1,
        rule=0,
        loss=3,
        san_before=50,
        san_after=47,
    )

    result = await dice_tools.spend_luck(ctx, points=5)

    assert result == services.i18n.with_locale(ctx.locale).t(
        "kp_tools.dice.luck.ineligible", skill="SAN"
    )

    other_services, other_ctx = _build()
    other_tools = DiceTools(other_services)
    await CharacterTools(other_services).create_character(
        other_ctx, name="Thorin", system="dnd5e", auto_generate=False
    )
    assert await other_tools.spend_luck(other_ctx, points=1) == other_services.i18n.with_locale(
        other_ctx.locale
    ).t("kp_tools.dice.luck.coc_only")


async def test_npc_actor_is_recorded_by_name_and_excluded_from_player_stats():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)

    seed_dice(7)
    await dice_tools.roll_dice(ctx, expression="1d20", actor="Cultist")
    await dice_tools.skill_check(ctx, skill_name="侦查", actor="Cultist")

    record = await services.battles.generator.get_current_session(ctx.chat_key)
    assert record is not None
    assert record.dice_rolls[0]["user_id"] == "__npc__"
    assert record.dice_rolls[0]["char_name"] == "Cultist"
    assert record.skill_checks[0]["user_id"] == "__npc__"
    assert record.skill_checks[0]["char_name"] == "Cultist"
    assert record.player_stats == {}


async def test_sanity_check_fumble_drains_all_remaining_san_house_rule(monkeypatch):
    """Locks the intentional house rule on `sanity_check`'s fumble branch (see the
    comment on the `rank == -2` branch in `agent/kp_tools_mechanics.py`): CoC7e RAW
    says a fumble's SAN loss is the MAX of the loss-dice range (e.g. "1d4" tops out
    at 4), but this port faithfully carries over `nekro_trpg_dice_plugin`'s house
    rule of draining ALL remaining SAN instead - confirmed intentional (not a bug
    introduced by this port) since the upstream source has the same behavior with
    its own explicit comment ("大失败时损失所有SAN" - "lose all SAN on a fumble").
    """
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)  # SAN starts at 50/99

    # d100 == 100 is always a fumble under the default CoC rule (rule 0), regardless
    # of skill value (`core.coc_rules.result_check_base`) - force the SAN-check roll.
    # `d20` (used for the "1d4" loss-dice roll below) draws from `random.randrange`,
    # never `random.randint`, so this only pins the SAN-check's own d100 roll.
    monkeypatch.setattr(random, "randint", lambda _lo, _hi: 100)

    result = await dice_tools.sanity_check(ctx, success_loss="1", failure_loss="1d4")

    # A "1d4" failure_loss maxes out at 4 under RAW; the house rule drains all 50.
    assert "0/99" in result
    sheet = await char_tools.get_character_sheet(ctx)
    assert "SAN: 0/99" in sheet


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
    character = await services.characters.get_character(ctx.uid(), ctx.chat_key)
    character.skills["会计"] = 100
    await services.characters.save_character(ctx.uid(), ctx.chat_key, character)

    result = await dice_tools.skill_growth(ctx, skill_name="会计")

    assert "100" in result
    assert "maxed" in result.lower() or "无需成长" in result


async def test_skill_growth_succeeds_on_roll_above_95_even_when_not_above_skill(monkeypatch):
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)
    character = await services.characters.get_character(ctx.uid(), ctx.chat_key)
    character.skills["会计"] = 99
    await services.characters.save_character(ctx.uid(), ctx.chat_key, character)

    # roll 97 is NOT > skill (99) but IS > 95, so the CoC7e experience check still grows
    # (+1d10 -> capped at 100). random.randint is called for the check roll, then the gain.
    queued = iter([97, 4])
    monkeypatch.setattr(random, "randint", lambda _lo, _hi: next(queued))

    result = await dice_tools.skill_growth(ctx, skill_name="会计")

    assert "Success" in result
    sheet = await char_tools.get_character_sheet(ctx)
    assert "会计: 100" in sheet


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


@pytest.mark.parametrize(
    ("value", "roll"),
    [
        (25, 1),  # natural-1 crit regardless of skill
        (25, 5),  # extreme (roll <= 25 // 5)
        (25, 10),  # hard (roll <= 25 // 2)
        (25, 25),  # regular success (roll <= value)
        (25, 26),  # fail
        (25, 96),  # fumble: skill < 50 -> 96-100 band
        (60, 1),  # natural-1 crit
        (60, 12),  # extreme (roll <= 60 // 5)
        (60, 30),  # hard (roll <= 60 // 2)
        (60, 60),  # regular success
        (60, 61),  # fail
        (60, 100),  # fumble: natural 100, any skill
    ],
)
async def test_opposed_check_per_side_level_matches_core_coc_rules(monkeypatch, value, roll):
    """`opposed_check`'s per-side level must come from the SAME authoritative
    `core.coc_rules.result_check_base` ladder used by `skill_check`/`sanity_check`
    (via `core.dice_engine`) - not a private re-implementation that can silently
    drift from it. Covers a natural-1 crit, the extreme/hard/regular-success bands,
    a plain fail, and both fumble bands (96-100 under skill 50, natural 100 otherwise).
    """
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)

    passive_value, passive_roll = 60, 50
    queued = iter([roll, passive_roll])
    monkeypatch.setattr(random, "randint", lambda _lo, _hi: next(queued))

    result = await dice_tools.opposed_check(
        ctx, skill1="侦查", skill2="聆听", skill1_value=value, skill2_value=passive_value
    )

    i18n = services.i18n.with_locale(ctx.locale)
    expected_rank, _ = result_check_base(DEFAULT_COC_RULE, roll, value, DIFFICULTY_REGULAR)
    expected_passive_rank, _ = result_check_base(DEFAULT_COC_RULE, passive_roll, passive_value, DIFFICULTY_REGULAR)
    expected_active_line = i18n.t(
        "kp_tools.dice.opposed.active_line",
        skill="侦查",
        value=value,
        roll=roll,
        level=coc_rank_label(expected_rank, i18n),
    )
    expected_passive_line = i18n.t(
        "kp_tools.dice.opposed.passive_line",
        skill="聆听",
        value=passive_value,
        roll=passive_roll,
        level=coc_rank_label(expected_passive_rank, i18n),
    )
    assert expected_active_line in result
    assert expected_passive_line in result


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


async def test_dnd_hp_manager_preserves_max_through_damage_and_heal():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Fighter", system="dnd5e", auto_generate=False)
    character = await services.characters.get_character(ctx.uid(), ctx.chat_key)
    character.hp_current = 12
    character.hp_max = 12
    await services.characters.save_character(ctx.uid(), ctx.chat_key, character)

    damaged = await dice_tools.hp_manager(ctx, action="sub", value=4)
    assert "8/12" in damaged
    healed = await dice_tools.hp_manager(ctx, action="add", value=3)
    assert "11/12" in healed

    persisted = await services.characters.get_character(ctx.uid(), ctx.chat_key)
    assert (persisted.hp_current, persisted.hp_max) == (11, 12)
    assert "生命值" not in persisted.secondary_attributes
    assert "生命值上限" not in persisted.secondary_attributes


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


async def test_initiative_round_counter_wraps_and_records_each_round_transition():
    services, ctx = _build()
    initiative_tools = InitiativeTools(services)

    await initiative_tools.initiative_tracker(ctx, action="add", name="Alice", initiative=15)
    await initiative_tools.initiative_tracker(ctx, action="add", name="Bob", initiative=20)

    first = await services.battles.generator.get_current_session(ctx.chat_key)
    assert first is not None
    assert [entry["round"] for entry in first.combat_rounds] == [1]

    await initiative_tools.initiative_tracker(ctx, action="next")
    await initiative_tools.initiative_tracker(ctx, action="next")

    raw_meta = await services.store.get(user_key="", store_key=f"initiative_meta.{ctx.chat_key}")
    assert json.loads(raw_meta or "{}")["round"] == 2
    second = await services.battles.generator.get_current_session(ctx.chat_key)
    assert second is not None
    assert [entry["round"] for entry in second.combat_rounds] == [1, 2]


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
