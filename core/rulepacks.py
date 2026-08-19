"""Rule-pack loading and derived-stat computation for command routing.

A "rule pack" is a `rulepacks/<id>.yaml` file. Dropping a new file in that
directory makes the system usable: it is discovered, resolvable by its id,
its declared `names:`, and its `set_keys:`, and its `derived:` section is
compiled into safe, non-evaluated derived-stat formulas.

Derived stats are HYBRID:
  - a small SAFE declarative DSL (copy_of / half_of / floor_div / sum_ranges)
    for pure-data systems that need no code, and
  - a named-computer registry (real Python callables, `_NAMED_COMPUTERS`) as
    the LAST-RESORT lane for third-party math the DSL cannot express.
Nothing in the `derived:` section is ever `eval`/`exec`-ed.

Discovery additionally scans a user data-dir, `_USER_RULEPACK_DIR` (Layer B.3b -- see
`docs/plugins.md` "Layer B" and `agent.forge.generate_and_install_rulepack`), when one is
configured, so a generated rulepack is discoverable without living inside the checkout. A
built-in id always wins over a same-named user-dir pack; left unset (the default), discovery is
byte-identical to before this existed.
"""

from __future__ import annotations

import logging
import math
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any

from core.condexpr import CondExprError, compile_expression
from core.resolution import CheckResolver, compile_resolution
from core.sheets import SheetSpec, parse_sheet_section
from core.subsystems import SubsystemSpec, parse_subsystems
from core.yaml_safety import safe_load_no_aliases

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
# Derived-stat computer registries — the LAST-RESORT extension point (M16
# addendum: replaceable strategies over hookable internals). The engine ships
# them EMPTY: every bundled system's derived math is pack DSL data below; a
# genuinely inexpressible third-party weirdo may register real code here at
# startup and reference it via `{computer: <name>}` / `{computer_group: <id>}`.
# --------------------------------------------------------------------------

_NAMED_COMPUTERS: dict[str, Callable[[Mapping[str, Any]], Any]] = {}
_COMPUTER_GROUPS: dict[str, dict[str, Callable[[Mapping[str, Any]], Any]]] = {}


def register_computer(name: str, func: Callable[[Mapping[str, Any]], Any]) -> None:
    _NAMED_COMPUTERS[str(name)] = func


def register_computer_group(group_id: str, table: Mapping[str, Callable[[Mapping[str, Any]], Any]]) -> None:
    _COMPUTER_GROUPS[str(group_id)] = dict(table)


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
                return result(values) if callable(result) else result
        return fallback(values) if callable(fallback) else fallback

    return _calc


_DERIVED_EXPR_FUNCTIONS: dict[str, Callable[..., Any]] = {
    "floor": lambda value: math.floor(value),
    "ceil": lambda value: math.ceil(value),
    "min": lambda *values: min(values),
    "max": lambda *values: max(values),
    "abs": lambda value: abs(value),
    # Function-form conditional (kept OUT of the shared condexpr grammar — the
    # one expression grammar never grows syntax for one consumer). Eager, pure.
    "if": lambda condition, then_value, else_value: then_value if condition else else_value,
}


