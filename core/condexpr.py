"""Safe, deterministic evaluator for JS-flavored condition expressions.

The worldbook's `condition` field (and the `core.ejs_lite` template subset) needs to evaluate
author-written expressions like ``town_fear >= 5 && !alerted``, ``variables.stage === 2`` or
``getvar('好感度') > 50`` against the room's deterministic variable state. SillyTavern cards
write these in JavaScript flavor (ST-Prompt-Template evaluates real EJS), so the surface here is
deliberately JS-shaped — but this is NOT a JavaScript engine: it is a hand-written tokenizer +
recursive-descent evaluator over a closed grammar with no function calls (except the whitelisted
``getvar``), no assignment, no loops, no attribute access on Python objects, and hard input
bounds. Nothing is ever ``eval``'d; a hostile expression can at worst return the wrong boolean.

Variable access forms, all resolved through a caller-supplied ``resolve(path) -> Any``:
- bare dotted paths: ``town_fear``, ``理.好感度`` (CJK identifiers are first-class)
- ``variables.<path>`` / ``stat_data.<path>`` — the ST/MVU-style roots (passed through verbatim;
  the caller's resolver normalizes known root prefixes)
- ``getvar('name')`` — extra arguments tolerated and ignored
- ``a.b[0]`` / ``a['key']`` bracket segments fold into the dotted path

Callers may additionally inject a CLOSED table of pure functions (``functions=``,
e.g. ``floor``/``min``/``max`` for the rulepack resolution DSL): a call ``name(a, b)``
evaluates its arguments in this same grammar and applies the Python callable. Nothing
outside that table is ever callable; ``getvar`` stays the only built-in.

Operators: ``|| && !`` (plus word forms ``or/and/not``), ``=== !== == != >= <= > <``, arithmetic
``+ - * / %``, parentheses, unary minus. ``==``/``!=`` are LOOSE (numeric strings compare equal
to their numbers, JS-style); ``===``/``!==`` are strict. Truthiness is JS-ish: ``0``, ``""``,
``null``/``None``, ``false`` and empty lists are falsy.

`evaluate` raises `CondExprError` on any lex/parse/eval problem; `evaluate_safe` degrades to a
caller-supplied default instead (the worldbook treats a broken condition as "don't inject").
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from typing import Any

MAX_EXPR_LEN = 500
MAX_TOKENS = 200

Resolver = Callable[[str], Any]


class CondExprError(ValueError):
    """Raised for any tokenize/parse/evaluate failure of a condition expression."""


# ---------------------------------------------------------------------------
# Tokenizer
# ---------------------------------------------------------------------------

_NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")
# Unicode identifier: a letter (incl. CJK) or underscore, then word chars — never a leading digit.
_IDENT_RE = re.compile(r"[^\W\d]\w*", re.UNICODE)

_OPERATORS = (
    "===", "!==", "==", "!=", ">=", "<=", "&&", "||",
    ">", "<", "!", "(", ")", "[", "]", ".", ",", "+", "-", "*", "/", "%",
)

_KEYWORDS: dict[str, Any] = {
    "true": True,
    "false": False,
    "null": None,
    "undefined": None,
    "none": None,
}
_WORD_OPS = {"and": "&&", "or": "||", "not": "!"}


def _tokenize(text: str) -> list[tuple[str, Any]]:
    """Produce ``(kind, value)`` tokens: kind is 'num' | 'str' | 'ident' | 'op'."""
    if len(text) > MAX_EXPR_LEN:
        raise CondExprError(f"expression too long ({len(text)} > {MAX_EXPR_LEN})")
    tokens: list[tuple[str, Any]] = []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch.isspace():
            i += 1
            continue
        if len(tokens) >= MAX_TOKENS:
            raise CondExprError("expression has too many tokens")
        if ch in ("'", '"'):
            value, i = _read_string(text, i)
            tokens.append(("str", value))
            continue
        match = _NUMBER_RE.match(text, i)
        if match:
            raw = match.group(0)
            tokens.append(("num", float(raw) if "." in raw else int(raw)))
            i = match.end()
            continue
        match = _IDENT_RE.match(text, i)
        if match:
            word = match.group(0)
            lowered = word.lower()
            if lowered in _WORD_OPS:
                tokens.append(("op", _WORD_OPS[lowered]))
            elif lowered in _KEYWORDS:
                tokens.append(("kw", _KEYWORDS[lowered]))
            else:
                tokens.append(("ident", word))
            i = match.end()
            continue
        for op in _OPERATORS:
            if text.startswith(op, i):
                tokens.append(("op", op))
                i += len(op)
                break
        else:
            raise CondExprError(f"unexpected character {ch!r} at position {i}")
    return tokens


def _read_string(text: str, start: int) -> tuple[str, int]:
    quote = text[start]
    out: list[str] = []
    i = start + 1
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            out.append(text[i + 1])
            i += 2
            continue
        if ch == quote:
            return "".join(out), i + 1
        out.append(ch)
        i += 1
    raise CondExprError("unterminated string literal")


# ---------------------------------------------------------------------------
# Recursive-descent evaluator (evaluates while parsing; short-circuits && / ||)
# ---------------------------------------------------------------------------


class _Evaluator:
    def __init__(
        self,
        tokens: list[tuple[str, Any]],
        resolve: Resolver,
        functions: Mapping[str, Callable[..., Any]] | None = None,
        probe: Any = 1,
    ) -> None:
        self._tokens = tokens
        self._pos = 0
        self._resolve = resolve
        self._functions = functions or {}
        # What a SHORT-CIRCUITED reference resolves to while its branch is parsed but
        # not evaluated (and what a dry run resolves everything to). See `_skip_and_expr`.
        self._probe = probe

    # -- token helpers -----------------------------------------------------

    def _peek(self) -> tuple[str, Any] | None:
        return self._tokens[self._pos] if self._pos < len(self._tokens) else None

    def _next(self) -> tuple[str, Any]:
        token = self._peek()
        if token is None:
            raise CondExprError("unexpected end of expression")
        self._pos += 1
        return token

    def _accept_op(self, *ops: str) -> str | None:
        token = self._peek()
        if token is not None and token[0] == "op" and token[1] in ops:
            self._pos += 1
            return token[1]
        return None

    def _expect_op(self, op: str) -> None:
        if self._accept_op(op) is None:
            found = self._peek()
            raise CondExprError(f"expected {op!r}, found {found[1]!r}" if found else f"expected {op!r}")

    # -- grammar -----------------------------------------------------------

    def evaluate(self) -> Any:
        value = self._or_expr()
        if self._peek() is not None:
            raise CondExprError(f"unexpected trailing token {self._peek()[1]!r}")
        return value

    def _or_expr(self) -> Any:
        value = self._and_expr()
        while self._accept_op("||"):
            if truthy(value):
                self._skip_and_expr()  # short-circuit: parse but don't evaluate refs
            else:
                value = self._and_expr()
        return value

    def _and_expr(self) -> Any:
        value = self._not_expr()
        while self._accept_op("&&"):
            if truthy(value):
                value = self._not_expr()
            else:
                self._skip_not_expr()
        return value

    def _not_expr(self) -> Any:
        if self._accept_op("!"):
            return not truthy(self._not_expr())
        return self._comparison()

    def _comparison(self) -> Any:
        left = self._additive()
        op = self._accept_op("===", "!==", "==", "!=", ">=", "<=", ">", "<")
        if op is None:
            return left
        right = self._additive()
        return _compare(op, left, right)

    def _additive(self) -> Any:
        value = self._term()
        while True:
            op = self._accept_op("+", "-")
            if op is None:
                return value
            right = self._term()
            value = _arith(op, value, right)

    def _term(self) -> Any:
        value = self._factor()
        while True:
            op = self._accept_op("*", "/", "%")
            if op is None:
                return value
            right = self._factor()
            value = _arith(op, value, right)

    def _factor(self) -> Any:
        if self._accept_op("("):
            value = self._or_expr()
            self._expect_op(")")
            return value
        if self._accept_op("-"):
            operand = self._factor()
            number = _as_number(operand)
            if number is None:
                raise CondExprError(f"cannot negate {operand!r}")
            return -number
        kind, value = self._next()
        if kind in ("num", "str", "kw"):
            return value
        if kind == "ident":
            return self._reference(value)
        raise CondExprError(f"unexpected token {value!r}")

    def _reference(self, first: str) -> Any:
        # getvar('name'[, ...]) — the one built-in callable in the grammar.
        if first == "getvar" and self._accept_op("("):
            kind, name = self._next()
            if kind != "str":
                raise CondExprError("getvar() takes a quoted variable name")  # i18n-exempt: developer diagnostic; callers degrade fail-safe, never show this raw to players
            while self._accept_op(","):
                self._next()  # tolerate and ignore extra arguments ({defaults: ...} etc.)
            self._expect_op(")")
            return self._resolve(name)
        # Caller-injected pure functions (a CLOSED table — see the module docstring).
        if first in self._functions and self._accept_op("("):
            arguments: list[Any] = []
            if not self._accept_op(")"):
                arguments.append(self._or_expr())
                while self._accept_op(","):
                    arguments.append(self._or_expr())
                self._expect_op(")")
            try:
                return self._functions[first](*arguments)
            except CondExprError:
                raise
            except Exception as exc:
                raise CondExprError(f"{first}() failed: {exc}") from exc
        segments = [first]
        while True:
            if self._accept_op("."):
                kind, part = self._next()
                if kind != "ident" and kind != "num":
                    raise CondExprError(f"bad path segment {part!r}")
                segments.append(str(part if kind == "ident" else _int_segment(part)))
            elif self._accept_op("["):
                kind, part = self._next()
                if kind not in ("str", "num"):
                    raise CondExprError(f"bad bracket segment {part!r}")
                self._expect_op("]")
                segments.append(str(part if kind == "str" else _int_segment(part)))
            else:
                break
        return self._resolve(".".join(segments))

    # -- short-circuit skippers (parse without resolving) -------------------
    # The skipped side still walks the normal evaluator over a BENIGN resolver;
    # every reference resolves to the probe so arithmetic/ordering in the dead branch
    # stays well-typed (a None placeholder used to make `false && x > 5` blow
    # up as "cannot order None and 5" instead of short-circuiting cleanly).

    def _skip_and_expr(self) -> None:
        resolve, self._resolve = self._resolve, lambda _path: self._probe
        try:
            self._and_expr()
        finally:
            self._resolve = resolve

    def _skip_not_expr(self) -> None:
        resolve, self._resolve = self._resolve, lambda _path: self._probe
        try:
            self._not_expr()
        finally:
            self._resolve = resolve


def _int_segment(value: Any) -> Any:
    return int(value) if isinstance(value, float) and value.is_integer() else value


# ---------------------------------------------------------------------------
# Semantics
# ---------------------------------------------------------------------------


def truthy(value: Any) -> bool:
    """JS-ish truthiness: 0, "", None, False, and empty containers are falsy."""
    if isinstance(value, (list, tuple, dict, set)):
        return len(value) > 0
    return bool(value)


def _as_number(value: Any) -> float | int | None:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        text = value.strip()
        try:
            return int(text)
        except ValueError:
            try:
                return float(text)
            except ValueError:
                return None
    return None


def _compare(op: str, left: Any, right: Any) -> bool:
    if op in ("===", "!=="):
        strict = type(left) is type(right) and left == right
        if isinstance(left, bool) != isinstance(right, bool):  # bool is not "the same type" as int here
            strict = False
        return strict if op == "===" else not strict
    if op in ("==", "!="):
        equal = left == right
        if not equal:
            left_num, right_num = _as_number(left), _as_number(right)
            if left_num is not None and right_num is not None:
                equal = left_num == right_num
        return equal if op == "==" else not equal

    left_num, right_num = _as_number(left), _as_number(right)
    if left_num is not None and right_num is not None:
        left, right = left_num, right_num
    elif not (isinstance(left, str) and isinstance(right, str)):
        raise CondExprError(f"cannot order {left!r} and {right!r}")
    if op == ">":
        return left > right
    if op == "<":
        return left < right
    if op == ">=":
        return left >= right
    return left <= right


def _arith(op: str, left: Any, right: Any) -> Any:
    if op == "+" and isinstance(left, str) and isinstance(right, str):
        return left + right
    left_num, right_num = _as_number(left), _as_number(right)
    if left_num is None or right_num is None:
        raise CondExprError(f"cannot compute {left!r} {op} {right!r}")
    if op == "+":
        return left_num + right_num
    if op == "-":
        return left_num - right_num
    if op == "*":
        return left_num * right_num
    if op == "/":
        if right_num == 0:
            raise CondExprError("division by zero")
        return left_num / right_num
    if right_num == 0:
        raise CondExprError("modulo by zero")
    return left_num % right_num


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def evaluate(
    expression: str,
    resolve: Resolver,
    *,
    functions: Mapping[str, Callable[..., Any]] | None = None,
) -> Any:
    """Evaluate `expression` against `resolve`, raising `CondExprError` on any problem."""
    tokens = _tokenize(expression)
    if not tokens:
        raise CondExprError("empty expression")
    return _Evaluator(tokens, resolve, functions).evaluate()


def compile_expression(
    expression: str,
    *,
    functions: Mapping[str, Callable[..., Any]] | None = None,
    probe: Any = 1,
) -> Callable[[Resolver], Any]:
    """Tokenize `expression` ONCE and return a reusable evaluator.

    Lex/parse errors surface at compile time; the returned callable re-walks the
    cached token stream per call (the resolution DSL evaluates its rank ladders
    hot — per check, and hundreds of thousands of times in the exhaustive
    rulebook tables — so re-tokenizing every evaluation would dominate)."""
    tokens = _tokenize(expression)
    if not tokens:
        raise CondExprError("empty expression")
    # Eager syntax check: evaluate once against a benign all-probe resolver so a
    # malformed expression fails at COMPILE time (pack load), not mid-check.
    #
    # `probe` is what every reference resolves to during that dry run. The default `1`
    # suits a closed NUMERIC namespace (the resolution DSL). A caller whose variables
    # may be strings passes `"1"` instead — it coerces as a number AND orders as a
    # string, so `note > 'a'` is not falsely rejected at build time for a type the
    # build cannot know yet.
    _Evaluator(tokens, lambda _path: probe, functions, probe).evaluate()

    def run(resolve: Resolver) -> Any:
        return _Evaluator(tokens, resolve, functions, probe).evaluate()

    return run


def referenced_names(
    expression: str,
    *,
    functions: Mapping[str, Callable[..., Any]] | None = None,
) -> frozenset[str]:
    """Every reference-path identifier `expression` reads, STATICALLY.

    An identifier immediately followed by ``(`` is a function call, not a
    reference (and unknown function names already fail the compile dry-run).
    This exists because a dry-run alone cannot prove name coverage — ``&&``
    short-circuiting can skip a misspelled operand — so closed-namespace
    consumers (the resolution DSL) validate the full set at pack load.
    """
    tokens = _tokenize(expression)
    known_functions = set(functions or ())
    names: set[str] = set()
    for index, (kind, value) in enumerate(tokens):
        if kind != "ident":
            continue
        follower = tokens[index + 1] if index + 1 < len(tokens) else None
        if follower == ("op", "(") and str(value) in known_functions:
            continue
        names.add(str(value))
    return frozenset(names)


# ---------------------------------------------------------------------------
# The PORTABLE subset (M19 item 7)
# ---------------------------------------------------------------------------

# `visible_when` is evaluated CLIENT-side — values move at runtime, so no server-side
# per-viewer filter could do it — which means every client implementation must agree
# with this one, exactly, forever. The way to keep that promise is to make the grammar
# small enough to reimplement without ambiguity: comparisons, boolean logic, literals
# and bare dotted references. Nothing else.
#
# Arithmetic, `getvar()`, any function call and bracket segments are OUT, and the
# omissions are deliberate rather than incidental: each is a place two evaluators could
# quietly disagree (integer vs float division, string concatenation, coercion inside a
# call). Growing this set later is additive and safe; shrinking it would break shipped
# packs, so v1 starts conservative. An author who wants `hp >= -1` writes `hp < 0`
# the other way round.
SUBSET_OPERATORS = frozenset({"===", "!==", "==", "!=", ">=", "<=", ">", "<", "&&", "||", "!", "(", ")", "."})


class CondExprSubsetError(CondExprError):
    """`expression` parses, but uses a construct outside the portable subset."""


def check_subset(expression: str) -> None:
    """Raise :class:`CondExprSubsetError` when ``expression`` leaves the portable
    subset (see :data:`SUBSET_OPERATORS`). Syntax itself is NOT checked here —
    callers pair this with `compile_expression`, which owns that."""
    tokens = _tokenize(expression)
    if not tokens:
        raise CondExprSubsetError("empty expression")
    for index, (kind, value) in enumerate(tokens):
        if kind == "op":
            if value not in SUBSET_OPERATORS:
                raise CondExprSubsetError(f"{value!r} is outside the portable subset")  # i18n-exempt: author diagnostic, wrapped by the pack layer
        elif kind == "ident":
            follower = tokens[index + 1] if index + 1 < len(tokens) else None
            if follower == ("op", "("):
                raise CondExprSubsetError(f"{value}(): function calls are outside the portable subset")  # i18n-exempt: author diagnostic, wrapped by the pack layer


def evaluate_bool(expression: str, resolve: Resolver) -> bool:
    """`evaluate` folded through JS-ish truthiness."""
    return truthy(evaluate(expression, resolve))


def evaluate_safe(expression: str, resolve: Resolver, default: bool = False) -> bool:
    """`evaluate_bool`, degrading to `default` instead of raising — the worldbook's
    "a broken condition never crashes injection, it just doesn't fire" contract."""
    try:
        return evaluate_bool(expression, resolve)
    except CondExprError:
        return default
    except Exception:
        # A hostile resolver value (e.g. an object with a throwing __eq__) must not
        # escape either; degrade identically.
        return default
