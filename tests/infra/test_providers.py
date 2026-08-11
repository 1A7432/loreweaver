from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from infra.config import LLMSettings, Settings
from infra.llm import OpenAILLM, ToolCall
from infra.providers import (
    PRESETS,
    AnthropicLLM,
    GeminiLLM,
    MutableLLM,
    anthropic_accepts_temperature,
    build_llm,
    from_anthropic_response,
    from_gemini_response,
    is_known_provider,
    list_models,
    sanitize_gemini_tool_parameters,
    to_anthropic_messages,
    to_anthropic_tools,
    to_gemini_tools,
)


class _FakeAsyncOpenAI:
    def __init__(self, **kwargs) -> None:
        self.init_kwargs = kwargs
        self.create = AsyncMock()
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))


def _settings(provider: str, *, base_url: str = "") -> Settings:
    return Settings(llm=LLMSettings(provider=provider, api_key="sk-test", base_url=base_url))


def test_build_llm_selects_openai_default(monkeypatch):
    monkeypatch.setattr("infra.llm.AsyncOpenAI", _FakeAsyncOpenAI)

    llm = build_llm(_settings("openai"))

    assert isinstance(llm.inner, OpenAILLM)
    assert llm._client.init_kwargs["base_url"] is None


def test_build_llm_selects_openai_compatible_preset(monkeypatch):
    monkeypatch.setattr("infra.llm.AsyncOpenAI", _FakeAsyncOpenAI)

    llm = build_llm(_settings("deepseek"))

    assert isinstance(llm.inner, OpenAILLM)
    assert llm._client.init_kwargs["base_url"] == PRESETS["deepseek"]


def test_build_llm_explicit_base_url_overrides_preset(monkeypatch):
    monkeypatch.setattr("infra.llm.AsyncOpenAI", _FakeAsyncOpenAI)

    llm = build_llm(_settings("deepseek", base_url="https://example.test/v1"))

    assert isinstance(llm.inner, OpenAILLM)
    assert llm._client.init_kwargs["base_url"] == "https://example.test/v1"


def test_build_llm_selects_chatgpt_subscription_proxy_with_explicit_base_url(monkeypatch):
    monkeypatch.setattr("infra.llm.AsyncOpenAI", _FakeAsyncOpenAI)

    llm = build_llm(_settings("gpt-subscription", base_url="https://proxy.example/v1"))

    assert is_known_provider("gpt-subscription")
    assert is_known_provider("chatgpt")
    assert isinstance(llm.inner, OpenAILLM)
    assert llm._client.init_kwargs["base_url"] == "https://proxy.example/v1"


def test_openai_compat_client_never_borrows_ambient_openai_key(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "ambient-must-not-leak")
    monkeypatch.setattr("infra.llm.AsyncOpenAI", _FakeAsyncOpenAI)

    llm = build_llm(
        Settings(
            llm=LLMSettings(
                provider="chatgpt",
                api_key="",
                base_url="https://proxy.example/v1",
            )
        )
    )

    assert isinstance(llm.inner, OpenAILLM)
    assert llm._client.init_kwargs["api_key"] == "missing"


def test_build_llm_chatgpt_without_base_url_requires_subscription_login(monkeypatch):
    monkeypatch.setattr("infra.llm.AsyncOpenAI", _FakeAsyncOpenAI)

    # Without credentials / prior `.model login`, the official OAuth path refuses to build.
    with pytest.raises(ValueError, match="subscription_login_required"):
        build_llm(_settings("gpt-subscription"))


async def test_list_models_does_not_construct_client_for_subscription_providers(monkeypatch):
    calls = []

    def _unexpected_client(**kwargs):
        calls.append(kwargs)
        raise AssertionError("AsyncOpenAI must not be constructed")

    monkeypatch.setenv("OPENAI_API_KEY", "ambient-secret")
    monkeypatch.setattr("openai.AsyncOpenAI", _unexpected_client)

    assert await list_models(
        LLMSettings(
            provider="supergrok",
            api_key="",
            base_url="https://stale-proxy.example/v1",
        )
    ) == []
    assert await list_models(LLMSettings(provider="chatgpt", api_key="", base_url="")) == []
    assert calls == []