def _compile_expr_value(
    pack_id: str, stat_name: str, spec: Any, defaults: Mapping[str, Any]
) -> Callable[[Mapping[str, Any]], Any]:
    """Compile an ``{expr: ..., format: ...}`` value: `core.condexpr` arithmetic
    over the stat namespace (missing / non-numeric names fall back to the
    pack's declared default, else 0), with an optional str.format wrapper —
    how a banded table's open tail expresses computed dice grades."""
    if isinstance(spec, Mapping):
        expr_text = spec.get("expr")
        format_text = spec.get("format")
        unknown = set(spec) - {"expr", "format"}
        if unknown:
            raise ValueError(f"rulepack '{pack_id}': expr spec for '{stat_name}' has unknown keys {sorted(unknown)}")
    else:
        expr_text, format_text = spec, None
    if not isinstance(expr_text, str) or not expr_text.strip():
        raise ValueError(f"rulepack '{pack_id}': expr for '{stat_name}' must be a non-empty string")
    if format_text is not None and not isinstance(format_text, str):
        raise ValueError(f"rulepack '{pack_id}': format for '{stat_name}' must be a string")
    try:
        compiled = compile_expression(expr_text, functions=_DERIVED_EXPR_FUNCTIONS)
    except CondExprError as exc:
        raise ValueError(f"rulepack '{pack_id}': bad expr for '{stat_name}': {exc}") from exc

    def _calc(values: Mapping[str, Any]) -> Any:
        def resolve(path: str) -> Any:
            raw = values.get(path, defaults.get(path, 0))
            if isinstance(raw, bool):
                return int(raw)
            if isinstance(raw, (int, float)):
                return raw
            try:
                return int(str(raw).strip())
            except (TypeError, ValueError):
                return _int_value(defaults, path, 0)

        result = compiled(resolve)
        if isinstance(result, float) and result.is_integer():
            result = int(result)
        if format_text is not None:
            return format_text.format(result)
        return result

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

    if "expr" in spec:
        return _compile_expr_value(pack_id, stat_name, spec, defaults)

    if "sum_ranges" in spec:
        params = spec["sum_ranges"]
        if not isinstance(params, Mapping) or "of" not in params or "ranges" not in params:
            raise ValueError(f"rulepack '{pack_id}': 'sum_ranges' for '{stat_name}' needs 'of' and 'ranges'")
        stats = [(str(item), _int_value(defaults, str(item), 0)) for item in params["of"]]

        def _range_value(raw: Any) -> Any:
            if isinstance(raw, Mapping) and "expr" in raw:
                return _compile_expr_value(pack_id, stat_name, raw, defaults)
            return raw

        ranges: list[tuple[int, int, Any]] = []
        for entry in params["ranges"]:
            if not isinstance(entry, (list, tuple)) or len(entry) != 3:
                raise ValueError(f"rulepack '{pack_id}': 'sum_ranges' range entries must be [lo, hi, value]")
            lo, hi, result = entry
            ranges.append((int(lo), int(hi), _range_value(result)))
        return _compile_sum_ranges(stats, ranges, _range_value(params.get("else")))

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
class RankLabel:
    """One rank's presentation labels for one locale.

    ``display`` renders in tool output / wire frames; ``markers`` are the
    surface forms (display variants, common synonyms) the agent's dice-first
    detectors treat as proof the model already narrated a graded outcome. A
    pack keeps a too-generic display word ("Success", "成功") OUT of
    ``markers`` so ordinary narration doesn't false-positive.
    """

    display: str
    markers: tuple[str, ...]


@dataclass(frozen=True)
class CommandBinding:
    """One dot-command dialect word's binding: either the generic ``check``
    action or a pack-declared subsystem tool (with optional preset args)."""

    action: str = ""  # "check" | "" (tool binding)
    tool: str = ""  # a subsystems: key
    args: dict[str, Any] = field(default_factory=dict)


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
    labels: dict[str, dict[str, RankLabel]] = field(default_factory=dict)
    resolver: CheckResolver | None = None
    subsystems: dict[str, SubsystemSpec] = field(default_factory=dict)
    expertise: dict[str, str] = field(default_factory=dict)
    commands: dict[str, CommandBinding] = field(default_factory=dict)
    sheet_spec: SheetSpec | None = None
    initiative_roll: str = ""  # dice expression; {name} slots read canonical sheet values
    # M20 C: the room's end-of-turn check table, as DECLARED (raw rows, shape-validated).
    # Core validates the shape and stays out of the meaning: a condition name is engine
    # code, so `agent.turn_checks` is what resolves it, drops an unknown one, and clamps
    # the round caps against the per-turn model-call budget.
    turn_checks: tuple[dict[str, Any], ...] = ()

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
        """Compute derived attributes for `values` without evaluating pack code.

        Evaluation is a DAG FOLD in declaration order: each computed value joins
        the namespace, so later entries may reference earlier derived results
        (the pack orders its own dependencies). The pipeline is
        ``source -> (modifier layer) -> derived`` — the modifier layer is a
        RESERVED, currently-empty insertion point (M16 addendum): when
        effects/conditions arrive they slot in between without reshaping the DAG.
        """
        namespace: dict[str, Any] = dict(values)
        out: dict[str, Any] = {}
        for name, func in self.derived_formulas.items():
            result = func(namespace)
            out[name] = result
            if name not in values:
                # Later entries see earlier DERIVED results, but a SOURCE value
                # the caller supplied always wins as a reference (e.g. a trained
                # skill overriding its derived untrained base).
                namespace[name] = result
        return out

    def rank_label(self, rank_id: str, locale: str) -> str:
        """Localized display label for a rank id; falls back to `en`, then the id."""
        base = str(locale or "").replace("_", "-").split("-")[0].casefold()
        for table in (self.labels.get(base), self.labels.get("en")):
            if table and rank_id in table:
                return table[rank_id].display
        return rank_id

    def expertise_text(self, locale: str) -> str:
        """The pack's per-locale keeper-expertise prompt text ("" when undeclared)."""
        base = str(locale or "en").replace("_", "-").split("-")[0].casefold()
        return self.expertise.get(base) or self.expertise.get("en") or ""


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


