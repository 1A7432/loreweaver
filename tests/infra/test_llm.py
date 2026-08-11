"""Tests for infra.llm: ToolCall/ChatResult, FakeLLM's script/responder
modes, the tool_call/assistant_tools/assistant_text test helpers, and
OpenAILLM's mapping of an OpenAI-shaped response onto those dataclasses
(the network client itself is swapped for an in-process double, per the
"no network in tests" rule).
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from infra.config import LLMSettings
from infra.i18n import t
from infra.llm import (
    ChatResult,
    FakeLLM,
    OpenAILLM,
    ToolCall,
    assistant_text,
    assistant_tools,
    tool_call,
)

# ---------------------------------------------------------------------------
# tool_call / assistant_tools / assistant_text helpers
# ---------------------------------------------------------------------------


def test_tool_call_builds_toolcall_with_arguments():
    call = tool_call("roll_dice", expression="1d20", reason="init")

    assert call.name == "roll_dice"
    assert call.arguments == {"expression": "1d20", "reason": "init"}


def test_tool_call_ids_are_unique_and_prefixed():
    first = tool_call("a")
    second = tool_call("b")

    assert first.id != second.id
    assert first.id.startswith("call_")
    assert second.id.startswith("call_")


def test_assistant_tools_has_no_content_and_lists_the_calls():
    calls = [tool_call("a"), tool_call("b")]

    result = assistant_tools(*calls)

    assert result.content is None
    assert result.tool_calls == calls


def test_assistant_text_has_text_and_no_tool_calls():
    result = assistant_text("Hello, traveler.")

    assert result.content == "Hello, traveler."
    assert result.tool_calls == []


def test_toolcall_and_chatresult_field_shapes():
    call = ToolCall(id="call_1", name="roll_dice", arguments={"expression": "1d20"})
    assert (call.id, call.name, call.arguments) == ("call_1", "roll_dice", {"expression": "1d20"})

    result = ChatResult(content="hi", tool_calls=[])
    assert result.raw is None  # default, no `raw` supplied


# ---------------------------------------------------------------------------
# FakeLLM — script mode
# ---------------------------------------------------------------------------


async def test_fakellm_script_yields_tool_calls_then_text_in_order():
    script = [
        assistant_tools(tool_call("get_module_summary")),
        assistant_text("The keeper begins the scene..."),
    ]
    llm = FakeLLM(script=script)

    first = await llm.chat([{"role": "user", "content": "begin"}])
    assert first.content is None
    assert [c.name for c in first.tool_calls] == ["get_module_summary"]

    second = await llm.chat([{"role": "user", "content": "begin"}])
    assert second.content == "The keeper begins the scene..."
    assert second.tool_calls == []


async def test_fakellm_records_messages_and_tools_per_call():
    llm = FakeLLM(script=[assistant_text("ok")])
    messages = [{"role": "user", "content": "hi"}]
    tools = [{"type": "function", "function": {"name": "noop"}}]

    await llm.chat(messages, tools=tools)

    assert llm.calls == [(messages, tools)]


async def test_fakellm_script_exhausted_raises_localized_error():
    llm = FakeLLM(script=[assistant_text("only one")])
    await llm.chat([])

    with pytest.raises(RuntimeError, match=t("infra.llm.fake_script_exhausted")):
        await llm.chat([])


async def test_fakellm_without_script_or_responder_raises_localized_error():
    llm = FakeLLM()

    with pytest.raises(RuntimeError, match=t("infra.llm.fake_not_configured")):
        await llm.chat([{"role": "user", "content": "hi"}])


# ---------------------------------------------------------------------------
# FakeLLM — responder mode
# ---------------------------------------------------------------------------


async def test_fakellm_responder_branches_on_latest_message_content():
    def responder(messages, tools):
        last = messages[-1]["content"]
        if "roll" in last:
            return assistant_tools(tool_call("roll_dice", expression="1d20"))
        return assistant_text(f"echo: {last}")

    llm = FakeLLM(responder=responder)

    rolled = await llm.chat([{"role": "user", "content": "please roll 1d20"}])
    assert [c.name for c in rolled.tool_calls] == ["roll_dice"]

    talked = await llm.chat([{"role": "user", "content": "hello there"}])
    assert talked.content == "echo: hello there"


async def test_fakellm_responder_receives_the_tools_argument():
    seen = {}

    def responder(messages, tools):
        seen["tools"] = tools
        return assistant_text("ok")

    llm = FakeLLM(responder=responder)
    tools = [{"type": "function", "function": {"name": "roll_dice"}}]

    await llm.chat([{"role": "user", "content": "hi"}], tools=tools)

    assert seen["tools"] == tools


async def test_fakellm_records_calls_across_multiple_invocations():
    llm = FakeLLM(responder=lambda messages, tools: assistant_text("ok"))

    await llm.chat([{"role": "user", "content": "one"}])
    await llm.chat([{"role": "user", "content": "two"}], tools=[{"a": 1}])

    assert llm.calls == [
        ([{"role": "user", "content": "one"}], None),
        ([{"role": "user", "content": "two"}], [{"a": 1}]),
    ]


# ---------------------------------------------------------------------------
# OpenAILLM — real implementation, `openai.AsyncOpenAI` swapped for a double
# ---------------------------------------------------------------------------


class _FakeAsyncOpenAI:
    """Stand-in for `openai.AsyncOpenAI`. Records constructor kwargs and
    exposes a `chat.completions.create` `AsyncMock` each test configures,
    so `OpenAILLM` can be exercised with zero network access."""

    def __init__(self, **kwargs) -> None:
        self.init_kwargs = kwargs
        self.create = AsyncMock()
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))


@pytest.fixture
def fake_async_openai(monkeypatch):
    monkeypatch.setattr("infra.llm.AsyncOpenAI", _FakeAsyncOpenAI)


def _fake_response(*, content=None, tool_calls=None):
    message = SimpleNamespace(content=content, tool_calls=tool_calls)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def _fake_tool_call(call_id, name, arguments):
    return SimpleNamespace(id=call_id, function=SimpleNamespace(name=name, arguments=arguments))


def test_openaillm_forwards_api_key_and_base_url_to_the_client(fake_async_openai):
    settings = LLMSettings(api_key="sk-test", base_url="https://api.deepseek.com/v1")

    llm = OpenAILLM(settings)

    assert llm._client.init_kwargs == {"api_key": "sk-test", "base_url": "https://api.deepseek.com/v1"}


async def test_openaillm_maps_text_only_response(fake_async_openai):
    llm = OpenAILLM(LLMSettings(api_key="sk-test"))
    llm._client.create.return_value = _fake_response(content="Roll for it.")

    result = await llm.chat([{"role": "user", "content": "hi"}])

    assert result.content == "Roll for it."
    assert result.tool_calls == []


async def test_openaillm_maps_tool_calls_with_json_parsed_arguments(fake_async_openai):
    llm = OpenAILLM(LLMSettings(api_key="sk-test"))
    raw_call = _fake_tool_call("call_abc", "roll_dice", '{"expression": "1d20"}')
    llm._client.create.return_value = _fake_response(content=None, tool_calls=[raw_call])

    result = await llm.chat([{"role": "user", "content": "roll it"}])

    assert result.content is None
    assert result.tool_calls == [ToolCall(id="call_abc", name="roll_dice", arguments={"expression": "1d20"})]


async def test_openaillm_tolerates_malformed_tool_arguments_json(fake_async_openai):
    llm = OpenAILLM(LLMSettings(api_key="sk-test"))
    raw_call = _fake_tool_call("call_bad", "roll_dice", "{not valid json")
    llm._client.create.return_value = _fake_response(tool_calls=[raw_call])

    result = await llm.chat([{"role": "user", "content": "roll it"}])

    assert result.tool_calls == [ToolCall(id="call_bad", name="roll_dice", arguments={})]


async def test_openaillm_no_choices_returns_empty_result(fake_async_openai):
    llm = OpenAILLM(LLMSettings(api_key="sk-test"))
    llm._client.create.return_value = SimpleNamespace(choices=[])

    result = await llm.chat([{"role": "user", "content": "hi"}])

    assert result.content is None
    assert result.tool_calls == []
    assert result.raw is not None


async def test_openaillm_passes_model_tools_tool_choice_and_default_temperature(fake_async_openai):
    llm = OpenAILLM(LLMSettings(api_key="sk-test", chat_model="gpt-4o-mini", temperature=0.42))
    llm._client.create.return_value = _fake_response(content="ok")
    tools = [{"type": "function", "function": {"name": "roll_dice"}}]

    await llm.chat([{"role": "user", "content": "hi"}], tools=tools, tool_choice="auto")

    kwargs = llm._client.create.call_args.kwargs
    assert kwargs["model"] == "gpt-4o-mini"
    assert kwargs["tools"] == tools
    assert kwargs["tool_choice"] == "auto"
    assert kwargs["temperature"] == 0.42  # falls back to settings.llm.temperature


async def test_openaillm_explicit_model_and_temperature_override_settings(fake_async_openai):
    llm = OpenAILLM(LLMSettings(api_key="sk-test", chat_model="gpt-4o-mini", temperature=0.42))
    llm._client.create.return_value = _fake_response(content="ok")

    await llm.chat([{"role": "user", "content": "hi"}], model="deepseek-chat", temperature=0.0)

    kwargs = llm._client.create.call_args.kwargs
    assert kwargs["model"] == "deepseek-chat"
    assert kwargs["temperature"] == 0.0  # explicit 0.0 must survive (not treated as falsy-missing)


async def test_openaillm_omits_tools_and_tool_choice_when_not_supplied(fake_async_openai):
    llm = OpenAILLM(LLMSettings(api_key="sk-test"))
    llm._client.create.return_value = _fake_response(content="ok")

    await llm.chat([{"role": "user", "content": "hi"}])

    kwargs = llm._client.create.call_args.kwargs
    assert "tools" not in kwargs
    assert "tool_choice" not in kwargs


# ---------------------------------------------------------------------------
# OpenAILLM — the STREAMING path and its token accounting
#
# A streamed turn is what a real table always runs (`agent.loop` passes an
# `on_text_delta` on the KP's reply call), so whatever this path reports IS the
# room's usage meter — and that meter is the chronicle fold's trigger, not a
# status-bar ornament. It used to report nothing at all.
# ---------------------------------------------------------------------------


class _FakeStream:
    """An `AsyncStream` stand-in: yields the chunks a vendor would send, in order."""

    def __init__(self, chunks: list) -> None:
        self._chunks = chunks

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk


def _delta_chunk(text: str):
    """One ordinary streamed chunk. `usage` is absent, as it is on every chunk but
    the last (DeepSeek documents sending it as an explicit null)."""
    return SimpleNamespace(
        choices=[SimpleNamespace(delta=SimpleNamespace(content=text, tool_calls=None))],
        usage=None,
    )


def _usage_chunk(prompt: int, completion: int):
    """The extra final chunk `stream_options.include_usage` buys: no choices at all,
    and the whole request's usage."""
    return SimpleNamespace(
        choices=[],
        usage=SimpleNamespace(prompt_tokens=prompt, completion_tokens=completion, total_tokens=prompt + completion),
    )