async def test_list_models_never_raises_when_client_construction_fails(monkeypatch):
    def _broken_client(**_kwargs):
        raise ValueError("malformed base URL")

    monkeypatch.setattr("openai.AsyncOpenAI", _broken_client)

    models = await list_models(
        LLMSettings(provider="openai", api_key="sk-test", base_url="not-a-url")
    )

    assert models == []


def test_mutable_llm_does_not_retry_internal_builder_type_error():
    calls = 0

    def broken_builder(_settings, *, credentials=None):
        nonlocal calls
        calls += 1
        raise TypeError("builder implementation failed")

    with pytest.raises(TypeError, match="implementation failed"):
        MutableLLM(_settings("openai"), builder=broken_builder)

    assert calls == 1


def test_mutable_llm_reports_when_offline_fallback_is_live():
    fallback = object()
    built = object()
    settings = Settings(llm=LLMSettings(provider="openai", api_key=""))
    llm = MutableLLM(settings, builder=lambda _settings: built, fallback_llm=fallback)

    assert llm.inner is fallback
    assert llm.using_fallback is True

    llm.apply({"provider": "deepseek", "api_key": "sk-test"})
    assert llm.inner is built
    assert llm.using_fallback is False

    llm.apply({})
    assert llm.inner is fallback
    assert llm.using_fallback is True


def _builder_failing_for(bad_provider: str, built=None):
    """A builder that fails for one provider (its optional SDK/env 'missing')
    and returns `built` for anything else."""

    def build(settings):
        if (settings.llm.provider or "").lower() == bad_provider:
            raise ValueError(f"{bad_provider} SDK missing")
        return built

    return build


def test_mutable_llm_degrades_to_fallback_when_the_baseline_build_fails():
    # `is_llm_configured` only checks that a key is PRESENT, so a provider can look
    # configured and still fail to construct (optional SDK never installed, proxy env
    # httpx can't honor, malformed base_url). Raising here takes the whole server down
    # -- including `.model set`, the one interface that could repair the config.
    fallback = object()

    llm = MutableLLM(
        _settings("anthropic"),
        builder=_builder_failing_for("anthropic"),
        fallback_llm=fallback,
    )

    assert llm.inner is fallback
    assert llm.using_fallback is True


def test_mutable_llm_reraises_baseline_build_failure_when_there_is_no_fallback():
    # Nothing to degrade to -- the original error must still surface unchanged.
    with pytest.raises(ValueError, match="anthropic SDK missing"):
        MutableLLM(_settings("anthropic"), builder=_builder_failing_for("anthropic"))


def test_reconfigure_still_raises_on_build_failure_even_when_a_fallback_exists():
    # Regression guard: the degradation above is BOOT-ONLY. `.model set` has an operator
    # waiting on a result, so a failed switch must surface. Silently serving demo replies
    # under a provider the keeper believes is live would be worse than refusing the switch.
    good = object()
    llm = MutableLLM(
        _settings("openai"),
        builder=_builder_failing_for("anthropic", built=good),
        fallback_llm=object(),
    )
    assert llm.inner is good

    with pytest.raises(ValueError, match="anthropic SDK missing"):
        llm.apply({"provider": "anthropic", "chat_model": "claude-x"})

    assert llm.inner is good  # live client never swapped
    assert llm.settings.llm.provider == "openai"  # shared settings never mutated


def test_build_llm_selects_anthropic(monkeypatch):
    class FakeAnthropic:
        def __init__(self, **kwargs) -> None:
            self.kwargs = kwargs

    monkeypatch.setattr("anthropic.AsyncAnthropic", FakeAnthropic)

    llm = build_llm(_settings("anthropic"))

    assert isinstance(llm.inner, AnthropicLLM)