def _parse_labels_section(pack_id: str, raw: Any) -> dict[str, dict[str, RankLabel]]:
    """Parse a pack's ``labels:`` (locale -> rank id -> label spec) section.

    A label spec is either a bare string (display == the only marker), a list
    (first entry displays, every entry is a marker), or a mapping
    ``{display: ..., markers: [...]}`` for the explicit split — how a pack
    keeps a too-generic display word out of the detector vocabulary.
    """
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise ValueError(f"rulepack '{pack_id}': 'labels' must be a mapping of locale -> rank table")
    labels: dict[str, dict[str, RankLabel]] = {}
    for locale, table in raw.items():
        if not isinstance(table, Mapping):
            raise ValueError(f"rulepack '{pack_id}': 'labels.{locale}' must be a mapping of rank id -> label")
        parsed: dict[str, RankLabel] = {}
        for rank_id, spec in table.items():
            if isinstance(spec, str):
                parsed[str(rank_id)] = RankLabel(display=spec, markers=(spec,))
            elif isinstance(spec, (list, tuple)) and spec and all(isinstance(item, str) for item in spec):
                parsed[str(rank_id)] = RankLabel(display=str(spec[0]), markers=tuple(str(item) for item in spec))
            elif isinstance(spec, Mapping) and isinstance(spec.get("display"), str):
                markers = spec.get("markers", ())
                if not isinstance(markers, (list, tuple)) or not all(isinstance(item, str) for item in markers):
                    raise ValueError(f"rulepack '{pack_id}': 'labels.{locale}.{rank_id}' markers must be a string list")
                parsed[str(rank_id)] = RankLabel(display=str(spec["display"]), markers=tuple(str(m) for m in markers))
            else:
                raise ValueError(f"rulepack '{pack_id}': bad label spec for 'labels.{locale}.{rank_id}': {spec!r}")
        labels[str(locale).casefold()] = parsed
    return labels


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


def _dir_script_loader(pack_id: str, directory: Path | None) -> Callable[[str], str] | None:
    """A `resolution.script` loader confined to `directory` (the pack YAML's own
    directory): bare filenames only — path separators/parents are rejected so a
    pack can never read outside its dir. None when there is no file context.

    Two layouts resolve, in this order: `directory/<pack_id>/<name>`, where
    `core.pack.install_pack` namespaces an installed pack's scripts so two packs
    shipping `resolver.js` into this shared dir cannot overwrite each other; then
    `directory/<name>`, the loose layout an author writes by hand and `agent.forge`
    generates. Authored YAML says `script: resolver.js` either way.
    """
    if directory is None:
        return None

    def _load(filename: str) -> str:
        name = filename.strip()
        if not name or "/" in name or "\\" in name or name != Path(name).name or name.startswith(".."):
            raise ValueError(f"rulepack '{pack_id}': script filename must be a bare name, got {filename!r}")
        # `pack_id` is a file stem on the discovery path, but callers pass it freely:
        # only ever treat a bare id as a directory segment.
        if pack_id and pack_id == Path(pack_id).name and pack_id not in (".", ".."):
            namespaced = directory / pack_id / name
            if namespaced.is_file():
                return namespaced.read_text(encoding="utf-8")
        return (directory / name).read_text(encoding="utf-8")

    return _load


