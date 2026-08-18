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
# A provider that SAYS how long to wait (`Retry-After`, `reset_seconds`, "try again in
# 8s") is believed up to this much — a hint the backoff would undershoot means every
# retry lands inside the cooldown and the whole turn dies for nothing (2026-08-18: a
# `429 model_cooldown … reset_seconds: 8` was retried after 1.9s and 1.4s). Beyond the
# cap the bounded-total-wait promise wins over the hint.
MAX_HINT_DELAY = 60.0
_HINT_MARGIN = 0.5

_HINT_TEXT = re.compile(
    r"(?i)(?:retry|try again|reset|wait|cool ?down)[^0-9]{0,40}?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b"
)
_HINT_KEYS = ("retry_after", "retry-after", "retry_after_ms", "reset_seconds", "reset_ms", "cooldown_seconds")

# Status codes worth asking again about. 429 is the reason this exists; 5xx covers the
# "overloaded"/"try again" family every vendor returns under load. 408/409 are transient
# by definition. Everything else (400/401/403/404/422) is a permanent problem with the
# request or the credentials — retrying only delays the operator learning about it.
RETRYABLE_STATUSES = frozenset({408, 409, 429, 500, 502, 503, 504, 529})

_RETRYABLE_TEXT = re.compile(
    r"(?i)\b(rate.?limit|too.?many.?requests|overloaded|capacity|server.?is.?busy|try.?again|"
    r"temporarily.?unavailable|429|503)\b"
)


def status_of(error: BaseException) -> int | None:
    """The HTTP status an exception carries, across five SDKs' conventions.

    Public because it is the one place that knows how five SDKs spell the same thing;
    `infra.llm_errors` gates on it too rather than growing a second copy.
    """
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
    status = status_of(error)
    if status is not None:
        return status in RETRYABLE_STATUSES
    return bool(_RETRYABLE_TEXT.search(str(error)))


def _hint_from_mapping(payload: Any, depth: int = 0) -> float | None:
    """A cooldown hint from a decoded error body: `reset_seconds`, `retry_after(_ms)` …
    at the top level or one nesting down (`{"error": {...}}`), milliseconds normalized."""
    if not isinstance(payload, dict) or depth > 2:
        return None
    for key in _HINT_KEYS:
        value = payload.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float, str)):
            continue
        try:
            seconds = float(value)
        except (TypeError, ValueError):
            continue
        if seconds < 0:
            continue
        return seconds / 1000.0 if key.endswith("_ms") else seconds
    for nested in payload.values():
        found = _hint_from_mapping(nested, depth + 1)
        if found is not None:
            return found
    return None


def retry_after_hint(error: BaseException) -> float | None:
    """Seconds the PROVIDER asked us to wait, if it said — else None.

    Looked for in the same shape-first way `status_of` reads the status: a
    `Retry-After` header on the error's response (seconds, or an HTTP date), a decoded
    body / `body` attribute carrying `reset_seconds` / `retry_after(_ms)`, and finally
    the message text ("try again in 8s"). Public for the same reason `status_of` is.
    """
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None)
    if headers is not None:
        try:
            raw = headers.get("retry-after") or headers.get("Retry-After")
        except Exception:
            raw = None
        if raw:
            text = str(raw).strip()
            if re.fullmatch(r"\d+(?:\.\d+)?", text):
                return float(text)
            try:
                from email.utils import parsedate_to_datetime

                when = parsedate_to_datetime(text)
                delta = (when - when.now(when.tzinfo)).total_seconds()
                return max(0.0, delta)
            except Exception:
                pass
    for candidate in (getattr(error, "body", None), getattr(response, "json", None)):
        payload = candidate
        if callable(candidate):
            try:
                payload = candidate()
            except Exception:
                payload = None
        found = _hint_from_mapping(payload)
        if found is not None:
            return found
    match = _HINT_TEXT.search(str(error))
    if match:
        amount = float(match.group(1))
        unit = match.group(2).lower()
        return amount / 1000.0 if unit.startswith("m") else amount
    return None


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
                hint = retry_after_hint(error)
                if hint is not None:
                    # Believe the provider (bounded): a wait shorter than its cooldown
                    # is a wasted attempt, and every attempt here is precious.
                    delay = max(delay, min(hint + _HINT_MARGIN, MAX_HINT_DELAY))
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
