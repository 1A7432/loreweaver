"""TRPG dice engine — `d20`-backed roller with COC7/DND success-level helpers.

Ported from `nekro_trpg_dice_plugin/trpg_dice/core/dice_engine.py`: the regex
expression parser/roller internals are replaced with the `d20` library
(https://github.com/avrae/d20), while the `DiceResult` semantic layer
(critical success/failure detection) and the COC/DND check helpers keep their
original nekro behavior. See `docs/specs/M0.md` §2 and `docs/specs/rules_coc.md`.

Determinism: `d20` draws randomness from the stdlib `random` module's global
instance (`random.randrange`), so `seed_dice(seed)` (== `random.seed(seed)`)
makes every roller in this module - and `d20.roll` itself - deterministic.
"""

from __future__ import annotations

import random
import re
import time
from dataclasses import dataclass

import d20

from core.coc_rules import DEFAULT_COC_RULE, DIFFICULTY_REGULAR, RANK_LABEL_KEYS, result_check_base
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

        A plain d20-style check crits on the max face; a d100 (COC-style percentile)
        check crits on a natural 1.
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

        A plain d20-style check fumbles on a natural 1; a d100 (COC-style percentile)
        check fumbles on a natural 100. (Skill-relative 96-100 fumble bands are handled
        by the dedicated COC check helpers, not here.)
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

    dice_count = len(rolls)  # 0 when no dice were actually rolled (a pure `+N` modifier)
    if not rolls:
        rolls = [0]

    total = int(result.total)
    modifier = total - sum(rolls)
    return DiceResult(
        expression=expression,
        rolls=rolls,
        modifier=modifier,
        dice_count=dice_count,
        dice_sides=dice_sides,
        is_check=is_check,
    )


