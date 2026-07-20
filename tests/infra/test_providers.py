from __future__ import annotations

from types import SimpleNamespace
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

    assert isinstance(llm, OpenAILLM)
    assert llm._client.init_kwargs["base_url"] is None


def test_build_llm_selects_openai_compatible_preset(monkeypatch):
    monkeypatch.setattr("infra.llm.AsyncOpenAI", _FakeAsyncOpenAI)

    llm = build_llm(_settings("deepseek"))

    assert isinstance(llm, OpenAILLM)
    assert llm._client.init_kwargs["base_url"] == PRESETS["deepseek"]


def test_build_llm_explicit_base_url_overrides_preset(monkeypatch):
    monkeypatch.setattr("infra.llm.AsyncOpenAI", _FakeAsyncOpenAI)

    llm = build_llm(_settings("deepseek", base_url="https://example.test/v1"))

    assert isinstance(llm, OpenAILLM)
    assert llm._client.init_kwargs["base_url"] == "https://example.test/v1"


def test_build_llm_selects_chatgpt_subscription_proxy_with_explicit_base_url(monkeypatch):
    monkeypatch.setattr("infra.llm.AsyncOpenAI", _FakeAsyncOpenAI)

    llm = build_llm(_settings("gpt-subscription", base_url="https://proxy.example/v1"))

    assert is_known_provider("gpt-subscription")
    assert is_known_provider("chatgpt")
    assert isinstance(llm, OpenAILLM)
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

    assert isinstance(llm, OpenAILLM)
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

    assert isinstance(llm, AnthropicLLM)


def test_build_llm_selects_gemini(monkeypatch):
    class FakeGenAIClient:
        def __init__(self, **kwargs) -> None:
            self.kwargs = kwargs

    monkeypatch.setattr("google.genai.Client", FakeGenAIClient)

    llm = build_llm(_settings("gemini"))

    assert isinstance(llm, GeminiLLM)


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
