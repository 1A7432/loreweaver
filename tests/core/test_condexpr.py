"""Tests for core.condexpr: the safe JS-flavored condition-expression evaluator."""

from __future__ import annotations

import pytest

from core.condexpr import CondExprError, evaluate, evaluate_bool, evaluate_safe, truthy


def _resolver(values: dict):
    return lambda path: values.get(path)


# ---------------------------------------------------------------------------
# Literals, references, paths
# ---------------------------------------------------------------------------


def test_literals():
    resolve = _resolver({})
    assert evaluate("42", resolve) == 42
    assert evaluate("3.5", resolve) == 3.5
    assert evaluate("'hello'", resolve) == "hello"
    assert evaluate('"double"', resolve) == "double"
    assert evaluate("true", resolve) is True
    assert evaluate("false", resolve) is False
    assert evaluate("null", resolve) is None


def test_bare_and_dotted_paths_resolve():
    resolve = _resolver({"town_fear": 7, "理.好感度": 33})
    assert evaluate("town_fear", resolve) == 7
    assert evaluate("理.好感度", resolve) == 33


def test_variables_and_stat_data_roots_pass_through():
    seen = []

    def resolve(path):
        seen.append(path)
        return 2

    assert evaluate("variables.stage", resolve) == 2
    assert evaluate("stat_data.理.情绪", resolve) == 2
    assert seen == ["variables.stage", "stat_data.理.情绪"]


def test_bracket_segments_fold_into_the_path():
    resolve = _resolver({"party.0.hp": 12, "a.key": "x"})
    assert evaluate("party[0].hp", resolve) == 12
    assert evaluate("a['key']", resolve) == "x"


def test_getvar_with_ignored_extra_args():
    resolve = _resolver({"好感度": 60})
    assert evaluate("getvar('好感度')", resolve) == 60
    assert evaluate("getvar('好感度', 0)", resolve) == 60
    with pytest.raises(CondExprError):
        evaluate("getvar(affection)", resolve)


# ---------------------------------------------------------------------------
# Comparison semantics
# ---------------------------------------------------------------------------


def test_loose_equality_coerces_numeric_strings():
    resolve = _resolver({"x": "5"})
    assert evaluate_bool("x == 5", resolve) is True
    assert evaluate_bool("x != 5", resolve) is False


def test_strict_equality_does_not_coerce():
    resolve = _resolver({"x": "5", "y": 5})
    assert evaluate_bool("x === 5", resolve) is False
    assert evaluate_bool("y === 5", resolve) is True
    assert evaluate_bool("x !== 5", resolve) is True
    assert evaluate_bool("true === 1", resolve) is False  # bool is not the same type as int


def test_ordering_numbers_and_numeric_strings():
    resolve = _resolver({"fear": "7"})
    assert evaluate_bool("fear >= 5", resolve) is True
    assert evaluate_bool("fear < 5", resolve) is False
    assert evaluate_bool("'apple' < 'banana'", resolve) is True


def test_ordering_incomparable_raises():
    with pytest.raises(CondExprError):
        evaluate("'apple' > 5", _resolver({}))


# ---------------------------------------------------------------------------
# Boolean operators + short-circuit
# ---------------------------------------------------------------------------


def test_and_or_not_including_word_forms():
    resolve = _resolver({"a": 1, "b": 0})
    assert evaluate_bool("a && !b", resolve) is True
    assert evaluate_bool("a and not b", resolve) is True
    assert evaluate_bool("b || a", resolve) is True
    assert evaluate_bool("b or b", resolve) is False


def test_short_circuit_does_not_resolve_the_skipped_side():
    calls = []

    def resolve(path):
        calls.append(path)
        return path == "a"

    assert evaluate_bool("a || boom", resolve) is True
    assert evaluate_bool("!a && boom", resolve) is False
    assert "boom" not in calls


# ---------------------------------------------------------------------------
# Arithmetic
# ---------------------------------------------------------------------------


def test_arithmetic_and_string_concat():
    resolve = _resolver({"x": 4})
    assert evaluate("x * 2 + 1", resolve) == 9
    assert evaluate("(x + 1) % 3", resolve) == 2
    assert evaluate("-x", resolve) == -4
    assert evaluate("'a' + 'b'", resolve) == "ab"


def test_division_by_zero_raises():
    with pytest.raises(CondExprError):
        evaluate("1 / 0", _resolver({}))


# ---------------------------------------------------------------------------
# Truthiness + errors + safe wrapper
# ---------------------------------------------------------------------------


def test_truthiness_is_js_ish():
    assert truthy(0) is False
    assert truthy("") is False
    assert truthy(None) is False
    assert truthy([]) is False
    assert truthy([1]) is True
    assert truthy("no") is True


def test_error_forms():
    resolve = _resolver({})
    for bad in ("'unterminated", "1 2", "&& 1", "a ~ b", "", "getvar('x'"):
        with pytest.raises(CondExprError):
            evaluate(bad, resolve)
    with pytest.raises(CondExprError):
        evaluate("x " * 300, resolve)  # token cap
    with pytest.raises(CondExprError):
        evaluate("1 + " * 200 + "1", resolve)  # length cap


def test_evaluate_safe_degrades_to_default():
    resolve = _resolver({})
    assert evaluate_safe("1 /", resolve) is False
    assert evaluate_safe("1 /", resolve, default=True) is True

    def hostile(_path):
        raise RuntimeError("boom")

    assert evaluate_safe("x > 1", hostile) is False
