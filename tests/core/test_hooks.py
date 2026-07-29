"""Tests for core.hooks: the sandboxed event-hook engine (registration, dispatch, effect
buffers, guardrails). Skipped as a module when the `ejs` extra (quickjs) is not installed —
without it the hook layer is inert by design."""

from __future__ import annotations

import pytest

pytest.importorskip("quickjs")

from core.hooks import HookScript, create_hook_engine  # noqa: E402


def _engine(code: str, *, flat=None, tree=None, scripts=None):
    scripts = scripts or [HookScript(source_id="test", code=code)]
    engine = create_hook_engine(scripts, flat_variables=flat or {}, tree=tree or {})
    assert engine is not None
    return engine


def test_no_scripts_means_no_engine():
    assert create_hook_engine([], flat_variables={}, tree={}) is None


def test_handler_registration_and_payload_dispatch():
    engine = _engine("on('turn_start', (event) => { narrate('saw: ' + event.user_message); });")
    outcome = engine.fire("turn_start", {"user_message": "hello"})
    assert outcome.handlers == 1
    assert outcome.narrations == ["saw: hello"]


def test_writes_buffer_through_the_bridge_and_read_variables():
    engine = _engine(
        "on('turn_start', () => { if (getvar('fear') >= 5) setvar('stage', 2); });",
        flat={"fear": 7},
    )
    outcome = engine.fire("turn_start", {})
    assert outcome.writes == [("stage", 2)]


def test_inject_and_rewrite_and_log():
    engine = _engine(
        "on('turn_start', () => inject('the bells toll'));"
        "on('reply_ready', (event) => { rewriteReply(event.reply + '!'); log('done'); });"
    )
    start = engine.fire("turn_start", {})
    assert start.injections == ["the bells toll"]
    ready = engine.fire("reply_ready", {"reply": "Night falls"})
    assert ready.rewrite == "Night falls!"
    assert any("log: done" in warning for warning in ready.warnings)


def test_effect_buffers_are_isolated_per_fire():
    engine = _engine("on('turn_start', () => narrate('once'));")
    assert engine.fire("turn_start", {}).narrations == ["once"]
    assert engine.fire("reply_ready", {"reply": ""}).narrations == []


def test_handler_error_is_tolerated_and_reported():
    engine = _engine(
        "on('turn_start', () => { throw new Error('boom'); });"
        "on('turn_start', () => narrate('still ran'));"
    )
    outcome = engine.fire("turn_start", {})
    assert outcome.narrations == ["still ran"]
    assert any("boom" in warning for warning in outcome.warnings)


def test_infinite_loop_in_registration_is_capped_not_a_hang():
    engine = create_hook_engine(
        [HookScript(source_id="evil", code="while(true){}")], flat_variables={}, tree={}
    )
    assert engine is not None
    assert any("evil" in warning for warning in engine.load_warnings)
    assert engine.fire("turn_start", {}).handlers == 0


def test_infinite_loop_in_a_handler_is_capped_not_a_hang():
    engine = _engine("on('turn_start', () => { while(true){} });")
    outcome = engine.fire("turn_start", {})
    assert any("dispatch failed" in warning or "error" in warning for warning in outcome.warnings)


def test_unknown_event_and_lodash_availability():
    engine = _engine("on('turn_start', () => narrate(_.range(3).join('-')));")
    assert engine.fire("bogus_event", {}).warnings
    assert engine.fire("turn_start", {}).narrations == ["0-1-2"]


def test_multiple_scripts_share_the_room_but_broken_one_is_skipped():
    engine = create_hook_engine(
        [
            HookScript(source_id="a", code="on('turn_start', () => narrate('A'));"),
            HookScript(source_id="broken", code="this is not javascript ((("),
            HookScript(source_id="b", code="on('turn_start', () => narrate('B'));"),
        ],
        flat_variables={},
        tree={},
    )
    assert engine is not None
    assert any("broken" in warning for warning in engine.load_warnings)
    assert engine.fire("turn_start", {}).narrations == ["A", "B"]
