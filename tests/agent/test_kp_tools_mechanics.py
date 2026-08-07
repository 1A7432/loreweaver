"""Tests for agent.kp_tools_mechanics: CharacterTools, DiceTools, InitiativeTools.

Services are built fully offline per `docs/specs/M1.md` §6.3's determinism rule
(`FakeLLM`/`FakeEmbeddings`, no network; dice seeded via `core.dice_engine.seed_dice`).
Each test builds its own `Services` (backed by a fresh in-memory `Store`) so tests
never share state.
"""

from __future__ import annotations

import json
import random
from types import SimpleNamespace

import pytest

from agent.context import AgentCtx
from agent.kp_tools_mechanics import CharacterTools, DiceTools, InitiativeTools
from agent.kp_tools_subsystems import dispatch_subsystem, subsystem_schemas
from agent.services import Services, build_services
from agent.tools import Toolset
from core.check_outcome import RollDetail
from core.dice_engine import DiceRoller, seed_dice
from core.rulepacks import load_rulepack
from core.sheets import sheet_value
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.i18n import I18n
from infra.llm import FakeLLM


async def _run_sub(services: Services, ctx: AgentCtx, name: str, **args):
    """Dispatch a pack-materialized subsystem tool the way the loop does."""
    return await dispatch_subsystem(services, ctx, load_rulepack("coc7"), name, args)


def _build() -> tuple[Services, AgentCtx]:
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    ctx = AgentCtx(chat_key="cli:dm:t", user_id="u1")
    return services, ctx


# ---------------------------------------------------------------------------
# Toolset integration — 18 tools, none keeper_only, valid schemas
# ---------------------------------------------------------------------------


def test_toolset_collects_all_twelve_static_tools_and_none_are_keeper_only():
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
        "hp_manager",
        "initiative_tracker",
    }
    assert len(expected_names) == 12
    assert set(toolset.names()) == expected_names

    schemas = toolset.schemas()
    assert len(schemas) == 12
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
    assert "coc7" in created

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
    assert "dnd5e" in created

    sheet = await char_tools.get_character_sheet(ctx)
    assert "Thorin" in sheet
    assert "dnd5e" in sheet


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
    dnd_pack = load_rulepack("dnd5e")
    assert sheet_value(updated, dnd_pack, "先攻修正") == 2
    assert sheet_value(updated, dnd_pack, "护甲等级") == 12
    assert sheet_value(updated, dnd_pack, "体操") == 2
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
            "detail": {
                "modifier": expected.modifier,
                "critical_success": expected.is_critical_success(),
                "critical_failure": expected.is_critical_failure(),
            },
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

    pack = load_rulepack("coc7")
    seed_dice(777)
    expected_rolled = DiceRoller().roll_for_check(pack.resolver)
    expected_outcome = pack.resolver.interpret(expected_rolled, 25)
    expected_label = pack.rank_label(expected_outcome.rank.id, "en")

    seed_dice(777)
    text = await dice_tools.skill_check(ctx, skill_name="侦查")

    assert "Vera" in text
    # The default (en) locale renders the rulepack display name, not the canonical key.
    assert "Spot Hidden" in text
    assert "侦查" not in text
    assert str(expected_rolled.total) in text
    assert expected_label in text
    payload = ctx.dice_payloads[-1]
    assert payload["kind"] == "check"
    assert payload["expr"] == "Spot Hidden"
    assert payload["rolls"] == [expected_rolled.total]
    assert payload["total"] == expected_rolled.total
    assert payload["target"] == 25
    assert payload["effective_target"] == 25
    assert payload["outcome"]["id"] == expected_outcome.rank.id
    assert payload["outcome"]["label"] == expected_label
    assert payload["outcome"]["success"] == expected_outcome.rank.success
    assert payload["outcome"]["tier"] == expected_outcome.rank.tier
    assert payload["detail"]["bonus"] == 0
    assert payload["detail"]["penalty"] == 0

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
    # `base_roll` is the pre-bonus d100; `raw_roll` belongs to the Luck layer only.
    assert isinstance(check["base_roll"], int)
    assert "raw_roll" not in check
    assert len(check["extra_tens"]) == 1
    assert isinstance(check["final_tens"], int)
    assert check["rank_id"] in {"crit", "extreme", "hard", "regular", "fail", "fumble"}
    assert isinstance(check["tier"], int)


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
    assert "target 10" in result


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
    # Advantage rolled 2d20kh1: every candidate face is recorded, one was kept.
    assert len(check["dice_all"]) == 2
    assert check["advantage"] == 1
    assert check["modifier"] == 2  # proficiency bonus on a 10-ability sheet
    assert isinstance(check["critical"], bool)
    assert isinstance(check["fumble"], bool)
    assert check["rank_id"] in {"crit", "success", "fail", "fumble"}
    payload = ctx.dice_payloads[-1]
    assert payload["kind"] == "check"
    assert payload["expr"] == "Athletics"
    assert payload["rolls"] == check["dice_all"]
    assert payload["target"] == 10
    assert payload["effective_target"] == 10
    assert payload["outcome"]["success"] == check["success"]
    assert payload["outcome"]["id"] == check["rank_id"]
    assert payload["outcome"]["label"]
    assert payload["detail"]["bonus"] == 1
    assert payload["detail"]["penalty"] == 0


