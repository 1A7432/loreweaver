"""Rule-pack loading and derived-stat computation for command routing.

A "rule pack" is a `rulepacks/<id>.yaml` file. Dropping a new file in that
directory makes the system usable: it is discovered, resolvable by its id,
its declared `names:`, and its `set_keys:`, and its `derived:` section is
compiled into safe, non-evaluated derived-stat formulas.

Derived stats are HYBRID:
  - a small SAFE declarative DSL (copy_of / half_of / floor_div / sum_ranges)
    for pure-data systems that need no code, and
  - a named-computer registry (real Python callables, `_NAMED_COMPUTERS`) for
    the built-in systems' bespoke math (CoC damage bonus, D&D ability mods, ...).
Nothing in the `derived:` section is ever `eval`/`exec`-ed.

Discovery additionally scans a user data-dir, `_USER_RULEPACK_DIR` (Layer B.3b -- see
`docs/plugins.md` "Layer B" and `agent.forge.generate_and_install_rulepack`), when one is
configured, so a generated rulepack is discoverable without living inside the checkout. A
built-in id always wins over a same-named user-dir pack; left unset (the default), discovery is
byte-identical to before this existed.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parent.parent
_RULEPACK_DIR = _REPO_ROOT / "rulepacks"
_SPACE_RE = re.compile(r"\s+")

# Layer B.3b (the rulepack-generation engine, `agent.forge`) discovery target: a user data-dir
# `rulepacks/` directory, set once at startup (`app.py`: `core.rulepacks._USER_RULEPACK_DIR =
# Path(settings.data_dir) / "rulepacks"`) so a generated rulepack need not live inside the checkout.
# `None` (the default, and every test unless it opts in) means discovery scans ONLY `_RULEPACK_DIR`,
# byte-identical to before this existed. `_discover_registry` reads this module attribute at scan
# time (not a value captured at import time), so setting it after import -- as `app.py` and tests
# both do -- takes effect on the next `reload_rulepacks()`/cache miss. Mirrors `core.skills`'s
# `_USER_SKILL_DIR` precedent exactly.
_USER_RULEPACK_DIR: Path | None = None


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


# --------------------------------------------------------------------------
# Built-in derived-stat computers (real code; the deterministic core).
# --------------------------------------------------------------------------


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


# Individually-named computers, referenceable from YAML via `{computer: <name>}`.
_NAMED_COMPUTERS: dict[str, Callable[[Mapping[str, Any]], Any]] = {
    "coc_db": _coc_db,
    "coc_build": _coc_build,
    "coc_mov": _coc_mov,
    "coc_hp": _coc_hp,
    "coc_mp": _coc_mp,
    "coc_sanmax": _coc_sanmax,
    "coc_own_language": _coc_own_language,
    "coc_dodge": _coc_dodge,
}

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

# Whole generated tables, referenceable from YAML via `{computer_group: <id>}`.
# Lets a pack reuse a built-in system's entire generated derived table (e.g.
# dnd5e's per-skill ability-modifier table) without hand-transcribing it.
_COMPUTER_GROUPS: dict[str, dict[str, Callable[[Mapping[str, Any]], Any]]] = {
    "coc7": _COC_DERIVED,
    "dnd5e": _DND_DERIVED,
}


# --------------------------------------------------------------------------
# Safe declarative derived-stat DSL. Never eval/exec: every spec shape below
# is the ONLY vocabulary understood; anything else raises ValueError at load.
# --------------------------------------------------------------------------


def _compile_copy_of(stat: str, default: int) -> Callable[[Mapping[str, Any]], Any]:
    # Numeric copy: int-coerce (like the built-in computers) and fall back to the source
    # stat's DECLARED default, so a partial/non-numeric values dict yields the same result as
    # a full sheet — matching e.g. the old `_coc_own_language` (`_int_value(values, 教育, 50)`).
    def _calc(values: Mapping[str, Any]) -> Any:
        return _int_value(values, stat, default)

    return _calc


def _compile_half_of(stat: str, default: int) -> Callable[[Mapping[str, Any]], Any]:
    def _calc(values: Mapping[str, Any]) -> Any:
        return _int_value(values, stat, default) // 2

    return _calc


def _compile_floor_div(stat: str, divisor: int, default: int) -> Callable[[Mapping[str, Any]], Any]:
    def _calc(values: Mapping[str, Any]) -> Any:
        return _int_value(values, stat, default) // divisor

    return _calc


def _compile_sum_ranges(
    stats: list[tuple[str, int]], ranges: list[tuple[int, int, Any]], fallback: Any
) -> Callable[[Mapping[str, Any]], Any]:
    # `stats` is a list of (name, default) so each summand falls back to its declared default.
    def _calc(values: Mapping[str, Any]) -> Any:
        total = sum(_int_value(values, stat, default) for stat, default in stats)
        for lo, hi, result in ranges:
            if lo <= total <= hi:
                return result
        return fallback

    return _calc


def _compile_derived_spec(
    pack_id: str, stat_name: str, spec: Any, defaults: Mapping[str, Any] | None = None
) -> Callable[[Mapping[str, Any]], Any]:
    """Compile one `derived:` entry's spec into a callable. SAFE: fixed vocabulary only.

    `defaults` is the pack's declared defaults, used so a stat-referencing primitive falls
    back to that stat's declared default (matching the built-in computers' hardcoded defaults);
    omit it (as isolated unit tests do) to fall back to 0.
    """
    if defaults is None:
        defaults = {}
    if not isinstance(spec, Mapping):
        raise ValueError(f"rulepack '{pack_id}': derived spec for '{stat_name}' must be a mapping, got {spec!r}")

    if "computer" in spec:
        name = str(spec["computer"])
        func = _NAMED_COMPUTERS.get(name)
        if func is None:
            raise ValueError(f"rulepack '{pack_id}': unknown computer '{name}' for derived stat '{stat_name}'")
        return func

    if "copy_of" in spec:
        stat = str(spec["copy_of"])
        return _compile_copy_of(stat, _int_value(defaults, stat, 0))

    if "half_of" in spec:
        stat = str(spec["half_of"])
        return _compile_half_of(stat, _int_value(defaults, stat, 0))

    if "floor_div" in spec:
        params = spec["floor_div"]
        if not isinstance(params, Mapping) or "of" not in params or "by" not in params:
            raise ValueError(f"rulepack '{pack_id}': 'floor_div' for '{stat_name}' needs 'of' and 'by'")
        stat = str(params["of"])
        return _compile_floor_div(stat, int(params["by"]), _int_value(defaults, stat, 0))

    if "sum_ranges" in spec:
        params = spec["sum_ranges"]
        if not isinstance(params, Mapping) or "of" not in params or "ranges" not in params:
            raise ValueError(f"rulepack '{pack_id}': 'sum_ranges' for '{stat_name}' needs 'of' and 'ranges'")
        stats = [(str(item), _int_value(defaults, str(item), 0)) for item in params["of"]]
        ranges: list[tuple[int, int, Any]] = []
        for entry in params["ranges"]:
            if not isinstance(entry, (list, tuple)) or len(entry) != 3:
                raise ValueError(f"rulepack '{pack_id}': 'sum_ranges' range entries must be [lo, hi, value]")
            lo, hi, result = entry
            ranges.append((int(lo), int(hi), result))
        return _compile_sum_ranges(stats, ranges, params.get("else"))

    raise ValueError(f"rulepack '{pack_id}': unrecognized derived spec shape for '{stat_name}': {spec!r}")


def _compile_derived_section(
    pack_id: str, derived: Mapping[str, Any], defaults: Mapping[str, Any] | None = None
) -> dict[str, Callable[[Mapping[str, Any]], Any]]:
    formulas: dict[str, Callable[[Mapping[str, Any]], Any]] = {}
    for stat_name, spec in derived.items():
        if isinstance(spec, Mapping) and "computer_group" in spec:
            group_id = str(spec["computer_group"])
            group = _COMPUTER_GROUPS.get(group_id)
            if group is None:
                raise ValueError(f"rulepack '{pack_id}': unknown computer_group '{group_id}'")
            formulas.update(group)
            continue
        formulas[str(stat_name)] = _compile_derived_spec(pack_id, str(stat_name), spec, defaults)
    return formulas


# --------------------------------------------------------------------------
# RulePack + discovery.
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class RulePack:
    """Loaded command rule-pack with flattened alias resolution."""

    system: str
    defaults: dict[str, Any]
    alias: dict[str, list[str]]
    st_show: dict[str, Any]
    set_keys: list[str]
    creation_constraints: dict[str, Any]
    alias_to_canonical: dict[str, str]
    derived_formulas: dict[str, Callable[[Mapping[str, Any]], Any]]
    names: list[str] = field(default_factory=list)
    display: dict[str, dict[str, str]] = field(default_factory=dict)

    def resolve_skill(self, name: str) -> str | None:
        """Resolve a player-entered skill/attribute name to this pack's canonical key."""
        return self.alias_to_canonical.get(_normalize_alias(name))

    def display_name(self, name: str, locale: str) -> str:
        """Localized display name for a canonical key; falls back to the key itself.

        Canonical keys stay the single identity used in sheets/aliases/derived
        formulas — `display` is presentation-only, so a missing locale table or
        an unmapped key can never break resolution.
        """
        base = str(locale or "").replace("_", "-").split("-")[0].casefold()
        return self.display.get(base, {}).get(name, name)

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