def _build_rulepack(
    pack_id: str, data: Mapping[str, Any], *, script_loader: Callable[[str], str] | None = None
) -> RulePack:
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
        labels=_parse_labels_section(pack_id, data.get("labels")),
        resolver=(
            compile_resolution(pack_id, data["resolution"], script_loader=script_loader)
            if data.get("resolution") is not None
            else None
        ),
        subsystems=parse_subsystems(pack_id, data.get("subsystems"), script_loader=script_loader),
        expertise=_parse_expertise_section(pack_id, data.get("expertise")),
        commands=_parse_commands_section(pack_id, data.get("commands"), data.get("subsystems") or {}),
        sheet_spec=parse_sheet_section(pack_id, data.get("sheet")),
        initiative_roll=_parse_initiative_section(pack_id, data.get("initiative")),
        turn_checks=_parse_turn_checks_section(pack_id, data.get("turn_checks")),
    )


_TURN_CHECK_KEYS = {"id", "when", "condition", "instruction", "max_rounds", "enabled"}


def _parse_turn_checks_section(pack_id: str, raw: Any) -> tuple[dict[str, Any], ...]:
    """Shape-validate a pack's ``turn_checks:`` table; the agent layer gives it meaning.

    A row is ``{when: <condition name>, instruction: {<locale>: <text>}, max_rounds: <n>,
    id: <slug>, enabled: <bool>}``. Everything here is a shape rule — an unknown KEY is a
    typo worth failing the pack for, while an unknown CONDITION is a newer-engine feature
    the agent layer skips at load, so it is not core's to reject.
    """
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise ValueError(f"rulepack '{pack_id}': 'turn_checks' must be a list of check rows")
    rows: list[dict[str, Any]] = []
    for index, row in enumerate(raw):
        if not isinstance(row, Mapping):
            raise ValueError(f"rulepack '{pack_id}': turn_checks[{index}] must be a mapping")
        unknown = set(map(str, row)) - _TURN_CHECK_KEYS
        if unknown:
            raise ValueError(
                f"rulepack '{pack_id}': turn_checks[{index}] has unknown keys {sorted(unknown)}; "
                f"allowed: {sorted(_TURN_CHECK_KEYS)}"
            )
        if not str(row.get("when") or row.get("condition") or "").strip():
            raise ValueError(f"rulepack '{pack_id}': turn_checks[{index}] needs a 'when' condition name")
        instruction = row.get("instruction")
        if instruction is not None and not isinstance(instruction, Mapping):
            raise ValueError(f"rulepack '{pack_id}': turn_checks[{index}] 'instruction' must be a locale mapping")
        rounds = row.get("max_rounds")
        if rounds is not None and (not isinstance(rounds, int) or isinstance(rounds, bool) or rounds < 1):
            raise ValueError(f"rulepack '{pack_id}': turn_checks[{index}] 'max_rounds' must be a positive integer")
        rows.append(dict(row))
    return tuple(rows)


def _parse_initiative_section(pack_id: str, raw: Any) -> str:
    if raw is None:
        return ""
    if not isinstance(raw, Mapping) or not isinstance(raw.get("roll"), str) or not raw["roll"].strip():
        raise ValueError(f"rulepack '{pack_id}': 'initiative' must be a mapping with a 'roll' expression")
    return raw["roll"].strip()


