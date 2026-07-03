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
    build_llm,
    from_anthropic_response,
    from_gemini_response,
    is_known_provider,
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


def test_build_llm_rejects_chatgpt_subscription_proxy_without_base_url(monkeypatch):
    monkeypatch.setattr("infra.llm.AsyncOpenAI", _FakeAsyncOpenAI)

    with pytest.raises(ValueError, match="chatgpt_subscription_proxy_requires_base_url"):
        build_llm(_settings("gpt-subscription"))


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
