"""ChatGPT subscription LLM via the ChatGPT backend Responses API.

Uses a subscription OAuth bearer (not a platform API key). Wire format mirrors
LiteLLM's ``chatgpt`` provider: ``POST {CHATGPT_API_BASE}/responses`` with
``Authorization: Bearer …`` and ``ChatGPT-Account-Id``.

Translates OpenAI chat-completions messages/tools ⇄ Responses API so the KP
function-calling loop is unchanged.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Awaitable, Callable
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

import httpx

from infra.config import LLMSettings
from infra.llm import ChatResult, ToolCall, _parse_tool_arguments, parse_usage
from infra.oauth_flows import CHATGPT_RESPONSES_URL, OAuthError, TokenManager

TokenProvider = Callable[[], Awaitable[str]]

_AUTH_SIGNALS = frozenset(
    {
        "authentication_error",
        "access_token_expired",
        "invalid_api_key",
        "invalid_token",
        "permission_denied",
        "token_expired",
        "unauthorized",
    }
)
_QUOTA_SIGNALS = frozenset(
    {
        "billing_hard_limit",
        "insufficient_quota",
        "quota_exceeded",
        "usage_limit",
    }
)
_CONTENT_SIGNALS = frozenset(
    {
        "content_filter",
        "context_length_exceeded",
        "input_too_long",
        "invalid_prompt",
        "max_output_tokens",
    }
)
_TRANSIENT_SIGNALS = frozenset(
    {
        "cancelled",
        "internal_error",
        "overloaded",
        "rate_limit",
        "rate_limit_exceeded",
        "server_error",
        "service_unavailable",
        "temporarily_unavailable",
        "timeout",
    }
)


def _normalized_signal(value: Any) -> str:
    return str(value).strip().casefold().replace("-", "_").replace(".", "_").replace(" ", "_")


def _error_signals(payload: Any) -> set[str]:
    """Extract stable code/type/reason fields without classifying free-form text."""
    signals: set[str] = set()
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in {"code", "type", "reason", "status"} and isinstance(value, (str, int)):
                normalized = _normalized_signal(value)
                if normalized:
                    signals.add(normalized)
            if isinstance(value, (dict, list)):
                signals.update(_error_signals(value))
    elif isinstance(payload, list):
        for value in payload:
            signals.update(_error_signals(value))
    return signals


def _matches_signal(signals: set[str], candidates: frozenset[str]) -> bool:
    return any(signal == candidate or signal.startswith(f"{candidate}_") for signal in signals for candidate in candidates)


def _classify_provider_error(payload: dict[str, Any]) -> str:
    signals = _error_signals(payload)
    if _matches_signal(signals, _QUOTA_SIGNALS):
        return "quota"
    if _matches_signal(signals, _AUTH_SIGNALS):
        return "auth"
    if _matches_signal(signals, _CONTENT_SIGNALS):
        return "content"
    if _matches_signal(signals, _TRANSIENT_SIGNALS):
        return "transient"
    # A terminal provider event with no recognized stable code is normally a
    # server-side interruption. Malformed/non-terminal streams still raise the
    # plain OAuthError below and are deliberately not retried.
    return "transient"


def _first_error_field(payload: Any, field: str) -> str:
    if isinstance(payload, dict):
        value = payload.get(field)
        if isinstance(value, (str, int)) and str(value).strip():
            return str(value).strip()
        for nested in payload.values():
            found = _first_error_field(nested, field)
            if found:
                return found
    elif isinstance(payload, list):
        for nested in payload:
            found = _first_error_field(nested, field)
            if found:
                return found
    return ""


class ProviderResponseError(OAuthError):
    """A terminal provider event with preserved structured diagnostic data."""

    def __init__(
        self,
        event_type: str,
        payload: dict[str, Any],
        *,
        code: str = "subscription_bad_response",
    ) -> None:
        copied = deepcopy(payload)
        category = _classify_provider_error(copied)
        details = [event_type]
        for field in ("code", "reason", "message"):
            value = _first_error_field(copied, field)
            if value:
                details.append(f"{field}={value[:300]}")
        super().__init__(
            code,
            f"{code}: {'; '.join(details)}",
        )
        self.event_type = event_type
        self.payload = copied
        self.category = category


def _http_status_signal(status_code: int) -> str:
    if status_code == 402:
        return "insufficient_quota"
    if status_code in {401, 403}:
        return "permission_denied"
    if status_code == 408:
        return "timeout"
    if status_code == 413:
        return "input_too_long"
    if status_code in {425, 429}:
        return "rate_limit"
    if status_code >= 500:
        return "server_error"
    return "invalid_prompt"


def _http_error_payload(response: httpx.Response) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "http_error",
        "status": _http_status_signal(response.status_code),
        "http_status": response.status_code,
    }
    try:
        provider_payload = response.json()
    except Exception:
        provider_payload = None
    if isinstance(provider_payload, (dict, list)):
        payload["provider"] = provider_payload
    return payload


def _transport_error_payload(exc: httpx.HTTPError) -> dict[str, Any]:
    signal = "timeout" if isinstance(exc, httpx.TimeoutException) else "service_unavailable"
    return {"type": "transport_error", "error": {"code": signal}}


@dataclass
class _ContinuationRound:
    """One raw Responses output group that led to tool dispatch."""

    output_items: list[dict[str, Any]]
    call_ids: frozenset[str]


@dataclass
class _Continuation:
    """All tool-call output groups tied to one agent message list."""

    messages: list[dict]
    rounds: list[_ContinuationRound]
    session_id: str
    turn_state: str = ""


class ChatGPTSubscriptionLLM:
    """``LLMClient`` backed by ChatGPT subscription Responses API."""

    def __init__(
        self,
        settings: LLMSettings,
        *,
        token_manager: TokenManager,
        client: httpx.AsyncClient | None = None,
        responses_url: str = CHATGPT_RESPONSES_URL,
        timeout: float = 120.0,
    ) -> None:
        self._settings = settings
        self._token_manager = token_manager
        self._client = client
        self._owns_client = client is None
        self._responses_url = responses_url
        self._timeout = timeout
        # The agent loop keeps one list object for all tool rounds in a turn.
        # Keying by that identity isolates simultaneous rooms without exposing a
        # provider-specific continuation field in the generic chat messages.
        self._continuations: dict[int, _Continuation] = {}

    async def aclose(self) -> None:
        self._continuations.clear()
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    def clear_continuation(self, messages: list[dict]) -> None:
        """Release provider state when its owning agent turn has ended."""
        continuation = self._continuations.get(id(messages))
        if continuation is not None and continuation.messages is messages:
            self._continuations.pop(id(messages), None)

    async def chat(
        self,
        messages: list[dict],
        *,
        tools: list[dict] | None = None,
        tool_choice: str | dict | None = None,
        temperature: float | None = None,
        model: str | None = None,
    ) -> ChatResult:
        del temperature  # ChatGPT backend rejects temperature / token limits.
        continuation = self._continuations.get(id(messages))
        if continuation is not None and continuation.messages is not messages:
            self._continuations.pop(id(messages), None)
            continuation = None
        body = messages_to_responses_body(
            messages,
            model=model or self._settings.chat_model,
            tools=tools,
            tool_choice=tool_choice,
            continuation_rounds=continuation.rounds if continuation is not None else None,
        )
        session_id = continuation.session_id if continuation is not None else str(uuid.uuid4())
        turn_state = continuation.turn_state if continuation is not None else ""
        result, response_turn_state = await self._request_with_refresh(
            body,
            session_id=session_id,
            turn_state=turn_state,
        )
        if result.tool_calls:
            self._remember_continuation(
                messages,
                result,
                session_id=session_id,
                turn_state=response_turn_state or turn_state,
            )
        else:
            self.clear_continuation(messages)
        return result

    def _remember_continuation(
        self,
        messages: list[dict],
        result: ChatResult,
        *,
        session_id: str,
        turn_state: str,
    ) -> None:
        if not result.tool_calls:
            return
        if not isinstance(result.raw, dict):
            self.clear_continuation(messages)
            raise OAuthError("subscription_bad_response")
        output_items = [deepcopy(item) for item in result.raw.get("output") or [] if isinstance(item, dict)]
        call_ids = frozenset(
            str(item.get("call_id") or item.get("id") or "")
            for item in output_items
            if item.get("type") in {"function_call", "tool_call"}
            and (item.get("call_id") or item.get("id"))
        )
        expected = {call.id for call in result.tool_calls}
        if not output_items or not expected or expected != call_ids:
            self.clear_continuation(messages)
            raise OAuthError("subscription_bad_response")
        new_round = _ContinuationRound(output_items, call_ids)
        continuation = self._continuations.get(id(messages))
        if continuation is not None and continuation.messages is messages:
            continuation.rounds.append(new_round)
            continuation.turn_state = turn_state
        else:
            self._continuations[id(messages)] = _Continuation(
                messages,
                [new_round],
                session_id=session_id,
                turn_state=turn_state,
            )

    async def _request_with_refresh(
        self,
        body: dict[str, Any],
        *,
        session_id: str,
        turn_state: str,
    ) -> tuple[ChatResult, str]:
        auth_refreshed = False
        transient_retried = False
        while True:
            try:
                return await self._post(body, session_id=session_id, turn_state=turn_state)
            except _AuthHTTPError as exc:
                if auth_refreshed:
                    raise OAuthError("subscription_relogin_required") from exc
                auth_refreshed = True
                await self._token_manager.force_refresh()
            except ProviderResponseError as exc:
                if exc.category != "transient" or transient_retried:
                    raise
                transient_retried = True

    async def _post(
        self,
        body: dict[str, Any],
        *,
        session_id: str,
        turn_state: str,
    ) -> tuple[ChatResult, str]:
        access = await self._token_manager.access_token()
        account_id = self._token_manager.token.account_id
        headers = {
            "Authorization": f"Bearer {access}",
            "content-type": "application/json",
            "accept": "text/event-stream",
            # ChatGPT's Codex backend accepts recognizable ``Codex `` clients.
            # Keep Loreweaver attribution instead of impersonating the CLI.
            "originator": "Codex Loreweaver",
            "User-Agent": "Codex Loreweaver",
            "session_id": session_id,
        }
        if account_id:
            headers["ChatGPT-Account-Id"] = account_id
        if turn_state:
            # ChatGPT returns this sticky-routing token on the first request in
            # a turn and requires it on every subsequent tool continuation.
            headers["x-codex-turn-state"] = turn_state

        client = self._client
        close = False
        if client is None:
            client = httpx.AsyncClient(timeout=self._timeout)
            close = True
        try:
            # ChatGPT's Codex backend requires streaming Responses requests.
            payload = {**body, "stream": True}
            resp = await client.post(self._responses_url, headers=headers, json=payload)
            if resp.status_code == 401:
                raise _AuthHTTPError()
            if resp.status_code < 200 or resp.status_code >= 300:
                # Some backends force SSE even when stream=false — retry as stream.
                if "text/event-stream" in (resp.headers.get("content-type") or ""):
                    return (
                        responses_payload_to_chat_result(_aggregate_sse(resp.text)),
                        resp.headers.get("x-codex-turn-state", ""),
                    )
                raise ProviderResponseError(
                    "http.error",
                    _http_error_payload(resp),
                    code="subscription_http_error",
                )

            content_type = (resp.headers.get("content-type") or "").lower()
            text = resp.text or ""
            if "text/event-stream" in content_type or text.lstrip().startswith(("event:", "data:")):
                data = _aggregate_sse(text)
            else:
                try:
                    data = resp.json()
                except Exception as exc:
                    raise OAuthError("subscription_bad_response") from exc
            return (
                responses_payload_to_chat_result(data),
                resp.headers.get("x-codex-turn-state", ""),
            )
        except _AuthHTTPError:
            raise
        except OAuthError:
            raise
        except httpx.HTTPError as exc:
            raise ProviderResponseError(
                "transport.error",
                _transport_error_payload(exc),
                code="subscription_http_error",
            ) from exc
        finally:
            if close:
                await client.aclose()


class _AuthHTTPError(Exception):
    """Internal: signal 401 so the caller can refresh once."""


# ---------------------------------------------------------------------------
# messages ⇄ Responses API
# ---------------------------------------------------------------------------


def messages_to_responses_body(
    messages: list[dict],
    *,
    model: str,
    tools: list[dict] | None = None,
    tool_choice: str | dict | None = None,
    continuation_rounds: list[_ContinuationRound] | None = None,
) -> dict[str, Any]:
    """Translate OpenAI chat messages/tools into a Responses API request body."""
    instructions_parts: list[str] = []
    input_items: list[dict[str, Any]] = []
    replayed_rounds: set[int] = set()

    for message in messages:
        role = message.get("role")
        if role == "system":
            text = _content_to_text(message.get("content"))
            if text:
                instructions_parts.append(text)
            continue
        if role == "user":
            text = _content_to_text(message.get("content"))
            input_items.append(
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": text}],
                }
            )
            continue
        if role == "assistant":
            calls = message.get("tool_calls") or []
            message_call_ids = {
                str(call.get("id") or call.get("call_id") or "")
                for call in calls
                if isinstance(call, dict) and (call.get("id") or call.get("call_id"))
            }
            matching_round = next(
                (
                    (index, raw_round)
                    for index, raw_round in enumerate(continuation_rounds or [])
                    if index not in replayed_rounds and message_call_ids == raw_round.call_ids
                ),
                None,
            )
            if message_call_ids and matching_round is not None:
                # Replay every output item exactly as returned. This preserves
                # encrypted reasoning plus provider item ids/status fields and
                # replaces the lossy chat-message reconstruction for this round.
                round_index, raw_round = matching_round
                input_items.extend(deepcopy(raw_round.output_items))
                replayed_rounds.add(round_index)
                continue
            text = _content_to_text(message.get("content"))
            if text:
                input_items.append(
                    {
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": text}],
                    }
                )
            for call in calls:
                function = call.get("function") if isinstance(call, dict) else {}
                if not isinstance(function, dict):
                    function = {}
                name = function.get("name") or call.get("name") or ""
                args = function.get("arguments", call.get("arguments", {}))
                if isinstance(args, dict):
                    args_str = json.dumps(args, ensure_ascii=False)
                else:
                    args_str = str(args or "{}")
                call_id = call.get("id") or call.get("call_id") or f"call_{uuid.uuid4().hex[:12]}"
                input_items.append(
                    {
                        "type": "function_call",
                        "call_id": call_id,
                        "name": name,
                        "arguments": args_str,
                    }
                )
            continue
        if role == "tool":
            call_id = message.get("tool_call_id") or message.get("id") or ""
            output = _content_to_text(message.get("content"))
            input_items.append(
                {
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output,
                }
            )
            continue
        # Unknown roles → treat as user text.
        text = _content_to_text(message.get("content"))
        if text:
            input_items.append(
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": text}],
                }
            )

    if continuation_rounds and len(replayed_rounds) != len(continuation_rounds):
        # Sending a partial stateless history would orphan encrypted reasoning
        # items. Fail locally instead of issuing a request the backend rejects.
        raise OAuthError("subscription_bad_response")

    body: dict[str, Any] = {
        "model": model,
        "input": input_items,
        "store": False,
        "include": ["reasoning.encrypted_content"],
    }
    if instructions_parts:
        body["instructions"] = "\n\n".join(instructions_parts)

    responses_tools = tools_to_responses(tools)
    if responses_tools:
        body["tools"] = responses_tools
    if tool_choice is not None:
        body["tool_choice"] = _map_tool_choice(tool_choice)
    return body


def tools_to_responses(tools: list[dict] | None) -> list[dict[str, Any]]:
    """OpenAI chat tool schema → Responses flat function tools."""
    out: list[dict[str, Any]] = []
    for tool in tools or []:
        function = tool.get("function", tool) if isinstance(tool, dict) else {}
        if not isinstance(function, dict):
            continue
        name = function.get("name")
        if not name:
            continue
        entry: dict[str, Any] = {
            "type": "function",
            "name": name,
            "description": function.get("description") or "",
        }
        params = function.get("parameters")
        if isinstance(params, dict):
            entry["parameters"] = params
        out.append(entry)
    return out


def responses_payload_to_chat_result(data: dict[str, Any] | None) -> ChatResult:
    """Map a Responses API JSON payload (or completed SSE object) to ChatResult."""
    if not isinstance(data, dict):
        return ChatResult(content=None, tool_calls=[], raw=data, usage=None)

    # Nested ``response`` object (SSE response.completed) or top-level.
    payload = data.get("response") if isinstance(data.get("response"), dict) else data
    if not isinstance(payload, dict):
        payload = data
    status = str(payload.get("status") or "")
    if status and status != "completed":
        event_type = f"response.{status}"
        raise ProviderResponseError(event_type, {"type": event_type, "response": payload})
    if payload.get("error"):
        raise ProviderResponseError("response.error", {"type": "response.error", "response": payload})

    content_parts: list[str] = []
    tool_calls: list[ToolCall] = []
    for item in payload.get("output") or []:
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        if item_type == "message" or item.get("role") == "assistant":
            for block in item.get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") in {"output_text", "text"} and block.get("text"):
                    content_parts.append(str(block["text"]))
            continue
        if item_type in {"function_call", "tool_call"}:
            name = str(item.get("name") or "")
            call_id = str(item.get("call_id") or item.get("id") or f"call_{uuid.uuid4().hex[:12]}")
            args_raw = item.get("arguments")
            if isinstance(args_raw, dict):
                arguments = args_raw
            else:
                arguments = _parse_tool_arguments(str(args_raw) if args_raw is not None else None)
            tool_calls.append(ToolCall(id=call_id, name=name, arguments=arguments))
            continue

    content = "\n".join(content_parts) if content_parts else None
    # Build a usage-shaped object parse_usage understands (input/output tokens).
    usage_obj = payload.get("usage")
    usage = parse_usage({"usage": usage_obj} if usage_obj is not None else payload)
    return ChatResult(content=content, tool_calls=tool_calls, raw=payload, usage=usage)


def _aggregate_sse(body_text: str) -> dict[str, Any]:
    """Pull the final response object out of an SSE Responses stream."""
    completed: dict[str, Any] | None = None
    output_items: list[dict[str, Any]] = []
    for line in body_text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        raw = line[5:].strip()
        if not raw or raw == "[DONE]":
            continue
        try:
            chunk = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(chunk, dict):
            continue
        event_type = str(chunk.get("type") or "")
        if event_type in {
            "error",
            "response.error",
            "response.cancelled",
            "response.failed",
            "response.incomplete",
        }:
            raise ProviderResponseError(event_type, chunk)
        if event_type == "response.output_item.done":
            item = chunk.get("item")
            if isinstance(item, dict):
                output_items.append(deepcopy(item))
        elif event_type == "response.completed":
            response = chunk.get("response")
            if isinstance(response, dict):
                if response.get("status") not in {None, "completed"} or response.get("error"):
                    raise ProviderResponseError(event_type, chunk)
                completed = response
            else:
                completed = chunk
    if completed is None:
        raise OAuthError("subscription_bad_response")
    completed = deepcopy(completed)
    if completed.get("status") not in {None, "completed"}:
        raise ProviderResponseError(
            "response.completed",
            {"type": "response.completed", "response": completed},
        )
    if output_items:
        # ``output_item.done`` contains fields such as encrypted_content that
        # may be omitted from the final response summary. Use the summary's
        # ordering while preferring the richer done item with the same id.
        done_by_id = {
            str(item.get("id")): item
            for item in output_items
            if item.get("id") is not None
        }
        merged: list[dict[str, Any]] = []
        used_ids: set[str] = set()
        for item in completed.get("output") or []:
            if not isinstance(item, dict):
                continue
            item_id = str(item.get("id")) if item.get("id") is not None else ""
            if item_id and item_id in done_by_id:
                merged.append(done_by_id[item_id])
                used_ids.add(item_id)
            else:
                merged.append(deepcopy(item))
        merged.extend(
            item
            for item in output_items
            if not item.get("id") or str(item.get("id")) not in used_ids
        )
        completed["output"] = merged
    return completed


def _content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                if block.get("type") in {"text", "input_text", "output_text"} and block.get("text"):
                    parts.append(str(block["text"]))
                elif "text" in block:
                    parts.append(str(block["text"]))
        return "".join(parts)
    return str(content)


def _map_tool_choice(tool_choice: str | dict) -> str | dict:
    if isinstance(tool_choice, str):
        return tool_choice
    if isinstance(tool_choice, dict):
        # chat: {"type":"function","function":{"name":"x"}} → responses: {"type":"function","name":"x"}
        if tool_choice.get("type") == "function":
            function = tool_choice.get("function") or {}
            name = function.get("name") if isinstance(function, dict) else None
            if name:
                return {"type": "function", "name": name}
        return tool_choice
    return "auto"