async def test_a_streamed_turn_asks_for_usage_and_reads_the_final_chunk(fake_async_openai):
    """The fix, end to end at the client: ask, then read the answer.

    The usage-bearing chunk is precisely the one with an EMPTY `choices` list, which
    the delta loop skips — so parsing it has to happen before that guard, or the
    parameter is requested and its answer discarded.
    """
    llm = OpenAILLM(LLMSettings(api_key="sk-test"))
    llm._client.create.return_value = _FakeStream(
        [_delta_chunk("The door "), _delta_chunk("creaks open."), _usage_chunk(1200, 80)]
    )
    seen: list[str] = []

    result = await llm.chat([{"role": "user", "content": "hi"}], on_text_delta=seen.append)

    assert llm._client.create.call_args.kwargs["stream_options"] == {"include_usage": True}
    assert seen == ["The door ", "creaks open."]
    assert result.content == "The door creaks open."
    assert result.usage is not None
    assert (result.usage.prompt_tokens, result.usage.completion_tokens) == (1200, 80)
    assert result.usage.estimated is False, "a provider-reported count is measured, never estimated"


async def test_a_vendor_that_repeats_a_cumulative_usage_reports_its_final_figure(fake_async_openai):
    """Some endpoints put a running usage on every chunk instead of one final chunk.
    Last non-empty parse wins, so the figure that lands is the complete one."""
    llm = OpenAILLM(LLMSettings(api_key="sk-test"))
    partial = SimpleNamespace(
        choices=[SimpleNamespace(delta=SimpleNamespace(content="hi", tool_calls=None))],
        usage=SimpleNamespace(prompt_tokens=1200, completion_tokens=5, total_tokens=1205),
    )
    llm._client.create.return_value = _FakeStream([partial, _usage_chunk(1200, 80)])

    result = await llm.chat([{"role": "user", "content": "hi"}], on_text_delta=lambda _text: None)

    assert result.usage.completion_tokens == 80


