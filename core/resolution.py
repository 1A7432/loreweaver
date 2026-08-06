"""Compiled check resolution — the pack-DSL half of the ROLL/INTERPRET/APPLY pipeline.

A rulepack's ``resolution:`` block compiles (at pack discovery, once) into a
:class:`CheckResolver`: the roll expression the engine will roll, named roll
modifiers, per-locale difficulty definitions, and one rank LADDER per house
variant — ordered ``when:`` rules over the reused ``core.condexpr`` grammar
whose first match wins.

The pipeline's phase boundaries are hard:

- ROLL happens in ``core.dice_engine`` (``DiceRoller.roll_detail``) — the only
  place randomness lives. The resolver only DECLARES the expression.
- INTERPRET (:meth:`CheckResolver.interpret`) is a PURE function
  ``(RollDetail, target, options) -> CheckOutcome`` — no randomness, no state.
  That purity is what makes house-rule variants, Luck re-grading, exhaustive
  rulebook-table testing, and the future sandbox script lane all trivial.
- APPLY (consequences) stays with the engine's callers/subsystems.

Rank expressions see a CLOSED namespace: ``roll`` (the comparison value —
dice total plus the situational ``modifier``), ``dice[i]`` (kept natural
faces), ``target`` (difficulty-adjusted), ``raw_target`` (before difficulty),
``modifier``, ``successes``/``ones`` (success-counting pools), plus the pure
math helpers ``floor``/``ceil``/``min``/``max``/``abs``. Nothing else — the
DSL never grows system-shaped syntax; what it cannot express uses the script
lane (stage E).
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from core.check_outcome import CheckOutcome, Rank, RollDetail
from core.condexpr import CondExprError, Resolver, compile_expression, referenced_names, truthy

# The resolution block's own schema version (M16 addendum: every 2.0-minted
# format versions itself from day one). Bump on shape changes; register an
# N -> N+1 migration so shipped packs keep loading.
RESOLUTION_VERSION = 1
_RESOLUTION_MIGRATIONS: dict[int, Callable[[dict], dict]] = {}

_EXPR_FUNCTIONS: dict[str, Callable[..., Any]] = {
    "floor": lambda value: math.floor(_number(value)),
    "ceil": lambda value: math.ceil(_number(value)),
    "min": lambda *values: min(_number(item) for item in values),
    "max": lambda *values: max(_number(item) for item in values),
    "abs": lambda value: abs(_number(value)),
}

_COMPARES = ("<=", ">=")
_TARGET_KINDS = ("skill", "dc", "none")
_RANK_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
_VARIANT_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
_PARAM_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
MAX_RANKS = 32
MAX_VARIANTS = 32
MAX_DIFFICULTIES = 16


def _number(value: Any) -> float | int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return value
    raise CondExprError(f"expected a number, got {value!r}")  # i18n-exempt: pack-author diagnostic, raised at compile/load time


class ResolutionError(ValueError):
    """A malformed ``resolution:`` block (raised at pack compile time)."""


@dataclass(frozen=True)
class RankRule:
    rank: Rank
    when: Callable[[Resolver], Any] | None  # None = unconditional fallback


@dataclass(frozen=True)
class Difficulty:
    """One named difficulty: a target transform plus its command-dialect words."""

    id: str
    target: Callable[[Resolver], Any] | None  # None = identity
    prefixes: Mapping[str, tuple[str, ...]] = field(default_factory=dict)


@dataclass(frozen=True)
class ParamSpec:
    """One ``{slot}`` in the roll expression: an integer with a clamped range."""

    id: str
    minimum: int
    maximum: int
    default: int | None = None


@dataclass(frozen=True)
class CheckSpec:
    """How the GENERIC check tool/commands feed this system (all pack-declared):
    which named roll modifiers the favorable/unfavorable counts route to, the
    default target for dc-kind systems, and the canonical stat a "proficient"
    check adds on top of the sheet's check value."""

    favorable: str = ""
    unfavorable: str = ""
    default_target: int | None = None
    proficiency: str = ""
    default_skill: str = ""  # canonical stat a bare check command rolls


