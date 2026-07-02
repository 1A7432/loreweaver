"""Deterministic character-sheet validation against rulepack creation constraints."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any

from core.character_manager import CharacterSheet
from core.rulepacks import RulePack, load_rulepack

_COC_SYSTEM = "coc7"
_DND_SYSTEM = "dnd5e"
_COC_DERIVED_SKILLS = {"母语", "闪避"}


@dataclass(frozen=True)
class SheetViolation:
    code: str
    path: str
    original: Any
    corrected: Any | None = None
    limit: Any | None = None


def validate_sheet(sheet: CharacterSheet, system: str | None = None) -> tuple[CharacterSheet, list[SheetViolation]]:
    """Return a clamped sheet copy plus deterministic rule violations.

    The validator never consults an LLM. It enforces the rulepack's creation
    constraints for core ability/characteristic ranges, skill ranges, and the
    budget checks that can be inferred from a complete sheet.
    """
    pack = load_rulepack(system or sheet.system)
    clamped = CharacterSheet.from_dict(copy.deepcopy(sheet.to_dict()))
    violations: list[SheetViolation] = []

    if pack.system == _COC_SYSTEM:
        _validate_coc_sheet(clamped, pack, violations)
    elif pack.system == _DND_SYSTEM:
        _validate_dnd_sheet(clamped, pack, violations)
    return clamped, violations


def _validate_coc_sheet(sheet: CharacterSheet, pack: RulePack, violations: list[SheetViolation]) -> None:
    constraints = pack.creation_constraints
    characteristics = constraints.get("characteristics") or {}
    for key, rule in characteristics.items():
        _clamp_numeric_field(
            sheet.attributes,
            str(key),
            int(rule.get("min", 0)),
            int(rule.get("max", 100)),
            "attribute",
            violations,
        )

    skills = constraints.get("skills") or {}
    default_skill_rule = skills.get("default") or {}
    min_skill = int(default_skill_rule.get("min", 0))
    max_skill = int(default_skill_rule.get("max", 99))
    for key in list(sheet.skills):
        _clamp_numeric_field(sheet.skills, key, min_skill, max_skill, "skill", violations)

    sheet._calc_coc_derived_skills()
    _recompute_coc_vitals(sheet)
    _check_coc_skill_budget(sheet, constraints.get("budgets") or {}, violations)


def _validate_dnd_sheet(sheet: CharacterSheet, pack: RulePack, violations: list[SheetViolation]) -> None:
    constraints = pack.creation_constraints
    abilities = constraints.get("abilities") or {}
    for key, rule in abilities.items():
        _clamp_numeric_field(
            sheet.attributes,
            str(key),
            int(rule.get("min", 3)),
            int(rule.get("max", 18)),
            "ability",
            violations,
        )
    _check_dnd_point_buy(sheet, constraints.get("methods", {}).get("point_buy") or {}, violations)


def _clamp_numeric_field(
    values: dict[str, Any],
    key: str,
    minimum: int,
    maximum: int,
    kind: str,
    violations: list[SheetViolation],
) -> None:
    if key not in values:
        return
    original = values[key]
    numeric = _coerce_int(original)
    plural = "abilities" if kind == "ability" else f"{kind}s"
    if numeric is None:
        values[key] = minimum
        violations.append(
            SheetViolation(f"{kind}_not_numeric", f"{plural}.{key}", original, corrected=minimum, limit=(minimum, maximum))
        )
        return
    corrected = max(minimum, min(maximum, numeric))
    values[key] = corrected
    if corrected != numeric:
        code = f"{kind}_{'below_min' if numeric < minimum else 'above_max'}"
        violations.append(SheetViolation(code, f"{plural}.{key}", numeric, corrected=corrected, limit=(minimum, maximum)))


def _coerce_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _recompute_coc_vitals(sheet: CharacterSheet) -> None:
    attrs = sheet.attributes
    skills = sheet.skills
    con = _int(attrs.get("CON"), 50)
    siz = _int(attrs.get("SIZ"), 50)
    pow_value = _int(attrs.get("POW"), 50)
    mythos = _int(skills.get("克苏鲁神话"), 0)
    hp = (con + siz) // 10
    mp = pow_value // 5
    sanmax = max(0, 99 - mythos)
    attrs["HPMAX"] = hp
    attrs["HP"] = hp
    attrs["MPMAX"] = mp
    attrs["MP"] = mp
    attrs["SANMAX"] = sanmax
    attrs["SAN"] = min(pow_value, sanmax)
    attrs["IDEA"] = _int(attrs.get("INT"), 50)
    attrs["KNOW"] = _int(attrs.get("EDU"), 50)


def _check_coc_skill_budget(sheet: CharacterSheet, budgets: dict[str, Any], violations: list[SheetViolation]) -> None:
    if not budgets:
        return
    base = CharacterSheet("", "CoC").skills
    spent = 0
    for skill, value in sheet.skills.items():
        if skill in _COC_DERIVED_SKILLS:
            continue
        spent += max(0, _int(value, 0) - _int(base.get(skill), 0))

    attrs = {key: _int(value, 0) for key, value in sheet.attributes.items()}
    interest_budget = _eval_budget_formula(
        str((budgets.get("personal_interest_points") or {}).get("formula", "0")),
        attrs,
    )
    occupation = budgets.get("occupational_points") or {}
    occupation_formulas = [str(item) for item in occupation.get("formulas") or []]
    if not occupation_formulas and occupation.get("default_formula"):
        occupation_formulas = [str(occupation["default_formula"])]
    occupation_budget = max((_eval_budget_formula(formula, attrs) for formula in occupation_formulas), default=0)
    budget = interest_budget + occupation_budget
    if spent > budget:
        violations.append(SheetViolation("coc_skill_budget_exceeded", "skills", spent, limit=budget))


def _check_dnd_point_buy(sheet: CharacterSheet, point_buy: dict[str, Any], violations: list[SheetViolation]) -> None:
    if not point_buy:
        return
    minimum = int(point_buy.get("min", 8))
    maximum = int(point_buy.get("max", 15))
    costs = {_int(key, -1): _int(value, 0) for key, value in (point_buy.get("costs") or {}).items()}
    abilities = [sheet.attributes.get(key) for key in ("STR", "DEX", "CON", "INT", "WIS", "CHA")]
    numeric = [_coerce_int(value) for value in abilities]
    if any(value is None or value < minimum or value > maximum for value in numeric):
        return
    spent = sum(costs.get(int(value), 0) for value in numeric if value is not None)
    budget = int(point_buy.get("budget", 27))
    if spent > budget:
        violations.append(SheetViolation("dnd_point_buy_budget_exceeded", "attributes", spent, limit=budget))


def _eval_budget_formula(formula: str, attrs: dict[str, int]) -> int:
    total = 0
    for term in formula.replace(" ", "").split("+"):
        if not term:
            continue
        product = 1
        for factor in term.split("*"):
            product *= _int(attrs.get(factor, factor), 0)
        total += product
    return total


def _int(value: Any, default: int = 0) -> int:
    coerced = _coerce_int(value)
    return default if coerced is None else coerced