async def test_an_endpoint_that_never_reports_usage_still_completes_the_turn(fake_async_openai):
    """The graceful degradation. A vendor that ignores the parameter simply sends no
    usage chunk: the reply and its tool calls are unaffected, `usage` stays None, and
    `agent.loop` meters the turn with an estimate instead (tests/agent/test_loop.py)."""
    llm = OpenAILLM(LLMSettings(api_key="sk-test"))
    llm._client.create.return_value = _FakeStream([_delta_chunk("The door creaks open.")])

    result = await llm.chat([{"role": "user", "content": "hi"}], on_text_delta=lambda _text: None)

    assert result.content == "The door creaks open."
    assert result.usage is None


async def test_the_operator_can_stop_asking_for_usage(fake_async_openai):
    """The escape hatch for an endpoint that rejects unknown request parameters, in
    the shape `TRPG_LLM__CONTEXT_WINDOW` already uses: static operator config, because
    which parameters an endpoint accepts is a property of the endpoint, not something
    to rediscover at runtime on every room's turn."""
    llm = OpenAILLM(LLMSettings(api_key="sk-test", stream_usage=False))
    llm._client.create.return_value = _FakeStream([_delta_chunk("ok")])

    result = await llm.chat([{"role": "user", "content": "hi"}], on_text_delta=lambda _text: None)

    assert "stream_options" not in llm._client.create.call_args.kwargs
    assert result.content == "ok"


