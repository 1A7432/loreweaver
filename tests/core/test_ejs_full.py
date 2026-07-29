"""Tests for core.ejs_full: the QuickJS-sandboxed full-EJS engine (real JavaScript, the
vendored official EJS + lodash, the pure-JS ST API bridge, buffered writes, hard limits).

Skipped as a module when the `ejs` extra (quickjs) is not installed — every caller degrades
to the `core.ejs_lite` subset in that case, which has its own suite."""

from __future__ import annotations

import pytest

pytest.importorskip("quickjs")

from core.ejs_full import EjsFullError, FullEjsEngine, create_full_engine  # noqa: E402


def _engine(**overrides) -> FullEjsEngine:
    kwargs = dict(
        flat_variables={"fear": 7, "mood": "tense"},
        tree={"理": {"好感度": [33, "affinity"], "情绪": {"pleasure": 0.1}}},
        worldinfo={"chapel": "The chapel is locked at night."},
    )
    kwargs.update(overrides)
    engine = create_full_engine(**kwargs)
    assert engine is not None
    return engine


# ---------------------------------------------------------------------------
# Real-JS rendering
# ---------------------------------------------------------------------------


def test_full_javascript_renders_loops_lodash_and_await():
    result = _engine().render(
        "<% for (const i of _.range(2)) { %>[<%= i %>]<% } %>"
        "<%= await Promise.resolve('async') %>"
    )
    assert result.text == "[0][1]async"


def test_st_api_bridge_getvar_getwi_and_vwd_unwrap():
    result = _engine().render(
        "<%= getvar('fear') %>/<%= getvar('理.好感度') %>/"
        "<%= SafeGetValue(stat_data.理.好感度) %>/<%- getwi('chapel') %>"
    )
    assert result.text == "7/33/33/The chapel is locked at night."


def test_getvar_defaults_and_variables_object():
    result = _engine().render("<%= getvar('missing', {defaults: 'dflt'}) %>|<%= variables.mood %>")
    assert result.text == "dflt|tense"


def test_setvar_incvar_buffer_reads_back_in_order():
    engine = _engine()
    engine.render("<% setvar('理.好感度', 40); incvar('fear', 2); decvar('fear') %>")
    assert engine.pending_writes == [("理.好感度", 40), ("fear", 9), ("fear", 8)]


def test_activewi_and_inject_prompt_round_trip():
    engine = _engine()
    result = engine.render(
        "<% activewi('chapel'); injectPrompt('cot', 'think step by step') %>"
        "<%= getPromptsInjected('cot') %>"
    )
    assert result.text == "think step by step"
    assert engine.activated == ["chapel"]


def test_faker_is_stubbed_with_a_warning_not_a_crash():
    result = _engine().render("[<%= faker.person.firstName() %>]")
    assert result.text == "[]"
    assert any("faker" in warning for warning in result.warnings)


# ---------------------------------------------------------------------------
# Conditions (full-JS @@if / condition field)
# ---------------------------------------------------------------------------


def test_eval_condition_full_javascript():
    engine = _engine()
    assert engine.eval_condition("variables.fear >= 5") is True
    assert engine.eval_condition("stat_data.理.好感度[0] === 33") is True
    assert engine.eval_condition("[1,2,3].some(x => x > 2)") is True
    assert engine.eval_condition("getvar('mood') === 'calm'") is False
    assert engine.eval_condition("nonexistent.deep.path > 1") is None  # error → caller fails closed


# ---------------------------------------------------------------------------
# Guardrails
# ---------------------------------------------------------------------------


def test_infinite_loop_hits_the_time_limit_not_a_hang():
    with pytest.raises(EjsFullError):
        _engine().render("<% while(true){} %>")


def test_template_error_raises_for_subset_fallback():
    with pytest.raises(EjsFullError):
        _engine().render("<%= definitely_not_defined_anywhere %>")


def test_writes_are_capped():
    engine = _engine()
    engine.render("<% for (const i of _.range(200)) { setvar('k' + i, i) } %>")
    assert len(engine.pending_writes) == 64


def test_state_leaks_within_one_engine_but_engines_are_per_turn():
    engine = _engine()
    engine.render("<% define('carried', 'over') %>")
    assert engine.render("<%= carried %>").text == "over"
    assert create_full_engine(flat_variables={}, tree={}, worldinfo={}).eval_condition(
        "typeof carried === 'undefined'"
    ) is True