@dataclass(frozen=True)
class CheckResolver:
    """One system's compiled check resolution. ``interpret`` is pure."""

    roll: str
    compare: str
    target_kind: str
    modifiers: Mapping[str, Mapping[str, Any]]
    ladders: Mapping[str, tuple[RankRule, ...]]  # "" = the default ladder
    difficulties: tuple[Difficulty, ...]
    params: tuple[ParamSpec, ...]
    margin: Callable[[Resolver], Any] | None = None
    check: CheckSpec = field(default_factory=CheckSpec)
    script: Any = None  # RulesScriptEngine — the stage-E lane replacing the DSL ladder

    def variant_ids(self) -> tuple[str, ...]:
        return tuple(sorted(key for key in self.ladders if key))

    def difficulty(self, difficulty_id: str | None) -> Difficulty | None:
        if not difficulty_id:
            return None
        for entry in self.difficulties:
            if entry.id == difficulty_id:
                return entry
        return None

    def clamp_params(self, values: Mapping[str, Any] | None) -> dict[str, int]:
        """Range-clamp the caller-supplied ``{slot}`` values per the declaration."""
        clamped: dict[str, int] = {}
        for spec in self.params:
            raw = (values or {}).get(spec.id, spec.default)
            if raw is None:
                raise ResolutionError(f"missing roll parameter {spec.id!r}")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
            try:
                value = int(raw)
            except (TypeError, ValueError) as exc:
                raise ResolutionError(f"roll parameter {spec.id!r} must be an integer") from exc  # i18n-exempt: pack-author diagnostic, raised at compile/load time
            clamped[spec.id] = max(spec.minimum, min(spec.maximum, value))
        return clamped

    def effective_target(self, target: int | None, *, difficulty: str | None = None) -> int | None:
        """The difficulty-adjusted target — what the roll actually has to beat."""
        if target is None:
            return None
        transform = self.difficulty(difficulty)
        if transform is None or transform.target is None:
            return int(target)
        value = transform.target(_namespace_resolver({"target": target, "raw_target": target}))
        return int(_number(value))

    def interpret(
        self,
        rolled: RollDetail,
        target: int | None,
        *,
        variant: str | None = None,
        difficulty: str | None = None,
        modifier: int = 0,
    ) -> CheckOutcome:
        """PURE: grade one already-rolled check. No randomness, no state.

        ``variant`` picks a house-rule ladder (falling back to the default);
        ``difficulty`` applies the named target transform; ``modifier`` is the
        situational flat add (d20-style systems) folded into ``roll``.
        """
        if self.script is not None:
            return self._interpret_script(rolled, target, variant=variant, difficulty=difficulty, modifier=modifier)
        ladder = self.ladders.get(variant or "") or self.ladders[""]
        effective = self.effective_target(target, difficulty=difficulty)
        roll_value = rolled.total + modifier
        names: dict[str, Any] = {
            "roll": roll_value,
            "target": effective if effective is not None else 0,
            "raw_target": int(target) if target is not None else 0,
            "modifier": modifier,
            "successes": rolled.successes if rolled.successes is not None else 0,
            "ones": rolled.ones if rolled.ones is not None else 0,
        }
        for index, face in enumerate(rolled.dice):
            names[f"dice.{index}"] = face
        resolver = _namespace_resolver(names)

        rank: Rank | None = None
        for rule in ladder:
            if rule.when is None or truthy(rule.when(resolver)):
                rank = rule.rank
                break
        if rank is None:  # unreachable: compilation guarantees a fallback rule
            raise ResolutionError("rank ladder resolved no rank")

        if self.margin is not None:
            margin_value: int | None = int(_number(self.margin(resolver)))
        elif effective is None:
            margin_value = None
        elif self.compare == "<=":
            margin_value = effective - roll_value
        else:
            margin_value = roll_value - effective
        return CheckOutcome(rolled=rolled, target=target, rank=rank, margin=margin_value)


    def _interpret_script(
        self,
        rolled: RollDetail,
        target: int | None,
        *,
        variant: str | None,
        difficulty: str | None,
        modifier: int,
    ) -> CheckOutcome:
        """Stage-E script lane: same PURE contract, the ladder lives in QuickJS.

        The engine has already rolled; the script sees the full input as data
        and returns rank-shaped JSON that `validate_rank_result` clamps. The
        script computes its own margin (or returns null for none).
        """
        from core.rules_script import validate_rank_result

        effective = self.effective_target(target, difficulty=difficulty)
        result = validate_rank_result(
            "script",
            self.script.run(
                {
                    "roll": rolled.total + modifier,
                    "dice": list(rolled.dice),
                    "total": rolled.total,
                    "target": effective if effective is not None else None,
                    "raw_target": int(target) if target is not None else None,
                    "modifier": modifier,
                    "successes": rolled.successes,
                    "ones": rolled.ones,
                    "variant": variant or "",
                    "difficulty": difficulty or "",
                }
            ),
        )
        rank = Rank(
            id=result["id"],
            tier=result["tier"],
            label_key=result["id"],
            success=result["success"],
            critical=result["critical"],
            fumble=result["fumble"],
        )
        return CheckOutcome(rolled=rolled, target=target, rank=rank, margin=result["margin"])