async def test_a_non_streaming_call_never_sends_stream_options(fake_async_openai):
    llm = OpenAILLM(LLMSettings(api_key="sk-test"))
    llm._client.create.return_value = _fake_response(content="ok")

    await llm.chat([{"role": "user", "content": "hi"}])

    kwargs = llm._client.create.call_args.kwargs
    assert "stream_options" not in kwargs and "stream" not in kwargs


async def test_streamed_tool_calls_are_still_reassembled_alongside_the_usage(fake_async_openai):
    """Guard on the ordering change: usage parsing sits in front of the delta loop, so
    the indexed tool-call fragments must still reassemble exactly as before."""
    llm = OpenAILLM(LLMSettings(api_key="sk-test"))
    first = SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(
                    content=None,
                    tool_calls=[
                        SimpleNamespace(
                            index=0, id="call_1", function=SimpleNamespace(name="roll_dice", arguments='{"expr')
                        )
                    ],
                )
            )
        ],
        usage=None,
    )
    second = SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(
                    content=None,
                    tool_calls=[
                        SimpleNamespace(index=0, id=None, function=SimpleNamespace(name=None, arguments='ession":"1d20"}'))
                    ],
                )
            )
        ],
        usage=None,
    )
    llm._client.create.return_value = _FakeStream([first, second, _usage_chunk(300, 10)])

    result = await llm.chat([{"role": "user", "content": "roll"}], on_text_delta=lambda _text: None)

    assert result.tool_calls == [ToolCall(id="call_1", name="roll_dice", arguments={"expression": "1d20"})]
    assert result.usage.prompt_tokens == 300