async def test_coc_npc_skill_check_requires_and_uses_explicit_target_without_player_sheet_leak():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)

    seed_dice(314)
    expected_rolled = DiceRoller().roll_for_check(load_rulepack("coc7").resolver)
    seed_dice(314)
    result = await dice_tools.skill_check(
        ctx,
        skill_name="化学",
        actor="Fire Captain Zhao",
        npc_target=73,
    )

    assert "73" in result
    assert ctx.dice_payloads[-1]["target"] == 73
    assert ctx.dice_payloads[-1]["total"] == expected_rolled.total
    record = await services.battles.generator.get_current_session(ctx.chat_key)
    assert record is not None
    assert record.skill_checks[0]["user_id"] == "__npc__"
    assert record.skill_checks[0]["char_name"] == "Fire Captain Zhao"
    assert record.skill_checks[0]["target"] == 73


async def test_dnd_npc_skill_check_uses_explicit_total_modifier():
    services, ctx = _build()
    await CharacterTools(services).create_character(ctx, name="Kael", system="dnd5e", auto_generate=False)
    dice_tools = DiceTools(services)

    seed_dice(91)
    natural = DiceRoller().roll_expression("1d20", is_check=True)
    seed_dice(91)
    await dice_tools.skill_check(
        ctx,
        skill_name="Perception",
        dc=14,
        actor="Goblin Scout",
        npc_target=6,
    )

    payload = ctx.dice_payloads[-1]
    assert payload["detail"]["modifier"] == 6
    assert payload["total"] == natural.total + 6
    record = await services.battles.generator.get_current_session(ctx.chat_key)
    assert record is not None
    assert record.skill_checks[0]["user_id"] == "__npc__"
    # The record keeps the natural roll and the modifier separately (their sum
    # is the compared value, mirrored by outcome margin vs the DC).
    assert record.skill_checks[0]["roll"] == natural.total
    assert record.skill_checks[0]["modifier"] == 6


@pytest.mark.parametrize("system", ["coc7", "dnd5e"])
async def test_actor_without_npc_target_errors_before_rolling(system: str):
    services, ctx = _build()
    await CharacterTools(services).create_character(ctx, name="Kael Thorn", system=system, auto_generate=False)
    dice_tools = DiceTools(services)

    seed_dice(117)
    result = await dice_tools.skill_check(ctx, skill_name="侦查", actor="凯尔")
    after = services.dice.roll_expression("1d20").total
    seed_dice(117)
    expected = services.dice.roll_expression("1d20").total

    assert result == services.i18n.with_locale(ctx.locale).t("kp_tools.dice.skill_check.npc_target_required")
    assert after == expected
    assert ctx.dice_payloads == []
    assert await services.battles.generator.get_current_session(ctx.chat_key) is None


async def test_room_roster_actor_name_is_attributed_to_player_for_checks_and_plain_rolls():
    services, ctx = _build()
    other_ctx = AgentCtx(chat_key=ctx.chat_key, user_id="u2", locale="en")
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)
    await char_tools.create_character(other_ctx, name="Morgan", system="coc7", auto_generate=False)

    await dice_tools.skill_check(ctx, skill_name="侦查", actor="mORGaN")
    await dice_tools.roll_dice(ctx, expression="1d6", actor="MORGAN")

    record = await services.battles.generator.get_current_session(ctx.chat_key)
    assert record is not None
    assert record.skill_checks[0]["user_id"] == ctx.uid()
    assert record.skill_checks[0]["char_name"] == "Morgan"
    assert record.dice_rolls[0]["user_id"] == ctx.uid()
    assert record.dice_rolls[0]["char_name"] == "Morgan"