def _parse_commands_section(pack_id: str, raw: Any, subsystems_raw: Mapping[str, Any]) -> dict[str, CommandBinding]:
    """Parse a pack's dot-command dialect table (``word -> binding``)."""
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise ValueError(f"rulepack '{pack_id}': 'commands' must be a mapping of word -> binding")
    bindings: dict[str, CommandBinding] = {}
    for word, spec in raw.items():
        word_key = str(word).strip().casefold()
        if not word_key:
            raise ValueError(f"rulepack '{pack_id}': 'commands' has an empty word")
        if not isinstance(spec, Mapping):
            raise ValueError(f"rulepack '{pack_id}': commands.{word_key} must be a mapping")
        unknown = set(spec) - {"action", "tool", "args"}
        if unknown:
            raise ValueError(f"rulepack '{pack_id}': commands.{word_key} has unknown keys {sorted(unknown)}")
        action = str(spec.get("action") or "")
        tool = str(spec.get("tool") or "")
        if bool(action) == bool(tool):
            raise ValueError(f"rulepack '{pack_id}': commands.{word_key} needs exactly one of action/tool")
        if action and action not in ("check", "make_char"):
            raise ValueError(f"rulepack '{pack_id}': commands.{word_key}.action must be 'check' or 'make_char'")
        if tool and tool not in subsystems_raw:
            raise ValueError(f"rulepack '{pack_id}': commands.{word_key}.tool names an undeclared subsystem {tool!r}")
        args = spec.get("args") or {}
        if not isinstance(args, Mapping):
            raise ValueError(f"rulepack '{pack_id}': commands.{word_key}.args must be a mapping")
        bindings[word_key] = CommandBinding(action=action, tool=tool, args=dict(args))
    return bindings


def _parse_expertise_section(pack_id: str, raw: Any) -> dict[str, str]:
    """Parse a pack's per-locale ``expertise:`` prompt text (locale -> str)."""
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise ValueError(f"rulepack '{pack_id}': 'expertise' must be a mapping of locale -> text")
    return {str(locale).casefold(): str(text) for locale, text in raw.items() if str(text).strip()}


MAX_EXTENDS_DEPTH = 4


def load_raw_rulepack_yaml(pack_id: str) -> Mapping[str, Any] | None:
    """The raw YAML mapping for `pack_id` from the discovery dirs (built-in dir first, then
    `_USER_RULEPACK_DIR`), or `None` when no such file exists / it isn't a mapping. This is the
    default `extends:` base loader — deliberately file-based rather than registry-based so
    resolution is independent of discovery scan order."""
    for directory in (_RULEPACK_DIR, _USER_RULEPACK_DIR):
        if directory is None or not directory.is_dir():
            continue
        path = directory / f"{pack_id}.yaml"
        if path.is_file():
            data = safe_load_no_aliases(path.read_text(encoding="utf-8")) or {}
            return data if isinstance(data, Mapping) else None
    return None


def _merge_extends(base: Mapping[str, Any], child: Mapping[str, Any]) -> dict[str, Any]:
    """Deep-merge `child` over `base`: mappings merge recursively, an explicit `null` child
    value DELETES the inherited key (how a patch removes a base alias/derived/default), and
    everything else — scalars and lists — replaces wholesale."""
    merged: dict[str, Any] = dict(base)
    for key, value in child.items():
        if value is None:
            merged.pop(key, None)
        elif isinstance(value, Mapping) and isinstance(merged.get(key), Mapping):
            merged[key] = _merge_extends(merged[key], value)
        else:
            merged[key] = value
    return merged


