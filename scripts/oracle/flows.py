"""End-to-end vectors for the pack-declared subsystem tools (``agent.kp_tools_subsystems``).

The five generic behaviour templates -- ``check_with_loss`` (sanity), ``improvement_check`` (skill
growth), ``resource_spend_adjust`` (Luck), ``opposed`` and ``table_draw`` (madness) -- are driven
through the REAL tool dispatcher against an in-memory service graph, with scripted randomness. Each
vector records what went in (sheet, arguments, room variant, a pre-existing recorded check), the
draws the engine consumed, and everything that came out: the reply text, the dice-frame payloads,
the character sheet before and after, and the session record's skill checks.
"""

from __future__ import annotations

import asyncio
import copy
from typing import Any

from . import _io  # noqa: F401  (must be imported before the engine; installs the guards)
from ._common import clean_session_record, fresh_sheet_input, sheet_dict
from ._io import error_dict, jsonable, scratch_dir, scripted_random

from agent.context import AgentCtx  # isort: skip
from agent.kp_tools_subsystems import dispatch_subsystem  # isort: skip
from agent.services import Services, build_services, set_room_rule_variant  # isort: skip
from core.character_manager import CharacterSheet  # isort: skip
from core.rulepacks import load_rulepack  # isort: skip
from infra.config import Settings  # isort: skip
from infra.embeddings import FakeEmbeddings  # isort: skip
from infra.llm import FakeLLM  # isort: skip

from . import synthetic  # isort: skip