# ---------------------------------------------------------------------------
# DiceTools — subsystem tools (loss/growth/opposed/tables) / hp_manager / pool checks
# ---------------------------------------------------------------------------


async def test_subsystem_tools_materialize_only_from_the_declaring_pack():
    """Stage D materialization: a subsystem tool exists exactly where the pack
    declares it — schema absent AND dispatch falls through elsewhere."""
    services, ctx = _build()

    coc_names = {schema["function"]["name"] for schema in subsystem_schemas(load_rulepack("coc7"))}
    dnd_names = {schema["function"]["name"] for schema in subsystem_schemas(load_rulepack("dnd5e"))}
    assert {"sanity_check", "skill_growth", "spend_luck", "opposed_check", "random_madness"} <= coc_names
    assert "sanity_check" not in dnd_names and "random_madness" not in dnd_names

    undeclared = await dispatch_subsystem(
        services, ctx, load_rulepack("dnd5e"), "sanity_check", {"success_loss": "1", "failure_loss": "1d6"}
    )
    assert undeclared is None  # the loop falls through to the static toolset (unknown tool)


async def test_sanity_check_updates_san_deterministically():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)  # SAN starts at 50/99

    pack = load_rulepack("coc7")
    seed_dice(11)
    expected_check = pack.resolver.interpret(DiceRoller().roll_for_check(pack.resolver), 50)
    expected_loss = 50 if expected_check.rank.fumble else 0  # loss expressions are both "0" below
    expected_san = max(0, 50 - expected_loss)

    seed_dice(11)
    result = await _run_sub(services, ctx, "sanity_check", success_loss="0", failure_loss="0")

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
    await _run_sub(services, ctx, "sanity_check", success_loss="1", failure_loss="1d6")

    record = await services.battles.generator.get_current_session(ctx.chat_key)
    assert record is not None
    check = record.skill_checks[0]
    assert check["skill"] == "SAN"
    assert check["target"] == before.attributes["SAN"]
    assert check["success"] == (check["tier"] >= 2)  # tiers 2+ are the CoC success rungs
    assert check["rank_id"] in {"crit", "extreme", "hard", "regular", "fail", "fumble"}
    assert check["label"]
    assert check["loss_expr"] in {"1", "1d6"}
    assert check["stat_before"] == before.attributes["SAN"]
    assert check["stat_after"] == check["stat_before"] - check["loss"]
    payload = ctx.dice_payloads[-1]
    assert payload["kind"] == "subsystem"
    assert payload["subsystem"] == "sanity_check"
    assert payload["expr"] == "SAN"
    assert payload["rolls"] == [check["roll"]]
    assert payload["total"] == check["roll"]
    assert payload["target"] == check["stat_before"]
    assert payload["effective_target"] == check["stat_before"]
    assert payload["outcome"]["label"] == check["label"]
    assert payload["outcome"]["success"] == check["success"]
    assert payload["detail"]["loss"] == check["loss"]
    assert payload["detail"]["remaining"] == check["stat_after"]


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
        rank_id="fail",
        tier=1,
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
        rank_id="fail",
        tier=1,
        difficulty=1,
        rule=0,
    )

    def unexpected_roll(*_args, **_kwargs):
        raise AssertionError("Luck spending must not roll dice")

    monkeypatch.setattr(services.dice, "roll_expression", unexpected_roll)
    monkeypatch.setattr(services.dice, "roll_for_check", unexpected_roll)
    monkeypatch.setattr(services.dice, "roll_detail", unexpected_roll)

    result = await _run_sub(services, ctx, "spend_luck", points=6)

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
    assert own_check["rank_id"] == "regular"
    assert own_check["success"] is True
    assert other_check["roll"] == 90
    assert record.player_stats[ctx.uid()]["successful_checks"] == 1
    assert ctx.dice_payloads[-1]["total"] == 49
    assert ctx.dice_payloads[-1]["detail"]["raw_roll"] == 55
    assert result == services.i18n.with_locale(ctx.locale).t(
        "kp_tools.subsystem.spend.done",
        label="Luck",
        name="Vera",
        points=6,
        skill="侦查",
        before=55,
        after=49,
        level="Success",
        remaining=44,
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
    before_character = await services.documents.get(ctx.chat_key, "sheet", "Vera")
    before_session = await services.store.state_get(ctx.chat_key, "session_record.current")

    result = await _run_sub(services, ctx, "spend_luck", points=51)

    assert result == services.i18n.with_locale(ctx.locale).t(
        "kp_tools.subsystem.spend.insufficient", label="Luck", points=51, available=50
    )
    assert await services.documents.get(ctx.chat_key, "sheet", "Vera") == before_character
    assert await services.store.state_get(ctx.chat_key, "session_record.current") == before_session
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
    before_character = await services.documents.get(ctx.chat_key, "sheet", "Vera")
    before_session = await services.store.state_get(ctx.chat_key, "session_record.current")

    async def always_conflict(*_args, **_kwargs):
        return False

    # The session record is now the room_state CAS resource `spend_luck` contends
    # on (`store.state_set_if_values`) — force every attempt to lose the race so
    # both retries exhaust and the tool reports a conflict.
    monkeypatch.setattr(services.store, "state_set_if_values", always_conflict, raising=False)

    result = await _run_sub(services, ctx, "spend_luck", points=6)

    assert result == services.i18n.with_locale(ctx.locale).t("kp_tools.subsystem.spend.conflict", label="Luck")
    assert await services.documents.get(ctx.chat_key, "sheet", "Vera") == before_character
    assert await services.store.state_get(ctx.chat_key, "session_record.current") == before_session
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

    result = await _run_sub(services, ctx, "spend_luck", points=5)

    assert result == services.i18n.with_locale(ctx.locale).t(
        "kp_tools.subsystem.spend.ineligible", label="Luck", skill="SAN"
    )


async def test_spend_luck_rejects_fumble_without_mutation():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)
    await services.battles.add_skill_check(
        ctx.chat_key,
        ctx.uid(),
        "Vera",
        "侦查",
        45,
        100,
        success=False,
        rank=-2,
        raw_roll=100,
        difficulty=1,
        rule=0,
    )
    before_session = await services.store.state_get(ctx.chat_key, "session_record.current")

    result = await _run_sub(services, ctx, "spend_luck", points=10)

    assert result == services.i18n.with_locale(ctx.locale).t("kp_tools.subsystem.spend.fumble", label="Luck")
    assert await services.store.state_get(ctx.chat_key, "session_record.current") == before_session
    assert ctx.dice_payloads == []