def test_build_llm_selects_gemini(monkeypatch):
    class FakeGenAIClient:
        def __init__(self, **kwargs) -> None:
            self.kwargs = kwargs

    monkeypatch.setattr("google.genai.Client", FakeGenAIClient)

    llm = build_llm(_settings("gemini"))

    assert isinstance(llm.inner, GeminiLLM)


def test_to_anthropic_messages_maps_system_text_tool_use_and_tool_result():
    messages = [
        {"role": "system", "content": "You are KP."},
        {"role": "user", "content": "roll"},
        {
            "role": "assistant",
            "content": "checking",
            "tool_calls": [
                {
                    "id": "call_1",
                    "function": {"name": "roll_dice", "arguments": '{"expression": "1d20"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": "17"},
    ]

    system, converted = to_anthropic_messages(messages)

    assert system == "You are KP."
    assert converted[0] == {"role": "user", "content": "roll"}
    assert converted[1]["role"] == "assistant"
    assert converted[1]["content"][1] == {
        "type": "tool_use",
        "id": "call_1",
        "name": "roll_dice",
        "input": {"expression": "1d20"},
    }
    assert converted[2] == {
        "role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "call_1", "content": "17"}],
    }


def test_to_anthropic_tools_maps_openai_function_tools():
    tools = [
        {
            "type": "function",
            "function": {
                "name": "roll_dice",
                "description": "Roll dice",
                "parameters": {"type": "object", "properties": {"expression": {"type": "string"}}},
            },
        }
    ]

    assert to_anthropic_tools(tools) == [
        {
            "name": "roll_dice",
            "description": "Roll dice",
            "input_schema": {"type": "object", "properties": {"expression": {"type": "string"}}},
        }
    ]


def test_from_anthropic_response_maps_text_and_tool_use_blocks():
    response = SimpleNamespace(
        content=[
            SimpleNamespace(type="text", text="Need a roll."),
            SimpleNamespace(type="tool_use", id="toolu_1", name="roll_dice", input={"expression": "1d20"}),
        ]
    )

    result = from_anthropic_response(response)

    assert result.content == "Need a roll."
    assert result.tool_calls == [ToolCall(id="toolu_1", name="roll_dice", arguments={"expression": "1d20"})]
    assert result.raw is response


async def test_anthropic_chat_uses_fake_client_without_network():
    fake_client = SimpleNamespace(messages=SimpleNamespace(create=AsyncMock()))
    fake_client.messages.create.return_value = SimpleNamespace(
        content=[SimpleNamespace(type="tool_use", id="toolu_1", name="roll_dice", input={"expression": "1d20"})]
    )
    llm = AnthropicLLM(LLMSettings(api_key="sk-test", chat_model="claude-test"), client=fake_client)

    result = await llm.chat([{"role": "user", "content": "roll"}])

    assert fake_client.messages.create.call_args.kwargs["model"] == "claude-test"
    assert result.tool_calls == [ToolCall(id="toolu_1", name="roll_dice", arguments={"expression": "1d20"})]


@pytest.mark.parametrize(
    ("model", "accepted"),
    [
        ("claude-opus-4-6", True),
        ("claude-sonnet-4-6", True),
        ("claude-haiku-4-5", True),
        ("claude-opus-4-7", False),
        ("claude-opus-4-8", False),
        ("claude-sonnet-5", False),
        ("claude-fable-5", False),
        ("claude-mythos-5", False),
        ("CLAUDE-OPUS-4-8", False),  # case-insensitive
        ("anthropic.claude-opus-4-8", False),  # Bedrock-prefixed id
        ("", True),  # unknown/empty: don't silently drop a caller's temperature
    ],
)
def test_anthropic_accepts_temperature_matches_models_that_removed_sampling_params(model, accepted):
    assert anthropic_accepts_temperature(model) is accepted


async def _anthropic_chat_kwargs(chat_model: str, temperature: float) -> dict:
    fake_client = SimpleNamespace(messages=SimpleNamespace(create=AsyncMock()))
    fake_client.messages.create.return_value = SimpleNamespace(content=[SimpleNamespace(type="text", text="ok")])
    llm = AnthropicLLM(LLMSettings(api_key="sk-test", chat_model=chat_model), client=fake_client)

    await llm.chat([{"role": "user", "content": "roll"}], temperature=temperature)

    return fake_client.messages.create.call_args.kwargs


async def test_anthropic_chat_drops_temperature_on_models_that_reject_it():
    # Opus 4.7+ removed the sampling params -- sending one is a 400, so a caller
    # that hand-tunes temperature (scripts/playtest.py, scripts/longrun.py) must
    # not be able to break every request just by picking a newer model.
    kwargs = await _anthropic_chat_kwargs("claude-opus-4-8", 0.9)

    assert "temperature" not in kwargs


async def test_anthropic_chat_keeps_temperature_on_models_that_accept_it():
    kwargs = await _anthropic_chat_kwargs("claude-opus-4-6", 0.9)

    assert kwargs["temperature"] == 0.9


def test_anthropic_base_url_drops_openai_style_v1_suffix():
    # The anthropic SDK appends /v1/messages itself; an OpenAI-convention base_url
    # ending in /v1 would otherwise request /v1/v1/messages and 404.
    llm = AnthropicLLM(LLMSettings(api_key="sk-test", base_url="https://proxy.example/claude/v1"))
    assert str(llm._client.base_url).rstrip("/") == "https://proxy.example/claude"


class _FakeAnthropicStream:
    """Captures messages.stream(**kwargs) the way the SDK's context manager works.

    `events` feeds the `async for` the adapter runs when a caller supplied an
    `on_text_delta`; `get_final_message` returns the accumulated Message the real
    SDK builds from those same events (usage included — see the streaming-usage
    test below for why that matters)."""

    def __init__(self, holder: dict, message: Any, events: tuple[Any, ...] = ()) -> None:
        self._holder = holder
        self._message = message
        self._events = events

    def __call__(self, **kwargs: Any) -> _FakeAnthropicStream:
        self._holder["kwargs"] = kwargs
        return self

    async def __aenter__(self) -> _FakeAnthropicStream:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def __aiter__(self):
        for event in self._events:
            yield event

    async def get_final_message(self) -> Any:
        return self._message


async def test_anthropic_chat_maps_reasoning_effort_to_extended_thinking():
    # The SAME reasoning_effort knob the OpenAI path reads: thinking budget on,
    # max_tokens raised above it, temperature omitted (API constraint while thinking),
    # and the call STREAMS (the SDK refuses non-streaming at thinking-sized max_tokens).
    holder: dict = {}
    stream = _FakeAnthropicStream(holder, SimpleNamespace(content=[SimpleNamespace(type="text", text="ok")]))
    fake_client = SimpleNamespace(messages=SimpleNamespace(create=AsyncMock(), stream=stream))
    llm = AnthropicLLM(
        LLMSettings(api_key="sk-test", chat_model="claude-opus-4-6", reasoning_effort="max"),
        client=fake_client,
    )

    result = await llm.chat([{"role": "user", "content": "act"}], temperature=0.9)

    kwargs = holder["kwargs"]
    assert kwargs["thinking"] == {"type": "enabled", "budget_tokens": 31744}
    assert kwargs["max_tokens"] > 31744
    assert "temperature" not in kwargs
    assert result.content == "ok"
    fake_client.messages.create.assert_not_called()


async def test_anthropic_per_call_effort_overrides_session_effort_but_never_the_off_switch():
    # An NPC line's dramatic weight may lower (or raise) the session effort per call,
    # but a deployment that turned reasoning OFF stays off — the operator wins.
    holder: dict = {}
    stream = _FakeAnthropicStream(holder, SimpleNamespace(content=[SimpleNamespace(type="text", text="ok")]))
    fake_client = SimpleNamespace(messages=SimpleNamespace(create=AsyncMock(), stream=stream))
    fake_client.messages.create.return_value = SimpleNamespace(content=[SimpleNamespace(type="text", text="ok")])

    with_session_effort = AnthropicLLM(
        LLMSettings(api_key="sk-test", chat_model="claude-opus-4-6", reasoning_effort="max"),
        client=fake_client,
    )
    await with_session_effort.chat([{"role": "user", "content": "line"}], reasoning_effort="low")
    assert holder["kwargs"]["thinking"] == {"type": "enabled", "budget_tokens": 2048}

    reasoning_off = AnthropicLLM(
        LLMSettings(api_key="sk-test", chat_model="claude-opus-4-6", reasoning_effort=""),
        client=fake_client,
    )
    await reasoning_off.chat([{"role": "user", "content": "line"}], reasoning_effort="medium")
    assert "thinking" not in fake_client.messages.create.call_args.kwargs


async def test_anthropic_chat_forced_tool_choice_runs_without_thinking():
    # Anthropic requires tool_choice auto/none while thinking — the deterministic
    # dice corrective forces a specific tool, so that call must drop thinking, not 400.
    fake_client = SimpleNamespace(messages=SimpleNamespace(create=AsyncMock()))
    fake_client.messages.create.return_value = SimpleNamespace(content=[SimpleNamespace(type="text", text="ok")])
    llm = AnthropicLLM(
        LLMSettings(api_key="sk-test", chat_model="claude-opus-4-6", reasoning_effort="max"),
        client=fake_client,
    )

    await llm.chat([{"role": "user", "content": "act"}], tool_choice="skill_check")

    kwargs = fake_client.messages.create.call_args.kwargs
    assert "thinking" not in kwargs
    assert kwargs["max_tokens"] == 4096
    assert kwargs["tool_choice"] == {"type": "tool", "name": "skill_check"}


async def test_anthropic_streams_text_and_still_reports_its_usage():
    """The Anthropic path needs no OpenAI-style opt-in — and this pins that it doesn't.

    Its streaming carries usage natively (`message_start` + `message_delta`), and the
    SDK folds those into the Message `get_final_message()` returns, which is the exact
    object `from_anthropic_response` parses. So a streamed Claude turn feeds the room's
    meter — and the chronicle fold that reads it — with no request-parameter changes.
    """
    holder: dict = {}
    final = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="The door creaks open.")],
        usage=SimpleNamespace(
            input_tokens=1000, output_tokens=80, cache_read_input_tokens=200, cache_creation_input_tokens=0
        ),
    )
    events = (
        SimpleNamespace(type="content_block_delta", delta=SimpleNamespace(type="text_delta", text="The door ")),
        SimpleNamespace(type="content_block_delta", delta=SimpleNamespace(type="text_delta", text="creaks open.")),
    )
    stream = _FakeAnthropicStream(holder, final, events)
    llm = AnthropicLLM(
        LLMSettings(api_key="sk-test", chat_model="claude-opus-4-6"),
        client=SimpleNamespace(messages=SimpleNamespace(create=AsyncMock(), stream=stream)),
    )
    seen: list[str] = []

    result = await llm.chat([{"role": "user", "content": "open it"}], on_text_delta=seen.append)

    assert "stream_options" not in holder["kwargs"], "an OpenAI parameter has no business here"
    assert seen == ["The door ", "creaks open."]
    assert result.usage is not None
    # prompt = input + cache_read + cache_creation (cached tokens still occupy the window).
    assert result.usage.prompt_tokens == 1200
    assert result.usage.completion_tokens == 80


async def test_gemini_streaming_keeps_the_usage_it_was_given():
    """Reading usage from the LAST chunk is not the same as reading the last usage.

    The google-genai SDK passes `usage_metadata` through per chunk and accumulates
    nothing, so nothing guarantees the terminal chunk is the one carrying it. Keeping
    the last chunk that HAD one costs nothing and stops a stream that reported its
    tokens early from arriving at the room's meter as silence.
    """
    from google.genai import types

    def _chunk(text: str, usage: Any = None) -> Any:
        return SimpleNamespace(
            candidates=[SimpleNamespace(content=SimpleNamespace(parts=[types.Part(text=text)]))],
            usage_metadata=usage,
        )

    chunks = [
        _chunk("The door "),
        _chunk("creaks open.", SimpleNamespace(prompt_token_count=900, candidates_token_count=40)),
        _chunk(""),  # a terminal chunk with no usage at all
    ]

    class _FakeGeminiModels:
        async def generate_content_stream(self, **_kwargs: Any) -> Any:
            async def _iter():
                for chunk in chunks:
                    yield chunk

            return _iter()

    llm = GeminiLLM(
        LLMSettings(api_key="sk-test", chat_model="gemini-2.5-pro"),
        client=SimpleNamespace(aio=SimpleNamespace(models=_FakeGeminiModels())),
    )
    seen: list[str] = []

    result = await llm.chat([{"role": "user", "content": "open it"}], on_text_delta=seen.append)

    assert result.content == "The door creaks open."
    assert result.usage is not None and result.usage.prompt_tokens == 900


def test_anthropic_thinking_blocks_replay_verbatim_through_the_tool_loop():
    # Signed thinking blocks must ride back with their assistant turn during the
    # SAME turn's tool loop; the loop attaches them and the converter replays them
    # verbatim instead of rebuilding a text+tool_use shape that would drop them.
    from agent.loop import _assistant_tool_call_message

    thinking_block = {"type": "thinking", "thinking": "…", "signature": "sig-1"}
    tool_block = {"type": "tool_use", "id": "toolu_9", "name": "roll_dice", "input": {"expression": "1d100"}}
    response = SimpleNamespace(content=[thinking_block, tool_block])

    result = from_anthropic_response(response)
    assert result.provider_blocks == [thinking_block, tool_block]

    assistant = _assistant_tool_call_message(result)
    assert assistant["provider_blocks"] == [thinking_block, tool_block]

    _, messages = to_anthropic_messages(
        [assistant, {"role": "tool", "tool_call_id": "toolu_9", "content": "42"}]
    )
    assert messages[0] == {"role": "assistant", "content": [thinking_block, tool_block]}
    assert messages[1]["content"][0]["type"] == "tool_result"


def test_sanitize_gemini_tool_parameters_removes_unsupported_fields_and_bad_numeric_enum():
    parameters = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "count": {"type": "integer", "enum": [1, 2], "description": "How many"},
            "mode": {"type": "string", "enum": ["a", "b"], "additionalProperties": False},
        },
        "required": ["count"],
    }

    assert sanitize_gemini_tool_parameters(parameters) == {
        "type": "object",
        "properties": {
            "count": {"type": "integer", "description": "How many"},
            "mode": {"type": "string", "enum": ["a", "b"]},
        },
        "required": ["count"],
    }


def test_to_gemini_tools_maps_function_declaration_with_clean_schema():
    tools = [
        {
            "type": "function",
            "function": {
                "name": "roll_dice",
                "description": "Roll dice",
                "parameters": {"type": "object", "additionalProperties": False, "properties": {}},
            },
        }
    ]

    [tool] = to_gemini_tools(tools)

    [declaration] = tool.function_declarations
    assert declaration.name == "roll_dice"
    assert declaration.description == "Roll dice"
    assert declaration.parameters_json_schema == {"type": "object", "properties": {}}


def test_from_gemini_response_maps_text_and_function_call():
    response = SimpleNamespace(
        candidates=[
            SimpleNamespace(
                content=SimpleNamespace(
                    parts=[
                        SimpleNamespace(text="Need a roll.", function_call=None),
                        SimpleNamespace(
                            text=None,
                            function_call=SimpleNamespace(id="call_1", name="roll_dice", args={"expression": "1d20"}),
                        ),
                    ]
                )
            )
        ]
    )

    result = from_gemini_response(response)

    assert result.content == "Need a roll."
    assert result.tool_calls == [ToolCall(id="call_1", name="roll_dice", arguments={"expression": "1d20"})]
