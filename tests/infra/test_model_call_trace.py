"""`infra.model_call_trace` — one probe row per LOGICAL model call, named by its lane.

The local run-3 play-test (2026-08-21) could recover per-call latency only from the
gaps between tool clusters in the tool trace, and the session's 46% cache-hit figure
was every lane summed together. These pin the shape that answers "where did the time
go": the retry wrapper measures the whole span (retries included), the row carries the
lane the ASSEMBLER declared, nested scopes restore the outer one, and without a sink
the whole thing is inert.
"""

from __future__ import annotations

import pytest

from infra import model_call_trace as trace
from infra.llm import ChatResult, FakeLLM, Usage, assistant_text
from infra.llm_retry import RetryingLLM


@pytest.fixture
def rows():
    captured: list[dict] = []
    trace.set_sink(captured.append)
    try:
        yield captured
    finally:
        trace.set_sink(None)


async def _no_sleep(_delay: float) -> None:
    return None


async def test_a_call_inside_a_lane_scope_is_recorded_with_its_lane_and_fields(rows):
    llm = RetryingLLM(FakeLLM(script=[assistant_text("hi")]), sleep=_no_sleep)

    with trace.lane_scope("keeper", chat_key="room-1", round=2, nothing=None):
        await llm.chat([{"role": "user", "content": "x"}])

    assert len(rows) == 1
    row = rows[0]
    assert row["lane"] == "keeper" and row["chat_key"] == "room-1" and row["round"] == 2
    assert "nothing" not in row, "None-valued fields are dropped, not written as null"
    assert row["attempts"] == 1 and row["ms"] >= 0
    assert "error" not in row


async def test_usage_rides_the_row_when_the_provider_reported_it(rows):
    usage = Usage(prompt_tokens=1200, completion_tokens=40, cache_hit_tokens=1000, cache_miss_tokens=200)
    llm = RetryingLLM(FakeLLM(script=[ChatResult(content="ok", tool_calls=[], usage=usage)]), sleep=_no_sleep)

    with trace.lane_scope("npc", npc="lao-kuai"):
        await llm.chat([{"role": "user", "content": "x"}], model="fast-model")

    row = rows[0]
    assert row["lane"] == "npc" and row["npc"] == "lao-kuai" and row["model"] == "fast-model"
    assert (row["prompt_tokens"], row["completion_tokens"]) == (1200, 40)
    assert (row["cache_hit_tokens"], row["cache_miss_tokens"]) == (1000, 200)


async def test_retries_are_one_logical_call_with_the_attempt_count(rows):
    class Throttled(RuntimeError):
        status_code = 429

    calls = {"n": 0}

    def responder(messages, tools):
        calls["n"] += 1
        if calls["n"] < 3:
            raise Throttled("rate limit")
        return assistant_text("finally")

    llm = RetryingLLM(FakeLLM(responder=responder), sleep=_no_sleep)
    with trace.lane_scope("scribe"):
        result = await llm.chat([{"role": "user", "content": "x"}])

    assert result.content == "finally"
    assert len(rows) == 1, "three HTTP attempts, one logical call, one row"
    assert rows[0]["attempts"] == 3 and rows[0]["lane"] == "scribe"


async def test_a_terminal_failure_is_recorded_by_class_and_status_never_by_text(rows):
    """A provider's 401/403 body routinely quotes the key it rejected. The row keeps what
    an operator needs to attribute the failure — the exception class and the HTTP status —
    and nothing of the message, so the probe file never becomes a second place a
    credential lives."""

    class Unauthorized(RuntimeError):
        status_code = 401

    def responder(messages, tools):
        raise Unauthorized("Incorrect API key provided: sk-live-ABCDEF0123456789")

    llm = RetryingLLM(FakeLLM(responder=responder), sleep=_no_sleep)
    with trace.lane_scope("director"), pytest.raises(Unauthorized):
        await llm.chat([{"role": "user", "content": "x"}])

    row = rows[0]
    assert row["error"] == "Unauthorized" and row["status"] == 401
    assert row["attempts"] == 1 and row["lane"] == "director"
    assert "error_text" not in row
    assert "sk-live" not in repr(row), "the message text — and the key in it — never reaches the row"


async def test_nested_scopes_restore_the_outer_lane(rows):
    llm = RetryingLLM(FakeLLM(script=[assistant_text("a"), assistant_text("b"), assistant_text("c")]), sleep=_no_sleep)

    with trace.lane_scope("keeper", chat_key="r", round=1):
        await llm.chat([{"role": "user", "content": "1"}])
        with trace.lane_scope("npc", npc="x"):
            await llm.chat([{"role": "user", "content": "2"}])
        trace.set_lane_field(round=2)
        await llm.chat([{"role": "user", "content": "3"}])

    assert [(r["lane"], r.get("round")) for r in rows] == [("keeper", 1), ("npc", None), ("keeper", 2)]
    assert rows[1].get("chat_key") is None, "an inner scope is its own dict, not the outer one plus a lane"
    assert trace.current_lane() == {}


async def test_without_a_sink_nothing_is_recorded_and_nothing_breaks():
    trace.set_sink(None)
    llm = RetryingLLM(FakeLLM(script=[assistant_text("hi")]), sleep=_no_sleep)
    with trace.lane_scope("keeper"):
        result = await llm.chat([{"role": "user", "content": "x"}])
    assert result.content == "hi"
    assert not trace.sink_installed()


async def test_a_sink_that_throws_never_reaches_the_caller():
    def bad_sink(_payload):
        raise RuntimeError("probe disk full")

    trace.set_sink(bad_sink)
    try:
        llm = RetryingLLM(FakeLLM(script=[assistant_text("hi")]), sleep=_no_sleep)
        result = await llm.chat([{"role": "user", "content": "x"}])
        assert result.content == "hi"
    finally:
        trace.set_sink(None)