def _parse_display_section(pack_id: str, raw: Any) -> dict[str, dict[str, str]]:
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise ValueError(f"rulepack '{pack_id}': 'display' must be a mapping of locale -> name table")
    display: dict[str, dict[str, str]] = {}
    for locale, table in raw.items():
        if not isinstance(table, Mapping):
            raise ValueError(f"rulepack '{pack_id}': 'display.{locale}' must be a mapping of canonical -> display name")
        display[str(locale).casefold()] = {str(key): str(value) for key, value in table.items()}
    return display


def _build_rulepack(pack_id: str, data: Mapping[str, Any]) -> RulePack:
    alias = data.get("alias") or {}
    derived = data.get("derived") or {}
    defaults = dict(data.get("defaults") or {})
    return RulePack(
        system=pack_id,
        defaults=defaults,
        alias={str(key): list(value or []) for key, value in alias.items()},
        st_show=dict(data.get("st_show") or {}),
        set_keys=list(data.get("set_keys") or []),
        creation_constraints=dict(data.get("creation_constraints") or {}),
        alias_to_canonical=_build_alias_map(alias),
        derived_formulas=_compile_derived_section(pack_id, derived, defaults),
        names=[str(name) for name in (data.get("names") or [])],
        display=_parse_display_section(pack_id, data.get("display")),
    )


