"""Chat-completion client abstraction (+ deterministic FakeLLM for tests).

`LLMClient` is a `Protocol`, so anything exposing a matching async `chat()`
satisfies it structurally. `OpenAILLM` wraps `openai.AsyncOpenAI` directly
(an OpenAI-*compatible* client, so pointing `settings.base_url` at another
provider such as DeepSeek works unmodified). `FakeLLM` is the deterministic,
scriptable stand-in every test in this repo drives the AI-KP loop with — see
the "no network in tests" rule in `docs/specs/M1.md`.
"""

from __future__ import annotations

import itertools
import json
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from openai import AsyncOpenAI

from infra.config import LLMSettings
from infra.i18n import t


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict  # already json-parsed (tolerates bad json -> {})


@dataclass
class ChatResult:
    content: str | None
    tool_calls: list[ToolCall]  # [] when none
    raw: Any = None


class LLMClient(Protocol):
    async def chat(
        self,
        messages: list[dict],
        *,
        tools: list[dict] | None = None,
        tool_choice: str | dict | None = None,
        temperature: float | None = None,
        model: str | None = None,
    ) -> ChatResult: ...


class OpenAILLM:
    """Real `LLMClient`, wrapping `openai.AsyncOpenAI`.

    Uses the OpenAI-compatible chat-completions API, so any OpenAI-compatible
    provider (e.g. DeepSeek) works by pointing `settings.base_url` at it —
    no other code change needed.
    """

    def __init__(self, settings: LLMSettings) -> None:
        self._settings = settings
        self._client = AsyncOpenAI(api_key=settings.api_key or None, base_url=settings.base_url or None)

    async def chat(
        self,
        messages: list[dict],
        *,
        tools: list[dict] | None = None,
        tool_choice: str | dict | None = None,
        temperature: float | None = None,
        model: str | None = None,
    ) -> ChatResult:
        kwargs: dict[str, Any] = {
            "model": model or self._settings.chat_model,
            "messages": messages,
        }
        if tools:
            kwargs["tools"] = tools
        if tool_choice is not None:
            kwargs["tool_choice"] = tool_choice
        if self._settings.reasoning_effort:
            # Reasoning models (deepseek-v4-pro, o-series) take a thinking budget and
            # ignore/reject `temperature`, so send one xor the other.
            kwargs["reasoning_effort"] = self._settings.reasoning_effort
        else:
            effective_temperature = self._settings.temperature if temperature is None else temperature
            if effective_temperature is not None:
                kwargs["temperature"] = effective_temperature

        response = await self._client.chat.completions.create(**kwargs)
        if not response.choices:
            return ChatResult(content=None, tool_calls=[], raw=response)

        message = response.choices[0].message
        tool_calls = [
            ToolCall(id=call.id, name=call.function.name, arguments=_parse_tool_arguments(call.function.arguments))
            for call in (message.tool_calls or [])
        ]
        return ChatResult(content=message.content, tool_calls=tool_calls, raw=response)


def _parse_tool_arguments(raw: str | None) -> dict:
    """Best-effort JSON parse of a tool call's arguments string.

    Tolerates malformed JSON (providers occasionally emit truncated/invalid
    JSON) by falling back to `{}` instead of raising.
    """
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


class FakeLLM:
    """Deterministic, scriptable `LLMClient` stand-in used throughout tests.

    Exactly one of `responder`/`script` is normally supplied:
    - `script`: each `chat()` call pops and returns the next `ChatResult`,
      in order; calling past the end raises.
    - `responder`: each `chat()` call invokes `responder(messages, tools)`,
      letting a test inspect the running conversation and branch.
    Every call is recorded to `self.calls` as `(messages, tools)` so tests
    can assert on what the loop actually sent; the per-call `tool_choice` is
    recorded in parallel to `self.tool_choices` (it is otherwise ignored — the
    script/responder decides the reply), so a test can assert the loop forced a
    tool with `tool_choice="required"`.
    """

    def __init__(
        self,
        responder: Callable[[list[dict], list[dict] | None], ChatResult] | None = None,
        script: list[ChatResult] | None = None,
    ) -> None:
        self._responder = responder
        self._script: deque[ChatResult] | None = deque(script) if script is not None else None
        self.calls: list[tuple[list[dict], list[dict] | None]] = []
        self.tool_choices: list[str | dict | None] = []

    async def chat(
        self,
        messages: list[dict],
        *,
        tools: list[dict] | None = None,
        tool_choice: str | dict | None = None,
        temperature: float | None = None,
        model: str | None = None,
    ) -> ChatResult:
        self.calls.append((messages, tools))
        self.tool_choices.append(tool_choice)
        if self._script is not None:
            if not self._script:
                raise RuntimeError(t("infra.llm.fake_script_exhausted"))
            return self._script.popleft()
        if self._responder is not None:
            return self._responder(messages, tools)
        raise RuntimeError(t("infra.llm.fake_not_configured"))


_tool_call_ids = itertools.count(1)


def tool_call(name: str, **arguments: Any) -> ToolCall:
    """Build a `ToolCall` for test scripts, auto-generating a `call_<n>` id."""
    return ToolCall(id=f"call_{next(_tool_call_ids)}", name=name, arguments=arguments)


def assistant_tools(*calls: ToolCall) -> ChatResult:
    """A scripted assistant turn that only invokes tools (no text yet)."""
    return ChatResult(content=None, tool_calls=list(calls))


def assistant_text(text: str) -> ChatResult:
    """A scripted assistant turn with a final text reply and no tool calls."""
    return ChatResult(content=text, tool_calls=[])
