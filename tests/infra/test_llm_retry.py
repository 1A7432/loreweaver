"""Tests for `infra.llm_retry` (F22) — a rate-limited turn gets SLOWER, never dead.

From a 2026-08-07 long session: a 429 killed the Keeper at the story's climax. The
contract these pin: a retryable failure is re-issued with bounded, jittered backoff;
a permanent one propagates immediately; and every provider path gets this from ONE
implementation because `build_llm` wraps them all.
"""

from __future__ import annotations

import logging

import pytest

from infra.config import Settings
from infra.llm import ChatResult, LLMClient, OpenAILLM
from infra.llm_retry import (
    MAX_DELAY,
    RetryingLLM,
    backoff_delay,
    is_retryable,
    unwrap_llm,
)


class _Flaky:
    """A client that fails the first `failures` calls with `error`, then succeeds."""

    def __init__(self, error: BaseException, failures: int = 1) -> None:
        self._error = error
        self._remaining = failures
        self.calls = 0
        self.last_kwargs: dict = {}

    async def chat(self, messages, **kwargs) -> ChatResult:
        self.calls += 1
        self.last_kwargs = kwargs
        if self._remaining > 0:
            self._remaining -= 1
            raise self._error
        return ChatResult(content="narration", tool_calls=[])


class _Status(Exception):
    """An SDK-shaped error: the status lives on the exception, as every SDK does it."""

    def __init__(self, status_code: int, message: str = "") -> None:
        super().__init__(message or f"HTTP {status_code}")
        self.status_code = status_code


def _retrying(inner: LLMClient, **kwargs) -> RetryingLLM:
    waits: list[float] = []

    async def _sleep(delay: float) -> None:
        waits.append(delay)

    client = RetryingLLM(inner, sleep=_sleep, rand=lambda: 1.0, **kwargs)
    client.waits = waits  # type: ignore[attr-defined]  # test-only handle
    return client


async def test_a_429_then_success_completes_the_turn():
    inner = _Flaky(_Status(429, "Rate limit reached"))
    client = _retrying(inner)

    result = await client.chat([{"role": "user", "content": "I open the door"}])

    assert result.content == "narration"
    assert inner.calls == 2, "the call was re-issued, not abandoned"
    assert client.waits == [backoff_delay(1, rand=lambda: 1.0)]


async def test_every_call_argument_survives_the_retry():
    # A retry that dropped `tools` would silently turn a tool-using turn into prose.
    inner = _Flaky(_Status(429), failures=1)
    client = _retrying(inner)
    tools = [{"type": "function", "function": {"name": "roll_dice"}}]

    await client.chat([{"role": "user", "content": "x"}], tools=tools, model="m", reasoning_effort="low")

    assert inner.last_kwargs["tools"] == tools
    assert inner.last_kwargs["model"] == "m" and inner.last_kwargs["reasoning_effort"] == "low"


async def test_a_permanent_error_is_not_retried():
    inner = _Flaky(_Status(401, "Invalid API key"), failures=99)
    client = _retrying(inner)

    with pytest.raises(_Status):
        await client.chat([{"role": "user", "content": "x"}])

    assert inner.calls == 1, "a bad key must surface at once, not after three waits"
    assert client.waits == []


async def test_persistent_throttling_gives_up_after_a_bounded_number_of_attempts():
    inner = _Flaky(_Status(429), failures=99)
    client = _retrying(inner, max_attempts=3)

    with pytest.raises(_Status):
        await client.chat([{"role": "user", "content": "x"}])

    # Bounded: a provider down for an hour becomes an error the operator can act on,
    # never a turn that hangs until someone kills the server.
    assert inner.calls == 3
    assert len(client.waits) == 2


async def test_the_wait_is_visible_to_the_operator_and_to_the_caller(caplog):
    seen: list[tuple[int, float]] = []
    inner = _Flaky(_Status(503, "Overloaded"))
    client = _retrying(inner, on_retry=lambda attempt, delay, error: seen.append((attempt, delay)))

    with caplog.at_level(logging.WARNING, logger="infra.llm_retry"):
        await client.chat([{"role": "user", "content": "x"}])

    assert seen and seen[0][0] == 1
    assert any("throttled" in record.message or "throttled" in record.getMessage() for record in caplog.records)


@pytest.mark.parametrize(
    ("error", "retryable"),
    [
        (_Status(429), True),
        (_Status(500), True),
        (_Status(503), True),
        (_Status(529), True),
        (_Status(400), False),
        (_Status(401), False),
        (_Status(403), False),
        (_Status(404), False),
        (_Status(422), False),
        # No status at all: some proxies surface a 429 as a bare error, and a table
        # dying at the climax over a missing attribute is the failure this prevents.
        (RuntimeError("Rate limit exceeded, please try again"), True),
        (RuntimeError("upstream is overloaded"), True),
        (RuntimeError("invalid_request_error: unknown field"), False),
        (ValueError("context length exceeded"), False),
    ],
)
def test_retryable_classification(error: BaseException, retryable: bool):
    assert is_retryable(error) is retryable


def test_backoff_grows_and_is_capped_and_jittered():
    full = [backoff_delay(attempt, rand=lambda: 1.0) for attempt in range(1, 8)]
    assert full[0] < full[1] < full[2], "exponential growth"
    assert max(full) <= MAX_DELAY, "capped"
    # Full jitter: the same attempt spans (0, window], so clients of a shared key do
    # not all re-collide on the next bucket boundary.
    assert backoff_delay(3, rand=lambda: 0.0) == 0.0
    assert backoff_delay(3, rand=lambda: 1.0) > backoff_delay(3, rand=lambda: 0.5)


def test_unrecognized_attributes_pass_through_to_the_provider():
    class _WithExtras:
        def __init__(self) -> None:
            self.cleared: list = []

        async def chat(self, messages, **kwargs):  # pragma: no cover - not called here
            return ChatResult(content="", tool_calls=[])

        def clear_continuation(self, messages):
            self.cleared.append(messages)

        def describe(self):
            return {"provider": "test"}

    inner = _WithExtras()
    client = RetryingLLM(inner)

    # Wrapping must be invisible to every caller that duck-types the client.
    client.clear_continuation([{"role": "user"}])
    assert inner.cleared == [[{"role": "user"}]]
    assert client.describe() == {"provider": "test"}


def test_every_provider_path_is_wrapped(monkeypatch):
    """The guarantee is structural: `build_llm` is the ONE construction point, so a
    new provider adapter cannot ship without backoff by forgetting to add it."""
    from infra.providers import build_llm

    class _FakeAsyncOpenAI:
        def __init__(self, **kwargs) -> None:
            self.init_kwargs = kwargs

    monkeypatch.setattr("infra.llm.AsyncOpenAI", _FakeAsyncOpenAI)
    settings = Settings()
    settings.llm.provider = "openai"
    settings.llm.api_key = "sk-test"

    client = build_llm(settings)

    assert isinstance(client, RetryingLLM)
    assert isinstance(unwrap_llm(client), OpenAILLM)
