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


def validate_sheet(
    sheet: CharacterSheet, system: str | None = None, *, initialize_vitals: bool = False
) -> tuple[CharacterSheet, list[SheetViolation]]:
    """Return a clamped sheet copy plus deterministic rule violations.

    The validator never consults an LLM. It enforces the rulepack's creation
    constraints for core ability/characteristic ranges, skill ranges, and the
    budget checks that can be inferred from a complete sheet.

    ``initialize_vitals`` distinguishes character CREATION from an in-play EDIT.
    On creation (True) the current HP/MP/SAN are (re)derived from the final
    characteristics — full HP/MP and CoC's starting SAN = min(POW, SANMAX). On
    an edit (False, the default) the current values are PRESERVED (only clamped
    to their new maxima) so editing a skill/attribute never heals a wounded PC.
    """
    pack = load_rulepack(system or sheet.system)
    clamped = CharacterSheet.from_dict(copy.deepcopy(sheet.to_dict()))
    violations: list[SheetViolation] = []

    if pack.system == _COC_SYSTEM:
        _validate_coc_sheet(clamped, pack, violations, initialize=initialize_vitals)
    elif pack.system == _DND_SYSTEM:
        _validate_dnd_sheet(clamped, pack, violations)
    return clamped, violations


def render_validation_notice(i18n: Any, violations: list[SheetViolation]) -> str:
    if not violations:
        return ""
    rendered = []
    for violation in violations:
        if violation.corrected is None:
            rendered.append(
                i18n.t(
                    "character.validation.budget_item",
                    code=violation.code,
                    path=violation.path,
                    value=violation.original,
                    limit=violation.limit,
                )
            )
        else:
            rendered.append(
                i18n.t(
                    "character.validation.clamped_item",
                    code=violation.code,
                    path=violation.path,
                    original=violation.original,
                    corrected=violation.corrected,
                    limit=violation.limit,
                )
            )
    return i18n.t("character.validation.notice", items=i18n.t("character.validation.separator").join(rendered))


def _validate_coc_sheet(
    sheet: CharacterSheet, pack: RulePack, violations: list[SheetViolation], *, initialize: bool = False
) -> None:
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
    _recompute_coc_vitals(sheet, initialize=initialize)
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


def _recompute_coc_vitals(sheet: CharacterSheet, *, initialize: bool = False) -> None:
    """Recompute the CoC derived maxima (HPMAX/MPMAX/SANMAX/IDEA/KNOW), then set
    the current HP/MP/SAN.

    ``initialize`` is the CREATION vs in-play EDIT switch. On creation (True) the
    current values are (re)derived from the final characteristics — full HP/MP and
    CoC's starting SAN = min(POW, SANMAX). On an edit (False) an existing current
    value is PRESERVED (only clamped to its new max), so editing a skill/attribute
    never heals a wounded character back to full; an absent value is initialized
    (a genuinely bare sheet). IDEA/KNOW are pure derivations and always recompute.
    """
    attrs = sheet.attributes
    skills = sheet.skills
    con = _int(attrs.get("CON"), 50)
    siz = _int(attrs.get("SIZ"), 50)
    pow_value = _int(attrs.get("POW"), 50)
    mythos = _int(skills.get("克苏鲁神话"), 0)
    hpmax = (con + siz) // 10
    mpmax = pow_value // 5
    sanmax = max(0, 99 - mythos)
    san_start = min(pow_value, sanmax)
    attrs["HPMAX"] = hpmax
    attrs["MPMAX"] = mpmax
    attrs["SANMAX"] = sanmax
    attrs["HP"] = hpmax if initialize else _clamp_current_vital(attrs, "HP", hpmax)
    attrs["MP"] = mpmax if initialize else _clamp_current_vital(attrs, "MP", mpmax)
    attrs["SAN"] = san_start if initialize else _clamp_current_vital(attrs, "SAN", sanmax, default=san_start)
    attrs["IDEA"] = _int(attrs.get("INT"), 50)
    attrs["KNOW"] = _int(attrs.get("EDU"), 50)


def _clamp_current_vital(attrs: dict[str, Any], key: str, maximum: int, default: int | None = None) -> int:
    """Preserve an existing current vital (clamped to [0, maximum]); initialize a
    genuinely absent one to ``default`` (or ``maximum``). Used for in-play edits."""
    fallback = maximum if default is None else default
    if key not in attrs:
        return fallback
    current = _int(attrs.get(key), fallback)
    return max(0, min(maximum, current))


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