async def test_spend_luck_rejects_overspend_that_would_push_roll_below_one():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)
    await services.battles.add_skill_check(
        ctx.chat_key,
        ctx.uid(),
        "Vera",
        "侦查",
        25,
        27,
        success=False,
        rank=-1,
        raw_roll=27,
        difficulty=1,
        rule=0,
    )
    before_session = await services.store.state_get(ctx.chat_key, "session_record.current")

    result = await _run_sub(services, ctx, "spend_luck", points=27)

    assert result == services.i18n.with_locale(ctx.locale).t(
        "kp_tools.subsystem.spend.exceeds_roll", label="Luck", points=27, roll=27, max=26
    )
    assert await services.store.state_get(ctx.chat_key, "session_record.current") == before_session
    assert ctx.dice_payloads == []

    other_services, other_ctx = _build()
    await CharacterTools(other_services).create_character(
        other_ctx, name="Thorin", system="dnd5e", auto_generate=False
    )
    # A system that declares no luck-family subsystem simply has no such tool.
    assert (
        await dispatch_subsystem(other_services, other_ctx, load_rulepack("dnd5e"), "spend_luck", {"points": 1})
        is None
    )


async def test_npc_actor_is_recorded_by_name_and_excluded_from_player_stats():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)

    seed_dice(7)
    await dice_tools.roll_dice(ctx, expression="1d20", actor="Cultist")
    await dice_tools.skill_check(ctx, skill_name="侦查", actor="Cultist", npc_target=45)

    record = await services.battles.generator.get_current_session(ctx.chat_key)
    assert record is not None
    assert record.dice_rolls[0]["user_id"] == "__npc__"
    assert record.dice_rolls[0]["char_name"] == "Cultist"
    assert record.skill_checks[0]["user_id"] == "__npc__"
    assert record.skill_checks[0]["char_name"] == "Cultist"
    assert record.player_stats == {}


