"""TRPG dice engine — the `d20`-backed roller and the check pipeline's ROLL phase.

System-agnostic by construction (M16): this module is the SUBSTRATE — the
expression language (d20 grammar plus success-counting pools ``7d10>=8``,
fudge dice ``4df``, exploding shorthand ``5d6!``, ``{param}`` slots), the
generic d100 tens-reroll modifier mechanic, and seeded randomness. Which
expression to roll and how to grade it live in the rulepacks' compiled
``resolution:`` blocks (`core.resolution`); randomness never leaves here.

Determinism: `d20` draws randomness from the stdlib `random` module's global
instance (`random.randrange`), so `seed_dice(seed)` (== `random.seed(seed)`)
makes every roller in this module - and `d20.roll` itself - deterministic.
"""

from __future__ import annotations

import random
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import d20

from core.check_outcome import RollDetail
from core.resolution import CheckResolver
from infra.i18n import I18n, get_i18n, t

# Matches a leading dice token, e.g. "d10", "2d6", "1d20" (case-insensitive; caller
# is expected to have already lower-cased the expression).
_LEADING_DICE_RE = re.compile(r"^(\d*)d(\d+)")

# SealDice-style multiplication ("x"/"X"/"×") between two digit/paren tokens, e.g. the
# "3d6x5" / "(2d6+6)x5" character-generation formulas used by
# `core.character_manager.CharacterTemplate`. `d20` only understands "*". Operates on an
# already lower-cased expression, so "X" has already become "x" by the time this runs.
_SEALDICE_MULTIPLY_RE = re.compile(r"(?<=[0-9)])\s*[x×]\s*(?=[0-9(])")

# A bare SealDice "keep N" selector, e.g. the "4d6k3" formula meaning "keep the highest
# 3 of 4 rolls". `d20` parses a bare "kN" as `SetSelector.literal` (keep dice whose face
# equals N) rather than "keep the highest N" - a silent semantic mismatch, not a syntax
# error - so "4d6k3" quietly drops every die that didn't roll exactly 3. The negative
# lookahead leaves already-valid `d20` selectors (`kh3`/`kl3`) untouched.
_SEALDICE_BARE_KEEP_RE = re.compile(r"k(?![hl])(\d+)")

# A success-counting dice pool, e.g. "7d10>=8" (count faces meeting the threshold;
# also counts natural 1s so a pack ladder can express botch rules) — a GENERIC
# substrate operator, not a system's.
_POOL_RE = re.compile(r"^(\d{1,3})d(\d{1,4})\s*(>=|<=)\s*(\d{1,4})$")
# Fudge/Fate dice, e.g. "4df" (each die -1/0/+1).
_FUDGE_RE = re.compile(r"^(\d{0,3})df\s*([+-]\s*\d{1,4})?$")
# Exploding-dice shorthand: "5d6!" → d20's native explode operator "5d6e6".
_EXPLODE_BANG_RE = re.compile(r"(\d*)d(\d+)!")
# {param} substitution slots in a pack's roll expression (integers only, range-clamped
# by the pack's own declaration before they get here).
_PARAM_RE = re.compile(r"\{([a-z_][a-z0-9_]*)\}")

# Upper bound on the number of SealDice bonus/penalty *tens dice* rolled. Past a handful
# the kept min/max tens digit is already statistically saturated, so this only guards
# against a pathological, unbounded `range()` (e.g. `.sc b100000000`, `.ra b100000000 ...`)
# freezing the process. It does not change the outcome distribution for realistic inputs.
_MAX_BONUS_PENALTY_DICE = 100

def _normalize_dice_expression(expression: str) -> str:
    """Rewrite SealDice-style notation into `d20` grammar (see the regexes above).

    `expression` must already be lower-cased (case-insensitive caller contract - see
    `DiceRoller.roll_expression`). d20-valid tokens (`kh`/`kl`/`e`/`rr`/`ro`/`mi`/`ma`/...)
    are left unchanged.
    """
    text = _SEALDICE_MULTIPLY_RE.sub("*", expression)
    return _SEALDICE_BARE_KEEP_RE.sub(r"kh\1", text)


@dataclass
class DiceConfig:
    """Dice engine toggles.

    No dice-count/sides cap lives here: `d20.Roller`'s own `RollContext`
    (default `max_rolls=1000`, see `roll_explode` for an explicit override) is
    the real guard against a pathological expression, so this only holds
    behavior toggles.
    """

    ENABLE_CRITICAL_EFFECTS: bool = True


