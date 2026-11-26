"""Reference vectors for the rule-system layer: check grading, check rolling, Luck, pack metadata.

``CheckResolver.interpret`` is pure, so its input spaces are enumerated cell by cell (the same
ranges as ``tests/core/test_resolution_tables.py``, widened where cheap) and the ENGINE's answer is
recorded. Anything that rolls runs under scripted randomness (see ``_io.scripted_random``).

Outputs (schemas in ``server/test/fixtures/reference/README.md``):

* ``rules_pack_meta``      -- per built-in pack: compiled resolver shape, rank ladders, labels
* ``rules_coc7_grid``      -- every d100 roll x target x difficulty x house variant
* ``rules_dnd5e_grid``     -- every natural d20 x flat modifier x DC
* ``rules_wod_grid``       -- every (successes, ones) cell of every pool size
* ``rules_interpret_cases``-- single-cell edge cases of ``interpret`` (unknown ids, missing target, ...)
* ``rules_check_roll``     -- ``favor_modifiers`` and ``graded_roll``
* ``rules_params``         -- ``clamp_params`` / ``effective_target`` on small literal inputs
* ``rules_luck``           -- ``core.luck`` (pure Luck-spend arithmetic)
* ``rules_subsystems``     -- the pack-declared subsystem tools, end to end (see ``flows.py``)
* ``rules_synthetic``      -- literal packs exercising DSL features no built-in pack uses
* ``rules_script_lane``    -- the QuickJS resolution script lane and its result validators
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from . import _io  # noqa: F401  (must be imported before the engine; installs the guards)
from ._io import assert_scripts_held, error_dict, jsonable, scripted_random, write_jsonl

from core.check_outcome import CheckOutcome, RollDetail, outcome_wire  # isort: skip
from core.check_roll import favor_modifiers, graded_roll  # isort: skip
from core.dice_engine import DiceRoller  # isort: skip
from core.luck import (  # isort: skip
    adjust_check_with_luck,
    find_latest_character_check,
    is_luck_eligible_check,
)
from core.resolution import CheckResolver, CheckSpec  # isort: skip
from core.rulepacks import load_rulepack  # isort: skip

from . import flows, synthetic  # isort: skip
from .dice import roll_detail_dict  # isort: skip

PACKS = ("coc7", "dnd5e", "wod")


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------


def rank_dict(rank: Any) -> dict[str, Any]:
    return {
        "id": rank.id,
        "tier": rank.tier,
        "success": rank.success,
        "critical": rank.critical,
        "fumble": rank.fumble,
    }


def outcome_dict(outcome: CheckOutcome) -> dict[str, Any]:
    return {
        "rank": rank_dict(outcome.rank),
        "margin": outcome.margin,
        "target": outcome.target,
        "rolled": roll_detail_dict(outcome.rolled),
    }


def _legend_row(legend: list[dict[str, Any]], rank: Any) -> int:
    entry = rank_dict(rank)
    if entry not in legend:
        legend.append(entry)
    return legend.index(entry)


def _detail(expression: str, dice: tuple[int, ...], total: int, successes: int | None = None, ones: int | None = None):
    return RollDetail(expression, dice, total, successes=successes, ones=ones)


# ---------------------------------------------------------------------------
# Pack metadata
# ---------------------------------------------------------------------------

LOCALES = ("en", "zh", "zh-CN", "zh_TW", "EN", "fr", "", None)


def _pack_meta_row(pack_id: str) -> dict[str, Any]:
    pack = load_rulepack(pack_id)
    resolver = pack.resolver
    assert resolver is not None
    ladders = {
        (variant or ""): [
            {**rank_dict(rule.rank), "conditional": rule.when is not None} for rule in resolver.ladders[variant or ""]
        ]
        for variant in (None, *resolver.variant_ids())
    }
    rank_ids = sorted({rule.rank.id for ladder in resolver.ladders.values() for rule in ladder})
    return {
        "kind": "pack_meta",
        "pack": pack_id,
        "names": list(pack.names),
        "set_keys": list(pack.set_keys),
        "roll": resolver.roll,
        "compare": resolver.compare,
        "target_kind": resolver.target_kind,
        "modifiers": jsonable(dict(resolver.modifiers)),
        "variants": list(resolver.variant_ids()),
        "has_margin_expression": resolver.margin is not None,
        "ladders": ladders,
        "difficulties": [
            {"id": entry.id, "has_target_transform": entry.target is not None, "prefixes": jsonable(entry.prefixes)}
            for entry in resolver.difficulties
        ],
        "params": [
            {"id": spec.id, "min": spec.minimum, "max": spec.maximum, "default": spec.default}
            for spec in resolver.params
        ],
        "check": {
            "favorable": resolver.check.favorable,
            "unfavorable": resolver.check.unfavorable,
            "default_target": resolver.check.default_target,
            "proficiency": resolver.check.proficiency,
            "default_skill": resolver.check.default_skill,
        },
        "rank_labels": [
            {"locale": locale, "labels": {rank_id: pack.rank_label(rank_id, locale) for rank_id in rank_ids}}
            for locale in LOCALES
        ],
        "display_names": [
            {"locale": locale, "names": {name: pack.display_name(name, locale) for name in sorted(_display_keys(pack))}}
            for locale in LOCALES
        ],
        "initiative_roll": pack.initiative_roll,
        "commands": {
            word: {"action": binding.action, "tool": binding.tool, "args": jsonable(binding.args)}
            for word, binding in sorted(pack.commands.items())
        },
        "subsystems": {
            name: {
                "template": spec.template,
                "stat": spec.stat,
                "stat_max": spec.stat_max,
                "fumble_loss": spec.fumble_loss,
                "loss_ceiling": list(spec.loss_ceiling) if spec.loss_ceiling else None,
                "roll": spec.roll,
                "improve": spec.improve,
                "cap": spec.cap,
                "auto_success_above": spec.auto_success_above,
                "default_table": spec.default_table,
                "tables": {
                    table.id: {
                        "aliases": list(table.aliases),
                        "entries": list(table.entries),
                        "display": jsonable(dict(table.display)),
                    }
                    for table in spec.tables
                },
                "labels": [{"locale": locale, "label": spec.label(locale)} for locale in LOCALES],
            }
            for name, spec in sorted(pack.subsystems.items())
        },
    }


def _display_keys(pack: Any) -> set[str]:
    return {name for table in pack.display.values() for name in table}


def _pack_meta_rows() -> list[dict[str, Any]]:
    return [_pack_meta_row(pack_id) for pack_id in PACKS]


# ---------------------------------------------------------------------------
# Exhaustive interpret() grids
# ---------------------------------------------------------------------------

COC_TARGETS = [-10, -1, *range(0, 121)]


def _coc_grid_rows() -> Iterator[dict[str, Any]]:
    resolver = load_rulepack("coc7").resolver
    assert resolver is not None
    variants = [None, *resolver.variant_ids()]
    difficulties = [None, *[entry.id for entry in resolver.difficulties]]
    for variant in variants:
        for difficulty in difficulties:
            for target in COC_TARGETS:
                legend: list[dict[str, Any]] = []
                ranks: list[int] = []
                margins: list[int | None] = []
                for roll in range(1, 101):
                    outcome = resolver.interpret(
                        _detail("1d100", (roll,), roll), target, variant=variant, difficulty=difficulty
                    )
                    ranks.append(_legend_row(legend, outcome.rank))
                    margins.append(outcome.margin)
                yield {
                    "kind": "interpret_grid",
                    "pack": "coc7",
                    "variant": variant,
                    "difficulty": difficulty,
                    "target": target,
                    "modifier": 0,
                    "effective_target": resolver.effective_target(target, difficulty=difficulty),
                    "legend": legend,
                    "rank": ranks,
                    "margin": margins,
                }
    # A flat modifier folds into `roll` for roll-under systems too (nothing in the shipped pack
    # declares one; the engine still applies it before grading).
    for variant in variants:
        for modifier in (-7, 13):
            for target in range(0, 121):
                legend = []
                ranks = []
                margins = []
                for roll in range(1, 101):
                    outcome = resolver.interpret(
                        _detail("1d100", (roll,), roll), target, variant=variant, modifier=modifier
                    )
                    ranks.append(_legend_row(legend, outcome.rank))
                    margins.append(outcome.margin)
                yield {
                    "kind": "interpret_grid",
                    "pack": "coc7",
                    "variant": variant,
                    "difficulty": None,
                    "target": target,
                    "modifier": modifier,
                    "effective_target": resolver.effective_target(target),
                    "legend": legend,
                    "rank": ranks,
                    "margin": margins,
                }


def _dnd_grid_rows() -> Iterator[dict[str, Any]]:
    resolver = load_rulepack("dnd5e").resolver
    assert resolver is not None
    for modifier in range(-10, 21):
        for dc in range(-2, 36):
            legend: list[dict[str, Any]] = []
            ranks: list[int] = []
            margins: list[int | None] = []
            for natural in range(1, 21):
                outcome = resolver.interpret(_detail("1d20", (natural,), natural), dc, modifier=modifier)
                ranks.append(_legend_row(legend, outcome.rank))
                margins.append(outcome.margin)
            yield {
                "kind": "interpret_grid",
                "pack": "dnd5e",
                "variant": None,
                "difficulty": None,
                "target": dc,
                "modifier": modifier,
                "effective_target": resolver.effective_target(dc),
                "legend": legend,
                "rank": ranks,
                "margin": margins,
            }


def _wod_grid_rows() -> Iterator[dict[str, Any]]:
    resolver = load_rulepack("wod").resolver
    assert resolver is not None
    for pool in range(1, 21):
        legend: list[dict[str, Any]] = []
        cells: list[list[int | None]] = []
        for successes in range(0, pool + 1):
            for ones in range(0, pool - successes + 1):
                detail = _detail(f"{pool}d10>=6", (0,) * pool, successes, successes=successes, ones=ones)
                outcome = resolver.interpret(detail, None)
                cells.append([successes, ones, _legend_row(legend, outcome.rank), outcome.margin])
        yield {"kind": "pool_grid", "pack": "wod", "pool": pool, "target": None, "legend": legend, "cells": cells}


# ---------------------------------------------------------------------------
# interpret() single-cell edge cases
# ---------------------------------------------------------------------------


def _interpret_case(pack_id: str, rolled: RollDetail, target: int | None, **kwargs: Any) -> dict[str, Any]:
    resolver = load_rulepack(pack_id).resolver
    assert resolver is not None
    row: dict[str, Any] = {
        "kind": "interpret_case",
        "pack": pack_id,
        "rolled": {
            "expression": rolled.expression,
            "dice": list(rolled.dice),
            "total": rolled.total,
            "successes": rolled.successes,
            "ones": rolled.ones,
        },
        "target": target,
        "variant": kwargs.get("variant"),
        "difficulty": kwargs.get("difficulty"),
        "modifier": kwargs.get("modifier", 0),
        "outcome": None,
        "effective_target": None,
        "error": None,
    }
    try:
        row["effective_target"] = resolver.effective_target(target, difficulty=kwargs.get("difficulty"))
        row["outcome"] = {
            "rank": None,
            "margin": None,
        }
        outcome = resolver.interpret(rolled, target, **kwargs)
        row["outcome"] = {"rank": rank_dict(outcome.rank), "margin": outcome.margin, "target": outcome.target}
    except Exception as exc:  # noqa: BLE001 - the error class IS the vector
        row["outcome"] = None
        row["error"] = error_dict(exc)
    return row


def _interpret_case_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    d100 = lambda roll, modifiers=None: _detail("1d100", (roll,), roll)  # noqa: E731
    # -- coc7: ids the pack does not know fall back (variant) or are the identity (difficulty)
    for variant in (None, "", "nope", "rule3", "RULE3", "dg"):
        for difficulty in (None, "", "nope", "hard", "HARD", "regular"):
            for roll, target in ((1, 50), (5, 50), (25, 50), (50, 50), (51, 50), (96, 40), (100, 90), (66, 66)):
                rows.append(_interpret_case("coc7", d100(roll), target, variant=variant, difficulty=difficulty))
    # -- coc7: no target (only a roll that never reads `target` can grade) and odd targets
    for variant in (None, "rule3", "dg", "rule2"):
        for roll in (1, 2, 5, 50, 96, 100):
            rows.append(_interpret_case("coc7", d100(roll), None, variant=variant))
    for target in (-50, 0, 1, 99, 100, 101, 500, 10_000):
        for roll in (1, 2, 50, 100):
            rows.append(_interpret_case("coc7", d100(roll), target))
    # -- coc7: rolls outside 1..100 and totals that do not match the kept dice
    for roll in (-5, 0, 101, 150):
        rows.append(_interpret_case("coc7", d100(roll), 50))
    rows.append(_interpret_case("coc7", _detail("1d100", (30,), 45), 50))
    rows.append(_interpret_case("coc7", _detail("1d100", (), 45), 50))
    rows.append(_interpret_case("coc7", _detail("1d100", (30, 40), 30), 50))
    # -- dnd5e
    for natural in (1, 2, 10, 19, 20):
        for dc in (None, 0, 10, 15, 21):
            for modifier in (0, 5):
                rows.append(_interpret_case("dnd5e", _detail("1d20", (natural,), natural), dc, modifier=modifier))
    rows.append(_interpret_case("dnd5e", _detail("1d20+5", (12,), 17), 15))
    rows.append(_interpret_case("dnd5e", _detail("1d20+5", (20,), 25), 30))
    rows.append(_interpret_case("dnd5e", _detail("1d20+5", (1,), 6), 3))
    rows.append(_interpret_case("dnd5e", _detail("1d20", (), 12), 10))
    rows.append(_interpret_case("dnd5e", _detail("1d20", (), 12), None))
    rows.append(_interpret_case("dnd5e", _detail("1d20", (15,), 15), 15, variant="rule1", difficulty="hard"))
    rows.append(_interpret_case("dnd5e", _detail("2d20", (20, 3), 23), 15))
    rows.append(_interpret_case("dnd5e", _detail("1d20", (15,), 15), 15, modifier=-100))
    rows.append(_interpret_case("dnd5e", _detail("1d20", (15,), 15), 15, modifier=1000))
    # -- wod (target kind "none": a target is accepted and ignored)
    for target in (None, 0, 6, 100):
        rows.append(_interpret_case("wod", _detail("5d10>=6", (0,) * 5, 3, successes=3, ones=0), target))
    rows.append(_interpret_case("wod", _detail("5d10>=6", (0,) * 5, 0), None))
    rows.append(_interpret_case("wod", _detail("5d10>=6", (0,) * 5, 0, successes=None, ones=1), None))
    rows.append(_interpret_case("wod", _detail("5d10>=6", (0,) * 5, 0, successes=0, ones=None), None))
    rows.append(_interpret_case("wod", _detail("5d10>=6", (0,) * 5, 4, successes=-1, ones=2), None))
    rows.append(_interpret_case("wod", _detail("5d10>=6", (0,) * 5, 4, successes=4, ones=9), None))
    rows.append(_interpret_case("wod", _detail("5d10>=6", (0,) * 5, 4, successes=4, ones=0), 6, modifier=3))
    rows.append(_interpret_case("wod", _detail("5d10>=6", (0,) * 5, 4, successes=4, ones=0), None, difficulty="hard"))
    return rows


# ---------------------------------------------------------------------------
# favor_modifiers / graded_roll
# ---------------------------------------------------------------------------

FAVOR_COUNTS = [0, 1, 2, 3, 4, 10, -1, -2, "2", "x", 2.7, True, None]


def _favor_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    specs: list[tuple[str, CheckSpec]] = [(pack_id, load_rulepack(pack_id).resolver.check) for pack_id in PACKS]
    specs += [
        ("literal:both", CheckSpec(favorable="bonus", unfavorable="penalty")),
        ("literal:favorable-only", CheckSpec(favorable="bonus")),
        ("literal:unfavorable-only", CheckSpec(unfavorable="penalty")),
        ("literal:none", CheckSpec()),
        ("literal:same-name", CheckSpec(favorable="x", unfavorable="x")),
    ]
    for label, spec in specs:
        for bonus in FAVOR_COUNTS:
            for penalty in FAVOR_COUNTS:
                row: dict[str, Any] = {
                    "kind": "favor_modifiers",
                    "check": {"label": label, "favorable": spec.favorable, "unfavorable": spec.unfavorable},
                    "bonus": bonus,
                    "penalty": penalty,
                    "modifiers": None,
                    "applied": None,
                    "error": None,
                }
                try:
                    modifiers, applied = favor_modifiers(spec, bonus, penalty)  # type: ignore[arg-type]
                    row["modifiers"], row["applied"] = modifiers, applied
                except Exception as exc:  # noqa: BLE001
                    row["error"] = error_dict(exc)
                rows.append(row)
    return rows


def _graded_row(
    pack_id: str,
    modifiers: list[tuple[str, int]],
    target: int | None,
    modifier: int,
    variant: str | None,
    difficulty: str | None,
    seed: int,
    forced: list[int] | None = None,
) -> dict[str, Any]:
    pack = load_rulepack(pack_id)
    resolver = pack.resolver
    assert resolver is not None
    result: dict[str, Any] | None = None
    error = None
    with scripted_random(seed, forced) as log:
        try:
            graded = graded_roll(
                DiceRoller(),
                resolver,
                modifiers=dict(modifiers),
                target=target,
                modifier=modifier,
                variant=variant,
                difficulty=difficulty,
            )
            result = {
                "rolled": roll_detail_dict(graded.rolled),
                "total": graded.total,
                "target": graded.target,
                "effective_target": graded.effective_target,
                "outcome": None
                if graded.outcome is None
                else {
                    **outcome_dict(graded.outcome),
                    "wire": {
                        locale: outcome_wire(graded.outcome, pack.rank_label(graded.outcome.rank.id, locale))
                        for locale in ("en", "zh")
                    },
                },
            }
        except Exception as exc:  # noqa: BLE001
            error = error_dict(exc)
    return {
        "kind": "graded_roll",
        "args": {
            "pack": pack_id,
            "modifiers": [[name, count] for name, count in modifiers],
            "target": target,
            "modifier": modifier,
            "variant": variant,
            "difficulty": difficulty,
        },
        "seed": seed,
        "forced": forced,
        "draws": log.draws,
        "result": result,
        "error": error,
    }


def _graded_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    coc = load_rulepack("coc7").resolver
    assert coc is not None
    coc_modifiers = [[], [("bonus", 1)], [("penalty", 2)], [("bonus", 2), ("penalty", 1)]]
    for variant in (None, *coc.variant_ids()):
        for difficulty in (None, "hard", "extreme", "critical", "nope"):
            for target in (0, 15, 50, 75, 100):
                for modifiers in coc_modifiers:
                    for seed in (1, 2):
                        rows.append(_graded_row("coc7", modifiers, target, 0, variant, difficulty, seed))
    for target in (None, 1, 50):
        for modifier in (0, 12):
            rows.append(_graded_row("coc7", [], target, modifier, None, None, 3))
    for modifiers in ([], [("advantage", 1)], [("disadvantage", 1)], [("advantage", 1), ("disadvantage", 1)]):
        for target in (None, 5, 10, 15, 20, 25):
            for modifier in (-2, 0, 3, 8):
                for difficulty in (None, "hard"):
                    for seed in (1, 2, 3):
                        rows.append(_graded_row("dnd5e", modifiers, target, modifier, None, difficulty, seed))
    for target in (None, 0, 3):
        for modifier in (0, 4):
            for modifiers in ([], [("bonus", 1)]):
                for seed in (1, 2, 3, 4, 5, 6):
                    rows.append(_graded_row("wod", modifiers, target, modifier, None, None, seed))
    # Forced faces: the d20 natural 1 / 20, the d100 ends, and the wod botch.
    for pack_id, modifiers, target, forced, variant in (
        ("dnd5e", [], 15, [20], None), ("dnd5e", [], 15, [1], None), ("dnd5e", [("advantage", 1)], 10, [1, 20], None),
        ("dnd5e", [("disadvantage", 1)], 10, [1, 20], None), ("dnd5e", [("advantage", 1)], 30, [20, 19], None),
        ("coc7", [], 50, [1], None), ("coc7", [], 50, [100], None), ("coc7", [], 30, [96], None),
        ("coc7", [], 30, [96], "rule3"), ("coc7", [], 70, [44], "dg"), ("coc7", [], 70, [100], "dg"),
        ("coc7", [("bonus", 1)], 50, [47, 0], None), ("coc7", [("penalty", 1)], 50, [47, 9], None),
        ("wod", [], 0, [1], None),
    ):
        rows.append(_graded_row(pack_id, modifiers, target, 0, variant, None, 1, forced))
    return rows


# ---------------------------------------------------------------------------
# clamp_params / effective_target
# ---------------------------------------------------------------------------

PARAM_INPUTS: list[dict[str, Any] | None] = [
    None, {}, {"pool": 5, "difficulty": 6}, {"pool": 0, "difficulty": 0}, {"pool": 201, "difficulty": 11},
    {"pool": 20_000_000, "difficulty": 1}, {"pool": -5}, {"pool": "7", "difficulty": " 8 "}, {"pool": 3.9},
    {"pool": "x"}, {"pool": None}, {"pool": True}, {"difficulty": None}, {"pool": 5, "unknown": 1}, {"pool": [3]},
    {"pool": float("1e3")},
]


def _param_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for pack_id in PACKS:
        resolver = load_rulepack(pack_id).resolver
        assert resolver is not None
        for values in PARAM_INPUTS:
            row: dict[str, Any] = {
                "kind": "clamp_params",
                "pack": pack_id,
                "values": values,
                "result": None,
                "error": None,
            }
            try:
                row["result"] = resolver.clamp_params(values)
            except Exception as exc:  # noqa: BLE001
                row["error"] = {**error_dict(exc), "param": getattr(exc, "param", None)}
            rows.append(row)
        for difficulty in (None, "", "nope", *[entry.id for entry in resolver.difficulties]):
            for target in (None, -3, 0, 1, 7, 50, 99, 100, 101):
                rows.append(
                    {
                        "kind": "effective_target",
                        "pack": pack_id,
                        "target": target,
                        "difficulty": difficulty,
                        "result": resolver.effective_target(target, difficulty=difficulty),
                    }
                )
    return rows


# ---------------------------------------------------------------------------
# Luck (core.luck)
# ---------------------------------------------------------------------------


def _luck_grader(resolver: CheckResolver, check: dict[str, Any]):
    target = int(check["target"])
    variant = str(check.get("variant", "") or "") or None
    difficulty = str(check.get("difficulty", "") or "") or None

    def grade(roll_value: int):
        return resolver.interpret(
            RollDetail(resolver.roll, (roll_value,), roll_value), target, variant=variant, difficulty=difficulty
        ).rank

    return grade


def _luck_row(check: dict[str, Any], points: Any) -> dict[str, Any]:
    resolver = load_rulepack("coc7").resolver
    assert resolver is not None
    import copy

    mutable = copy.deepcopy(check)
    row: dict[str, Any] = {"kind": "adjust", "check": check, "points": points, "adjustment": None, "check_after": None, "error": None}
    try:
        adjustment = adjust_check_with_luck(mutable, points, grade=_luck_grader(resolver, mutable))
        row["adjustment"] = {
            "before_roll": adjustment.before_roll,
            "after_roll": adjustment.after_roll,
            "before": rank_dict(adjustment.before),
            "after": rank_dict(adjustment.after),
            "total_spent": adjustment.total_spent,
        }
        row["check_after"] = jsonable(mutable)
    except Exception as exc:  # noqa: BLE001
        row["error"] = error_dict(exc)
        row["check_after"] = jsonable(mutable)
    return row


def _luck_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    rolls = (1, 2, 5, 10, 25, 48, 50, 51, 75, 96, 99, 100)
    points_list = (1, 2, 5, 10, 25, 50, 99, 0, -1, True, 1.5, "3", None)
    for variant in (None, "rule3", "dg"):
        for difficulty in (None, "hard", "extreme"):
            for target in (20, 50, 75, 90):
                for roll in rolls:
                    for points in points_list:
                        check: dict[str, Any] = {"user_id": "u1", "char_name": "Vera", "skill": "侦查", "target": target, "roll": roll}
                        if variant:
                            check["variant"] = variant
                        if difficulty:
                            check["difficulty"] = difficulty
                        rows.append(_luck_row(check, points))
    # A check that was already adjusted: spent points accumulate, `raw_roll` is kept.
    for raw_present in (True, False):
        for spent in (0, 3, None):
            check = {
                "user_id": "u1", "char_name": "Vera", "skill": "侦查", "target": 50, "roll": 40,
                "luck_adjusted": True, "luck_spent": spent,
            }
            if raw_present:
                check["raw_roll"] = 55
            for points in (1, 10, 39, 40):
                rows.append(_luck_row(check, points))
    for roll in ("40", 40.0, "x", None):
        rows.append(_luck_row({"user_id": "u1", "skill": "侦查", "target": 50, "roll": roll}, 5))
    # Eligibility: the skill surface forms that may never be bought off.
    for skill in ("san", "SAN", " San ", "luc", "LUC", "luck", "Luck", "理智", "幸运", "侦查", "", None, "sanity", "幸运值", 5):
        row_check = {"skill": skill} if skill is not None else {}
        rows.append({"kind": "eligible", "check": row_check, "result": is_luck_eligible_check(row_check)})
    # find_latest_character_check: newest check of ONE player character, case-insensitive on the name.
    history = [
        {"user_id": "u1", "char_name": "Vera", "skill": "a", "n": 1},
        {"user_id": "u2", "char_name": "Vera", "skill": "b", "n": 2},
        {"user_id": "u1", "char_name": "vera", "skill": "c", "n": 3},
        {"user_id": "u1", "char_name": "Bob", "skill": "d", "n": 4},
        {"user_id": "u1", "skill": "e", "n": 5},
        {"user_id": "u1", "char_name": "VERA", "skill": "f", "n": 6},
        {"user_id": "u2", "char_name": "Bob", "skill": "g", "n": 7},
    ]
    for checks in ([], history[:1], history, history[:3], history[3:5], history[4:5]):
        for user, name in (("u1", "Vera"), ("u1", "VERA"), ("u2", "Vera"), ("u1", "Bob"), ("u3", "Vera"), ("u1", "")):
            found = find_latest_character_check(checks, user, name)
            rows.append(
                {
                    "kind": "find_latest",
                    "checks": checks,
                    "user_id": user,
                    "char_name": name,
                    "result": None if found is None else found["n"],
                }
            )
    return rows


# ---------------------------------------------------------------------------
# Literal packs (rules_synthetic)
# ---------------------------------------------------------------------------


def _check_roll_row(
    pack_id: str, params: dict[str, Any] | None, modifiers: list[tuple[str, Any]], seed: int, forced: list[int] | None = None
) -> dict[str, Any]:
    """One ``DiceRoller.roll_for_check`` call (the ROLL phase) under scripted randomness."""
    resolver = load_rulepack(pack_id).resolver
    assert resolver is not None
    result = None
    error = None
    with scripted_random(seed, forced) as log:
        try:
            result = roll_detail_dict(DiceRoller().roll_for_check(resolver, params=params, modifiers=dict(modifiers) or None))
        except Exception as exc:  # noqa: BLE001
            error = {**error_dict(exc), "param": getattr(exc, "param", None)}
    return {
        "kind": "roll_for_check",
        "args": {"pack": pack_id, "params": params, "modifiers": [[name, count] for name, count in modifiers]},
        "seed": seed,
        "forced": forced,
        "draws": log.draws,
        "result": result,
        "error": error,
    }


def _synthetic_rows() -> list[dict[str, Any]]:
    synth, pool = synthetic.SYNTH_ID, synthetic.POOL_ID
    rows: list[dict[str, Any]] = [*synthetic.pack_rows(), _pack_meta_row(synth), _pack_meta_row(pool)]

    # -- oraclesynth: a dc-kind d20 system WITH difficulty transforms, a variant ladder and a margin expression
    resolver = load_rulepack(synth).resolver
    assert resolver is not None
    difficulties = (None, "easy", "hard", "brutal", "thirds", "swing", "flat", "plain", "nope")
    for variant in (None, "lenient", "nope"):
        for difficulty in difficulties:
            for dc in (-4, 0, 1, 3, 5, 8, 10, 12, 15, 18, 20, 25, 30):
                for modifier in (-3, 0, 4):
                    legend: list[dict[str, Any]] = []
                    ranks: list[int] = []
                    margins: list[int | None] = []
                    for natural in range(1, 21):
                        outcome = resolver.interpret(
                            _detail("1d20", (natural,), natural), dc, variant=variant, difficulty=difficulty, modifier=modifier
                        )
                        ranks.append(_legend_row(legend, outcome.rank))
                        margins.append(outcome.margin)
                    rows.append(
                        {
                            "kind": "interpret_grid",
                            "pack": synth,
                            "variant": variant,
                            "difficulty": difficulty,
                            "target": dc,
                            "modifier": modifier,
                            "effective_target": resolver.effective_target(dc, difficulty=difficulty),
                            "legend": legend,
                            "rank": ranks,
                            "margin": margins,
                        }
                    )
    for natural, total, dc, kwargs in (
        (20, 20, None, {}), (5, 5, None, {}), (1, 1, None, {"variant": "lenient"}), (12, 12, None, {"difficulty": "easy"}),
        (12, 18, 10, {}), (3, 3, 10, {"variant": "lenient"}), (19, 19, 25, {"variant": "lenient"}),
    ):
        rows.append(_interpret_case(synth, _detail("1d20", (natural,), total), dc, **kwargs))

    # -- oraclepool: a pool pack with params, a margin expression and ladders over `successes` and `ones`
    pool_resolver = load_rulepack(pool).resolver
    assert pool_resolver is not None
    for count in range(1, 9):
        legend = []
        cells: list[list[int | None]] = []
        for successes in range(0, count + 1):
            for ones in range(0, count - successes + 1):
                outcome = pool_resolver.interpret(
                    _detail(f"{count}d6>=5", (0,) * count, successes, successes=successes, ones=ones), None
                )
                cells.append([successes, ones, _legend_row(legend, outcome.rank), outcome.margin])
        rows.append({"kind": "pool_grid", "pack": pool, "pool": count, "target": None, "legend": legend, "cells": cells})

    # -- the ROLL phase (modifier overrides, params) and the shared roll-and-grade step
    for modifiers in ([], [("boon", 1)], [("bane", 1)], [("boon", 1), ("bane", 1)], [("bane", 1), ("boon", 1)], [("boon", 0)]):
        for seed in (1, 2, 3):
            rows.append(_check_roll_row(synth, None, modifiers, seed))
    for params in (None, {}, {"pool": 5, "need": 4}, {"pool": 0, "need": 1}, {"pool": 99, "need": 9}, {"pool": "x"}, {"need": 3}):
        for seed in (1, 2, 3):
            rows.append(_check_roll_row(pool, params, [], seed))
    for modifiers in ([], [("boon", 1)], [("bane", 2)]):
        for variant in (None, "lenient"):
            for difficulty in (None, "easy", "hard", "brutal", "thirds", "swing", "flat", "plain"):
                for target in (None, 0, 8, 12, 20):
                    for modifier in (0, 3):
                        for seed in (1, 2):
                            rows.append(_graded_row(synth, modifiers, target, modifier, variant, difficulty, seed))
    for target in (None, 4):
        for seed in (1, 2, 3, 4, 5, 6):
            rows.append(_graded_row(pool, [], target, 0, None, None, seed))
    for forced in ([1], [20], [19], [10]):
        for variant in (None, "lenient"):
            rows.append(_graded_row(synth, [], 12, 0, variant, None, 1, forced))
    for forced in ([5, 5, 5], [1, 1, 1], [6, 2, 1]):
        rows.append(_graded_row(pool, [], None, 0, None, None, 1, forced))

    # -- check specs and params
    check = resolver.check
    for bonus in (0, 1, 2, 3):
        for penalty in (0, 1, 2, 3):
            modifiers_out, applied = favor_modifiers(check, bonus, penalty)
            rows.append(
                {
                    "kind": "favor_modifiers",
                    "check": {"label": synth, "favorable": check.favorable, "unfavorable": check.unfavorable},
                    "bonus": bonus,
                    "penalty": penalty,
                    "modifiers": modifiers_out,
                    "applied": applied,
                    "error": None,
                }
            )
    for values in PARAM_INPUTS:
        row: dict[str, Any] = {"kind": "clamp_params", "pack": pool, "values": values, "result": None, "error": None}
        try:
            row["result"] = pool_resolver.clamp_params(values)
        except Exception as exc:  # noqa: BLE001
            row["error"] = {**error_dict(exc), "param": getattr(exc, "param", None)}
        rows.append(row)
    for difficulty in difficulties:
        for target in (None, -3, 0, 1, 7, 15, 16, 50):
            rows.append(
                {
                    "kind": "effective_target",
                    "pack": synth,
                    "target": target,
                    "difficulty": difficulty,
                    "result": resolver.effective_target(target, difficulty=difficulty),
                }
            )
    return rows


# ---------------------------------------------------------------------------
# The QuickJS script lane (rules_script_lane)
# ---------------------------------------------------------------------------

RANK_RESULTS: list[Any] = [
    {"rank": {"id": "win", "tier": 2, "success": True}, "margin": 3},
    {"rank": {"id": "win", "tier": 2}, "margin": None},
    {"rank": {"id": "win", "tier": 2}},
    {"rank": {"id": "a", "tier": 0, "success": False, "critical": False, "fumble": True}, "margin": -4},
    {"rank": {"id": "a_b_9", "tier": 32}, "margin": 0},
    {"rank": {"id": "z" * 32, "tier": 1}},
    {"rank": {"id": "z" * 33, "tier": 1}},
    {"rank": {"id": "Win", "tier": 1}},
    {"rank": {"id": "1win", "tier": 1}},
    {"rank": {"id": "", "tier": 1}},
    {"rank": {"id": "win"}},
    {"rank": {"id": "win", "tier": 33}},
    {"rank": {"id": "win", "tier": -1}},
    {"rank": {"id": "win", "tier": 1.0}},
    {"rank": {"id": "win", "tier": 1.5}},
    {"rank": {"id": "win", "tier": "1"}},
    {"rank": {"id": "win", "tier": True}},
    {"rank": {"id": "win", "tier": 1, "success": 1}},
    {"rank": {"id": "win", "tier": 1, "critical": "true"}},
    {"rank": {"id": "win", "tier": 1, "fumble": None}},
    {"rank": {"id": "win", "tier": 1, "label": "x"}},
    {"rank": {"id": "win", "tier": 1}, "margin": 1.5},
    {"rank": {"id": "win", "tier": 1}, "margin": "3"},
    {"rank": {"id": "win", "tier": 1}, "margin": True},
    {"rank": {"id": "win", "tier": 1}, "margin": -12},
    {"rank": {"id": "win", "tier": 1}, "margin": 0},
    {"rank": {"id": "win", "tier": 1}, "extra": 1},
    {"rank": "win"}, {"rank": None}, {"margin": 1}, {}, [], "text", 7, None, True,
]

FLOW_RESULTS: list[Any] = [
    {}, {"stat_delta": {}}, {"stat_delta": {"hp": -3}}, {"stat_delta": {" hp ": 5, "mp": 0}},
    {"stat_delta": {"hp": 5000}}, {"stat_delta": {"hp": -5000}}, {"stat_delta": {"hp": 1.5}}, {"stat_delta": {"hp": True}},
    {"stat_delta": {"hp": "3"}}, {"stat_delta": {"": 1}}, {"stat_delta": {"  ": 1}},
    {"stat_delta": {f"s{i}": 1 for i in range(8)}}, {"stat_delta": {f"s{i}": 1 for i in range(9)}},
    {"stat_delta": []}, {"stat_delta": None}, {"stat_delta": "x"},
    {"mark": "tick"}, {"mark": "m" * 100}, {"mark": None}, {"mark": 5}, {"mark": ""},
    {"narration": "A line."}, {"narration": "n" * 2500}, {"narration": None}, {"narration": 5}, {"narration": ""},
    {"stat_delta": {"hp": 1}, "mark": "t", "narration": "n"}, {"other": 1}, {"stat_delta": {"hp": 1}, "other": 1},
    [], "text", None, 3,
]


def _script_rows() -> list[dict[str, Any]]:
    from core.rules_script import RulesScriptError, validate_flow_effect, validate_rank_result

    rows: list[dict[str, Any]] = [*synthetic.script_pack_rows()]
    pack_id = synthetic.SCRIPT_ID
    resolver = load_rulepack(pack_id).resolver
    assert resolver is not None
    for natural in (1, 2, 10, 15, 19, 20):
        for target in (None, 5, 15, 25):
            for difficulty in (None, "hard", "nope"):
                for modifier in (0, 3):
                    rows.append(
                        _interpret_case(pack_id, _detail("1d20", (natural,), natural), target, difficulty=difficulty, modifier=modifier)
                    )
    for variant in (
        "bad_id", "tier_high", "tier_negative", "tier_float", "flag_string", "extra_key", "extra_rank_key", "margin_float",
        "margin_string", "no_rank", "not_object", "array", "null", "throws", "undefined", "unknown", "", None,
    ):
        for natural in (10, 20):
            rows.append(_interpret_case(pack_id, _detail("1d20", (natural,), natural), 12, variant=variant))
    rows.append(_interpret_case(pack_id, _detail("1d20", (), 12), 10))
    rows.append(_interpret_case(pack_id, _detail("2d20kh1", (20,), 20), 10, modifier=-30))
    for raw in RANK_RESULTS:
        row: dict[str, Any] = {"kind": "validate_rank_result", "raw": raw, "result": None, "error": None}
        try:
            row["result"] = validate_rank_result("script", raw)
        except RulesScriptError as exc:
            row["error"] = error_dict(exc)
        rows.append(row)
    for raw in FLOW_RESULTS:
        row = {"kind": "validate_flow_effect", "raw": raw, "result": None, "error": None}
        try:
            row["result"] = validate_flow_effect("script", "flow", raw)
        except RulesScriptError as exc:
            row["error"] = error_dict(exc)
        rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def export() -> list[tuple[str, int, str]]:
    synthetic.install()
    check_roll = [*_favor_rows(), *_graded_rows()]
    synthetic_rows = _synthetic_rows()
    flow_rows = flows.rows()
    script_rows = _script_rows()
    for rows in (check_roll, synthetic_rows, flow_rows):
        assert_scripts_held(rows)
    return [
        write_jsonl("rules_pack_meta", _pack_meta_rows()),
        write_jsonl("rules_coc7_grid", _coc_grid_rows()),
        write_jsonl("rules_dnd5e_grid", _dnd_grid_rows()),
        write_jsonl("rules_wod_grid", _wod_grid_rows()),
        write_jsonl("rules_interpret_cases", _interpret_case_rows()),
        write_jsonl("rules_check_roll", check_roll),
        write_jsonl("rules_params", _param_rows()),
        write_jsonl("rules_luck", _luck_rows()),
        write_jsonl("rules_subsystems", flow_rows),
        write_jsonl("rules_synthetic", synthetic_rows),
        write_jsonl("rules_script_lane", script_rows),
    ]
