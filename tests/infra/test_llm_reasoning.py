"""OpenAILLM reasoning-effort + temperature wiring (DeepSeek thinking mode).

Per the DeepSeek docs: thinking models take `reasoning_effort` (high/max) and IGNORE
temperature; a low temperature can degrade the reasoning trace. So when reasoning_effort
is set we send it and omit temperature, and by default we don't hand-set temperature at all
(let the provider use its own default)."""
from __future__ import annotations

import asyncio
import types

from infra.config import LLMSettings
from infra.llm import OpenAILLM


class _RecordingCompletions:
    def __init__(self):
        self.kwargs: dict | None = None

    async def create(self, **kwargs):
        self.kwargs = kwargs
        msg = types.SimpleNamespace(content="ok", tool_calls=None)
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=msg)], model_dump=lambda: {})


def _llm(settings: LLMSettings):
    llm = OpenAILLM(settings)
    rec = _RecordingCompletions()
    llm._client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=rec))
    return llm, rec


def _base(**over):
    params = dict(provider="deepseek", api_key="x", base_url="https://api.deepseek.com/v1",
                  chat_model="deepseek-v4-pro")
    params.update(over)
    return LLMSettings(**params)


def test_reasoning_effort_is_sent_and_temperature_omitted():
    llm, rec = _llm(_base(reasoning_effort="max"))
    asyncio.run(llm.chat([{"role": "user", "content": "hi"}]))
    assert rec.kwargs["reasoning_effort"] == "max"
    assert "temperature" not in rec.kwargs  # thinking mode ignores it; don't send


def test_temperature_not_sent_by_default_without_reasoning():
    llm, rec = _llm(_base(chat_model="deepseek-v4-flash"))  # reasoning_effort="" (off)
    asyncio.run(llm.chat([{"role": "user", "content": "hi"}]))
    assert "reasoning_effort" not in rec.kwargs
    assert "temperature" not in rec.kwargs  # default temperature is None -> unset -> provider default


def test_explicit_temperature_still_honored_when_not_reasoning():
    llm, rec = _llm(_base(chat_model="deepseek-v4-flash"))
    asyncio.run(llm.chat([{"role": "user", "content": "hi"}], temperature=0.5))
    assert rec.kwargs["temperature"] == 0.5