def parse_rulepack_text(pack_id: str, text: str) -> RulePack:
    """Parse rulepack YAML `text` into a `RulePack`, assigning it `pack_id`.

    The same YAML-to-`RulePack` builder `_discover_registry` uses on-disk, exposed so a caller
    that has rulepack YAML in memory (`agent.forge`, validating LLM-generated rulepack text
    before ever writing it to disk) can validate against the identical rules real discovery will
    later apply -- no separate/divergent parser to keep in sync (mirrors
    `core.skills.parse_skill_text`'s precedent). Raises `ValueError` on any malformed input (bad
    YAML, a non-mapping root, or an invalid `derived:` spec -- see `_compile_derived_section`);
    never `eval`/`exec`s anything -- the YAML is `yaml.safe_load`-ed only and `derived:` compiles
    through the fixed safe DSL / named-computer vocabulary only.
    """
    data = yaml.safe_load(text) or {}
    if not isinstance(data, Mapping):
        raise ValueError(f"rulepack '{pack_id}': YAML root must be a mapping, got {type(data).__name__}")
    return _build_rulepack(pack_id, data)


def _parse_rulepack_file(path: Path) -> RulePack:
    return parse_rulepack_text(path.stem, path.read_text(encoding="utf-8"))


def _scan_rulepack_dir(directory: Path, registry: dict[str, RulePack], *, allow_override: bool) -> None:
    """Scan `directory` for `<id>.yaml` files, adding valid parses into `registry`.

    A malformed file (parse error, bad structure, or an invalid `derived:` spec) is logged and
    skipped -- it never prevents discovery of the other, valid packs (mirrors
    `core.skills._scan_skill_dir`). When `allow_override` is False, an id already present in
    `registry` is left untouched: this is how a user-dir pack (Layer B.3b, `agent.forge`) can
    never shadow a built-in of the same id -- a built-in always wins.
    """
    if not directory.is_dir():
        return
    for path in sorted(directory.glob("*.yaml")):
        if not allow_override and path.stem in registry:
            continue
        try:
            registry[path.stem] = _parse_rulepack_file(path)
        except Exception:
            logger.warning("Skipping malformed rulepack file: %s", path, exc_info=True)