async def test_sanity_check_fumble_drains_all_remaining_san_house_rule(monkeypatch):
    """Locks the intentional house rule the coc7 pack declares (``fumble_loss:
    all`` on its check_with_loss subsystem): CoC7e RAW would take the loss
    dice's maximum ("1d4" tops out at 4); the pack drains ALL remaining points,
    faithfully carried over from the pre-M16 engine."""
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)  # SAN starts at 50/99

    # d100 == 100 is always a fumble under the default ladder, regardless of
    # skill value — pin the SAN-check's own roll to 100 (the "1d4" loss dice
    # below still roll for real).
    monkeypatch.setattr(
        services.dice, "roll_for_check", lambda resolver, **kwargs: RollDetail("1d100", (100,), 100)
    )

    result = await _run_sub(services, ctx, "sanity_check", success_loss="1", failure_loss="1d4")

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
    expected_roll = DiceRoller().roll_expression("1d100").total
    expected_growth = DiceRoller().roll_expression("1d10").total if expected_roll > 5 else None

    seed_dice(6)
    result = await _run_sub(services, ctx, "skill_growth", skill_name="会计")

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

    result = await _run_sub(services, ctx, "skill_growth", skill_name="会计")

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

    # roll 97 is NOT > skill (99) but IS > the pack's auto_success_above (95), so the
    # experience check still grows (+1d10 -> capped at 100). The improvement roll and the
    # gain roll both go through the dice engine.
    queued = iter([97, 4])
    monkeypatch.setattr(
        services.dice, "roll_expression", lambda _expr, **_kw: SimpleNamespace(total=next(queued))
    )

    result = await _run_sub(services, ctx, "skill_growth", skill_name="会计")

    assert "Success" in result
    sheet = await char_tools.get_character_sheet(ctx)
    assert "会计: 100" in sheet


async def test_opposed_check_deterministic_outcome():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)  # "侦查" starts at 25

    pack = load_rulepack("coc7")
    seed_dice(8)
    r1 = DiceRoller().roll_for_check(pack.resolver).total
    r2 = DiceRoller().roll_for_check(pack.resolver).total

    seed_dice(8)
    result = await _run_sub(services, ctx, "opposed_check", skill1="侦查", skill2="聆听", skill2_value=60)

    assert str(r1) in result
    assert str(r2) in result
    assert "侦查" in result and "聆听" in result


async def test_opposed_check_levels_come_from_the_pack_ladder():
    """`opposed_check`'s per-side levels must come from the SAME compiled pack
    ladder used by `skill_check`/`sanity_check` — never a private
    re-implementation that can drift. Seed-replayed against the resolver."""
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)

    pack = load_rulepack("coc7")
    value, passive_value = 60, 60
    seed_dice(19)
    expected_active = pack.resolver.interpret(DiceRoller().roll_for_check(pack.resolver), value)
    expected_passive = pack.resolver.interpret(DiceRoller().roll_for_check(pack.resolver), passive_value)

    seed_dice(19)
    result = await _run_sub(
        services, ctx, "opposed_check", skill1="侦查", skill2="聆听", skill1_value=value, skill2_value=passive_value
    )

    i18n = services.i18n.with_locale(ctx.locale)
    expected_active_line = i18n.t(
        "kp_tools.dice.opposed.active_line",
        skill="侦查",
        value=value,
        roll=expected_active.rolled.total,
        level=pack.rank_label(expected_active.rank.id, ctx.locale),
    )
    expected_passive_line = i18n.t(
        "kp_tools.dice.opposed.passive_line",
        skill="聆听",
        value=passive_value,
        roll=expected_passive.rolled.total,
        level=pack.rank_label(expected_passive.rank.id, ctx.locale),
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


async def test_pool_parameterized_check_rides_skill_check_params():
    """The old dedicated pool tool is gone (stage D): a pool system's graded
    check is `skill_check(params=...)` under the ROOM's pack."""
    services = build_services(
        Settings(default_rulepack="wod"), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64)
    )
    ctx = AgentCtx(chat_key="cli:dm:pool", user_id="u1")
    dice_tools = DiceTools(services)

    seed_dice(4)
    result = await dice_tools.skill_check(ctx, skill_name="", params={"pool": 5, "difficulty": 6})

    assert "5d10" in result

    out_of_range = await dice_tools.skill_check(ctx, skill_name="", params={"pool": 20_000_000})
    assert out_of_range == services.i18n.with_locale(ctx.locale).t(
        "kp_tools.dice.pool.out_of_range", param="pool", minimum=1, maximum=200
    )


