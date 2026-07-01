"""Build rule-legal TRPG sheets from SillyTavern persona cards."""

from __future__ import annotations

import json
import re
from typing import Any

from core.character_manager import CharacterManager, CharacterSheet
from core.charcard import CharacterCard
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

COC_CHARACTERISTICS = ["STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU", "LUC"]
COC_HIGH_MIN_CHARACTERISTICS = {"SIZ", "INT", "EDU"}
DND_STANDARD_ARRAY = [15, 14, 13, 12, 10, 8]
DND_CLASS_PRIORITIES = {
    "barbarian": ["STR", "CON", "DEX", "WIS", "CHA", "INT"],
    "bard": ["CHA", "DEX", "CON", "WIS", "INT", "STR"],
    "cleric": ["WIS", "CON", "STR", "CHA", "INT", "DEX"],
    "druid": ["WIS", "CON", "DEX", "INT", "CHA", "STR"],
    "fighter": ["STR", "CON", "DEX", "WIS", "INT", "CHA"],
    "monk": ["DEX", "WIS", "CON", "STR", "INT", "CHA"],
    "paladin": ["STR", "CHA", "CON", "WIS", "DEX", "INT"],
    "ranger": ["DEX", "WIS", "CON", "STR", "INT", "CHA"],
    "rogue": ["DEX", "INT", "CON", "CHA", "WIS", "STR"],
    "sorcerer": ["CHA", "CON", "DEX", "WIS", "INT", "STR"],
    "warlock": ["CHA", "CON", "DEX", "WIS", "INT", "STR"],
    "wizard": ["INT", "CON", "DEX", "WIS", "CHA", "STR"],
}


async def build_sheet_from_persona(
    services: Any,
    card: CharacterCard,
    system: str,
    *,
    module_context: str = "",
) -> CharacterSheet:
    manager = _character_manager_from_services(services)
    template_name = _template_name(system)
    concept = await _ask_concept(services, card, template_name, module_context)
    sheet = manager.generate_character(template_name, card.name or None)
    sheet.name = card.name or sheet.name

    if not concept:
        _apply_persona_text(sheet, card, {})
        return sheet

    if template_name == "coc7":
        _bias_coc7_sheet(manager, sheet, concept)
    else:
        _bias_dnd5e_sheet(manager, sheet, concept)
    _apply_persona_text(sheet, card, concept)
    return sheet


def _character_manager_from_services(services: Any) -> CharacterManager:
    manager = getattr(services, "characters", None)
    if isinstance(manager, CharacterManager):
        return manager
    store = getattr(services, "store", None)
    return CharacterManager(store if isinstance(store, Store) else Store(":memory:"))


def _template_name(system: str) -> str:
    normalized = system.strip().lower()
    if normalized in {"coc", "coc7", "call of cthulhu"}:
        return "coc7"
    if normalized in {"dnd", "dnd5e", "d&d5e"}:
        return "dnd5e"
    return normalized


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


def _bias_coc7_sheet(manager: CharacterManager, sheet: CharacterSheet, concept: dict[str, Any]) -> None:
    emphasis = _normalized_attrs(concept.get("attribute_emphasis") or concept.get("emphasis"), COC_CHARACTERISTICS)
    _assign_coc_group(sheet, emphasis, [attr for attr in COC_CHARACTERISTICS if attr in COC_HIGH_MIN_CHARACTERISTICS])
    _assign_coc_group(sheet, emphasis, [attr for attr in COC_CHARACTERISTICS if attr not in COC_HIGH_MIN_CHARACTERISTICS])

    occupation = _as_text(concept.get("occupation") or concept.get("class"))
    if occupation:
        sheet.occupation = occupation
    for skill in _list_text(concept.get("signature_skills") or concept.get("skills")):
        standard = manager.find_skill_by_alias(sheet, skill) or skill
        if standard in sheet.skills:
            sheet.skills[standard] = min(99, max(int(sheet.skills.get(standard, 0)), 60))

    template = manager.templates.get("coc7")
    if template is not None:
        template._calculate_mappings(sheet)
    sheet._calc_coc_derived_skills()


def _assign_coc_group(sheet: CharacterSheet, emphasis: list[str], attrs: list[str]) -> None:
    values = sorted((int(sheet.attributes[attr]) for attr in attrs), reverse=True)
    preferred = [attr for attr in emphasis if attr in attrs]
    ordered_attrs = preferred + [attr for attr in attrs if attr not in preferred]
    for attr, value in zip(ordered_attrs, values, strict=True):
        sheet.attributes[attr] = value


def _bias_dnd5e_sheet(manager: CharacterManager, sheet: CharacterSheet, concept: dict[str, Any]) -> None:
    class_name = _as_text(concept.get("class") or concept.get("occupation")) or "Fighter"
    sheet.character_class = class_name
    emphasis = _normalized_attrs(concept.get("attribute_emphasis") or concept.get("emphasis"), list(sheet.attributes))
    priority = _dnd_priority(class_name, emphasis)
    for attr, value in zip(priority, DND_STANDARD_ARRAY, strict=True):
        sheet.attributes[attr] = value

    template = manager.templates.get("dnd5e")
    if template is not None:
        template._calculate_mappings(sheet)
        for skill, formula in template.skills.items():
            if isinstance(formula, str) and "{" in formula:
                sheet.skills[skill] = _eval_attr_formula(formula, sheet.attributes)


def _dnd_priority(class_name: str, emphasis: list[str]) -> list[str]:
    key = class_name.strip().lower()
    base = DND_CLASS_PRIORITIES.get(key, DND_CLASS_PRIORITIES["fighter"])
    preferred = [attr for attr in emphasis if attr in base]
    return preferred + [attr for attr in base if attr not in preferred]


def _normalized_attrs(value: Any, allowed: list[str]) -> list[str]:
    allowed_set = set(allowed)
    attrs = _list_text(value)
    normalized: list[str] = []
    for attr in attrs:
        key = attr.strip().upper()
        if key in allowed_set and key not in normalized:
            normalized.append(key)
    return normalized


def _eval_attr_formula(formula: str, attributes: dict[str, Any]) -> int:
    expression = formula
    for attr, value in attributes.items():
        expression = expression.replace(f"{{{attr}}}", str(value))
    try:
        return int(eval(expression, {"__builtins__": {}}))  # noqa: S307
    except Exception:
        return 0


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