class Harness:
    """One in-memory service graph; every vector gets its own room (chat key)."""

    def __init__(self) -> None:
        settings = Settings(_env_file=None, data_dir=str(scratch_dir() / "flows"))
        self.services: Services = build_services(settings, llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
        self.count = 0

    async def run(
        self,
        *,
        pack_id: str,
        subsystem: str,
        arguments: dict[str, Any],
        sheet_input: dict[str, Any] | None,
        locale: str = "en",
        variant: str | None = None,
        prior_check: dict[str, Any] | None = None,
        seed: int = 1,
        forced: list[int] | None = None,
    ) -> dict[str, Any]:
        services = self.services
        self.count += 1
        chat_key = f"tui:group:oracle-{self.count}"
        ctx = AgentCtx(chat_key=chat_key, user_id="u1", platform="tui", locale=locale)

        sheet_before: dict[str, Any] | None = None
        if sheet_input is not None:
            sheet = CharacterSheet.from_dict(copy.deepcopy(sheet_input))
            await services.characters.save_character(ctx.uid(), chat_key, sheet)
            sheet_before = sheet_dict(await services.characters.get_character(ctx.uid(), chat_key))
        if variant:
            await set_room_rule_variant(services.store, chat_key, variant)
        if prior_check is not None:
            await services.battles.add_skill_check(
                chat_key, ctx.uid(), prior_check["char_name"], prior_check["skill"], prior_check["target"],
                prior_check["roll"], **prior_check.get("details", {}),
            )

        reply: str | None = None
        error: dict[str, str] | None = None
        with scripted_random(seed, forced, strict=False) as log:
            try:
                reply = await dispatch_subsystem(services, ctx, load_rulepack(pack_id), subsystem, copy.deepcopy(arguments))
            except Exception as exc:  # noqa: BLE001 - the error class IS the vector
                error = error_dict(exc)

        sheet_after: dict[str, Any] | None = None
        if sheet_input is not None:
            sheet_after = sheet_dict(await services.characters.get_character(ctx.uid(), chat_key))
        record = clean_session_record(await services.store.state_get(chat_key, "session_record.current"))
        return {
            "kind": "flow",
            "pack": pack_id,
            "subsystem": subsystem,
            "locale": locale,
            "variant": variant,
            "arguments": arguments,
            "sheet_input": sheet_input,
            "prior_check": prior_check,
            "seed": seed,
            "forced": forced,
            "draws": log.draws,
            "reply": reply,
            "error": error,
            "dice_payloads": jsonable(ctx.dice_payloads),
            "sheet_before": sheet_before,
            "sheet_after": sheet_after,
            "skill_checks": None if record is None else record.get("skill_checks"),
            "player_stats": None if record is None else record.get("player_stats"),
        }


def _locale(index: int) -> str:
    return "en" if index % 2 == 0 else "zh"


# ---------------------------------------------------------------------------
# Case builders
# ---------------------------------------------------------------------------


async def _sanity(harness: Harness) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    pairs = [("0", "1d4"), ("1", "1d6"), ("1d4", "1d10"), ("0", "1d100"), ("0", "0"), ("3", "2d6+3"),
             ("0", "1d6+1d6"), ("0", "abc")]
    index = 0
    for san in (0, 5, 50, 99):
        sheet = fresh_sheet_input("coc7", attributes={"SAN": san})
        for variant in (None, "rule1", "rule3", "dg"):
            for success_loss, failure_loss in pairs:
                for seed in (1, 2, 3):
                    index += 1
                    rows.append(
                        await harness.run(
                            pack_id="coc7", subsystem="sanity_check",
                            arguments={"success_loss": success_loss, "failure_loss": failure_loss},
                            sheet_input=sheet, locale=_locale(index), variant=variant, seed=seed,
                        )
                    )
    # The fumble policy ("all": a fumbled check drains every remaining point) and the crit end.
    sheet = fresh_sheet_input("coc7", attributes={"SAN": 40})
    for forced in ([100, 3], [96, 3], [1, 3], [50, 6], [40, 6], [41, 6]):
        for variant in (None, "rule2", "rule3", "dg"):
            rows.append(
                await harness.run(
                    pack_id="coc7", subsystem="sanity_check", arguments={"success_loss": "1", "failure_loss": "1d6"},
                    sheet_input=sheet, variant=variant, forced=forced,
                )
            )
    # Mythos lowers SANMAX: the stored SAN is clamped on save, before the check ever runs.
    mythos = fresh_sheet_input("coc7", attributes={"SAN": 90}, skills={"克苏鲁神话": 30})
    rows.append(await harness.run(pack_id="coc7", subsystem="sanity_check",
                                  arguments={"success_loss": "0", "failure_loss": "1d6"}, sheet_input=mythos, seed=2))
    # Argument edge cases: missing, scene tag (no ceiling declared), over-long tag, non-string values, no character.
    base = fresh_sheet_input("coc7", attributes={"SAN": 50})
    for arguments in ({}, {"success_loss": "0"}, {"failure_loss": "1d6"}, {"success_loss": "0", "failure_loss": "1d6", "tag": "fire"},
                      {"success_loss": "0", "failure_loss": "1d6", "tag": "x" * 80}, {"success_loss": 1, "failure_loss": 2},
                      {"success_loss": " 1d4 ", "failure_loss": "1D6"}, {"success_loss": "1d4", "failure_loss": "d6"}):
        rows.append(await harness.run(pack_id="coc7", subsystem="sanity_check", arguments=arguments, sheet_input=base, seed=4))
    rows.append(await harness.run(pack_id="coc7", subsystem="sanity_check",
                                  arguments={"success_loss": "0", "failure_loss": "1d6"}, sheet_input=None, seed=1))
    return rows


async def _growth(harness: Harness) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    index = 0
    cases = [("侦查", v) for v in (1, 25, 50, 90, 95, 96, 99, 100)] + [
        ("spot hidden", 25), ("SPOT HIDDEN", 60), ("信用评级", 30), ("闪避", None), ("祖传菜刀", None),
        ("克苏鲁神话", 0), ("母语", None), ("", None), ("图书馆", 99),
    ]
    for skill, value in cases:
        patch = {"skills": {"侦查": value}} if skill in ("侦查", "spot hidden", "SPOT HIDDEN") and value is not None else {}
        if skill == "信用评级":
            patch = {"skills": {"信用": value}}
        if skill == "图书馆":
            patch = {"skills": {"图书馆": value}}
        sheet = fresh_sheet_input("coc7", **patch)
        for seed in (1, 2, 3, 4):
            index += 1
            rows.append(
                await harness.run(pack_id="coc7", subsystem="skill_growth", arguments={"skill_name": skill},
                                  sheet_input=sheet, locale=_locale(index), seed=seed)
            )
    # Forced experience rolls against a skill of 60: above it, 96+ auto-grows, at/below it fails.
    sheet = fresh_sheet_input("coc7", skills={"侦查": 60})
    for roll in (1, 59, 60, 61, 95, 96, 100):
        for growth in (1, 10):
            rows.append(
                await harness.run(pack_id="coc7", subsystem="skill_growth", arguments={"skill_name": "侦查"},
                                  sheet_input=sheet, forced=[roll, growth])
            )
    high = fresh_sheet_input("coc7", skills={"侦查": 98})
    for roll in (99, 100):
        rows.append(
            await harness.run(pack_id="coc7", subsystem="skill_growth", arguments={"skill_name": "侦查"},
                              sheet_input=high, forced=[roll, 10])
        )
    rows.append(await harness.run(pack_id="coc7", subsystem="skill_growth", arguments={}, sheet_input=sheet, seed=1))
    rows.append(await harness.run(pack_id="coc7", subsystem="skill_growth", arguments={"skill_name": "侦查"},
                                  sheet_input=None, seed=1))
    return rows


def _prior_check(
    skill: str, target: int, roll: int, *, variant: str | None = None, difficulty: str | None = None
) -> dict[str, Any]:
    resolver = load_rulepack("coc7").resolver
    from core.check_outcome import RollDetail

    outcome = resolver.interpret(RollDetail("1d100", (roll,), roll), target, variant=variant, difficulty=difficulty)
    details: dict[str, Any] = {
        "success": outcome.rank.success, "rank_id": outcome.rank.id, "tier": outcome.rank.tier,
        "critical": outcome.rank.critical, "fumble": outcome.rank.fumble,
    }
    if variant:
        details["variant"] = variant
    if difficulty:
        details["difficulty"] = difficulty
    return {"char_name": "Vera", "skill": skill, "target": target, "roll": roll, "details": details}


async def _spend_luck(harness: Harness) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    index = 0
    points_list: list[Any] = [1, 5, 10, 54, 55, 99, 0, -1, "3", "x", None, True, 2.5]
    sheet = fresh_sheet_input("coc7", attributes={"LUC": 50})
    for roll in (1, 2, 30, 55, 96, 100):
        for points in points_list:
            index += 1
            rows.append(
                await harness.run(pack_id="coc7", subsystem="spend_luck", arguments={"points": points}, sheet_input=sheet,
                                  prior_check=_prior_check("侦查", 50, roll), locale=_locale(index))
            )
    for variant, difficulty in ((None, "hard"), (None, "extreme"), ("rule3", None), ("dg", "hard"), ("rule2", "critical")):
        for roll in (5, 33, 60, 97):
            for points in (3, 20):
                rows.append(
                    await harness.run(pack_id="coc7", subsystem="spend_luck", arguments={"points": points},
                                      sheet_input=sheet, variant=variant,
                                      prior_check=_prior_check("侦查", 60, roll, variant=variant, difficulty=difficulty))
                )
    for skill in ("理智", "SAN", "幸运", "luck", "侦查", "聆听"):
        rows.append(
            await harness.run(pack_id="coc7", subsystem="spend_luck", arguments={"points": 5}, sheet_input=sheet,
                              prior_check=_prior_check(skill, 50, 60))
        )
    for luc in (0, 3, 10, 50):
        for points in (3, 10, 50):
            rows.append(
                await harness.run(pack_id="coc7", subsystem="spend_luck", arguments={"points": points},
                                  sheet_input=fresh_sheet_input("coc7", attributes={"LUC": luc}),
                                  prior_check=_prior_check("侦查", 50, 80))
            )
    # No recorded check at all, no active character.
    rows.append(await harness.run(pack_id="coc7", subsystem="spend_luck", arguments={"points": 3}, sheet_input=sheet))
    rows.append(await harness.run(pack_id="coc7", subsystem="spend_luck", arguments={"points": 3}, sheet_input=None))
    return rows


async def _opposed(harness: Harness) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    index = 0
    coc = fresh_sheet_input("coc7")
    arg_sets = [
        {"skill1": "侦查", "skill2": "聆听"},
        {"skill1": "侦查", "skill2": "聆听", "skill1_value": 60, "skill2_value": 40},
        {"skill1": "侦查", "skill2": "聆听", "skill1_value": 50, "skill2_value": 50},
        {"skill1": "侦查", "skill2": "聆听", "skill1_value": 0, "skill2_value": 100},
        {"skill1": "spot hidden", "skill2": "unknown skill"},
        {"skill1": "力量", "skill2": "体型", "skill1_value": 80, "skill2_value": 30},
        {"skill1": "a", "skill2": "b", "skill1_value": "70", "skill2_value": 20.0},
    ]
    for variant in (None, "rule3", "dg"):
        for arguments in arg_sets:
            for seed in (1, 2, 3):
                index += 1
                rows.append(await harness.run(pack_id="coc7", subsystem="opposed_check", arguments=arguments,
                                              sheet_input=coc, locale=_locale(index), variant=variant, seed=seed))
    dnd = fresh_sheet_input("dnd5e", attributes={"STR": 16, "DEX": 12})
    for arguments in (
        {"skill1": "运动", "skill2": "体操"}, {"skill1": "athletics", "skill2": "acrobatics"},
        {"skill1": "力量", "skill2": "敏捷", "skill1_value": 3, "skill2_value": 1},
        {"skill1": "运动", "skill2": "体操", "skill1_value": 5, "skill2_value": 5},
    ):
        for seed in (1, 2, 3, 4, 5, 6):
            index += 1
            rows.append(await harness.run(pack_id="dnd5e", subsystem="opposed_check", arguments=arguments,
                                          sheet_input=dnd, locale=_locale(index), seed=seed))
    for forced in ([100, 1], [1, 100], [1, 1], [50, 50], [20, 1], [1, 20], [20, 20]):
        rows.append(await harness.run(pack_id="coc7", subsystem="opposed_check", arguments=arg_sets[1], sheet_input=coc, forced=forced))
        rows.append(await harness.run(pack_id="dnd5e", subsystem="opposed_check", arguments=arg_sets[0] | {"skill1": "运动", "skill2": "体操"},
                                      sheet_input=dnd, forced=forced[:2]))
    return rows


async def _madness(harness: Harness) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    index = 0
    sheet = fresh_sheet_input("coc7")
    for table in ("temp", "long", "indefinite", "临时", "temporary", "总结", "总结性", "不定", "", "unknown", " TEMP ", "Long"):
        for seed in (1, 2, 3, 4):
            index += 1
            rows.append(await harness.run(pack_id="coc7", subsystem="random_madness", arguments={"table": table},
                                          sheet_input=sheet, locale=_locale(index), seed=seed))
    for forced in ([1], [8]):
        for table in ("temp", "long", "indefinite"):
            rows.append(await harness.run(pack_id="coc7", subsystem="random_madness", arguments={"table": table},
                                          sheet_input=sheet, forced=forced))
    rows.append(await harness.run(pack_id="coc7", subsystem="random_madness", arguments={}, sheet_input=None, seed=1))
    return rows


async def _synthetic(harness: Harness) -> list[dict[str, Any]]:
    """The same templates on the literal ``oraclesynth`` pack: ``max`` fumble policy, ``loss_ceiling``,
    a different cap / auto-success threshold, a d20 re-grade for the spend, a dc-kind opposed check."""
    pack = synthetic.SYNTH_ID
    rows: list[dict[str, Any]] = []
    index = 0
    for level in (1, 5):
        for fate in (1, 3, 6):
            sheet = fresh_sheet_input(pack, attributes={"FATE": fate}, fields={"level": level})
            for tag in ("", "safe", "fire"):
                for success_loss, failure_loss in (("0", "1d6"), ("1", "2d4+1"), ("0", "d6")):
                    for variant in (None, "lenient"):
                        for forced in ([1, 5], [20, 5], [10, 6], [15, 4]):
                            index += 1
                            rows.append(
                                await harness.run(
                                    pack_id=pack, subsystem="stress_check",
                                    arguments={"success_loss": success_loss, "failure_loss": failure_loss, "tag": tag},
                                    sheet_input=sheet, variant=variant, forced=forced, locale=_locale(index),
                                )
                            )
    for seed in (1, 2, 3):
        rows.append(await harness.run(pack_id=pack, subsystem="stress_check",
                                      arguments={"success_loss": "0", "failure_loss": "1d6", "tag": "safe"},
                                      sheet_input=fresh_sheet_input(pack), seed=seed))
    sheet = fresh_sheet_input(pack)
    for skill, value in (("lore", 0), ("lore", 10), ("lore", 19), ("lore", 20), ("sneak", 5), ("athletics", None), ("bluff", 12)):
        patch: dict[str, Any] = {"skills": {"LORE": value}} if skill == "lore" else (
            {"skills": {"sneak": value}} if skill == "sneak" else {"skills": {skill: value}}
        )
        for forced in ([1, 2], [5, 2], [17, 4], [18, 4], [19, 3], [20, 4]):
            rows.append(await harness.run(pack_id=pack, subsystem="grow", arguments={"skill_name": skill},
                                          sheet_input=fresh_sheet_input(pack, **patch), forced=forced))
    for roll in (1, 2, 8, 15, 19, 20):
        for points in (1, 3, 7, 19):
            rows.append(
                await harness.run(
                    pack_id=pack, subsystem="spend_fate", arguments={"points": points},
                    sheet_input=fresh_sheet_input(pack, attributes={"FATE": 6}),
                    prior_check=_synthetic_prior(roll, 12),
                )
            )
    for arguments in ({"skill1": "athletics", "skill2": "bluff"}, {"skill1": "lore", "skill2": "sneak", "skill1_value": 4, "skill2_value": 9}):
        for forced in ([1, 20], [20, 1], [10, 10], [15, 12]):
            rows.append(await harness.run(pack_id=pack, subsystem="clash", arguments=arguments, sheet_input=sheet, forced=forced))
    for table in ("minor", "major", "small", "小", "", "none"):
        for forced in ([1], [2], [3], [1], [2]):
            rows.append(await harness.run(pack_id=pack, subsystem="omen", arguments={"table": table}, sheet_input=sheet, forced=forced))
    return rows


def _synthetic_prior(roll: int, target: int) -> dict[str, Any]:
    from core.check_outcome import RollDetail

    resolver = load_rulepack(synthetic.SYNTH_ID).resolver
    outcome = resolver.interpret(RollDetail("1d20", (roll,), roll), target)
    return {
        "char_name": "Vera", "skill": "athletics", "target": target, "roll": roll,
        "details": {
            "success": outcome.rank.success, "rank_id": outcome.rank.id, "tier": outcome.rank.tier,
            "critical": outcome.rank.critical, "fumble": outcome.rank.fumble,
        },
    }


async def _all() -> list[dict[str, Any]]:
    harness = Harness()
    rows: list[dict[str, Any]] = []
    for builder in (_sanity, _growth, _spend_luck, _opposed, _madness, _synthetic):
        rows.extend(await builder(harness))
    return rows


def rows() -> list[dict[str, Any]]:
    synthetic.install()
    return asyncio.run(_all())