# Default configuration instance. `ENABLE_CRITICAL_EFFECTS` may be overridden from
# `infra.config.Settings` at wiring time (e.g. `config.ENABLE_CRITICAL_EFFECTS = settings.enable_critical_effects`).
config = DiceConfig()


class DiceResult:
    """The outcome of a single dice roll/check, with critical-success/failure semantics."""

    def __init__(
        self,
        expression: str,
        rolls: list[int],
        modifier: int = 0,
        dice_count: int = 1,
        dice_sides: int = 20,
        is_check: bool = False,
    ) -> None:
        self.expression = expression
        self.rolls = rolls
        self.modifier = modifier
        self.dice_count = dice_count
        self.dice_sides = dice_sides
        self.total = sum(rolls) + modifier
        self.timestamp = time.time()
        self.is_check = is_check  # whether this roll is a single-die check (vs. a damage roll etc.)

    def is_critical_success(self) -> bool:
        """Critical success only applies to single-die checks.

        A plain d20-style check crits on the max face; a d100 percentile check
        crits on a natural 1 (the generic roll-under intuition for bare rolls —
        graded checks go through the pack resolvers instead).
        """
        if not config.ENABLE_CRITICAL_EFFECTS:
            return False
        if not self.is_check or self.dice_count != 1:
            return False
        if self.dice_sides == 100:
            return any(roll == 1 for roll in self.rolls)
        return any(roll == self.dice_sides for roll in self.rolls)

    def is_critical_failure(self) -> bool:
        """Critical failure only applies to single-die checks.

        A plain d20-style check fumbles on a natural 1; a d100 percentile check
        fumbles on a natural 100. (Skill-relative fumble bands are pack ladder
        rules, not this bare-roll intuition.)
        """
        if not config.ENABLE_CRITICAL_EFFECTS:
            return False
        if not self.is_check or self.dice_count != 1:
            return False
        if self.dice_sides == 100:
            return any(roll == 100 for roll in self.rolls)
        return any(roll == 1 for roll in self.rolls)

    def format_result(self, show_details: bool = True, i18n: I18n | None = None) -> str:
        """Render this result as localized text (see `locales/{en,zh}/dice.json`)."""
        active_i18n = i18n or get_i18n()
        if not show_details:
            return active_i18n.t("dice.result_simple", total=self.total)

        roll_str = f"[{', '.join(str(roll) for roll in self.rolls)}]"
        if self.modifier:
            sign = "+" if self.modifier > 0 else ""
            roll_str = f"{roll_str}{sign}{self.modifier}"
        return active_i18n.t("dice.result", expression=self.expression, roll_str=roll_str, total=self.total)


def _find_primary_dice(node: d20.Number) -> d20.Dice | None:
    """Pre-order DFS for the first (primary) `Dice` group in an evaluated `d20` tree.

    Left-to-right so `"3d6+2d4"` resolves to the `3d6` group, and `"5+3d6"` still
    finds `3d6` even though it isn't the leftmost leaf.
    """
    if isinstance(node, d20.Dice):
        return node
    for child in node.children:
        found = _find_primary_dice(child)
        if found is not None:
            return found
    return None


def _dice_result_from_roll(expression: str, result: d20.RollResult, *, is_check: bool = False) -> DiceResult:
    """Build a `DiceResult` from a `d20.RollResult`.

    `rolls` is populated with the *kept* natural faces of the primary dice group (so
    e.g. `2d20kh1` collapses to a single kept face and crit detection still works);
    `modifier` is back-computed as `total - sum(rolls)` so it absorbs everything else
    in the expression (other dice groups, flat `+N`, ...) on a best-effort basis.
    """
    primary = _find_primary_dice(result.expr)
    if primary is not None:
        rolls = [int(die.total) for die in primary.keptset]
        dice_sides = 100 if primary.size == "%" else int(primary.size)
    else:
        rolls = []
        dice_sides = 0
    all_faces = [int(die.total) for die in primary.set] if primary is not None else []

    dice_count = len(rolls)  # 0 when no dice were actually rolled (a pure `+N` modifier)
    if not rolls:
        rolls = [0]

    total = int(result.total)
    modifier = total - sum(rolls)
    parsed = DiceResult(
        expression=expression,
        rolls=rolls,
        modifier=modifier,
        dice_count=dice_count,
        dice_sides=dice_sides,
        is_check=is_check,
    )
    # Every primary face incl. dropped ones (2d20kh1 keeps one, rolled two) — a
    # display concern records/frames surface without re-rolling anything.
    parsed.all_rolls = all_faces if len(all_faces) > len(rolls) else list(rolls)
    return parsed