def resolve_extends(
    pack_id: str,
    data: Mapping[str, Any],
    *,
    base_loader: Callable[[str], Mapping[str, Any] | None] | None = None,
) -> dict[str, Any]:
    """Resolve a rulepack's ``extends: <base-id>`` chain into one flat raw mapping.

    This is how a WORLD ships its own rules without rewriting a whole system (the
    module <-> rules coupling `docs/plugins.md` describes): a pack file patches a base —
    `extends: <base-id>` plus only the deltas — or replaces it outright by not extending at all.
    Chains resolve base-first (`_merge_extends`, child wins, `null` deletes), are capped at
    `MAX_EXTENDS_DEPTH`, and fail loudly on a cycle or an unknown base. NOTE: a patch needs
    its own NEW id — discovery never lets a user-dir file shadow a built-in of the same id.
    """
    loader = base_loader or load_raw_rulepack_yaml
    seen = {pack_id}
    resolved = dict(data)
    while True:
        base_ref = resolved.pop("extends", None)
        if base_ref is None:
            return resolved
        if not isinstance(base_ref, str) or not base_ref.strip():
            raise ValueError(f"rulepack '{pack_id}': extends must name a base rulepack id")
        base_id = base_ref.strip()
        if base_id in seen:
            raise ValueError(f"rulepack '{pack_id}': extends cycle through '{base_id}'")
        if len(seen) > MAX_EXTENDS_DEPTH:
            raise ValueError(f"rulepack '{pack_id}': extends chain deeper than {MAX_EXTENDS_DEPTH}")
        base = loader(base_id)
        if base is None:
            raise ValueError(f"rulepack '{pack_id}': extends unknown base rulepack '{base_id}'")
        seen.add(base_id)
        # The base's own `extends` key (if any) survives the merge — the loop resolves the
        # grandparent on the next pass, so multi-level patches compose naturally.
        resolved = _merge_extends(base, resolved)


def parse_rulepack_text(
    pack_id: str,
    text: str,
    *,
    base_loader: Callable[[str], Mapping[str, Any] | None] | None = None,
    script_dir: Path | None = None,
    script_loader: Callable[[str], str] | None = None,
) -> RulePack:
    """Parse rulepack YAML `text` into a `RulePack`, assigning it `pack_id`.

    The same YAML-to-`RulePack` builder `_discover_registry` uses on-disk, exposed so a caller
    that has rulepack YAML in memory (`agent.forge`, validating LLM-generated rulepack text
    before ever writing it to disk) can validate against the identical rules real discovery will
    later apply -- no separate/divergent parser to keep in sync (mirrors
    `core.skills.parse_skill_text`'s precedent). Raises `ValueError` on any malformed input (bad
    YAML, a non-mapping root, an unresolvable `extends:` chain, or an invalid `derived:` spec --
    see `_compile_derived_section`); never `eval`/`exec`s anything -- the YAML is
    `yaml.safe_load`-ed only (via `core.yaml_safety.safe_load_no_aliases`, which also rejects
    alias/anchor nodes so a small YAML file can never alias-bomb into an exponential in-memory
    structure) and `derived:` compiles through the fixed safe DSL / named-computer vocabulary
    only. `base_loader` overrides where `extends:` bases are read from (`core.pack` resolves a
    pack's bundled siblings through the archive before falling back to the discovery dirs).
    """
    data = safe_load_no_aliases(text) or {}
    if not isinstance(data, Mapping):
        raise ValueError(f"rulepack '{pack_id}': YAML root must be a mapping, got {type(data).__name__}")
    if "extends" in data:
        data = resolve_extends(pack_id, data, base_loader=base_loader)
    return _build_rulepack(
        pack_id, data, script_loader=script_loader or _dir_script_loader(pack_id, script_dir)
    )


def _parse_rulepack_file(path: Path) -> RulePack:
    return parse_rulepack_text(path.stem, path.read_text(encoding="utf-8"), script_dir=path.parent)


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


def _discovery_dirs() -> tuple[Path, ...]:
    """Every directory discovery scans, in precedence order (built-in first)."""
    dirs = [_RULEPACK_DIR]
    if _USER_RULEPACK_DIR is not None:
        dirs.append(_USER_RULEPACK_DIR)
    dirs.extend(_EXTRA_RULEPACK_DIRS)
    return tuple(dirs)


def _discovery_signature() -> tuple[Any, ...]:
    """A fingerprint of the discovery dirs: each dir's `mtime_ns` plus its `*.yaml` names/mtimes.

    A directory's own mtime moves whenever an entry is created or removed inside it — exactly
    what installing a pack out-of-process does — and the per-file mtimes additionally catch an
    in-place rewrite on a filesystem with coarse directory timestamps. Only ever computed on a
    resolution MISS, so the hit path never touches the filesystem.
    """
    signature: list[Any] = []
    for directory in _discovery_dirs():
        try:
            dir_mtime: int | None = directory.stat().st_mtime_ns
            files = tuple(sorted((path.name, path.stat().st_mtime_ns) for path in directory.glob("*.yaml")))
        except OSError:
            dir_mtime, files = None, ()
        signature.append((str(directory), dir_mtime, files))
    return tuple(signature)


