"""Deterministic character-sheet validation against rulepack creation constraints.

M16 stage B: fully pack-data-driven — numeric clamps come from
``creation_constraints.attributes`` / ``.skills``, derived slots recompute
through the pack DAG (storage is never trusted for them), and budget checks are
typed data (``budgets.<id>.parts`` condexpr formulas over the canonical value
namespace; ``methods.point_buy`` applies only when the caller says the sheet
was point-bought). Every stat write path funnels through `validate_sheet`, so
manual edits, AI tool writes, rolled generation and imports all get the same
deterministic enforcement.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from core.character_manager import CharacterSheet
from core.condexpr import CondExprError, compile_expression
from core.rulepacks import RulePack, load_rulepack
from core.sheets import canonical_values, refresh_sheet


@dataclass(frozen=True)
class SheetViolation:
    code: str
    path: str
    original: Any
    corrected: Any | None = None
    limit: Any | None = None


def validate_sheet(
    sheet: CharacterSheet,
    system: str | None = None,
    *,
    initialize_vitals: bool = False,
    creation_method: str | None = None,
) -> tuple[CharacterSheet, list[SheetViolation]]:
    """Return a clamped sheet copy plus deterministic rule violations.

    The validator never consults an LLM. It enforces the rulepack's creation
    constraints for attribute ranges, skill ranges, and the budget checks that
    can be inferred from a complete sheet.

    ``initialize_vitals`` distinguishes character CREATION from an in-play EDIT.
    On creation (True) the current pools are (re)derived from the final stats
    per each vital's declared start; on an edit (False, the default) current
    values are PRESERVED (only clamped to their new maxima) so editing a
    skill/attribute never heals a wounded PC.

    ``creation_method`` makes method-specific validation explicit: the
    point-buy budget is enforced only for ``"point_buy"`` creation; rolled,
    standard-array, imported, and in-play sheets still receive the shared
    range validation without being guessed to be point-buy sheets.
    """
    pack = load_rulepack(system or sheet.system)
    clamped = CharacterSheet.from_dict(copy.deepcopy(sheet.to_dict()))
    violations: list[SheetViolation] = []
    constraints = pack.creation_constraints

    for key, rule in (constraints.get("attributes") or {}).items():
        if not isinstance(rule, Mapping):
            continue
        _clamp_numeric_field(
            clamped.attributes,
            str(key),
            int(rule.get("min", 0)),
            int(rule.get("max", 100)),
            "attribute",
            violations,
        )

    default_skill_rule = (constraints.get("skills") or {}).get("default") or {}
    if default_skill_rule:
        min_skill = int(default_skill_rule.get("min", 0))
        max_skill = int(default_skill_rule.get("max", 99))
        derived_keys = set(pack.sheet_spec.derived_skills) if pack.sheet_spec else set()
        for key in list(clamped.skills):
            if key in derived_keys:
                # Derived slots recompute below; clamping them would masquerade
                # the clamped copy as a trained override.
                continue
            _clamp_numeric_field(clamped.skills, key, min_skill, max_skill, "skill", violations)

    refresh_sheet(clamped, pack, initialize_vitals=initialize_vitals)

    _check_budgets(clamped, pack, violations)
    method = (creation_method or "").strip().casefold().replace("-", "_")
    if method == "point_buy":
        _check_point_buy(
            clamped, pack, (constraints.get("methods") or {}).get("point_buy") or {}, violations
        )
    return clamped, violations


def render_validation_notice(i18n: Any, violations: list[SheetViolation]) -> str:
    if not violations:
        return ""
    corrected_items = []
    warning_items = []
    for violation in violations:
        if violation.corrected is None:
            warning_items.append(
                i18n.t(
                    "character.validation.budget_item",
                    code=violation.code,
                    path=violation.path,
                    value=violation.original,
                    limit=violation.limit,
                )
            )
        else:
            corrected_items.append(
                i18n.t(
                    "character.validation.clamped_item",
                    code=violation.code,
                    path=violation.path,
                    original=violation.original,
                    corrected=violation.corrected,
                    limit=violation.limit,
                )
            )
    separator = i18n.t("character.validation.separator")
    notices = []
    if corrected_items:
        notices.append(i18n.t("character.validation.notice", items=separator.join(corrected_items)))
    if warning_items:
        notices.append(i18n.t("character.validation.warning_notice", items=separator.join(warning_items)))
    return "\n".join(notices)


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
    plural = f"{kind}s"
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


def _check_budgets(sheet: CharacterSheet, pack: RulePack, violations: list[SheetViolation]) -> None:
    """Typed budget checks. ``skill-points`` semantics: spent = the points every
    non-derived skill sits above its fresh-sheet base; budget = the sum of the
    declared parts (a ``{max: [...]}`` part takes the best alternative)."""
    budgets = pack.creation_constraints.get("budgets") or {}
    if not budgets:
        return
    spec = pack.sheet_spec
    base_skills: Mapping[str, Any] = spec.skills if spec is not None else {}
    derived_keys = set(spec.derived_skills) if spec is not None else set()

    namespace = canonical_values(sheet, pack)
    namespace.update(pack.compute_derived(namespace))

    for budget_id, rule in budgets.items():
        parts = rule.get("parts") if isinstance(rule, Mapping) else None
        if not isinstance(parts, list) or not parts:
            continue
        spent = 0
        for skill, value in sheet.skills.items():
            if skill in derived_keys:
                continue
            spent += max(0, _int(value, 0) - _int(base_skills.get(skill), 0))
        budget = 0
        for part in parts:
            if isinstance(part, Mapping) and "max" in part:
                budget += max(
                    (_eval_budget_formula(pack, str(formula), namespace) for formula in (part["max"] or [])),
                    default=0,
                )
            else:
                budget += _eval_budget_formula(pack, str(part), namespace)
        if spent > budget:
            violations.append(SheetViolation(f"{budget_id}_exceeded", "skills", spent, limit=budget))


def _check_point_buy(
    sheet: CharacterSheet, pack: RulePack, point_buy: Mapping[str, Any], violations: list[SheetViolation]
) -> None:
    if not point_buy:
        return
    minimum = int(point_buy.get("min", 0))
    maximum = int(point_buy.get("max", 0))
    costs = {_int(key, -1): _int(value, 0) for key, value in (point_buy.get("costs") or {}).items()}
    keys = list((pack.creation_constraints.get("attributes") or {}).keys())
    numeric = [_coerce_int(sheet.attributes.get(key)) for key in keys]
    if not numeric or any(value is None or value < minimum or value > maximum for value in numeric):
        return
    spent = sum(costs.get(int(value), 0) for value in numeric if value is not None)
    budget = int(point_buy.get("budget", 0))
    if spent > budget:
        violations.append(SheetViolation("point_buy_budget_exceeded", "attributes", spent, limit=budget))


def _eval_budget_formula(pack: RulePack, formula: str, namespace: Mapping[str, Any]) -> int:
    """Evaluate one condexpr budget formula over the canonical value namespace
    (unknown / non-numeric names fall back to the pack default, then 0)."""
    try:
        compiled = compile_expression(formula)
    except CondExprError:
        return 0

    def resolve(path: str) -> Any:
        return _int(namespace.get(path, pack.defaults.get(path, 0)), 0)

    try:
        return int(compiled(resolve))
    except (CondExprError, TypeError, ValueError):
        return 0


def _int(value: Any, default: int = 0) -> int:
    coerced = _coerce_int(value)
    return default if coerced is None else coerced
