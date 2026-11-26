"""Reference vectors for ``core.dice_engine`` -- the dice-expression semantics.

Every vector replays the engine with SCRIPTED randomness (``_io.scripted_random``): the draws the
engine asked for are recorded as ``[lo, hi, value, step]`` and are authoritative. A TypeScript
implementation replays the same draws in order and must produce the same result.

Outputs (see ``server/test/fixtures/reference/README.md`` for the schemas):

* ``dice_vectors``       -- rolls: every public ``DiceRoller`` entry point, each with several seeds
* ``dice_normalize``     -- the pure SealDice -> d20 notation rewrite
* ``dice_result_flags``  -- ``DiceResult`` totals / critical flags / rendered text (no randomness)
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import Any

from . import _io  # noqa: F401  (must be imported before the engine; installs the guards)
from ._io import error_dict, jsonable, scripted_random, write_jsonl

from core import dice_engine  # isort: skip
from core.dice_engine import DiceResult, DiceRoller  # isort: skip
from core.rulepacks import load_rulepack  # isort: skip
from infra.i18n import I18n  # isort: skip

SEEDS = (1, 2, 3, 4, 5)
FEW_SEEDS = (1, 2)
ONE_SEED = (1,)

_I18N = {"en": I18n(locale="en"), "zh": I18n(locale="zh")}


# ---------------------------------------------------------------------------
# Result serialisation
# ---------------------------------------------------------------------------


def dice_result_dict(result: DiceResult) -> dict[str, Any]:
    """Every observable field of a ``DiceResult`` as plain data (the wall-clock timestamp excluded)."""
    return {
        "expression": result.expression,
        "rolls": list(result.rolls),
        "modifier": result.modifier,
        "dice_count": result.dice_count,
        "dice_sides": result.dice_sides,
        "total": result.total,
        "is_check": result.is_check,
        # Set only by the d20-backed path; absent (null) for pools / fate / explode-less results.
        "all_rolls": list(result.all_rolls) if hasattr(result, "all_rolls") else None,
        "critical_success": result.is_critical_success(),
        "critical_failure": result.is_critical_failure(),
        "text": {
            locale: {
                "detail": result.format_result(show_details=True, i18n=i18n),
                "simple": result.format_result(show_details=False, i18n=i18n),
            }
            for locale, i18n in _I18N.items()
        },
    }


def roll_detail_dict(detail: Any) -> dict[str, Any]:
    return {
        "expression": detail.expression,
        "dice": list(detail.dice),
        "total": detail.total,
        "modifiers": jsonable(dict(detail.modifiers)),
        "successes": detail.successes,
        "ones": detail.ones,
    }


# ---------------------------------------------------------------------------
# Vector runner
# ---------------------------------------------------------------------------


class _Counter:
    def __init__(self) -> None:
        self.n = 0

    def next(self, fn: str) -> str:
        self.n += 1
        return f"{fn}/{self.n:04d}"


def _vector(
    counter: _Counter,
    fn: str,
    args: dict[str, Any],
    seed: int,
    call,
    forced: Sequence[int] | None = None,
) -> dict[str, Any]:
    """Run ``call(roller)`` under scripted randomness and package the outcome."""
    roller = DiceRoller()
    result: Any = None
    error: dict[str, str] | None = None
    with scripted_random(seed, forced) as log:
        try:
            result = call(roller)
        except Exception as exc:  # noqa: BLE001 - the error class IS the vector
            error = error_dict(exc)
    return {
        "id": counter.next(fn),
        "fn": fn,
        "args": args,
        "seed": seed,
        "forced": list(forced) if forced else None,
        "draws": log.draws,
        "result": result,
        "error": error,
    }


# ---------------------------------------------------------------------------
# Case lists
# ---------------------------------------------------------------------------

# roll_expression(expression, is_check) ------------------------------------------------------

PLAIN_EXPRESSIONS = [
    "1d20", "d20", "D20", "2d6", "3d6", "4d4", "10d6", "1d100", "d100", "1d1", "100d1", "1d2", "3D6", " 1d20 ",
    "1d20+5", "1d20-3", "1D20+3", "1d20 + 5", "1d20+0", "2d6+1d4", "3d6+2d4+5", "5+3d6", "1d6+1d6", "1d6-1d4",
    "1d20+1d4+5-2", "1d20*2", "2*1d6", "(1d6+2)*3", "((1d6))", "(1d6)", "((2d6))+1", "2*3+4", "2+3*4",
    "10/3", "10/4", "7//2", "7%3", "1d20/2", "1d6//2", "1d20%7", "-1d6", "+1d6", "--1d6", "-(1d6+2)",
    "+5", "5", "0", "-5", "5+5", "1.5+1d6", "2.5*2", "1d6*1.5",
]

KEEP_DROP_EXPRESSIONS = [
    "2d20kh1", "2d20kl1", "4d6kh3", "4d6kl3", "4d6kh1", "4d6kh4", "4d6kh0", "4d6kh10", "4d6k3", "4d6k1",
    "4d6pl1", "4d6ph1", "4d6p1", "4d6p>3", "4d6p<3", "6d6k>4", "6d6k<3", "6d6p>=3", "8d6k2kh1",
    "4d6kh3+2", "10d10kh3", "3d6k6", "2d20kh1+5", "(2d20kh1)+5", "1d20kh1",
    "(1,2,3)kh2", "(1d6, 2d6, 3)kh2", "(1d6,1d6,1d6)kl1", "(4d6kh3,4d6kh3)kh1", "()", "(5)", "(1d20,)",
]

REROLL_EXPLODE_EXPRESSIONS = [
    "3d6rr1", "3d6rr<3", "3d6rr>4", "2d6ro1", "2d6ro<2", "2d6ra1", "2d6ra<3", "3d6rr1rr2", "1d20rr1",
    "1d6e6", "3d6e6", "2d6e5", "1d10e>8", "1d6e<2", "1d6e1", "5d6e6kh3", "3d6e6+2", "1d8e8e1",
    "1d6!", "5d6!", "2d10!+3", "3d6!kh2",
]

MINMAX_EXPRESSIONS = ["1d20mi5", "1d20ma15", "3d6mi2", "3d6ma5", "3d6mi2ma5", "2d20kh1mi3", "10d6mi4"]

COMPARISON_EXPRESSIONS = [
    "1d20>10", "1d20<10", "1d20==10", "1d20!=5", "1d20>=10+0", "1d20<=10+0", "2d6>7", "3d6==10", "1d20+5>15",
    "2d20kh1>10", "1>0", "1==1", "5<3", "1d6>1d6", "1d20>=10", "1d20<=10", "3d6>=3", "3d6<=3", "3d6 >= 3",
]

POOL_EXPRESSIONS = [
    "4d10>=7", "7d10>=8", "5d10<=3", "10d10>=7", "6d6>=5", "1d10>=10", "3d10>=0", "3d10<=10", "5d10>=11",
    "1d100>=50", "2d1>=1", "5D10>=6", "5d10 >= 6", "20d10>=6",
]

PERCENTILE_EXPRESSIONS = ["1d%", "d%", "2d%", "1d%+5", "2d%kh1", "1d%+1d10", "3d%kl1"]

ANNOTATION_EXPRESSIONS = [
    "1d20 [sword] + 5 [bonus]", "1d20 [a]", "2d6[fire] + 1d4[cold]", "5 [flat]", "1d20+5 [x]", "(1d6 [a] + 2) [b]",
    "1d20 [unclosed", "1d20 []",
]

SEALDICE_EXPRESSIONS = [
    "3d6x5", "3D6X5", "3d6×5", "3d6 x 5", "(2d6+6)x5", "(2d6+6) X 5", "(2d6+6)×5", "2d6x5+3", "4d6k3", "4d6K3",
    "1d100x2", "3d6x5x2", "5x5", "2d6x(1d4)", "3d6 X 5",
]

ERROR_EXPRESSIONS = [
    "", " ", "abc", "1d20 sword", "1d20 + sword", "侦查", "1d", "d", "dd6", "1d0", "1d-1", "1d6k", "1d6kh", "1d20+",
    "+", "*3", "(1d6", "1d6)", "1d20/0", "1d20//0", "1d20%0", "5/0", "0d0", "1d6rr", "1d6e", "1dx", "1d20 1d20",
    "1d20,1d20", "!", "1d6!!", "999999999d6", "1001d6", "1d1e1", "2d1e1", "1d6kh1kh1kh1kh1kh1kh1",
    "1d20; DROP TABLE", "1d20\n+5", "１d20", "1d20＋5", "1e3", "0x10", "1_000", "1d6\t+\t2",
]

# Cases with forced leading draws: edge behaviours the seeded generator may never hit.
# (expression, is_check, forced draws)
FORCED_ROLL_EXPRESSIONS: list[tuple[str, bool, list[int]]] = [
    ("1d20", True, [20]), ("1d20", True, [1]), ("1d20", False, [20]), ("1d20+5", True, [20]), ("1d20+5", True, [1]),
    ("1d100", True, [1]), ("1d100", True, [100]), ("1d%", True, [0]), ("1d%", True, [90]), ("1d6", True, [6]),
    ("1d6", True, [1]), ("2d20kh1", True, [1, 20]), ("2d20kh1", True, [20, 1]), ("2d20kh1", True, [20, 20]),
    ("2d20kl1", True, [1, 20]), ("2d20kl1", True, [20, 20]), ("2d20kh1", True, [1, 1]),
    ("4d6kh3", False, [1, 1, 1, 1]), ("4d6kh3", False, [6, 6, 6, 6]), ("4d6kh3", False, [3, 1, 6, 2]),
    ("4d6kl3", False, [3, 1, 6, 2]), ("4d6k3", False, [3, 1, 6, 2]), ("4d6pl1", False, [3, 1, 6, 2]),
    ("4d6p1", False, [1, 1, 3, 4]), ("4d6k3", False, [3, 3, 3, 3]), ("6d6k>4", False, [1, 5, 6, 2, 5, 3]),
    ("3d6rr1", False, [1, 1, 4, 2, 5]), ("3d6rr1", False, [1, 1, 1, 1, 1, 1, 1]),
    ("3d6rr<3", False, [1, 2, 3, 4, 5, 6]), ("2d6ro1", False, [1, 1, 3, 4]), ("2d6ro1", False, [1, 3, 4]),
    ("2d6ra1", False, [1, 5, 6]), ("2d6ra1", False, [1, 1, 5, 6]), ("1d6e6", False, [6, 6, 3]),
    ("1d6e6", False, [6, 6, 6, 6, 1]), ("3d6e6", False, [6, 1, 6, 2, 6, 3, 5, 5]), ("1d6!", False, [6, 6, 6, 2]),
    ("2d6e5", False, [5, 6, 2, 3, 4]), ("1d10e>8", False, [9, 10, 8]), ("1d6e<2", False, [1, 1, 5]),
    ("1d6e1", False, [1, 1, 1, 4]), ("1d20mi5", False, [1]), ("1d20mi5", False, [7]), ("1d20ma15", False, [20]),
    ("3d6mi2ma5", False, [1, 6, 3]), ("4d10>=7", False, [1, 1, 1, 1]), ("4d10>=7", False, [10, 10, 10, 10]),
    ("5d10<=3", False, [1, 2, 3, 4, 10]), ("1d20>10", False, [11]), ("1d20>10", False, [10]),
    ("3d6>=3", False, [1, 3, 6]), ("1d20 [sword] + 5 [bonus]", False, [14]), ("(1,2,3)kh2", False, []),
    ("3d6x5", False, [6, 6, 6]), ("3d6x5", False, [1, 1, 1]), ("(2d6+6)x5", False, [6, 6]),
    ("2d6+1d4", False, [6, 6, 4]), ("3d6+2d4+5", False, [1, 2, 3, 4, 4]), ("10d6", False, [1] * 10),
    ("1d1", True, [1]), ("1d2", True, [2]), ("2d20", True, [20, 20]), ("1d6", False, [3]),
]

# roll_detail(expression, params) ---------------------------------------------------------------

DETAIL_EXPRESSIONS: list[tuple[str, dict[str, Any] | None]] = [
    ("1d20", None), ("1d20+5", None), ("1d100", None), ("2d20kh1", None), ("2d20kl1", None), ("4d6kh3+2", None),
    ("1d%", None), ("3d6", None), ("2d6+1d4", None), ("4d6k3", None), ("3d6x5", None), ("(2d6+6)x5", None),
    ("1d6!", None), ("5d6!", None), ("2d10!+3", None), ("d6!", None), ("3d6!kh2", None), ("3d6e6", None),
    ("1D20", None), (" 1d20 + 5 ", None),
    ("7d10>=8", None), ("5d10<=3", None), ("5D10>=6", None), ("5d10 >= 6", None), ("10d10>=7", None),
    ("1d10>=10", None), ("3d10>=0", None), ("20d10>=6", None), ("999d10>=6", None), ("0d10>=6", None),
    ("5d1>=1", None), ("1d1>=1", None), ("1d2>=2", None), ("1000d10>=6", None),
    ("4df", None), ("df", None), ("3df", None), ("10df", None), ("4df+2", None), ("4df-1", None),
    ("4df + 2", None), ("4DF", None), ("0df", None), ("1df", None), ("4df+0", None), ("999df", None),
    ("1000df", None), ("4df+", None), ("2df+10000", None),
    ("{pool}d10>={difficulty}", {"pool": 5, "difficulty": 6}),
    ("{pool}d10>={difficulty}", {"pool": 1, "difficulty": 10}),
    ("{pool}d10>={difficulty}", {"pool": 12, "difficulty": 2}),
    ("{pool}d10>={difficulty}", {"pool": 5}),
    ("{pool}d10>={difficulty}", {"pool": "5", "difficulty": "7"}),
    ("{pool}d10>={difficulty}", {"pool": 5.9, "difficulty": 6}),
    ("{pool}d10>={difficulty}", {"pool": 0, "difficulty": 6}),
    ("{pool}d10>={difficulty}", {"pool": -3, "difficulty": 6}),
    ("{pool}d10>={difficulty}", {"pool": "x", "difficulty": 6}),
    ("{pool}d10>={difficulty}", None),
    ("{pool}d10>={difficulty}", {}),
    ("{POOL}d10>=6", {"pool": 3}),
    ("{pool}d6+{bonus}", {"pool": 2, "bonus": 3}),
    ("{pool}d6+{bonus}", {"pool": 2, "bonus": -3}),
    ("{n}df+{m}", {"n": 4, "m": 2}),
    ("1d20+{x}", {"x": 5, "unused": 9}),
    ("1d20", {"x": 5}),
    ("{ pool }d6", {"pool": 3}),
    ("{1pool}d6", {"1pool": 3}),
    ("abc", None), ("", None), ("1d20 sword", None),
]

FORCED_DETAIL: list[tuple[str, dict[str, Any] | None, list[int]]] = [
    ("5d10>=6", None, [1, 1, 1, 1, 1]), ("5d10>=6", None, [10, 10, 10, 10, 10]), ("5d10>=6", None, [1, 6, 5, 1, 7]),
    ("5d10>=6", None, [2, 3, 4, 5, 1]), ("{pool}d10>={difficulty}", {"pool": 4, "difficulty": 6}, [1, 1, 6, 10]),
    ("5d10<=3", None, [1, 2, 3, 4, 5]), ("4df", None, [1, 1, 1, 1]), ("4df", None, [3, 3, 3, 3]),
    ("4df+2", None, [1, 2, 3, 2]), ("2d20kh1", None, [20, 1]), ("2d20kh1", None, [1, 1]), ("2d20kl1", None, [20, 1]),
    ("1d6!", None, [6, 6, 2]), ("1d20", None, [20]), ("1d20", None, [1]), ("1d100", None, [100]),
]

# roll_explode(expression, max_explosions) --------------------------------------------------------

EXPLODE_CASES: list[tuple[str, int | None]] = [
    ("1d6", None), ("2d6", None), ("3d6+2", None), ("1d20", None), ("d6", None), ("4d10", None), ("1d4", None),
    ("1D6", None), ("2d6kh1", None), ("1d6", 0), ("1d6", 1), ("2d6", 2), ("1d2", 3), ("1d1", 5), ("1d1", 10),
    ("3d6", 10), ("1d6+1d6", None), ("not-a-dice", None), ("5+1d6", None), ("", None), ("2d", None), ("1d1", 2),
    ("1d2", 1), ("10d6", 10), ("1d%", None),
]
FORCED_EXPLODE: list[tuple[str, int | None, list[int]]] = [
    ("1d6", None, [6, 1]), ("1d6", None, [6, 6, 6, 3]), ("2d6", None, [6, 6, 1, 2, 3]), ("1d6", 2, [6, 6, 6, 6]),
    ("1d6", 0, [6, 6]), ("1d2", 3, [2, 2, 2, 2, 2]), ("1d6", None, [3]), ("3d6", 1, [6, 6, 6, 6, 6, 6, 6]),
]

# roll_fate(dice_count, modifier) -------------------------------------------------------------------

FATE_CASES = [
    (4, 0), (4, 2), (4, -1), (1, 0), (2, 0), (3, 1), (6, 2), (10, 0), (20, -5), (0, 0), (0, 3), (-1, 0), (-4, 2),
]
FORCED_FATE = [(4, 0, [1, 1, 1, 1]), (4, 0, [3, 3, 3, 3]), (4, 1, [2, 2, 2, 2]), (4, -2, [1, 2, 3, 3])]

# advantage / disadvantage / repeat ---------------------------------------------------------------

ADV_EXPRESSIONS = ["1d20", "1d20+5", "2d6", "1d100", "1d20kh1", "3d6+2", "1d6!", "1d20 sword", "4df"]
REPEAT_CASES = [
    ("1d6", 1), ("1d6", 2), ("1d6", 5), ("1d20+5", 3), ("3d6x5", 3), ("1d6", 20), ("1d6", 0), ("1d6", -1),
    ("1d6", 21), ("not-dice", 2), ("1d6!", 2), ("5d10>=6", 2),
]

# the d100 tens-reroll mechanic -------------------------------------------------------------------

TENS_NETS = [0, 1, 2, 3, 5, -1, -2, -3, -5, 99, 100, 101, 1000, -99, -100, -101, -1000, 100_000_000, -100_000_000]
FORCED_TENS: list[tuple[int, list[int]]] = [
    (2, [47, 8, 2]), (-2, [47, 8, 2]), (0, [47]), (-1, [100, 3]), (1, [70, 0]), (1, [100, 0]), (1, [100, 5]),
    (-1, [70, 0]), (-1, [10, 0]), (1, [10, 0]), (1, [1, 0]), (-1, [1, 9]), (1, [50, 5, 5]), (-1, [50, 5, 5]),
    (3, [20, 9, 9, 9]), (-3, [99, 0, 0, 0]), (1, [91, 9]), (-1, [91, 0]),
]

# roll_for_check(resolver, params, modifiers) -----------------------------------------------------

# modifiers are ORDERED (name, count) pairs: the engine iterates them in this order, and when two
# modifiers both override the roll expression the LAST one wins.
COC_MODIFIERS: list[list[tuple[str, Any]]] = [
    [], [("bonus", 1)], [("bonus", 2)], [("bonus", 3)], [("penalty", 1)], [("penalty", 2)], [("penalty", 3)],
    [("bonus", 2), ("penalty", 2)], [("bonus", 3), ("penalty", 1)], [("bonus", 1), ("penalty", 3)],
    [("penalty", 1), ("bonus", 1)], [("bonus", 0)], [("bonus", -1)], [("bonus", "2")], [("bonus", "x")],
    [("bonus", 2.9)], [("bonus", True)], [("bonus", None)], [("unknown", 1)], [("bonus", 1), ("unknown", 4)],
    [("bonus", 150)], [("penalty", 150)], [("bonus", 100)], [("bonus", 101)],
]
DND_MODIFIERS: list[list[tuple[str, Any]]] = [
    [], [("advantage", 1)], [("disadvantage", 1)], [("advantage", 2)], [("advantage", 1), ("disadvantage", 1)],
    [("disadvantage", 1), ("advantage", 1)], [("advantage", 0)], [("bonus", 1)], [("advantage", "1")],
]
WOD_PARAMS: list[dict[str, Any] | None] = [
    None, {}, {"pool": 5, "difficulty": 6}, {"pool": 1, "difficulty": 2}, {"pool": 10, "difficulty": 10},
    {"pool": 200, "difficulty": 6}, {"pool": 20_000_000, "difficulty": 1}, {"pool": -5}, {"pool": 0},
    {"pool": "4", "difficulty": "8"}, {"pool": "x"}, {"pool": None, "difficulty": None}, {"pool": 3.9},
    {"difficulty": 9}, {"pool": 5, "difficulty": 6, "extra": 1}, {"pool": True, "difficulty": 6},
]
FORCED_CHECK: list[tuple[str, dict[str, Any] | None, list[tuple[str, Any]], list[int]]] = [
    ("coc7", None, [], [1]), ("coc7", None, [], [100]), ("coc7", None, [("bonus", 1)], [47, 8]),
    ("coc7", None, [("penalty", 1)], [47, 8]), ("coc7", None, [("bonus", 2)], [47, 8, 2]),
    ("coc7", None, [("penalty", 1)], [100, 3]), ("coc7", None, [("bonus", 1)], [70, 0]),
    ("coc7", None, [("bonus", 1)], [100, 0]), ("dnd5e", None, [("advantage", 1)], [3, 17]),
    ("dnd5e", None, [("disadvantage", 1)], [3, 17]), ("dnd5e", None, [("advantage", 1)], [20, 20]),
    ("dnd5e", None, [], [20]), ("dnd5e", None, [], [1]),
    ("wod", {"pool": 4, "difficulty": 6}, [], [1, 1, 5, 6]), ("wod", {"pool": 4, "difficulty": 6}, [], [1, 1, 1, 1]),
    ("wod", {"pool": 4, "difficulty": 6}, [], [10, 10, 10, 10]), ("wod", {"pool": 3, "difficulty": 9}, [], [9, 8, 1]),
]


# ---------------------------------------------------------------------------
# Row generators
# ---------------------------------------------------------------------------


def _roll_expression_rows(counter: _Counter) -> Iterator[dict[str, Any]]:
    groups = [
        (PLAIN_EXPRESSIONS, SEEDS), (KEEP_DROP_EXPRESSIONS, SEEDS), (REROLL_EXPLODE_EXPRESSIONS, SEEDS),
        (MINMAX_EXPRESSIONS, SEEDS), (COMPARISON_EXPRESSIONS, SEEDS), (POOL_EXPRESSIONS, FEW_SEEDS),
        (PERCENTILE_EXPRESSIONS, SEEDS), (ANNOTATION_EXPRESSIONS, FEW_SEEDS), (SEALDICE_EXPRESSIONS, SEEDS),
        (ERROR_EXPRESSIONS, ONE_SEED),
    ]
    for expressions, seeds in groups:
        for expression in expressions:
            for seed in seeds:
                for is_check in (False, True) if seed == seeds[0] else (False,):
                    yield _vector(
                        counter, "roll_expression", {"expression": expression, "is_check": is_check}, seed,
                        lambda roller, e=expression, c=is_check: dice_result_dict(roller.roll_expression(e, is_check=c)),
                    )
    for expression, is_check, forced in FORCED_ROLL_EXPRESSIONS:
        yield _vector(
            counter, "roll_expression", {"expression": expression, "is_check": is_check}, 1,
            lambda roller, e=expression, c=is_check: dice_result_dict(roller.roll_expression(e, is_check=c)), forced,
        )
    # Over-long inputs: the d20 grammar's own roll budget (1000 dice) is the guard.
    for expression in ("1000d6", "1000d1", "500d6+500d6", "500d6+501d6", "10d10!", "1d1!"):
        yield _vector(
            counter, "roll_expression", {"expression": expression, "is_check": False}, 1,
            lambda roller, e=expression: dice_result_dict(roller.roll_expression(e)),
        )


def _roll_detail_rows(counter: _Counter) -> Iterator[dict[str, Any]]:
    for expression, params in DETAIL_EXPRESSIONS:
        many = params is None and len(expression) < 14 and "999" not in expression and "1000" not in expression
        for seed in SEEDS if many else FEW_SEEDS if "999" not in expression and "1000" not in expression else ONE_SEED:
            yield _vector(
                counter, "roll_detail", {"expression": expression, "params": params}, seed,
                lambda roller, e=expression, p=params: roll_detail_dict(roller.roll_detail(e, p)),
            )
    for expression, params, forced in FORCED_DETAIL:
        yield _vector(
            counter, "roll_detail", {"expression": expression, "params": params}, 1,
            lambda roller, e=expression, p=params: roll_detail_dict(roller.roll_detail(e, p)), forced,
        )


def _explode_rows(counter: _Counter) -> Iterator[dict[str, Any]]:
    def _call(roller: DiceRoller, expression: str, limit: int | None) -> dict[str, Any]:
        if limit is None:
            return dice_result_dict(roller.roll_explode(expression))
        return dice_result_dict(roller.roll_explode(expression, limit))

    for expression, limit in EXPLODE_CASES:
        for seed in SEEDS:
            yield _vector(
                counter, "roll_explode", {"expression": expression, "max_explosions": limit}, seed,
                lambda roller, e=expression, m=limit: _call(roller, e, m),
            )
    for expression, limit, forced in FORCED_EXPLODE:
        yield _vector(
            counter, "roll_explode", {"expression": expression, "max_explosions": limit}, 1,
            lambda roller, e=expression, m=limit: _call(roller, e, m), forced,
        )


def _fate_rows(counter: _Counter) -> Iterator[dict[str, Any]]:
    for count, modifier in FATE_CASES:
        for seed in SEEDS:
            yield _vector(
                counter, "roll_fate", {"dice_count": count, "modifier": modifier}, seed,
                lambda roller, c=count, m=modifier: dice_result_dict(roller.roll_fate(c, m)),
            )
    for count, modifier, forced in FORCED_FATE:
        yield _vector(
            counter, "roll_fate", {"dice_count": count, "modifier": modifier}, 1,
            lambda roller, c=count, m=modifier: dice_result_dict(roller.roll_fate(c, m)), forced,
        )


def _advantage_rows(counter: _Counter) -> Iterator[dict[str, Any]]:
    def _call(roller: DiceRoller, kind: str, expression: str, is_check: bool) -> dict[str, Any]:
        method = (
            roller.roll_advantage_with_candidates if kind == "advantage" else roller.roll_disadvantage_with_candidates
        )
        kept, candidates = method(expression, is_check=is_check)
        return {
            "kept": dice_result_dict(kept),
            "kept_index": next(index for index, item in enumerate(candidates) if item is kept),
            "candidates": [dice_result_dict(item) for item in candidates],
        }

    for kind in ("advantage", "disadvantage"):
        for expression in ADV_EXPRESSIONS:
            for seed in SEEDS:
                for is_check in (True, False):
                    yield _vector(
                        counter, f"roll_{kind}", {"expression": expression, "is_check": is_check}, seed,
                        lambda roller, k=kind, e=expression, c=is_check: _call(roller, k, e, c),
                    )
        # Ties keep the FIRST candidate; forced faces make the tie explicit.
        for forced in ([9, 9], [5, 17], [17, 5], [1, 1], [20, 20]):
            yield _vector(
                counter, f"roll_{kind}", {"expression": "1d20", "is_check": True}, 1,
                lambda roller, k=kind: _call(roller, k, "1d20", True), forced,
            )


def _repeat_rows(counter: _Counter) -> Iterator[dict[str, Any]]:
    for expression, times in REPEAT_CASES:
        for seed in FEW_SEEDS:
            yield _vector(
                counter, "roll_repeat", {"expression": expression, "times": times}, seed,
                lambda roller, e=expression, n=times: [dice_result_dict(item) for item in roller.roll_repeat(e, n)],
            )


def _tens_rows(counter: _Counter) -> Iterator[dict[str, Any]]:
    for net in TENS_NETS:
        for seed in SEEDS if abs(net) < 100 else ONE_SEED:
            yield _vector(
                counter, "roll_d100_tens_reroll", {"net": net}, seed,
                lambda roller, n=net: jsonable(roller._roll_d100_tens_reroll(n)),
            )
    for net, forced in FORCED_TENS:
        yield _vector(
            counter, "roll_d100_tens_reroll", {"net": net}, 1,
            lambda roller, n=net: jsonable(roller._roll_d100_tens_reroll(n)), forced,
        )


def _check_rows(counter: _Counter) -> Iterator[dict[str, Any]]:
    def _call(pack_id: str, params: dict[str, Any] | None, modifiers: list[tuple[str, Any]]):
        resolver = load_rulepack(pack_id).resolver

        def _run(roller: DiceRoller) -> dict[str, Any]:
            return roll_detail_dict(roller.roll_for_check(resolver, params=params, modifiers=dict(modifiers) or None))

        return _run

    def _args(pack_id: str, params: dict[str, Any] | None, modifiers: list[tuple[str, Any]]) -> dict[str, Any]:
        return {"pack": pack_id, "params": params, "modifiers": [[name, count] for name, count in modifiers]}

    for modifiers in COC_MODIFIERS:
        for seed in SEEDS:
            yield _vector(counter, "roll_for_check", _args("coc7", None, modifiers), seed, _call("coc7", None, modifiers))
    for modifiers in DND_MODIFIERS:
        for seed in SEEDS:
            yield _vector(counter, "roll_for_check", _args("dnd5e", None, modifiers), seed, _call("dnd5e", None, modifiers))
    for params in WOD_PARAMS:
        for seed in FEW_SEEDS:
            yield _vector(counter, "roll_for_check", _args("wod", params, []), seed, _call("wod", params, []))
    for pack_id, params, modifiers, forced in FORCED_CHECK:
        yield _vector(counter, "roll_for_check", _args(pack_id, params, modifiers), 1, _call(pack_id, params, modifiers), forced)


def _vector_rows() -> list[dict[str, Any]]:
    counter = _Counter()
    rows: list[dict[str, Any]] = []
    for generator in (
        _roll_expression_rows, _roll_detail_rows, _explode_rows, _fate_rows, _advantage_rows, _repeat_rows,
        _tens_rows, _check_rows,
    ):
        rows.extend(generator(counter))
    return rows


# ---------------------------------------------------------------------------
# Pure vectors
# ---------------------------------------------------------------------------

NORMALIZE_INPUTS = [
    "3d6x5", "(2d6+6)x5", "4d6k3", "4d6kh3", "4d6kl3", "3d6×5", "3d6 x 5", "3d6X5", "3d6 × 5", "2d20kh1",
    "1d20mi5", "1d20ma15", "3d6rr1", "2d6ro1", "1d6e6", "5x5", "5x 5", "x5", "5x", "3d6x", "(5)x(5)", "3d6xx5",
    "4d6k3+1d6k2", "4d6k", "4d6kh", "k3", "1d20", "", "abc x def", "10x10x10", "2d6kh1k2", "1d%x5",
    "(1d4)x(1d4)", "3d6x5+2d4x2", "4d6k10", "4d6k03", "1d6 x5", "1d6x 5",
]


def _normalize_rows() -> list[dict[str, Any]]:
    return [
        {"input": text, "output": dice_engine._normalize_dice_expression(text)} for text in NORMALIZE_INPUTS
    ]


def _flag_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    saved = dice_engine.config.ENABLE_CRITICAL_EFFECTS
    try:
        for enabled in (True, False):
            dice_engine.config.ENABLE_CRITICAL_EFFECTS = enabled
            for sides in (0, 2, 3, 4, 6, 8, 10, 12, 20, 100):
                for dice_count in (0, 1, 2):
                    for is_check in (True, False):
                        faces = sorted({0, 1, 2, sides - 1, sides, sides + 1, max(1, sides // 2)})
                        for face in faces:
                            for modifier in (0, 5, -3):
                                rolls = [face] if dice_count < 2 else [face, face]
                                result = DiceResult(
                                    f"{dice_count}d{sides}", list(rolls), modifier, dice_count, sides, is_check
                                )
                                rows.append(
                                    {
                                        "enable_critical_effects": enabled,
                                        "input": {
                                            "expression": result.expression,
                                            "rolls": rolls,
                                            "modifier": modifier,
                                            "dice_count": dice_count,
                                            "dice_sides": sides,
                                            "is_check": is_check,
                                        },
                                        "result": dice_result_dict(result),
                                    }
                                )
            # Mixed faces on a multi-dice result (crit needs dice_count == 1, never inspects count of rolls).
            for rolls, sides in (([20, 1], 20), ([1, 20], 20), ([1, 100], 100), ([5, 6], 6)):
                result = DiceResult("mixed", list(rolls), 0, len(rolls), sides, True)
                rows.append(
                    {
                        "enable_critical_effects": enabled,
                        "input": {
                            "expression": "mixed",
                            "rolls": rolls,
                            "modifier": 0,
                            "dice_count": len(rolls),
                            "dice_sides": sides,
                            "is_check": True,
                        },
                        "result": dice_result_dict(result),
                    }
                )
            # A single die whose `rolls` list carries two entries (dice_count says 1).
            result = DiceResult("odd", [20, 1], 0, 1, 20, True)
            rows.append(
                {
                    "enable_critical_effects": enabled,
                    "input": {
                        "expression": "odd", "rolls": [20, 1], "modifier": 0, "dice_count": 1, "dice_sides": 20,
                        "is_check": True,
                    },
                    "result": dice_result_dict(result),
                }
            )
    finally:
        dice_engine.config.ENABLE_CRITICAL_EFFECTS = saved
    return rows


def export() -> list[tuple[str, int, str]]:
    return [
        write_jsonl("dice_vectors", _vector_rows()),
        write_jsonl("dice_normalize", _normalize_rows()),
        write_jsonl("dice_result_flags", _flag_rows()),
    ]