class DiceRoller:
    """`d20`-backed dice roller with advantage/disadvantage, COC7, WoD and Fate helpers."""

    def __init__(self, config: DiceConfig = config) -> None:
        self.config = config

    # -- generic expressions -------------------------------------------------
    def roll_expression(self, expression: str, is_check: bool = False) -> DiceResult:
        """Roll a `d20`-grammar expression (e.g. `"1d20+5"`, `"4d6kh3"`), also accepting
        SealDice-style character-generation notation (`"3d6x5"`, `"4d6k3"`) via
        `_normalize_dice_expression`.
        """
        normalized = _normalize_dice_expression(expression.strip().lower())
        try:
            result = d20.roll(normalized)
        except d20.RollError as exc:
            # A malformed expression (e.g. a skill name typed at `.r`) surfaces as a
            # localized ValueError, like the other roll_* methods, so callers never see
            # a raw d20 traceback.
            raise ValueError(t("dice.error.invalid_expression", expression=expression)) from exc
        return _dice_result_from_roll(expression, result, is_check=is_check)

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

    # -- COC7 --------------------------------------------------------------
    def _roll_bonus_penalty_d100(self, bonus: int = 0, penalty: int = 0) -> dict:
        """SealDice-style d100 with tens bonus/penalty dice (ported from nekro).

        d100 = tens*10 + ones (00+0 == 100). Bonus dice: roll extra tens dice and
        keep the tens digit giving the *lowest* d100 value. Penalty dice: keep the
        one giving the *highest* value. Net bonus/penalty dice cancel out 1-for-1.

        Candidates are compared by full d100 VALUE, never by bare tens digit: the
        kept ones die is shared across every tens candidate (SealDice swaps only
        the tens), and a tens of 0 with a ones of 0 is 100 - the *largest* roll,
        not the smallest. Comparing bare tens would let a penalty die improve, or
        a bonus die worsen, any `x0` roll (e.g. raw 100 dropping to 30).
        """
        roll = random.randint(1, 100)
        ones = roll % 10
        tens = (roll // 10) % 10  # roll == 100 -> tens == 0

        def _value(candidate_tens: int) -> int:
            # d100 built from a tens candidate sharing the kept ones die (00+0 == 100).
            return 100 if candidate_tens == 0 and ones == 0 else candidate_tens * 10 + ones

        net_bonus = bonus - penalty
        extra_count = min(abs(net_bonus), _MAX_BONUS_PENALTY_DICE)
        extra_tens: list[int] = [random.randint(0, 9) for _ in range(extra_count)]

        if net_bonus > 0:
            final_tens = min([tens, *extra_tens], key=_value)
        elif net_bonus < 0:
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

    def roll_coc_check(
        self,
        skill_value: int,
        rule: int = 0,
        difficulty: int = 1,
        bonus: int = 0,
        penalty: int = 0,
    ) -> dict:
        """CoC7 skill check wired to `coc_rules.result_check_base` (SealDice port).

        Applies SealDice tens bonus/penalty dice (see `_roll_bonus_penalty_d100`)
        before computing the success rank; `rank`/`level_code`/`level` are the same
        canonical -2..4 code (see `coc_rules.RANK_LABEL_KEYS`) - render a localized
        label at the edge via `coc_rank_label`, never store the CN/EN label itself.
        """
        bonus_penalty = self._roll_bonus_penalty_d100(bonus, penalty)
        d100 = bonus_penalty["final_roll"]
        rank, critical_threshold = result_check_base(rule, d100, skill_value, difficulty)
        return {
            "roll": d100,
            "raw_roll": bonus_penalty["roll"],
            "skill_value": skill_value,
            "rank": rank,
            "level_code": rank,
            "level": rank,  # compatibility field (legacy nekro callers)
            "success": rank >= 1,
            "difficulty": difficulty,
            "rule": rule,
            "bonus": bonus,
            "penalty": penalty,
            "critical_threshold": critical_threshold,
        }

    def roll_coc_check_with_bonus(self, skill_value: int, bonus: int = 0, penalty: int = 0) -> dict:
        """Legacy-shaped CoC check exposing the raw bonus/penalty tens-dice mechanics.

        Same success-rank math as `roll_coc_check` (default rule/difficulty) but keeps
        nekro's original diagnostic fields (`tens`/`ones`/`extra_tens`/`final_tens`,
        plus both the raw `roll` and the bonus/penalty-adjusted `final_roll`).
        """
        bonus_penalty = self._roll_bonus_penalty_d100(bonus, penalty)
        rank, critical_threshold = result_check_base(DEFAULT_COC_RULE, bonus_penalty["final_roll"], skill_value, 1)
        return {
            "roll": bonus_penalty["roll"],
            "final_roll": bonus_penalty["final_roll"],
            "skill_value": skill_value,
            "level": rank,  # compatibility field (legacy nekro callers)
            "level_code": rank,
            "rank": rank,
            "success": rank >= 1,
            "bonus": bonus,
            "penalty": penalty,
            "tens": bonus_penalty["tens"],
            "ones": bonus_penalty["ones"],
            "extra_tens": bonus_penalty["extra_tens"],
            "final_tens": bonus_penalty["final_tens"],
            "critical_threshold": critical_threshold,
            "difficulty": DIFFICULTY_REGULAR,
            "rule": DEFAULT_COC_RULE,
        }

    # -- World of Darkness ---------------------------------------------------
    def roll_wod_pool(self, pool_size: int, difficulty: int = 6, specialization: bool = False) -> dict:
        """World of Darkness dice-pool check."""
        if pool_size <= 0:
            return {"successes": 0, "rolls": [], "botch": True}

        rolls = [random.randint(1, 10) for _ in range(pool_size)]
        successes = 0
        ones = 0
        for roll in rolls:
            if roll >= difficulty:
                successes += 1
                if specialization and roll == 10:
                    successes += 1  # specialization: a 10 counts as two successes
            elif roll == 1:
                ones += 1

        botch = successes == 0 and ones > 0
        return {
            "successes": successes,
            "rolls": rolls,
            "botch": botch,
            "difficulty": difficulty,
            "pool_size": pool_size,
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

    Both the plain-`random.randint` helpers in this module (bonus/penalty dice, WoD
    pools, Fate dice) and the `d20` library itself (`random.randrange`) draw from this
    same global instance, so tests can call `seed_dice(N)` before rolling to get
    reproducible faces/totals.
    """
    random.seed(seed)


def coc_rank_label(rank: int, i18n: I18n | None = None) -> str:
    """Localized label for a `coc_rules.result_check_base` success-rank code."""
    active_i18n = i18n or get_i18n()
    return active_i18n.t(RANK_LABEL_KEYS.get(rank, "coc.rank.fail"))