# Signature of the discovery dirs as they looked during the last real scan. `None` means
# discovery has not run yet in this process.
_LAST_SCAN_SIGNATURE: tuple[Any, ...] | None = None


def _rescan_if_dirs_changed() -> bool:
    """Reload discovery when the dirs changed since the last scan; True if a reload happened.

    This is the SELF-HEAL for out-of-process installs: a pack installed by another process
    (Studio's install button shells out to the CLI) writes into a discovery dir that the
    running server already scanned, and both `@cache`s would otherwise stay stale for the
    rest of the process lifetime. Signature unchanged means the miss is a genuine unknown
    name, so nothing is rescanned and a bad name cannot trigger a scan storm.
    """
    if _discovery_signature() == _LAST_SCAN_SIGNATURE:
        return False
    reload_rulepacks()
    return True


@cache
def _discover_registry() -> dict[str, RulePack]:
    """Scan `rulepacks/*.yaml` (built-in), then `_USER_RULEPACK_DIR` (Layer B.3b) when set.

    Robust by construction: a single malformed/broken YAML file (parse error, bad structure, or
    an invalid `derived:` spec) is logged and skipped — it never prevents discovery of the other,
    valid packs. A built-in id always wins over a same-named user-dir entry
    (`_scan_rulepack_dir`'s `allow_override=False` for the user dir), so a generated pack can
    never override a built-in id. With `_USER_RULEPACK_DIR` left at its default `None`
    (every test unless it opts in), this scans ONLY `_RULEPACK_DIR` -- byte-identical to before
    the user data-dir existed.
    """
    global _LAST_SCAN_SIGNATURE
    _LAST_SCAN_SIGNATURE = _discovery_signature()
    registry: dict[str, RulePack] = {}
    _scan_rulepack_dir(_RULEPACK_DIR, registry, allow_override=True)
    if _USER_RULEPACK_DIR is not None:
        _scan_rulepack_dir(_USER_RULEPACK_DIR, registry, allow_override=False)
    for extra in _EXTRA_RULEPACK_DIRS:
        _scan_rulepack_dir(extra, registry, allow_override=False)
    return registry


# Extra discovery dirs beyond the built-in and user dirs: dev-room mounts
# (`gateway.dev_room`) point these at a pack SOURCE tree's `rulepacks/` so an
# author's edit is one cache-clear away from live. Same precedence rule as the
# user dir — a built-in id always wins.
_EXTRA_RULEPACK_DIRS: tuple[Path, ...] = ()


def set_extra_rulepack_dirs(dirs: Iterable[Path | str]) -> None:
    """Replace the extra discovery dirs and drop BOTH caches (dev-room mounts)."""
    global _EXTRA_RULEPACK_DIRS
    _EXTRA_RULEPACK_DIRS = tuple(Path(entry) for entry in dirs)
    reload_rulepacks()


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
    global _LAST_SCAN_SIGNATURE
    _LAST_SCAN_SIGNATURE = None
    _discover_registry.cache_clear()
    _alias_resolver.cache_clear()


def built_in_rulepack_ids() -> set[str]:
    """File stems under `_RULEPACK_DIR` — the BUILT-IN rulepacks only, never `_USER_RULEPACK_DIR`.

    Used by `agent.forge` to reject a generated rulepack id that collides with a built-in (e.g.
    a built-in id) before ever writing it -- deliberately a raw file listing rather than going
    through `_discover_registry`/`available_systems`, so this stays accurate even if a built-in's
    own YAML happens to be malformed at the moment of the check.
    """
    if not _RULEPACK_DIR.is_dir():
        return set()
    return {path.stem for path in _RULEPACK_DIR.glob("*.yaml")}