def _namespace_resolver(names: Mapping[str, Any]) -> Resolver:
    def resolve(path: str) -> Any:
        if path in names:
            return names[path]
        raise CondExprError(f"unknown name {path!r} in resolution expression")  # i18n-exempt: pack-author diagnostic, raised at compile/load time

    return resolve


# ---------------------------------------------------------------------------
# Compilation
# ---------------------------------------------------------------------------


# The CLOSED namespace resolution expressions may read. `dice.<i>` indexes the
# kept natural faces. A name outside this set fails at PACK LOAD (statically —
# a dry-run alone can't prove coverage because `&&` short-circuits), giving a
# third-party/forge-generated pack a pointable diagnostic instead of a
# first-check crash (M16 window-1 review note 1).
_EXPR_NAMES = frozenset({"roll", "target", "raw_target", "modifier", "successes", "ones", "dice"})
_DICE_NAME_RE = re.compile(r"^dice\.\d+$")


def _compile_expr(pack_id: str, where: str, text: Any) -> Callable[[Resolver], Any]:
    if not isinstance(text, str) or not text.strip():
        raise ResolutionError(f"rulepack '{pack_id}': {where} must be a non-empty expression string")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
    try:
        compiled = compile_expression(text, functions=_EXPR_FUNCTIONS)
        unknown = {
            name
            for name in referenced_names(text, functions=_EXPR_FUNCTIONS)
            if name not in _EXPR_NAMES and not _DICE_NAME_RE.match(name)
        }
    except CondExprError as exc:
        raise ResolutionError(f"rulepack '{pack_id}': {where}: bad expression ({exc})") from exc  # i18n-exempt: pack-author diagnostic, raised at compile/load time
    if unknown:
        raise ResolutionError(
            f"rulepack '{pack_id}': {where} references unknown name(s) {sorted(unknown)}"  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        )
    return compiled


