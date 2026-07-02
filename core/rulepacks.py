"""Rule-pack loading and fixed derived-stat helpers for command routing."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

import yaml

_REPO_ROOT = Path(__file__).resolve().parent.parent
_RULEPACK_DIR = _REPO_ROOT / "rulepacks"
_SPACE_RE = re.compile(r"\s+")


def _normalize_alias(value: str) -> str:
    text = value.strip().casefold().replace("_", " ")
    text = text.replace("：", ":").replace("（", "(").replace("）", ")")
    return _SPACE_RE.sub(" ", text)


def _int_value(values: Mapping[str, Any], key: str, default: int = 0) -> int:
    value = values.get(key, default)
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _coc_str_siz(values: Mapping[str, Any]) -> int:
    return _int_value(values, "力量", 50) + _int_value(values, "体型", 50)


def _coc_db(values: Mapping[str, Any]) -> str:
    total = _coc_str_siz(values)
    if total < 65:
        return "-2"
    if total < 85:
        return "-1"
    if total < 125:
        return "0"
    if total < 165:
        return "1d4"
    if total < 205:
        return "1d6"
    dice_count = ((total - 205) // 80) + 2
    return f"{dice_count}d6"


def _coc_build(values: Mapping[str, Any]) -> int:
    total = _coc_str_siz(values)
    if total < 65:
        return -2
    if total < 85:
        return -1
    if total < 125:
        return 0
    if total < 165:
        return 1
    if total < 205:
        return 2
    return ((total - 205) // 80) + 3


def _coc_mov(values: Mapping[str, Any]) -> int:
    dex = _int_value(values, "敏捷", 50)
    strength = _int_value(values, "力量", 50)
    siz = _int_value(values, "体型", 50)
    if dex > siz and strength > siz:
        return 9
    if dex < siz and strength < siz:
        return 7
    return 8


def _coc_hp(values: Mapping[str, Any]) -> int:
    return (_int_value(values, "体质", 50) + _int_value(values, "体型", 50)) // 10


def _coc_mp(values: Mapping[str, Any]) -> int:
    return _int_value(values, "意志", 50) // 5


def _coc_sanmax(values: Mapping[str, Any]) -> int:
    return 99 - _int_value(values, "克苏鲁神话", 0)


def _coc_own_language(values: Mapping[str, Any]) -> int:
    return _int_value(values, "教育", 50)


def _coc_dodge(values: Mapping[str, Any]) -> int:
    return _int_value(values, "敏捷", 50) // 2


def _dnd_mod_for(ability: str) -> Callable[[Mapping[str, Any]], int]:
    def _calc(values: Mapping[str, Any]) -> int:
        return (_int_value(values, ability, 10) - 10) // 2

    return _calc


_DND_SKILL_ABILITIES: dict[str, str] = {
    "运动": "力量",
    "体操": "敏捷",
    "巧手": "敏捷",
    "隐匿": "敏捷",
    "调查": "智力",
    "奥秘": "智力",
    "历史": "智力",
    "自然": "智力",
    "宗教": "智力",
    "察觉": "感知",
    "洞悉": "感知",
    "驯兽": "感知",
    "医药": "感知",
    "求生": "感知",
    "游说": "魅力",
    "欺瞒": "魅力",
    "威吓": "魅力",
    "表演": "魅力",
}


def _dnd_skill_for(skill: str) -> Callable[[Mapping[str, Any]], int]:
    ability = _DND_SKILL_ABILITIES[skill]
    return _dnd_mod_for(ability)


def _dnd_pp(values: Mapping[str, Any]) -> int:
    perception = values.get("察觉")
    if perception is None:
        perception = _dnd_skill_for("察觉")(values)
    return 10 + _int_value({"察觉": perception}, "察觉", 0)


_COC_DERIVED: dict[str, Callable[[Mapping[str, Any]], Any]] = {
    "DB": _coc_db,
    "体格": _coc_build,
    "移动力": _coc_mov,
    "生命值上限": _coc_hp,
    "生命值": _coc_hp,
    "魔法值上限": _coc_mp,
    "魔法值": _coc_mp,
    "理智上限": _coc_sanmax,
    "母语": _coc_own_language,
    "闪避": _coc_dodge,
}

_DND_DERIVED: dict[str, Callable[[Mapping[str, Any]], Any]] = {
    "pp": _dnd_pp,
    "力量调整值": _dnd_mod_for("力量"),
    "敏捷调整值": _dnd_mod_for("敏捷"),
    "体质调整值": _dnd_mod_for("体质"),
    "智力调整值": _dnd_mod_for("智力"),
    "感知调整值": _dnd_mod_for("感知"),
    "魅力调整值": _dnd_mod_for("魅力"),
    **{skill: _dnd_skill_for(skill) for skill in _DND_SKILL_ABILITIES},
}

_DERIVED_TABLES: dict[str, dict[str, Callable[[Mapping[str, Any]], Any]]] = {
    "coc7": _COC_DERIVED,
    "dnd5e": _DND_DERIVED,
}


@dataclass(frozen=True)
class RulePack:
    """Loaded command rule-pack with flattened alias resolution."""

    system: str
    defaults: dict[str, Any]
    defaults_computed: dict[str, str]
    alias: dict[str, list[str]]
    st_show: dict[str, Any]
    set_keys: list[str]
    creation_constraints: dict[str, Any]
    alias_to_canonical: dict[str, str]
    derived_formulas: dict[str, Callable[[Mapping[str, Any]], Any]]

    def resolve_skill(self, name: str) -> str | None:
        """Resolve a player-entered skill/attribute name to this pack's canonical key."""
        return self.alias_to_canonical.get(_normalize_alias(name))

    def compute_derived(self, values: Mapping[str, Any]) -> dict[str, Any]:
        """Compute fixed derived attributes for `values` without evaluating pack code."""
        return {name: func(values) for name, func in self.derived_formulas.items()}


def _build_alias_map(alias: Mapping[str, Any]) -> dict[str, str]:
    flattened: dict[str, str] = {}
    for canonical, variants in alias.items():
        canonical_str = str(canonical)
        flattened[_normalize_alias(canonical_str)] = canonical_str
        if variants is None:
            continue
        for variant in variants:
            flattened[_normalize_alias(str(variant))] = canonical_str
    return flattened


@cache
def load_rulepack(system: str) -> RulePack:
    """Load and cache `rulepacks/{coc7,dnd5e}.yaml`."""
    normalized = system.strip().casefold()
    if normalized in {"coc", "coc7", "call of cthulhu"}:
        normalized = "coc7"
    elif normalized in {"dnd", "dnd5e", "d&d5e"}:
        normalized = "dnd5e"
    else:
        raise ValueError(f"unknown rulepack: {system}")

    path = _RULEPACK_DIR / f"{normalized}.yaml"
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}

    alias = data.get("alias") or {}
    return RulePack(
        system=normalized,
        defaults=dict(data.get("defaults") or {}),
        defaults_computed=dict(data.get("defaultsComputed") or {}),
        alias={str(key): list(value or []) for key, value in alias.items()},
        st_show=dict(data.get("st_show") or {}),
        set_keys=list(data.get("set_keys") or []),
        creation_constraints=dict(data.get("creation_constraints") or {}),
        alias_to_canonical=_build_alias_map(alias),
        derived_formulas=dict(_DERIVED_TABLES[normalized]),
    )