class DiceRoller:
    """`d20`-backed dice roller: generic expressions, the check pipeline's ROLL
    phase (`roll_for_check`), advantage/disadvantage, explode/Fate/repeat."""

    def __init__(self, config: DiceConfig = config) -> None:
        self.config = config

    # -- generic expressions -------------------------------------------------
    def roll_expression(self, expression: str, is_check: bool = False) -> DiceResult:
        """Roll a `d20`-grammar expression (e.g. `"1d20+5"`, `"4d6kh3"`), also accepting
        SealDice-style character-generation notation (`"3d6x5"`, `"4d6k3"`) via
        `_normalize_dice_expression`.
        """
        normalized = _normalize_dice_expression(expression.strip().lower())
        pool = _POOL_RE.match(normalized)
        if pool:
            # Success-counting pools are substrate syntax, not d20 grammar: d20 would
            # evaluate `>=` as a boolean comparison (total 1/0, nonsense modifier).
            # Route through the pool roller and keep its semantics: total = successes.
            detail = self.roll_detail(normalized)
            parsed = DiceResult(
                expression=expression,
                rolls=list(detail.dice),
                modifier=0,
                dice_count=len(detail.dice),
                dice_sides=int(pool.group(2)),
                is_check=False,
            )
            parsed.total = detail.total
            return parsed
        try:
            result = d20.roll(normalized)
        except d20.RollError as exc:
            # A malformed expression (e.g. a skill name typed at `.r`) surfaces as a
            # localized ValueError, like the other roll_* methods, so callers never see
            # a raw d20 traceback.
            raise ValueError(t("dice.error.invalid_expression", expression=expression)) from exc
        return _dice_result_from_roll(expression, result, is_check=is_check)

    def roll_detail(self, expression: str, params: Mapping[str, int] | None = None) -> RollDetail:
        """Roll one resolution-DSL expression into the neutral `RollDetail` contract.

        This is the ROLL phase of the check pipeline: the ONLY place randomness
        happens. On top of the d20 grammar it understands the substrate
        extensions every pack's ``resolution:`` may use — success-counting
        pools (``7d10>=8`` → `successes`/`ones`), fudge dice (``4df``),
        exploding shorthand (``5d6!``) — and ``{param}`` slots substituted from
        `params` (integers only; the pack declaration clamps ranges upstream).
        """
        text = expression.strip().lower()
        if params:
            def _slot(match: re.Match[str]) -> str:
                name = match.group(1)
                if name not in params:
                    raise ValueError(t("dice.error.invalid_expression", expression=expression))
                return str(int(params[name]))

            text = _PARAM_RE.sub(_slot, text)
        if _PARAM_RE.search(text):
            raise ValueError(t("dice.error.invalid_expression", expression=expression))

        pool = _POOL_RE.match(text)
        if pool:
            count, sides = int(pool.group(1)), int(pool.group(2))
            op, threshold = pool.group(3), int(pool.group(4))
            if count < 1 or sides < 2:
                raise ValueError(t("dice.error.invalid_expression", expression=expression))
            faces = [random.randint(1, sides) for _ in range(count)]
            if op == ">=":
                successes = sum(1 for face in faces if face >= threshold)
            else:
                successes = sum(1 for face in faces if face <= threshold)
            ones = sum(1 for face in faces if face == 1)
            return RollDetail(
                expression=text,
                dice=tuple(faces),
                total=successes,
                modifiers={"threshold": threshold},
                successes=successes,
                ones=ones,
            )

        fudge = _FUDGE_RE.match(text)
        if fudge:
            count = int(fudge.group(1) or 4)
            modifier = int(fudge.group(2).replace(" ", "")) if fudge.group(2) else 0
            result = self.roll_fate(count, modifier)
            return RollDetail(
                expression=text,
                dice=tuple(result.rolls),
                total=result.total,
                modifiers={"modifier": modifier} if modifier else {},
            )

        normalized = _EXPLODE_BANG_RE.sub(lambda match: f"{match.group(1)}d{match.group(2)}e{match.group(2)}", text)
        result = self.roll_expression(normalized, is_check=True)
        modifiers: dict[str, Any] = {"modifier": result.modifier} if result.modifier else {}
        all_rolls = getattr(result, "all_rolls", list(result.rolls))
        if len(all_rolls) > len(result.rolls):
            modifiers["dice_all"] = list(all_rolls)
        return RollDetail(
            expression=text,
            dice=tuple(result.rolls),
            total=result.total,
            modifiers=modifiers,
        )

    def roll_for_check(
        self,
        resolver: CheckResolver,
        *,
        params: Mapping[str, int] | None = None,
        modifiers: Mapping[str, int] | None = None,
    ) -> RollDetail:
        """The check pipeline's ROLL phase for one compiled resolver.

        ``modifiers`` maps the pack's declared modifier NAMES to counts. A
        ``roll:`` override replaces the roll expression (advantage-style); a
        ``tens_reroll:`` modifier nets its counts (keep_lowest positive,
        keep_highest negative) into the generic d100 tens-reroll mechanic.
        Applied modifier data is recorded on ``RollDetail.modifiers`` so
        records and wire frames can replay what happened.
        """
        roll_expr = resolver.roll
        net_tens = 0
        applied: dict[str, Any] = {}
        for name, count in (modifiers or {}).items():
            spec = resolver.modifiers.get(name)
            try:
                count = int(count)
            except (TypeError, ValueError):
                count = 0
            if spec is None or count <= 0:
                continue
            applied[name] = count
            if "roll" in spec:
                roll_expr = str(spec["roll"])
            if spec.get("tens_reroll") == "keep_lowest":
                net_tens += count
            elif spec.get("tens_reroll") == "keep_highest":
                net_tens -= count

        if net_tens != 0:
            tens = self._roll_d100_tens_reroll(net_tens)
            detail_modifiers = {
                **applied,
                "base_roll": tens["roll"],
                "extra_tens": tens["extra_tens"],
                "final_tens": tens["final_tens"],
            }
            return RollDetail(
                expression=roll_expr,
                dice=(tens["final_roll"],),
                total=tens["final_roll"],
                modifiers=detail_modifiers,
            )

        rolled = self.roll_detail(roll_expr, self._check_params(resolver, params))
        if applied:
            rolled = RollDetail(
                expression=rolled.expression,
                dice=rolled.dice,
                total=rolled.total,
                modifiers={**dict(rolled.modifiers), **applied},
                successes=rolled.successes,
                ones=rolled.ones,
            )
        return rolled

    @staticmethod
    def _check_params(resolver: CheckResolver, params: Mapping[str, int] | None) -> dict[str, int] | None:
        return resolver.clamp_params(params) if resolver.params else None

    def roll_advantage(self, expression: str, is_check: bool = False) -> DiceResult:
        """Roll `expression` twice and keep the higher total (2d20kh1-equivalent).

        Rolling twice - rather than injecting a `kh1` operator into the expression
        text - keeps this correct for arbitrary expressions (not just a bare `dN`)
        and keeps `dice_count == 1` on a plain d20 check, so crit detection still
        applies to the winning roll.
        """
        kept, _candidates = self.roll_advantage_with_candidates(expression, is_check=is_check)
        return kept

    def roll_advantage_with_candidates(
        self, expression: str, is_check: bool = False
    ) -> tuple[DiceResult, list[DiceResult]]:
        """Roll with advantage and return both the kept result and candidates."""
        candidates = [
            self.roll_expression(expression, is_check=is_check),
            self.roll_expression(expression, is_check=is_check),
        ]
        return max(candidates, key=lambda item: item.total), candidates

    def roll_disadvantage(self, expression: str, is_check: bool = False) -> DiceResult:
        """Roll `expression` twice and keep the lower total (2d20kl1-equivalent)."""
        kept, _candidates = self.roll_disadvantage_with_candidates(expression, is_check=is_check)
        return kept

    def roll_disadvantage_with_candidates(
        self, expression: str, is_check: bool = False
    ) -> tuple[DiceResult, list[DiceResult]]:
        """Roll with disadvantage and return both the kept result and candidates."""
        candidates = [
            self.roll_expression(expression, is_check=is_check),
            self.roll_expression(expression, is_check=is_check),
        ]
        return min(candidates, key=lambda item: item.total), candidates

    # -- d100 tens-reroll modifier -------------------------------------------
    def _roll_d100_tens_reroll(self, net: int) -> dict:
        """The generic d100 tens-reroll mechanic packs declare as a named
        ``tens_reroll:`` modifier (``keep_lowest`` counts positive, ``keep_highest``
        negative; opposing counts cancel 1-for-1).

        d100 = tens*10 + ones (00+0 == 100): roll |net| extra tens dice and keep
        the tens digit giving the lowest (net > 0) or highest (net < 0) d100.

        Candidates are compared by full d100 VALUE, never by bare tens digit: the
        kept ones die is shared across every tens candidate, and a tens of 0 with
        a ones of 0 is 100 - the *largest* roll, not the smallest. Comparing bare
        tens would let a keep_highest die improve, or a keep_lowest die worsen,
        any `x0` roll (e.g. raw 100 dropping to 30).
        """
        roll = random.randint(1, 100)
        ones = roll % 10
        tens = (roll // 10) % 10  # roll == 100 -> tens == 0

        def _value(candidate_tens: int) -> int:
            # d100 built from a tens candidate sharing the kept ones die (00+0 == 100).
            return 100 if candidate_tens == 0 and ones == 0 else candidate_tens * 10 + ones

        extra_count = min(abs(net), _MAX_BONUS_PENALTY_DICE)
        extra_tens: list[int] = [random.randint(0, 9) for _ in range(extra_count)]

        if net > 0:
            final_tens = min([tens, *extra_tens], key=_value)
        elif net < 0:
            final_tens = max([tens, *extra_tens], key=_value)
        else:
            final_tens = tens

        final_roll = _value(final_tens)
        return {
            "roll": roll,
            "final_roll": final_roll,
            "tens": tens,
            "ones": ones,
            "extra_tens": extra_tens,
            "final_tens": final_tens,
        }

    # -- exploding / Fate / repeat -------------------------------------------
    def roll_explode(self, expression: str, max_explosions: int = 10) -> DiceResult:
        """Explode the primary die: reroll-and-add whenever it shows its max face.

        Uses `d20`'s native `e` (explode) operator; `max_explosions` bounds the total
        dice rolled (via a scoped `d20.RollContext`) so a pathological run cannot loop
        forever.
        """
        text = expression.strip().lower()
        match = _LEADING_DICE_RE.match(text)
        if not match:
            raise ValueError(t("dice.error.invalid_expression", expression=expression))

        dice_count = int(match.group(1)) if match.group(1) else 1
        dice_sides = int(match.group(2))
        exploded_expression = _normalize_dice_expression(f"{text[: match.end()]}e{dice_sides}{text[match.end() :]}")

        roller = d20.Roller(context=d20.RollContext(max_rolls=dice_count * (max_explosions + 1)))
        result = roller.roll(exploded_expression)
        return _dice_result_from_roll(expression, result, is_check=False)

    def roll_fate(self, dice_count: int = 4, modifier: int = 0) -> DiceResult:
        """Fate/FUDGE dice: each die contributes -1, 0 or +1."""
        if dice_count <= 0:
            dice_count = 4

        rolls = [random.randint(1, 3) - 2 for _ in range(dice_count)]  # 1,2,3 -> -1,0,+1

        suffix = f"+{modifier}" if modifier > 0 else (str(modifier) if modifier < 0 else "")
        expression = f"{dice_count}df{suffix}"
        return DiceResult(
            expression=expression,
            rolls=rolls,
            modifier=modifier,
            dice_count=dice_count,
            dice_sides=3,
        )

    def roll_repeat(self, expression: str, times: int) -> list[DiceResult]:
        """Roll the same expression `times` times (1-20)."""
        if times <= 0 or times > 20:
            raise ValueError(t("dice.error.invalid_repeat_times", times=times))
        return [self.roll_expression(expression) for _ in range(times)]


def seed_dice(seed: int) -> None:
    """Seed the shared stdlib `random` instance so dice rolls become deterministic.

    Both the plain-`random.randint` helpers in this module (tens-reroll dice,
    success pools, Fate dice) and the `d20` library itself (`random.randrange`)
    draw from this same global instance, so tests can call `seed_dice(N)` before
    rolling to get reproducible faces/totals.
    """
    random.seed(seed)
