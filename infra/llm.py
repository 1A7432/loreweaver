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

# Private message keys: metadata the AGENT layer attaches to a message, which must
# never reach a vendor's wire.
#
# `_lw_cache_breakpoint` (M20 A1) marks a message as the END of a cacheable prefix.
# It is MESSAGE-level, not a character offset into one message: the layout is
# `[system: stable] [history] [state: volatile] [user]`, so the two boundaries worth
# caching fall between whole messages (end of the system message, end of history).
# The Anthropic adapter turns each mark into an explicit `cache_control` breakpoint
# (the API allows up to 4; the loop sets 2); OpenAI-compatible endpoints cache by
# prefix automatically and simply have the key stripped.
#
# `_lw_turn` stamps a persisted history message with the room turn that produced it,
# so the chronicle fold can drop exactly the turns it has folded into the rolling
# summary. Unlike the other two it IS persisted (into the room's history blob) — the
# shared rule it obeys is only "strip before the wire".
#
# `provider_blocks` predates both and follows the same rule.
CACHE_BREAKPOINT_KEY = "_lw_cache_breakpoint"
HISTORY_TURN_KEY = "_lw_turn"
PRIVATE_MESSAGE_KEYS = frozenset({CACHE_BREAKPOINT_KEY, HISTORY_TURN_KEY, "provider_blocks"})