@cache
def _discover_registry() -> dict[str, RulePack]:
    """Scan `rulepacks/*.yaml` (built-in), then `_USER_RULEPACK_DIR` (Layer B.3b) when set.

    Robust by construction: a single malformed/broken YAML file (parse error, bad structure, or
    an invalid `derived:` spec) is logged and skipped — it never prevents discovery of the other,
    valid packs. A built-in id always wins over a same-named user-dir entry
    (`_scan_rulepack_dir`'s `allow_override=False` for the user dir), so a generated pack can
    never override e.g. `coc7`/`dnd5e`. With `_USER_RULEPACK_DIR` left at its default `None`
    (every test unless it opts in), this scans ONLY `_RULEPACK_DIR` -- byte-identical to before
    the user data-dir existed.
    """
    registry: dict[str, RulePack] = {}
    _scan_rulepack_dir(_RULEPACK_DIR, registry, allow_override=True)
    if _USER_RULEPACK_DIR is not None:
        _scan_rulepack_dir(_USER_RULEPACK_DIR, registry, allow_override=False)
    return registry


@cache
def _alias_resolver() -> dict[str, str]:
    """Normalized alias -> pack id, built from each pack's id, `names:`, and `set_keys:`."""
    resolver: dict[str, str] = {}
    for pack_id, pack in _discover_registry().items():
        for candidate in (pack_id, *pack.names, *pack.set_keys):
            key = _normalize_alias(str(candidate))
            resolver.setdefault(key, pack_id)
    return resolver


def reload_rulepacks() -> None:
    """Clear both cached lookups so a just-written rulepack (`agent.forge`) is picked up
    immediately: the discovery registry AND the alias resolver built from it -- rulepacks (unlike
    `core.skills`) additionally cache alias resolution, so both `@cache`s must be cleared together
    or a newly installed pack's names/set_keys would keep resolving against the stale registry.
    Discovery is otherwise cached for process lifetime; nothing else needs to call this in normal
    operation since the on-disk rulepack set doesn't change outside of generation.
    """
    _discover_registry.cache_clear()
    _alias_resolver.cache_clear()


def built_in_rulepack_ids() -> set[str]:
    """File stems under `_RULEPACK_DIR` — the BUILT-IN rulepacks only, never `_USER_RULEPACK_DIR`.

    Used by `agent.forge` to reject a generated rulepack id that collides with a built-in (e.g.
    `coc7`, `dnd5e`) before ever writing it -- deliberately a raw file listing rather than going
    through `_discover_registry`/`available_systems`, so this stays accurate even if a built-in's
    own YAML happens to be malformed at the moment of the check.
    """
    if not _RULEPACK_DIR.is_dir():
        return set()
    return {path.stem for path in _RULEPACK_DIR.glob("*.yaml")}


def built_in_aliases() -> set[str]:
    """Every normalized alias (id + declared `names:` + `set_keys:`) claimed by a BUILT-IN rulepack.

    Used by `agent.forge` to refuse a generated pack that tries to CLAIM a built-in's name/alias
    (e.g. a user pack with `names: [..., coc7]`). A built-in already wins resolution today via
    `_alias_resolver`'s insertion order, but rejecting up front makes the invariant explicit rather
    than dependent on scan order, and stops a generated pack from declaring a dead alias it could
    never actually resolve as.
    """
    aliases: set[str] = set()
    for pack_id in built_in_rulepack_ids():
        try:
            pack = load_rulepack(pack_id)
        except ValueError:
            continue
        for candidate in (pack.system, *pack.names, *pack.set_keys):
            aliases.add(_normalize_alias(str(candidate)))
    return aliases


def claims_built_in_alias(candidates: Iterable[str]) -> bool:
    """True if any of `candidates` (a pack's declared names/set_keys) normalizes to an alias already
    reserved by a built-in rulepack — the check `agent.forge` uses to reject such a generated pack."""
    reserved = built_in_aliases()
    return any(_normalize_alias(str(candidate)) in reserved for candidate in candidates)


def available_systems() -> list[str]:
    """Return the sorted ids of every rule pack discoverable in `rulepacks/`."""
    return sorted(_discover_registry())


def load_rulepack(system: str) -> RulePack:
    """Resolve `system` (an id, a declared name, or a set_key) to its RulePack.

    Resolution is cached keyed by the resolved pack id (via `_discover_registry`),
    so every alias of a pack returns the same loaded `RulePack`.
    """
    pack_id = _alias_resolver().get(_normalize_alias(system))
    if pack_id is None:
        raise ValueError(f"unknown rulepack: {system}")
    return _discover_registry()[pack_id]
