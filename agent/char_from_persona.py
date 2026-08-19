"""Build rule-legal TRPG sheets from SillyTavern persona cards.

Lives in ``agent/`` (moved from ``core/`` 2026-08-19): the persona → numbers step is a
model call; only the validation against the rulepack (``core.character_rules``) is
deterministic, and that part stays in ``core/``."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Any

from core.character_manager import CharacterManager, CharacterSheet
from core.charcard import CharacterCard
from core.rulepacks import RulePack, load_rulepack
from core.sheets import has_check_value, refresh_sheet, set_sheet_value, sheet_value
from infra.i18n import t
from infra.store import Store

# Gendered-pronoun markers for the deterministic gender/pronoun inference below. English is matched on
# word boundaries (he/she + their possessive/reflexive forms); CJK counts singular 他/她 while skipping
# the plural 们 forms (他们/她们 == "they"), which carry no personal-gender signal.
_EN_MALE_RE = re.compile(r"\b(?:he|him|his|himself)\b", re.IGNORECASE)
_EN_FEMALE_RE = re.compile(r"\b(?:she|her|hers|herself)\b", re.IGNORECASE)
_ZH_MALE_RE = re.compile(r"他(?!们)")
_ZH_FEMALE_RE = re.compile(r"她(?!们)")


def infer_pronoun_note(text: str) -> str:
    """Deterministically infer a compact pronoun note ('he/him' | 'she/her' | '') from persona text.

    Counts gendered pronoun markers -- English he/she (+ possessive/reflexive) and CJK 他/她
    (singular only) -- and returns the dominant one, or '' when there is no clear signal so the
    Keeper is handed a real pronoun hint or nothing at all, never a coin-flip guess. This is data
    inference over text the user supplied, not generation, so it lives in the deterministic core.
    """
    if not text:
        return ""
    male = len(_EN_MALE_RE.findall(text)) + len(_ZH_MALE_RE.findall(text))
    female = len(_EN_FEMALE_RE.findall(text)) + len(_ZH_FEMALE_RE.findall(text))
    if male > female:
        return "he/him"
    if female > male:
        return "she/her"
    return ""


async def build_sheet_from_persona(
    services: Any,
    card: CharacterCard,
    system: str,
    *,
    module_context: str = "",
) -> CharacterSheet:
    manager = _character_manager_from_services(services)
    pack = load_rulepack(system)  # unknown systems raise ValueError with a clear message
    concept = await _ask_concept(services, card, pack.system, module_context)
    sheet = manager.generate_character(pack.system, card.name or None)
    sheet.name = card.name or sheet.name

    if not concept:
        _apply_persona_text(sheet, card, {})
        return sheet

    _bias_sheet(manager, sheet, pack, concept)
    _apply_persona_text(sheet, card, concept)
    return sheet


async def build_sheet_from_description(
    services: Any,
    description: str,
    system: str,
    *,
    name: str = "",
    module_context: str = "",
) -> CharacterSheet:
    text = description.strip()
    card = CharacterCard(name=name.strip(), description=text, personality=text)
    return await build_sheet_from_persona(services, card, system, module_context=module_context)


def _character_manager_from_services(services: Any) -> CharacterManager:
    manager = getattr(services, "characters", None)
    if isinstance(manager, CharacterManager):
        return manager
    store = getattr(services, "store", None)
    return CharacterManager(store if isinstance(store, Store) else Store(":memory:"))


async def _ask_concept(
    services: Any,
    card: CharacterCard,
    template_name: str,
    module_context: str,
) -> dict[str, Any]:
    llm = getattr(services, "llm", None)
    if llm is None:
        return {}

    prompt = _render_prompt(services, card, template_name, module_context)
    try:
        result = await llm.chat(
            [
                {"role": "system", "content": prompt},
                {"role": "user", "content": _persona_summary(card)},
            ],
            temperature=0,
        )
    except Exception:
        return {}
    return _parse_concept(getattr(result, "content", None))


def _render_prompt(services: Any, card: CharacterCard, template_name: str, module_context: str) -> str:
    i18n = getattr(services, "i18n", None)
    renderer = i18n.t if i18n is not None and hasattr(i18n, "t") else t
    return renderer(
        "charcard.concept_prompt",
        system=template_name,
        module_context=module_context,
        persona=_persona_summary(card),
    )


def _persona_summary(card: CharacterCard) -> str:
    parts = [
        f"name: {card.name}",
        f"description: {card.description}",
        f"personality: {card.personality}",
        f"scenario: {card.scenario}",
        f"tags: {', '.join(card.tags)}",
    ]
    return "\n".join(part for part in parts if not part.endswith(": "))


def _parse_concept(content: str | None) -> dict[str, Any]:
    if not content:
        return {}
    text = content.strip()
    candidates = [text]
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        candidates.append(text[start : end + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _bias_sheet(manager: CharacterManager, sheet: CharacterSheet, pack: RulePack, concept: dict[str, Any]) -> None:
    """Bias a freshly generated sheet toward `concept`: reassign its rolled or
    arrayed attributes to favor the concept's emphasis, set its occupation/class
    meta field, and raise its signature skills to a competent floor.

    Entirely generic over the pack's own ``creation_constraints`` shape -- a
    pack that declares a ``standard_array`` method plus ``archetype_priorities``
    places values by best-first archetype list; one that only declares rolled
    attributes redistributes each same-roll group's already-rolled values
    (never re-rolling). A pack with neither section (or no ``sheet:`` at all)
    is simply left at its freshly generated values.
    """
    constraints = pack.creation_constraints or {}
    attribute_rules: dict[str, Any] = constraints.get("attributes") or {}
    emphasis = _normalized_attrs(
        concept.get("attribute_emphasis") or concept.get("emphasis"), list(attribute_rules.keys())
    )
    role_text = _as_text(concept.get("occupation") or concept.get("class"))

    methods = constraints.get("methods") or {}
    array_values = (methods.get("standard_array") or {}).get("values")
    archetypes = constraints.get("archetype_priorities")
    if array_values and archetypes:
        _assign_by_archetype(sheet, emphasis, array_values, archetypes, constraints.get("default_archetype"), role_text)
    else:
        _assign_rolled_groups(sheet, emphasis, attribute_rules)

    spec = pack.sheet_spec
    if role_text and spec is not None:
        for field_name in ("occupation", "character_class"):
            if field_name in spec.fields:
                setattr(sheet, field_name, role_text)
                break

    for skill in _list_text(concept.get("signature_skills") or concept.get("skills")):
        canonical = manager.find_skill_by_alias(sheet, skill) or skill
        if has_check_value(sheet, pack, canonical):
            trained = min(99, max(int(sheet_value(sheet, pack, canonical)), 60))
            set_sheet_value(sheet, pack, canonical, trained)

    # A full creation-style refresh: the reassignment above may have moved the
    # very attributes a current-pool vital (HP/SAN/MP-alike) derives from, so
    # this sheet -- never having been played -- starts fresh at its recomputed
    # full values, exactly like `CharacterManager.generate_character` itself.
    refresh_sheet(sheet, pack, initialize_vitals=True)


def _assign_by_archetype(
    sheet: CharacterSheet,
    emphasis: list[str],
    values: list[Any],
    archetypes: Mapping[str, Any],
    default_archetype: Any,
    role_text: str,
) -> None:
    """Assign a declared standard array of values to attribute keys, following
    the archetype (a pack-declared, best-first attribute priority list) the
    concept's class/occupation text names -- falling back to the pack's
    declared default archetype, then to an arbitrary declared one."""
    base = archetypes.get(role_text.strip().casefold())
    if base is None:
        base = archetypes.get(str(default_archetype or "").strip().casefold())
    if base is None and archetypes:
        base = next(iter(archetypes.values()))
    if not base:
        return
    preferred = [attr for attr in emphasis if attr in base]
    priority = preferred + [attr for attr in base if attr not in preferred]
    for attr, value in zip(priority, values, strict=True):
        sheet.attributes[str(attr)] = value


def _assign_rolled_groups(sheet: CharacterSheet, emphasis: list[str], attribute_rules: Mapping[str, Any]) -> None:
    """Within each set of attribute keys sharing an identical roll/min/max (the
    pack's own rolled-attribute groups), redistribute their already-rolled
    values so the concept's emphasized attributes land on the group's highest
    rolls -- a same-distribution swap, never a re-roll."""
    groups: dict[tuple[Any, Any, Any], list[str]] = {}
    for key, rule in attribute_rules.items():
        if not isinstance(rule, Mapping):
            continue
        signature = (rule.get("roll"), rule.get("min"), rule.get("max"))
        groups.setdefault(signature, []).append(str(key))

    for attrs in groups.values():
        values = sorted((int(sheet.attributes.get(attr, 0)) for attr in attrs), reverse=True)
        preferred = [attr for attr in emphasis if attr in attrs]
        ordered_attrs = preferred + [attr for attr in attrs if attr not in preferred]
        for attr, value in zip(ordered_attrs, values, strict=True):
            sheet.attributes[attr] = value


def _normalized_attrs(value: Any, allowed: list[str]) -> list[str]:
    allowed_set = set(allowed)
    attrs = _list_text(value)
    normalized: list[str] = []
    for attr in attrs:
        key = attr.strip().upper()
        if key in allowed_set and key not in normalized:
            normalized.append(key)
    return normalized


def _list_text(value: Any) -> list[str]:
    if isinstance(value, list):
        return [_as_text(item) for item in value if _as_text(item)]
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    return []


def _apply_persona_text(sheet: CharacterSheet, card: CharacterCard, concept: dict[str, Any]) -> None:
    backstory = _as_text(concept.get("backstory"))
    if backstory:
        sheet.background = backstory
    else:
        sheet.background = card.description

    notes = [
        card.description,
        card.personality,
        card.scenario,
        _as_text(concept.get("notes")),
    ]
    sheet.notes = "\n".join(part for part in notes if part).strip()


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)