def wire_messages(messages: list[dict]) -> list[dict]:
    """`messages` with every private key removed — what an OpenAI-compatible endpoint
    may actually be sent. A vendor rejects unknown message properties, so this is the
    difference between "extra metadata" and "HTTP 400 on every turn"."""
    if not any(key in message for message in messages for key in PRIVATE_MESSAGE_KEYS):
        return messages
    return [{key: value for key, value in message.items() if key not in PRIVATE_MESSAGE_KEYS} for message in messages]


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

    `estimated` marks a reading nobody measured: `parse_usage` NEVER sets it (a
    provider-reported number is measured by definition), and the agent loop sets
    it when it had to size the assembled prompt itself because the endpoint
    reported nothing. It rides with the numbers rather than beside them so no
    consumer can read the tokens without also being able to see where they came
    from — `infra.usage_stats` persists the flag, and the chronicle fold's re-arm
    check refuses to compare a measured reading against an estimated one.
    """

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cache_hit_tokens: int = 0
    cache_miss_tokens: int = 0
    estimated: bool = False


@dataclass
class ChatResult:
    content: str | None
    tool_calls: list[ToolCall]  # [] when none
    raw: Any = None
    usage: Usage | None = None  # best-effort `parse_usage(raw)`; None when unavailable/unparsed
    # Raw provider content blocks for FAITHFUL same-turn replay, when the provider requires
    # it (Anthropic extended thinking: the signed thinking blocks must ride back with their
    # assistant turn during the tool loop). Ephemeral by construction — the loop's persisted
    # history keeps only user text + final reply, so these never reach the store.
    provider_blocks: Any = None


class LLMClient(Protocol):
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
        reasoning_effort: str | None = None,
        on_text_delta: Callable[[str], None] | None = None,
    ) -> ChatResult:
        if self._token_provider is not None:
            token = await self._token_provider()
            self._client.api_key = token
        kwargs: dict[str, Any] = {
            "model": model or self._settings.chat_model,
            "messages": wire_messages(messages),
        }
        if tools:
            kwargs["tools"] = tools
        if tool_choice is not None:
            kwargs["tool_choice"] = tool_choice
        if self._settings.reasoning_effort:
            # Reasoning models (deepseek-v4-pro, o-series) take a thinking budget and
            # ignore/reject `temperature`, so send one xor the other. A per-call override
            # (e.g. an NPC line's dramatic weight) engages only when the deployment opted
            # into reasoning at all — the operator's off switch always wins.
            kwargs["reasoning_effort"] = reasoning_effort or self._settings.reasoning_effort
        else:
            effective_temperature = self._settings.temperature if temperature is None else temperature
            if effective_temperature is not None:
                kwargs["temperature"] = effective_temperature

        if on_text_delta is None:
            response = await self._client.chat.completions.create(**kwargs)
            if not response.choices:
                return ChatResult(content=None, tool_calls=[], raw=response, usage=parse_usage(response))

            message = response.choices[0].message
            tool_calls = [
                ToolCall(id=call.id, name=call.function.name, arguments=_parse_tool_arguments(call.function.arguments))
                for call in (message.tool_calls or [])
            ]
            return ChatResult(content=message.content, tool_calls=tool_calls, raw=response, usage=parse_usage(response))

        # Streaming path: text deltas reach the caller as they generate; tool calls are
        # reassembled from their indexed argument fragments.
        #
        # `stream_options={"include_usage": True}` is what makes a streamed turn report
        # its tokens at all: the vendor then sends ONE extra final chunk whose `choices`
        # is empty and whose `usage` covers the whole request. It is part of the OpenAI
        # Chat Completions API and documented verbatim by the providers this project runs
        # on (DeepSeek, Moonshot), so it is sent unconditionally rather than probed for.
        # It is not optional garnish: the room's usage meter is the chronicle fold's
        # trigger, so a streaming room that reports nothing never trims its history and
        # eventually walks into the provider's real context ceiling. An endpoint that
        # rejects unknown parameters is the operator's `TRPG_LLM__STREAM_USAGE=false`,
        # after which `agent.loop` meters the turn with an ESTIMATE instead.
        kwargs["stream"] = True
        if self._settings.stream_usage:
            kwargs["stream_options"] = {"include_usage": True}
        content_parts: list[str] = []
        slots: dict[int, dict[str, str]] = {}
        usage: Usage | None = None
        stream = await self._client.chat.completions.create(**kwargs)
        async for chunk in stream:
            # Before the choices guard, never after: the usage-bearing chunk is exactly
            # the one with no choices. Last non-empty parse wins — a vendor that repeats
            # a cumulative usage on every chunk then reports its final figure, and one
            # that sends `usage: null` on the others (DeepSeek's documented shape) is
            # unaffected because `parse_usage` reads those as "nothing here".
            chunk_usage = parse_usage(chunk)
            if chunk_usage is not None:
                usage = chunk_usage
            if not getattr(chunk, "choices", None):
                continue
            delta = chunk.choices[0].delta
            if delta is None:
                continue
            if delta.content:
                content_parts.append(delta.content)
                on_text_delta(delta.content)
            for call in delta.tool_calls or []:
                slot = slots.setdefault(call.index or 0, {"id": "", "name": "", "arguments": ""})
                if call.id:
                    slot["id"] = call.id
                if call.function and call.function.name:
                    slot["name"] = call.function.name
                if call.function and call.function.arguments:
                    slot["arguments"] += call.function.arguments
        tool_calls = [
            ToolCall(id=slot["id"], name=slot["name"], arguments=_parse_tool_arguments(slot["arguments"]))
            for _, slot in sorted(slots.items())
        ]
        return ChatResult(content="".join(content_parts) or None, tool_calls=tool_calls, raw=None, usage=usage)


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
        # Anthropic ALWAYS reports cache_read_input_tokens (0 when nothing was cached yet --
        # e.g. a cold first turn, before the M20 A breakpoints that every KP turn now sends
        # have written anything). Reporting hit=0 / miss=prompt on such a turn
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


# Case-insensitive substring -> context-window (tokens), verified against each vendor's
# OWN documentation (checked 2026-08-11; source noted per row). This started life as a
# status-bar indicator where a coarse guess was harmless, and M18 then made it the
# DENOMINATOR of the chronicle fold policy — at which point a stale row stopped being
# cosmetic. The 65536 this table used to carry for DeepSeek was ~16x under the real
# window, so a v4 room folded and trimmed its raw history at ~4% of actual capacity;
# M21's auto-fed records are what turned that latent error into daily damage. Re-verify
# these against the vendor docs whenever a model family is added.
_CONTEXT_WINDOWS: tuple[tuple[str, int], ...] = (
    # DeepSeek — api-docs.deepseek.com: v4-pro/v4-flash 1M context, 384K max output.
    ("deepseek-v4", 1_000_000),
    # Moonshot — platform.kimi.ai: k3 is 1M, but every k2.x is 256K. One "kimi" needle
    # would misjudge whichever it did not name, which is why matching is longest-first.
    ("kimi-k3", 1_000_000),
    ("kimi-k2", 256_000),
    # OpenAI — developers.openai.com: the gpt-5.6 family documents "1.05M tokens".
    ("gpt-5.6", 1_050_000),
    ("gpt-5", 256_000),
    ("gpt-4o", 128_000),
    ("gpt-4.1", 128_000),
    ("o1", 128_000),
    ("o3", 128_000),
    # xAI — docs.x.ai: 4.5 is 500K while 4.3 and 4.20 are 1M; not one family window.
    ("grok-4.5", 500_000),
    ("grok-4.3", 1_000_000),
    ("grok-4.20", 1_000_000),
    ("grok-build", 256_000),
    # Anthropic — Opus 5 / Opus 4.8 / Sonnet 5 / Fable 5 / Mythos 5 are 1M; Haiku 4.5
    # stayed at 200K, so the specific needle has to outrank the family one.
    ("claude-haiku", 200_000),
    ("claude", 1_000_000),
    # Google — ai.google.dev states "1 million or more tokens" without publishing a
    # per-model figure on a fetchable page, so this is a documented FLOOR, not an exact
    # window. Set the knob below if a room runs a larger Gemini.
    ("gemini", 1_000_000),
)
# Deliberately conservative, and deliberately NOT raised to match the modern families
# above: an unknown model is unknown in both directions. Guessing too HIGH lets a prompt
# grow past the real limit and the turn dies on a provider error; guessing too LOW only
# folds earlier than needed, which degrades rather than breaks. `context_window` in
# `TRPG_LLM__*` is the answer for anything this table cannot name.
_DEFAULT_CONTEXT_WINDOW = 128_000


def context_window_for(model: str, override: int = 0) -> int:
    """Context-window size (tokens) for `model`, or the operator's `override`.

    `override` (config `TRPG_LLM__CONTEXT_WINDOW`, 0 = auto) wins outright: no lookup
    table survives contact with a vendor's release schedule, so the operator gets the
    last word rather than waiting on a table edit. Auto-detection is the default because
    it follows a RUNTIME model switch correctly — the model screen changes the model
    name, and the window follows it — where a pinned number would silently describe the
    model the room used to run.

    Matching is case-insensitive substring, LONGEST NEEDLE FIRST. Longest-first is not a
    tidiness preference: `kimi-k3` (1M) and `kimi-k2` (256K), `grok-4.5` (500K) and
    `grok-4.3` (1M), `claude-haiku` (200K) and `claude` (1M) all share a prefix with a
    sibling that has a different window, and a first-match-in-tuple-order rule would make
    the file's line order load-bearing for correctness.
    """
    if override > 0:
        return override
    lowered = (model or "").lower()
    for needle, window in sorted(_CONTEXT_WINDOWS, key=lambda row: -len(row[0])):
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
        self.reasoning_efforts: list[str | None] = []

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
        self.calls.append((messages, tools))
        self.tool_choices.append(tool_choice)
        self.reasoning_efforts.append(reasoning_effort)
        if self._script is not None:
            if not self._script:
                raise RuntimeError(t("infra.llm.fake_script_exhausted"))
            result = self._script.popleft()
        elif self._responder is not None:
            result = self._responder(messages, tools)
        else:
            raise RuntimeError(t("infra.llm.fake_not_configured"))
        if on_text_delta is not None and result.content:
            # Mimic a real stream: the reply arrives in two slices so accumulation is tested.
            middle = max(1, len(result.content) // 2)
            on_text_delta(result.content[:middle])
            on_text_delta(result.content[middle:])
        return result


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
