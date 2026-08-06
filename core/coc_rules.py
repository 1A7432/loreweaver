"""COC7 success-level rules — authoritative port of SealDice `ResultCheckBase`.

Ported byte-for-byte from SealDice `dice/ext_coc7.go:ResultCheckBase` (MIT) and the
`.setcoc` rule table `dice/utils.go:SetCocRuleText`. This is deterministic code —
never "improve" or AI-rewrite the branching below. See `docs/specs/rules_coc.md`
(authoritative) for the port instructions and the test-vector derivation notes.

Used by `core.dice_engine` (`DiceRoller.roll_coc_check*`) and the future `.setcoc`
command (per-group rule stored under `coc_rule.{chat_key}`, default `DEFAULT_COC_RULE`).

M16 stage A adds the `CheckOutcome` bridge (`RANKS`/`outcome_from_check`): every
consumer now reads the neutral contract while this legacy resolver stays alive.
The whole module is deleted in stage C once the compiled pack resolver passes the
exhaustive rulebook tables.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from core.check_outcome import CheckOutcome, Rank, RollDetail


def result_check_base(coc_rule: int, d100: int, attr_value: int, difficulty_required: int = 1) -> tuple[int, int]:
    """Return (success_rank, critical_success_value). Port of SealDice ResultCheckBase.

    success_rank: 4 crit / 3 extreme / 2 hard / 1 success / -1 fail / -2 fumble.
    """
    critical_success_value = 1  # 大成功阈值
    fumble_value = 100  # 大失败阈值

    check_val = attr_value
    if difficulty_required == 2:
        check_val //= 2
    elif difficulty_required == 3:
        check_val //= 5
    elif difficulty_required == 4:
        check_val = critical_success_value

    success_rank = 1 if d100 <= check_val else -1

    if coc_rule == 0:
        if check_val < 50:
            fumble_value = 96
    elif coc_rule == 1:
        if attr_value >= 50:
            critical_success_value = 5
        if attr_value < 50:
            fumble_value = 96
    elif coc_rule == 2:
        critical_success_value = 5
        if attr_value < critical_success_value:
            critical_success_value = attr_value
        fumble_value = 96
        if attr_value >= fumble_value:
            fumble_value = attr_value + 1
            if fumble_value > 100:
                fumble_value = 100
    elif coc_rule == 3:
        critical_success_value = 5
        fumble_value = 96
    elif coc_rule == 4:
        critical_success_value = attr_value // 10
        if critical_success_value > 5:
            critical_success_value = 5
        fumble_value = 96 + attr_value // 10
        if 100 < fumble_value:
            fumble_value = 100
    elif coc_rule == 5:
        critical_success_value = attr_value // 5
        if critical_success_value > 2:
            critical_success_value = 2
        fumble_value = 96 if attr_value < 50 else 99
    elif coc_rule == 11:  # dg (Delta Green)
        critical_success_value = 1
        fumble_value = 100

    if success_rank == 1 or d100 <= critical_success_value:
        if d100 <= attr_value // 2:
            success_rank = 2
        if d100 <= attr_value // 5:
            success_rank = 3
        if d100 <= critical_success_value:
            success_rank = 4
    elif d100 >= fumble_value:
        success_rank = -2

    if coc_rule in (0, 1, 2):
        if d100 == 1:
            success_rank = 4

    if d100 == 100 and coc_rule == 0:
        success_rank = -2

    if coc_rule == 3:
        if d100 <= critical_success_value:
            success_rank = 4
        if d100 >= fumble_value:
            success_rank = -2

    if coc_rule == 11:
        num_units = d100 % 10
        num_tens = d100 % 100 // 10
        dg_check = num_units == num_tens
        if success_rank > 0:
            success_rank = 4 if dg_check else 1
        else:
            success_rank = -2 if dg_check else -1
        if d100 == 1:
            success_rank = 4

    return success_rank, critical_success_value


# Rule-table descriptions kept verbatim from docs/specs/rules_coc.md. These describe
# SealDice's `.setcoc` rule-variant table (reference/citation data ported alongside the
# math above — like `core/game_clock.py`'s date formats), not chat-facing UI copy, so
# they are intentionally NOT routed through `infra.i18n`.
COC_RULE_TEXT: dict[int, str] = {
    0: "rule 0 (rulebook): 1=crit; <50 -> 96-100 fumble, >=50 -> 100 fumble",
    1: "rule 1: <50 -> 1 crit / >=50 -> 1-5 crit; <50 -> 96-100 fumble / >=50 -> 100 fumble",
    2: "rule 2 (domestic common): 1-5 & success = crit; 96-100 & fail = fumble",
    3: "rule 3 (strict): 1-5 crit; 96-100 fumble (overrides check result)",
    4: "rule 4 (balanced): 1-5 & <=skill/10 crit; <50 -> >=96+skill/10 fumble, >=50 -> 100 fumble",
    5: "rule 5 (hard): 1-2 & <=skill/5 crit; <50 -> 96-100 fumble, >=50 -> 99-100 fumble",
    11: "dg (Delta Green): 1 or (success & units==tens) crit; 100 or (fail & units==tens) fumble; no hard/extreme",
}

DEFAULT_COC_RULE = 0  # SealDice default; `.setcoc N` sets per-group (stored group_rule.{chat_key})

# Difficulty codes for `difficulty_required` (see docs/specs/rules_coc.md §Difficulty codes).
DIFFICULTY_REGULAR = 1
DIFFICULTY_HARD = 2
DIFFICULTY_EXTREME = 3
DIFFICULTY_CRITICAL = 4

# CN dialect prefix -> difficulty code (`.setcoc` style commands like "困难侦查").
DIFFICULTY_PREFIX_MAP: dict[str, int] = {
    "": DIFFICULTY_REGULAR,
    "困难": DIFFICULTY_HARD,
    "极难": DIFFICULTY_EXTREME,
    "大成功": DIFFICULTY_CRITICAL,
}

# success_rank code -> infra.i18n key (see locales/{en,zh}/dice.json). Rendering happens
# at the edge (an `I18n` instance is required) — see `core.dice_engine.coc_rank_label`.
RANK_LABEL_KEYS: dict[int, str] = {
    4: "coc.rank.crit",
    3: "coc.rank.extreme",
    2: "coc.rank.hard",
    1: "coc.rank.success",
    -1: "coc.rank.fail",
    -2: "coc.rank.fumble",
}

# --------------------------------------------------------------------------
# Stage-A bridge onto the neutral `CheckOutcome` contract. Dies with this
# module in stage C, when the compiled rulepack resolver produces outcomes.
# --------------------------------------------------------------------------

# The CoC7 ladder as `Rank` values, keyed by the legacy -2..4 code.
RANKS: dict[int, Rank] = {
    4: Rank(id="crit", tier=5, label_key="coc.rank.crit", success=True, critical=True),
    3: Rank(id="extreme", tier=4, label_key="coc.rank.extreme", success=True),
    2: Rank(id="hard", tier=3, label_key="coc.rank.hard", success=True),
    1: Rank(id="regular", tier=2, label_key="coc.rank.success", success=True),
    -1: Rank(id="fail", tier=1, label_key="coc.rank.fail"),
    -2: Rank(id="fumble", tier=0, label_key="coc.rank.fumble", fumble=True),
}


def effective_target(target: int, difficulty: int) -> int:
    """The d100 value a roll must not exceed under a `DIFFICULTY_*` code."""
    if difficulty == DIFFICULTY_HARD:
        return target // 2
    if difficulty == DIFFICULTY_EXTREME:
        return target // 5
    if difficulty == DIFFICULTY_CRITICAL:
        return 1
    return target


def outcome_from_check(result: Mapping[str, Any]) -> CheckOutcome:
    """Bridge one legacy ``roll_coc_check*`` result dict onto ``CheckOutcome``.

    ``margin`` is measured against the difficulty-adjusted target (the number
    the d100 actually had to beat), positive on the success side.
    """
    roll = int(result.get("final_roll", result["roll"]))
    target = int(result["skill_value"])
    difficulty = int(result.get("difficulty", DIFFICULTY_REGULAR) or DIFFICULTY_REGULAR)
    modifiers: dict[str, Any] = {
        "bonus": int(result.get("bonus", 0) or 0),
        "penalty": int(result.get("penalty", 0) or 0),
        "difficulty": difficulty,
        "rule": int(result.get("rule", DEFAULT_COC_RULE) or DEFAULT_COC_RULE),
    }
    # `base_roll` = the pre-bonus/penalty d100 as rolled ("raw_roll" is owned by
    # the Luck layer: the pre-Luck effective roll).
    base_roll = int(result.get("raw_roll", result["roll"]))
    if base_roll != roll or modifiers["bonus"] or modifiers["penalty"]:
        modifiers["base_roll"] = base_roll
    if "extra_tens" in result:
        modifiers["extra_tens"] = list(result.get("extra_tens") or [])
    if result.get("final_tens") is not None:
        modifiers["final_tens"] = int(result["final_tens"])
    return CheckOutcome(
        rolled=RollDetail(expression="1d100", dice=(roll,), total=roll, modifiers=modifiers),
        target=target,
        rank=RANKS[int(result["rank"])],
        margin=effective_target(target, difficulty) - roll,
    )