def _compile_rank_rules(
    pack_id: str, where: str, raw: Any, *, labels_hint: Callable[[str], None] | None = None
) -> tuple[RankRule, ...]:
    if not isinstance(raw, list) or not raw:
        raise ResolutionError(f"rulepack '{pack_id}': {where} must be a non-empty list of rank rules")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
    if len(raw) > MAX_RANKS:
        raise ResolutionError(f"rulepack '{pack_id}': {where} lists too many ranks (max {MAX_RANKS})")  # i18n-exempt: pack-author diagnostic, raised at compile/load time

    rules: list[RankRule] = []
    default_tier = len(raw)
    for index, entry in enumerate(raw):
        if not isinstance(entry, Mapping):
            raise ResolutionError(f"rulepack '{pack_id}': {where}[{index}] must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        unknown = set(entry) - {"id", "when", "success", "critical", "fumble", "tier"}
        if unknown:
            raise ResolutionError(f"rulepack '{pack_id}': {where}[{index}] has unknown keys {sorted(unknown)}")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        rank_id = entry.get("id")
        if not isinstance(rank_id, str) or not _RANK_ID_RE.match(rank_id):
            raise ResolutionError(f"rulepack '{pack_id}': {where}[{index}] needs a slug 'id'")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        for flag in ("success", "critical", "fumble"):
            if flag in entry and not isinstance(entry[flag], bool):
                raise ResolutionError(f"rulepack '{pack_id}': {where}[{index}].{flag} must be a boolean")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        tier = entry.get("tier", default_tier - 1 - index)
        if not isinstance(tier, int) or isinstance(tier, bool) or tier < 0 or tier > MAX_RANKS:
            raise ResolutionError(f"rulepack '{pack_id}': {where}[{index}].tier must be an integer 0..{MAX_RANKS}")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        when = entry.get("when")
        compiled = None if when is None else _compile_expr(pack_id, f"{where}[{index}].when", when)
        if labels_hint is not None:
            labels_hint(rank_id)
        rules.append(
            RankRule(
                rank=Rank(
                    id=rank_id,
                    tier=tier,
                    label_key=rank_id,
                    success=bool(entry.get("success", False)),
                    critical=bool(entry.get("critical", False)),
                    fumble=bool(entry.get("fumble", False)),
                ),
                when=compiled,
            )
        )
    if rules[-1].when is not None:
        raise ResolutionError(
            f"rulepack '{pack_id}': {where} must end with an unconditional fallback rule (no 'when')"  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        )
    for rule in rules[:-1]:
        if rule.when is None:
            raise ResolutionError(f"rulepack '{pack_id}': {where} has an unconditional rule before the last")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
    return tuple(rules)


def _compile_difficulties(pack_id: str, raw: Any) -> tuple[Difficulty, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, Mapping):
        raise ResolutionError(f"rulepack '{pack_id}': resolution.difficulties must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
    if len(raw) > MAX_DIFFICULTIES:
        raise ResolutionError(f"rulepack '{pack_id}': too many difficulties (max {MAX_DIFFICULTIES})")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
    entries: list[Difficulty] = []
    for difficulty_id, spec in raw.items():
        if not isinstance(difficulty_id, str) or not _VARIANT_ID_RE.match(difficulty_id):
            raise ResolutionError(f"rulepack '{pack_id}': difficulty ids must be slugs, got {difficulty_id!r}")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        spec = spec or {}
        if not isinstance(spec, Mapping):
            raise ResolutionError(f"rulepack '{pack_id}': difficulty {difficulty_id!r} must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        unknown = set(spec) - {"target", "prefixes"}
        if unknown:
            raise ResolutionError(
                f"rulepack '{pack_id}': difficulty {difficulty_id!r} has unknown keys {sorted(unknown)}"  # i18n-exempt: pack-author diagnostic, raised at compile/load time
            )
        transform = (
            _compile_expr(pack_id, f"difficulties.{difficulty_id}.target", spec["target"])
            if spec.get("target") is not None
            else None
        )
        prefixes_raw = spec.get("prefixes") or {}
        if not isinstance(prefixes_raw, Mapping):
            raise ResolutionError(f"rulepack '{pack_id}': difficulty {difficulty_id!r} prefixes must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        prefixes = {
            str(locale).casefold(): tuple(str(word) for word in (words or []) if str(word).strip())
            for locale, words in prefixes_raw.items()
        }
        entries.append(Difficulty(id=difficulty_id, target=transform, prefixes=prefixes))
    return tuple(entries)


def _compile_params(pack_id: str, raw: Any) -> tuple[ParamSpec, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, Mapping):
        raise ResolutionError(f"rulepack '{pack_id}': resolution.params must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
    specs: list[ParamSpec] = []
    for param_id, spec in raw.items():
        if not isinstance(param_id, str) or not _PARAM_ID_RE.match(param_id):
            raise ResolutionError(f"rulepack '{pack_id}': param ids must be slugs, got {param_id!r}")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        if not isinstance(spec, Mapping):
            raise ResolutionError(f"rulepack '{pack_id}': param {param_id!r} must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        unknown = set(spec) - {"min", "max", "default"}
        if unknown:
            raise ResolutionError(f"rulepack '{pack_id}': param {param_id!r} has unknown keys {sorted(unknown)}")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        try:
            minimum = int(spec.get("min", 0))
            maximum = int(spec.get("max", 0))
        except (TypeError, ValueError) as exc:
            raise ResolutionError(f"rulepack '{pack_id}': param {param_id!r} bounds must be integers") from exc  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        if maximum < minimum:
            raise ResolutionError(f"rulepack '{pack_id}': param {param_id!r} has max < min")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        default = spec.get("default")
        if default is not None:
            try:
                default = int(default)
            except (TypeError, ValueError) as exc:
                raise ResolutionError(f"rulepack '{pack_id}': param {param_id!r} default must be an integer") from exc  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        specs.append(ParamSpec(id=param_id, minimum=minimum, maximum=maximum, default=default))
    return tuple(specs)


def compile_resolution(
    pack_id: str,
    raw: Any,
    *,
    script_loader: Callable[[str], str] | None = None,
) -> CheckResolver:
    """Compile one ``resolution:`` block. Raises :class:`ResolutionError` on any
    malformed shape — a pack whose resolution does not compile does not load.

    ``script_loader`` resolves a ``script:`` filename to its source (stage E);
    a pack declaring a script without a loader (or with a bad file) fails."""
    if not isinstance(raw, Mapping):
        raise ResolutionError(f"rulepack '{pack_id}': resolution must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at compile/load time

    version = raw.get("version", RESOLUTION_VERSION)
    if not isinstance(version, int) or isinstance(version, bool):
        raise ResolutionError(f"rulepack '{pack_id}': resolution.version must be an integer")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
    if version > RESOLUTION_VERSION:
        raise ResolutionError(
            f"rulepack '{pack_id}': resolution.version {version} is newer than this engine ({RESOLUTION_VERSION})"  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        )
    while version < RESOLUTION_VERSION:
        migrate = _RESOLUTION_MIGRATIONS.get(version)
        if migrate is None:
            raise ResolutionError(f"rulepack '{pack_id}': resolution.version {version} has no migration path")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        raw = migrate(dict(raw))
        version += 1

    unknown = set(raw) - {
        "version", "roll", "target", "compare", "modifiers", "ranks", "variants", "difficulties", "params", "margin",
        "check", "script",
    }
    if unknown:
        raise ResolutionError(f"rulepack '{pack_id}': resolution has unknown keys {sorted(unknown)}")  # i18n-exempt: pack-author diagnostic, raised at compile/load time

    roll = raw.get("roll")
    if not isinstance(roll, str) or not roll.strip():
        raise ResolutionError(f"rulepack '{pack_id}': resolution.roll must be a dice expression string")  # i18n-exempt: pack-author diagnostic, raised at compile/load time

    target_kind = raw.get("target", "skill")
    if target_kind not in _TARGET_KINDS:
        raise ResolutionError(f"rulepack '{pack_id}': resolution.target must be one of {list(_TARGET_KINDS)}")  # i18n-exempt: pack-author diagnostic, raised at compile/load time

    compare = raw.get("compare", "<=")
    if compare not in _COMPARES:
        raise ResolutionError(f"rulepack '{pack_id}': resolution.compare must be one of {list(_COMPARES)}")  # i18n-exempt: pack-author diagnostic, raised at compile/load time

    modifiers_raw = raw.get("modifiers") or {}
    if not isinstance(modifiers_raw, Mapping):
        raise ResolutionError(f"rulepack '{pack_id}': resolution.modifiers must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
    modifiers: dict[str, dict[str, Any]] = {}
    for name, spec in modifiers_raw.items():
        if not isinstance(name, str) or not _PARAM_ID_RE.match(name):
            raise ResolutionError(f"rulepack '{pack_id}': modifier names must be slugs, got {name!r}")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        if not isinstance(spec, Mapping):
            raise ResolutionError(f"rulepack '{pack_id}': modifier {name!r} must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        unknown_keys = set(spec) - {"roll", "tens_reroll"}
        if unknown_keys:
            raise ResolutionError(f"rulepack '{pack_id}': modifier {name!r} has unknown keys {sorted(unknown_keys)}")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        if "tens_reroll" in spec and spec["tens_reroll"] not in ("keep_lowest", "keep_highest"):
            raise ResolutionError(
                f"rulepack '{pack_id}': modifier {name!r}.tens_reroll must be keep_lowest or keep_highest"  # i18n-exempt: pack-author diagnostic, raised at compile/load time
            )
        if "roll" in spec and (not isinstance(spec["roll"], str) or not spec["roll"].strip()):
            raise ResolutionError(f"rulepack '{pack_id}': modifier {name!r}.roll must be a dice expression string")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        modifiers[name] = dict(spec)

    script_name = raw.get("script")
    script_engine = None
    if script_name is not None:
        if not isinstance(script_name, str) or not script_name.strip():
            raise ResolutionError(f"rulepack '{pack_id}': resolution.script must be a filename")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        if raw.get("ranks") is not None or raw.get("variants"):
            raise ResolutionError(
                f"rulepack '{pack_id}': resolution.script replaces ranks/variants — declare one lane, not both"  # i18n-exempt: pack-author diagnostic, raised at compile/load time
            )
        if script_loader is None:
            raise ResolutionError(f"rulepack '{pack_id}': resolution.script needs a pack file context")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        from core.rules_script import RulesScriptEngine, RulesScriptError

        try:
            source = script_loader(script_name.strip())
            script_engine = RulesScriptEngine(pack_id, "resolution.script", source, "resolve")
        except RulesScriptError as exc:
            raise ResolutionError(str(exc)) from exc
        except OSError as exc:
            raise ResolutionError(f"rulepack '{pack_id}': resolution.script unreadable: {exc}") from exc  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        # A synthetic always-fail fallback ladder keeps the dataclass total; the
        # script branch in `interpret` runs before any ladder lookup.
        ladders_raw: Any = [{"id": "fail", "tier": 0}]
    else:
        ladders_raw = raw.get("ranks")

    ladders: dict[str, tuple[RankRule, ...]] = {
        "": _compile_rank_rules(pack_id, "resolution.ranks", ladders_raw)
    }
    variants_raw = raw.get("variants") or {}
    if not isinstance(variants_raw, Mapping):
        raise ResolutionError(f"rulepack '{pack_id}': resolution.variants must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
    if len(variants_raw) > MAX_VARIANTS:
        raise ResolutionError(f"rulepack '{pack_id}': too many variants (max {MAX_VARIANTS})")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
    for variant_id, spec in variants_raw.items():
        if not isinstance(variant_id, str) or not _VARIANT_ID_RE.match(variant_id):
            raise ResolutionError(f"rulepack '{pack_id}': variant ids must be slugs, got {variant_id!r}")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        if not isinstance(spec, Mapping) or "ranks" not in spec:
            raise ResolutionError(f"rulepack '{pack_id}': variant {variant_id!r} must declare 'ranks'")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
        unknown_keys = set(spec) - {"ranks"}
        if unknown_keys:
            raise ResolutionError(
                f"rulepack '{pack_id}': variant {variant_id!r} has unknown keys {sorted(unknown_keys)}"  # i18n-exempt: pack-author diagnostic, raised at compile/load time
            )
        ladders[variant_id] = _compile_rank_rules(pack_id, f"variants.{variant_id}.ranks", spec["ranks"])

    margin = _compile_expr(pack_id, "resolution.margin", raw["margin"]) if raw.get("margin") is not None else None

    return CheckResolver(
        roll=roll.strip(),
        compare=compare,
        target_kind=target_kind,
        modifiers=modifiers,
        ladders=ladders,
        difficulties=_compile_difficulties(pack_id, raw.get("difficulties")),
        params=_compile_params(pack_id, raw.get("params")),
        margin=margin,
        check=_compile_check(pack_id, raw.get("check"), modifiers),
        script=script_engine,
    )


def _compile_check(pack_id: str, raw: Any, modifiers: Mapping[str, Any]) -> CheckSpec:
    if raw is None:
        return CheckSpec()
    if not isinstance(raw, Mapping):
        raise ResolutionError(f"rulepack '{pack_id}': resolution.check must be a mapping")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
    unknown = set(raw) - {"favorable", "unfavorable", "default_target", "proficiency", "default_skill"}
    if unknown:
        raise ResolutionError(f"rulepack '{pack_id}': resolution.check has unknown keys {sorted(unknown)}")  # i18n-exempt: pack-author diagnostic, raised at compile/load time
    favorable = str(raw.get("favorable") or "")
    unfavorable = str(raw.get("unfavorable") or "")
    for name in (favorable, unfavorable):
        if name and name not in modifiers:
            raise ResolutionError(
                f"rulepack '{pack_id}': resolution.check routes to undeclared modifier {name!r}"  # i18n-exempt: pack-author diagnostic, raised at compile/load time
            )
    default_target = raw.get("default_target")
    if default_target is not None:
        try:
            default_target = int(default_target)
        except (TypeError, ValueError) as exc:
            raise ResolutionError(f"rulepack '{pack_id}': resolution.check.default_target must be an integer") from exc  # i18n-exempt: pack-author diagnostic, raised at compile/load time
    return CheckSpec(
        favorable=favorable,
        unfavorable=unfavorable,
        default_target=default_target,
        proficiency=str(raw.get("proficiency") or ""),
        default_skill=str(raw.get("default_skill") or ""),
    )