def built_in_aliases() -> set[str]:
    """Every normalized alias (id + declared `names:` + `set_keys:`) claimed by a BUILT-IN rulepack.

    Used by `agent.forge` to refuse a generated pack that tries to CLAIM a built-in's name/alias
    (e.g. a user pack claiming a built-in name). A built-in already wins resolution today via
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

    A miss re-checks the discovery dirs once (`_rescan_if_dirs_changed`) before giving up, so a
    pack installed by ANOTHER process resolves without restarting the server.
    """
    alias = _normalize_alias(system)
    pack_id = _alias_resolver().get(alias)
    if pack_id is None and _rescan_if_dirs_changed():
        pack_id = _alias_resolver().get(alias)
    if pack_id is None:
        raise ValueError(f"unknown rulepack: {system}")
    return _discover_registry()[pack_id]


def all_check_terms() -> frozenset[str]:
    """Every skill/attribute surface form across ALL discovered rule systems —
    ``defaults`` keys, alias canonicals and variants, and localized display names.

    The agent's dice-first detectors compile their skill vocabulary from this,
    so a custom system's skills earn roll discipline with zero engine change:
    the engine stays system-agnostic (iron rule #1) and the rulepack layer owns
    the vocabulary. Terms shorter than 2 characters are dropped (single CJK
    characters and one-letter aliases match far too much ordinary prose)."""
    terms: set[str] = set()
    for pack in _discover_registry().values():
        terms.update(pack.defaults.keys())
        for canonical, variants in pack.alias.items():
            terms.add(canonical)
            terms.update(variants)
        for table in pack.display.values():
            terms.update(table.values())
    return frozenset(term.strip() for term in terms if isinstance(term, str) and len(term.strip()) >= 2)


def all_command_words() -> frozenset[str]:
    """Every dot-command dialect word any discovered pack declares."""
    words: set[str] = set()
    for pack in _discover_registry().values():
        words.update(pack.commands)
    return frozenset(words)


def own_make_char_word(pack: RulePack) -> str | None:
    """The word that creates a character IN `pack` — one that dispatch routes back to it.

    An `extends:` pack inherits its base's whole `commands:` table, base words first
    (`_merge_extends`), and `pack_declaring_command` gives an inherited word to the BASE
    pack — so `.coc` on a `coc7-antu` row would create a plain CoC7 sheet. Only a word of
    the pack's own is its entry point; a patch that declares none has no way to create
    in it, and this says so with None rather than the base's word. Declaration order,
    so a pack that declares several words picks its own primary.
    """
    for word, binding in pack.commands.items():
        if binding.action != "make_char":
            continue
        maker = pack_declaring_command(word, "make_char")
        if maker is not None and maker.system == pack.system:
            return word
    return None


def pack_declaring_command(word: str, action: str) -> RulePack | None:
    """The discovered pack whose ``commands:`` table binds `word` to `action`.

    Cross-pack words (a make-char word is the ENTRY POINT into its system, so
    it must resolve regardless of the room's current pack) route through this;
    ordinary dialect words stay room-scoped.
    """
    word_key = str(word).strip().casefold()
    for pack in _discover_registry().values():
        binding = pack.commands.get(word_key)
        if binding is not None and binding.action == action:
            return pack
    return None


def all_subsystem_tool_names() -> frozenset[str]:
    """Every subsystem tool name any discovered pack declares — the loop's
    dice-first detectors treat these as dice tools (same union pattern as
    `all_check_terms`)."""
    names: set[str] = set()
    for pack in _discover_registry().values():
        names.update(pack.subsystems)
    return frozenset(names)


def all_outcome_labels() -> frozenset[str]:
    """Every success-level marker across ALL discovered rule systems' ``labels:``
    tables, casefolded — the vocabulary `agent.loop`'s dice-first corrective uses
    to detect that the model already narrated a graded check outcome. Same
    pattern as `all_check_terms`: the engine stays system-agnostic and the
    rulepack layer owns the words."""
    markers: set[str] = set()
    for pack in _discover_registry().values():
        for table in pack.labels.values():
            for label in table.values():
                markers.update(marker.strip().casefold() for marker in label.markers)
    return frozenset(marker for marker in markers if marker)