async def test_random_madness_draws_from_the_packs_declared_table():
    services, ctx = _build()

    spec = load_rulepack("coc7").subsystems["random_madness"]
    long_table = spec.table("long")
    assert long_table is not None

    result = await _run_sub(services, ctx, "random_madness", table="long")
    assert any(entry in result for entry in long_table.entries)

    aliased = await _run_sub(services, ctx, "random_madness", table="总结")
    assert any(entry in aliased for entry in long_table.entries)


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
    assert "Alice" in next_result

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

    raw_meta = await services.store.state_get(ctx.chat_key, "initiative_meta")
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


async def test_skill_check_resolves_chinese_attribute_names_to_codes():
    """"力量" must roll against STR's attribute value, not fall through to a nonexistent
    skill with target 0 (2026-08-05 play-test Bug6: a roll of 1 read as a critical)."""
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)

    seed_dice(1)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=True)
    character = await services.characters.get_character(ctx.uid(), ctx.chat_key)
    strength = character.attributes.get("STR", 0)
    assert strength > 0

    seed_dice(777)
    text = await dice_tools.skill_check(ctx, skill_name="力量")

    assert f"{strength}" in text  # the target line carries STR's real value
    assert "0" != f"{strength}"


async def test_skill_check_refuses_unknown_skill_names():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    dice_tools = DiceTools(services)

    seed_dice(1)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=True)

    text = await dice_tools.skill_check(ctx, skill_name="呼啦圈精通")

    expected = services.i18n.with_locale(ctx.locale).t(
        "kp_tools.dice.skill_check.unknown_skill", name="呼啦圈精通"
    )
    assert text == expected


# ---------------------------------------------------------------------------
# check_with_loss: conditional loss ceiling (`loss_ceiling: {when, value}`)
# ---------------------------------------------------------------------------

_CEILING_PACK_YAML = """\
extends: coc7
names: [coc7-ceiling-test]
subsystems:
  sanity_check:
    loss_ceiling: {when: 'tag == "fire"', value: 0}
"""


def _ceiling_pack():
    from core.rulepacks import load_raw_rulepack_yaml, parse_rulepack_text

    return parse_rulepack_text("coc7-ceiling-test", _CEILING_PACK_YAML, base_loader=load_raw_rulepack_yaml)


async def test_loss_ceiling_caps_loss_only_when_the_condition_holds(monkeypatch):
    services, ctx = _build()
    char_tools = CharacterTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)  # SAN 50/99

    pack = _ceiling_pack()
    assert pack.subsystems["sanity_check"].loss_ceiling == ('tag == "fire"', 0)
    monkeypatch.setattr("agent.kp_tools_subsystems.load_rulepack", lambda *a, **k: pack)

    # Tag matches: the ceiling caps even a fumble's all-loss at 0.
    seed_dice(11)
    capped = await dispatch_subsystem(
        services, ctx, pack, "sanity_check", {"success_loss": "0", "failure_loss": "1d6", "tag": "fire"}
    )
    assert "Loss ceiling applied: capped at 0" in capped
    sheet = await char_tools.get_character_sheet(ctx)
    assert "SAN: 50/99" in sheet

    # No tag: the same seeded roll takes its normal course — no ceiling line.
    seed_dice(11)
    uncapped = await dispatch_subsystem(
        services, ctx, pack, "sanity_check", {"success_loss": "0", "failure_loss": "1d6"}
    )
    assert "Loss ceiling applied" not in uncapped


async def test_loss_ceiling_absent_in_base_pack_never_caps():
    services, ctx = _build()
    char_tools = CharacterTools(services)
    await char_tools.create_character(ctx, name="Vera", system="coc7", auto_generate=False)

    pack = load_rulepack("coc7")
    assert pack.subsystems["sanity_check"].loss_ceiling is None
    seed_dice(11)
    result = await _run_sub(services, ctx, "sanity_check", success_loss="0", failure_loss="1d6", tag="fire")
    assert "Loss ceiling applied" not in result
