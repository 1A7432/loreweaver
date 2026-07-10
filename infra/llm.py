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
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from openai import AsyncOpenAI

from infra.config import LLMSettings
from infra.i18n import t

TokenProvider = Callable[[], Awaitable[str]]


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict  # already json-parsed (tolerates bad json -> {})


@dataclass
class Usage:
    """Token/cache accounting for one `chat()` call, provider-agnostic (see `parse_usage`).

    All fields default to `0` so an unpopulated `Usage()` (e.g. every existing
    `FakeLLM` script/responder result, which never sets `ChatResult.usage`) reads
    as "no real usage" rather than `None`-checks scattered everywhere.
    """

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cache_hit_tokens: int = 0
    cache_miss_tokens: int = 0


@dataclass
class ChatResult:
    content: str | None
    tool_calls: list[ToolCall]  # [] when none
    raw: Any = None
    usage: Usage | None = None  # best-effort `parse_usage(raw)`; None when unavailable/unparsed


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

    Optional ``token_provider`` supplies a fresh Bearer on every request
    (subscription OAuth); when set, the static ``settings.api_key`` is ignored.
    """

    def __init__(
        self,
        settings: LLMSettings,
        *,
        token_provider: TokenProvider | None = None,
        client: Any | None = None,
    ) -> None:
        self._settings = settings
        self._token_provider = token_provider
        if client is not None:
            self._client = client
        else:
            # Placeholder key when a token_provider will inject the real bearer.
            # Always pass an explicit value. Letting the SDK resolve a missing
            # key from ambient OPENAI_API_KEY could send an OpenAI credential to
            # a selected third-party/custom base URL.
            api_key = settings.api_key or ("subscription" if token_provider else "missing")
            self._client = AsyncOpenAI(api_key=api_key, base_url=settings.base_url or None)

    async def chat(
        self,
        messages: list[dict],
        *,
        tools: list[dict] | None = None,
        tool_choice: str | dict | None = None,
        temperature: float | None = None,
        model: str | None = None,
    ) -> ChatResult:
        if self._token_provider is not None:
            token = await self._token_provider()
            self._client.api_key = token
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
            return ChatResult(content=None, tool_calls=[], raw=response, usage=parse_usage(response))

        message = response.choices[0].message
        tool_calls = [
            ToolCall(id=call.id, name=call.function.name, arguments=_parse_tool_arguments(call.function.arguments))
            for call in (message.tool_calls or [])
        ]
        return ChatResult(content=message.content, tool_calls=tool_calls, raw=response, usage=parse_usage(response))


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


def _g(obj: Any, key: str, default: Any = None) -> Any:
    """Tolerant attr-OR-dict getter (mirrors `infra.providers._get_value`).

    Every provider SDK response can plausibly show up here as either a real
    SDK object (attribute access) or a plain dict (test doubles, some
    already-parsed provider payloads), so every `parse_usage` lookup goes
    through this rather than assuming one shape.
    """
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _coerce_int(value: Any) -> int:
    """Best-effort int coercion: `None`/unparseable -> `0`, never raises."""
    if value is None:
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _build_usage(prompt: int, completion: int, total: int, cache_hit_raw: Any, cache_miss_raw: Any) -> Usage | None:
    """Assemble a `Usage` from already-extracted-but-not-yet-coerced fields, applying
    the shared derivation rules (see `parse_usage`'s docstring). `None` when neither
    `prompt` nor `completion` carries a real value (no usage-like object was present).
    """
    if prompt == 0 and completion == 0:
        return None
    if total <= 0:
        total = prompt + completion
    cache_hit = _coerce_int(cache_hit_raw) if cache_hit_raw is not None else 0
    if cache_miss_raw is not None:
        cache_miss = _coerce_int(cache_miss_raw)
    elif cache_hit_raw is not None:
        # cache_hit is known (the field was present) but no explicit miss count --
        # derive it from what's left of the prompt.
        cache_miss = max(0, prompt - cache_hit)
    else:
        cache_miss = 0
    return Usage(
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=total,
        cache_hit_tokens=cache_hit,
        cache_miss_tokens=cache_miss,
    )


def parse_usage(raw: Any) -> Usage | None:
    """Best-effort, provider-agnostic token/cache usage parse from a raw chat response.

    NEVER raises -- any shape mismatch (missing/`None` fields, an unrecognized
    response object) degrades to `None` rather than crashing a turn. Recognizes
    three response shapes, tried in order:

    - **Gemini** (`google-genai`): discriminated by a top-level `usage_metadata`.
      `prompt_token_count` / `candidates_token_count` / `cached_content_token_count`.
    - **Anthropic** (`messages.create`): discriminated by `response.usage` carrying
      `input_tokens`/`output_tokens`. Anthropic's `input_tokens` EXCLUDES cached
      tokens, so `prompt_tokens = input_tokens + cache_read_input_tokens +
      cache_creation_input_tokens`; `cache_hit_tokens = cache_read_input_tokens`.
    - **OpenAI-compatible** (`chat.completions.create`, incl. DeepSeek): plain
      `usage.prompt_tokens`/`completion_tokens`/`total_tokens`. Cache-hit tokens come
      from EITHER DeepSeek's `prompt_cache_hit_tokens` (+ miss `prompt_cache_miss_tokens`)
      OR OpenAI's `prompt_tokens_details.cached_tokens`. DeepSeek's extra fields can
      live as plain attributes OR inside the openai SDK's `usage.model_extra` dict
      (a pydantic "extra fields" bucket) depending on SDK version, so both are tried.

    Derived fields (all three shapes): `total_tokens` defaults to `prompt + completion`
    when absent/zero; when a cache-hit count is known but no explicit miss count is,
    `cache_miss_tokens = max(0, prompt_tokens - cache_hit_tokens)`. Every field is
    defensively coerced to `int` (a `None`/non-numeric value becomes `0`). Returns
    `None` when no usage-like object is found, OR when both prompt and completion
    parsed to `0` (no real usage to report).
    """
    if raw is None:
        return None

    usage_metadata = _g(raw, "usage_metadata")
    if usage_metadata is not None:
        prompt = _coerce_int(_g(usage_metadata, "prompt_token_count"))
        completion = _coerce_int(_g(usage_metadata, "candidates_token_count"))
        cache_hit_raw = _g(usage_metadata, "cached_content_token_count")
        return _build_usage(prompt, completion, 0, cache_hit_raw, None)

    usage = _g(raw, "usage")
    if usage is None:
        return None

    if _g(usage, "input_tokens") is not None or _g(usage, "output_tokens") is not None:
        input_tokens = _coerce_int(_g(usage, "input_tokens"))
        output_tokens = _coerce_int(_g(usage, "output_tokens"))
        cache_read_raw = _g(usage, "cache_read_input_tokens")
        cache_creation = _coerce_int(_g(usage, "cache_creation_input_tokens"))
        prompt = input_tokens + _coerce_int(cache_read_raw) + cache_creation
        # Anthropic ALWAYS reports cache_read_input_tokens (0 unless a cache_control breakpoint
        # was sent -- which this codebase never does). Reporting hit=0 / miss=prompt every turn
        # would render as a misleading, permanent "0%" cache rate; when there is NO cache activity
        # at all, pass the hit as absent so `_build_usage` leaves both hit and miss at 0 and the
        # HUD shows the honest "—" (not-applicable) instead. A real cache hit (read/creation > 0)
        # still flows through as a genuine rate. (Contrast DeepSeek, which auto-caches: a cold 0%
        # there IS information, so its explicit miss count is preserved below.)
        cache_active = _coerce_int(cache_read_raw) > 0 or cache_creation > 0
        return _build_usage(prompt, output_tokens, 0, cache_read_raw if cache_active else None, None)

    model_extra = _g(usage, "model_extra") or {}
    cache_hit_raw = _g(usage, "prompt_cache_hit_tokens")
    if cache_hit_raw is None:
        cache_hit_raw = _g(model_extra, "prompt_cache_hit_tokens")
    if cache_hit_raw is None:
        details = _g(usage, "prompt_tokens_details")
        if details is not None:
            cache_hit_raw = _g(details, "cached_tokens")
    cache_miss_raw = _g(usage, "prompt_cache_miss_tokens")
    if cache_miss_raw is None:
        cache_miss_raw = _g(model_extra, "prompt_cache_miss_tokens")

    return _build_usage(
        _coerce_int(_g(usage, "prompt_tokens")),
        _coerce_int(_g(usage, "completion_tokens")),
        _coerce_int(_g(usage, "total_tokens")),
        cache_hit_raw,
        cache_miss_raw,
    )


# Case-insensitive substring -> context-window (tokens) lookup for the status-bar
# context% meter. Small and deliberately coarse (a family's exact window varies by
# minor version) -- good enough for a "how full is context" indicator, not billing.
_CONTEXT_WINDOWS: tuple[tuple[str, int], ...] = (
    ("deepseek", 65536),
    ("gpt-5", 256000),
    ("gpt-4o", 128000),
    ("gpt-4.1", 128000),
    ("o1", 128000),
    ("o3", 128000),
    ("claude", 200000),
    ("gemini", 1000000),
)
_DEFAULT_CONTEXT_WINDOW = 128000


def context_window_for(model: str) -> int:
    """Best-effort context-window size (tokens) for `model`.

    Case-insensitive substring match against `_CONTEXT_WINDOWS`; falls back to
    `_DEFAULT_CONTEXT_WINDOW` for anything unrecognized (a custom/local model,
    an unfamiliar provider's naming).
    """
    lowered = (model or "").lower()
    for needle, window in _CONTEXT_WINDOWS:
        if needle in lowered:
            return window
    return _DEFAULT_CONTEXT_WINDOW


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
