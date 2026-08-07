"""Bounded retry for rate-limited / overloaded LLM calls (F22).

From a 2026-08-07 long session: a rate limit killed the Keeper at the story's
climax. A 429 is not a failure of the request — it is the provider saying "not
right now", and the only correct answer at a table is to wait a moment and ask
again. **A rate-limited turn should get SLOWER. It must never get dead.**

`RetryingLLM` wraps any `LLMClient` and re-issues a call that failed with a
retryable status (429, 5xx, "overloaded"): a few attempts, exponential backoff,
full jitter, every wait logged at WARNING so an operator watching the console can
see the table is throttled rather than hung. Anything else — a bad key, a
malformed request, a content refusal — propagates immediately and unchanged; a
retry loop around a permanent error is just a slower failure.

It wraps at :func:`infra.providers.build_llm`, so EVERY provider path gets it from
one implementation: the OpenAI-compatible client, the native Anthropic and Gemini
adapters, the ChatGPT/SuperGrok subscription paths, and the separately-built
Scribe and Director clients alike. Detection is by exception SHAPE rather than by
SDK class (`status_code`/`status`/`code`, then the message text), because the five
paths raise five different exception types for the same HTTP 429.

Two things worth knowing:

- **A streamed call is retried too, and its draft bubble briefly shows both
  attempts.** `on_text_delta` may already have emitted text when the provider gave
  up, and there is no un-emitting it. This is safe rather than merely tolerated:
  the protocol's closing `narrative` frame carries the FULL final text and REPLACES
  the draft (docs/protocol.md, "Streaming is two frame types with one rule"), so
  the doubling lasts until the turn ends and then disappears. `on_retry` is
  available for a caller that wants to say something in the meantime.
- **The total wait is bounded** (`MAX_ATTEMPTS` attempts, each capped at
  `MAX_DELAY`). A provider that is down for an hour should surface as an error the
  operator can act on, not as a turn that hangs until someone kills the server.
"""

from __future__ import annotations

import asyncio
import logging
import random
import re
from collections.abc import Callable
from typing import Any

from infra.llm import ChatResult, LLMClient

logger = logging.getLogger(__name__)

# Three total attempts: two retries. Long enough to ride out the per-minute buckets
# every vendor uses, short enough that a genuinely dead endpoint still reports within
# a table's patience.
MAX_ATTEMPTS = 3
BASE_DELAY = 2.0
MAX_DELAY = 20.0

# Status codes worth asking again about. 429 is the reason this exists; 5xx covers the
# "overloaded"/"try again" family every vendor returns under load. 408/409 are transient
# by definition. Everything else (400/401/403/404/422) is a permanent problem with the
# request or the credentials — retrying only delays the operator learning about it.
RETRYABLE_STATUSES = frozenset({408, 409, 429, 500, 502, 503, 504, 529})

_RETRYABLE_TEXT = re.compile(
    r"(?i)\b(rate.?limit|too.?many.?requests|overloaded|capacity|server.?is.?busy|try.?again|"
    r"temporarily.?unavailable|429|503)\b"
)


def _status_of(error: BaseException) -> int | None:
    """The HTTP status an exception carries, across five SDKs' conventions."""
    for attribute in ("status_code", "status", "http_status", "code"):
        value = getattr(error, attribute, None)
        if isinstance(value, int) and 100 <= value <= 599:
            return value
        if isinstance(value, str) and value.isdigit() and 100 <= int(value) <= 599:
            return int(value)
    response = getattr(error, "response", None)
    status = getattr(response, "status_code", None)
    return status if isinstance(status, int) else None


def is_retryable(error: BaseException) -> bool:
    """Whether `error` means "not right now" rather than "not like this".

    Status first (unambiguous). Only when there is no status at all does the message
    text decide — some proxies surface a 429 as a bare RuntimeError, and a table
    dying at the climax because the wrapper insisted on a structured status would be
    the exact failure this module exists to prevent.
    """
    status = _status_of(error)
    if status is not None:
        return status in RETRYABLE_STATUSES
    return bool(_RETRYABLE_TEXT.search(str(error)))


def backoff_delay(attempt: int, *, rand: Callable[[], float] = random.random) -> float:
    """Seconds to wait before `attempt` (1-based retry index), full-jittered.

    Full jitter (`uniform(0, window)`, not `window ± noise`) because every client of a
    shared key retries on the same 60-second bucket boundary; without it they simply
    re-collide, and a table with a companion director firing several calls per turn
    collides with ITSELF.
    """
    window = min(MAX_DELAY, BASE_DELAY * (2 ** max(0, attempt - 1)))
    return round(window * rand(), 3)


class RetryingLLM:
    """An `LLMClient` that re-issues rate-limited/overloaded calls (module docstring).

    `on_retry(attempt, delay, error)` fires before each wait — the streaming caller's
    hook for discarding a partial draft and telling the room it is waiting, not stuck.
    `sleep` is injectable so tests run at full speed without pretending time passed.
    """

    def __init__(
        self,
        inner: LLMClient,
        *,
        max_attempts: int = MAX_ATTEMPTS,
        sleep: Callable[[float], Any] = asyncio.sleep,
        rand: Callable[[], float] = random.random,
        on_retry: Callable[[int, float, BaseException], None] | None = None,
    ) -> None:
        self._inner = inner
        self._max_attempts = max(1, max_attempts)
        self._sleep = sleep
        self._rand = rand
        self._on_retry = on_retry

    @property
    def inner(self) -> LLMClient:
        return self._inner

    def __getattr__(self, name: str) -> Any:
        """Pass through everything else (`clear_continuation`, `describe`, provider
        extras) so wrapping is invisible to callers that duck-type the client."""
        return getattr(self._inner, name)

    async def chat(
        self,
        messages: list[dict],
        *,
        tools: list[dict] | None = None,
        tool_choice: str | dict | None = None,
        temperature: float | None = None,
        model: str | None = None,
        reasoning_effort: str | None = None,
        on_text_delta: Callable[[str], None] | None = None,
    ) -> ChatResult:
        last_error: BaseException | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                return await self._inner.chat(
                    messages,
                    tools=tools,
                    tool_choice=tool_choice,
                    temperature=temperature,
                    model=model,
                    reasoning_effort=reasoning_effort,
                    on_text_delta=on_text_delta,
                )
            except Exception as error:
                last_error = error
                if attempt >= self._max_attempts or not is_retryable(error):
                    raise
                delay = backoff_delay(attempt, rand=self._rand)
                logger.warning(
                    "LLM throttled (%s); retrying in %.1fs (attempt %d/%d)",
                    error,
                    delay,
                    attempt + 1,
                    self._max_attempts,
                )
                if self._on_retry is not None:
                    self._on_retry(attempt, delay, error)
                await self._sleep(delay)
        # Unreachable — the loop above either returns or re-raises.
        raise last_error if last_error is not None else RuntimeError("retry loop exited without a result")  # i18n-exempt: developer invariant, never player-facing


def unwrap_llm(client: Any) -> Any:
    """The concrete provider client behind any number of transparent wrappers.

    `build_llm` wraps every path in `RetryingLLM`, and `MutableLLM` wraps that again, so
    "which provider am I actually on?" needs one shared answer rather than a chain of
    `.inner.inner` guesses at each call site.
    """
    seen = 0
    while hasattr(client, "inner") and seen < 8:
        client = client.inner
        seen += 1
    return client
