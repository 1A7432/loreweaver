"""Offline tests for ChatGPTSubscriptionLLM (official openai SDK Responses surface).

The fake below stands in for ``openai.AsyncOpenAI``: ``responses.with_raw_response.create``
records kwargs + the bearer in force, and returns (headers, events) outcomes — events are
dicts with attribute access and ``model_dump`` so the client's SDK-object handling is the
code path under test. Real ``openai`` exception classes exercise the error mapping.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import httpx
import openai
import pytest

from infra.config import LLMSettings
from infra.llm_chatgpt import (
    ChatGPTSubscriptionLLM,
    messages_to_responses_body,
    responses_payload_to_chat_result,
    tools_to_responses,
)
from infra.oauth_flows import OAuthError, SubscriptionToken, TokenManager


class _StaticFlow:
    async def start(self):
        raise NotImplementedError

    async def poll(self, login):
        raise NotImplementedError

    async def refresh(self, token: SubscriptionToken) -> SubscriptionToken:
        return SubscriptionToken(
            access_token="refreshed-token",
            refresh_token=token.refresh_token,
            expires_at=time.time() + 3600,
            account_id=token.account_id,
        )


def _manager(access: str = "access-token", account_id: str = "acc-1") -> TokenManager:
    return TokenManager(
        SubscriptionToken(
            access_token=access,
            refresh_token="rt",
            expires_at=time.time() + 3600,
            account_id=account_id,
        ),
        _StaticFlow(),  # type: ignore[arg-type]
    )


class _Event(dict):
    """A wire event with SDK-object ergonomics: attribute access + model_dump."""

    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError as exc:  # pragma: no cover - attribute misuse in a test
            raise AttributeError(name) from exc

    def model_dump(self, **_: Any) -> dict[str, Any]:
        return {key: value for key, value in self.items() if value is not None}


class _FakeRaw:
    def __init__(self, headers: dict[str, str], events: list[dict]) -> None:
        self.headers = headers
        self._events = events

    def parse(self) -> _FakeStream:
        return _FakeStream(self._events)


class _FakeStream:
    def __init__(self, events: list[dict]) -> None:
        self._events = list(events)

    def __aiter__(self):
        return self._generate()

    async def _generate(self):
        for event in self._events:
            if isinstance(event, Exception):
                raise event
            yield _Event(event)


Outcome = "tuple[dict[str, str], list[dict]] | Exception"


class _FakeClient:
    """openai.AsyncOpenAI stand-in: respond(call_index, kwargs) -> (headers, events) | Exception."""

    def __init__(self, respond: Callable[[int, dict], Any]) -> None:
        self.api_key = ""
        self.calls: list[dict] = []
        self.api_keys: list[str] = []
        outer = self

        class _RawResponses:
            async def create(self, **kwargs: Any) -> _FakeRaw:
                outer.calls.append(kwargs)
                outer.api_keys.append(outer.api_key)
                outcome = respond(len(outer.calls), kwargs)
                if isinstance(outcome, Exception):
                    raise outcome
                headers, events = outcome
                return _FakeRaw(headers, events)

        self.responses = SimpleNamespace(with_raw_response=_RawResponses())


def _llm(respond: Callable[[int, dict], Any], manager: TokenManager | None = None) -> tuple[ChatGPTSubscriptionLLM, _FakeClient]:
    client = _FakeClient(respond)
    llm = ChatGPTSubscriptionLLM(
        LLMSettings(provider="chatgpt", chat_model="gpt-5.4"),
        token_manager=manager or _manager(),
        client=client,
    )
    return llm, client


def _completed(output: list[dict], usage: dict | None = None) -> dict:
    response: dict[str, Any] = {"id": "resp", "output": output}
    if usage is not None:
        response["usage"] = usage
    return {"type": "response.completed", "response": response}


def _message(text: str) -> dict:
    return {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}


def _request(url: str = "https://example.test/responses") -> httpx.Request:
    return httpx.Request("POST", url)


def _status_error(status_code: int, text: str = "provider rejected request") -> openai.APIStatusError:
    response = httpx.Response(status_code, text=text, request=_request())
    if status_code == 401:
        return openai.AuthenticationError("unauthorized", response=response, body=None)
    return openai.APIStatusError("http error", response=response, body=None)


# ---------------------------------------------------------------------------
# Pure conversion layer (unchanged by the SDK rebase)
# ---------------------------------------------------------------------------


def test_messages_tools_to_responses_golden():
    messages = [
        {"role": "system", "content": "You are the KP."},
        {"role": "user", "content": "Roll insight."},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "roll_dice", "arguments": '{"expr":"1d100"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": "42"},
    ]
    tools = [
        {
            "type": "function",
            "function": {
                "name": "roll_dice",
                "description": "Roll dice",
                "parameters": {"type": "object", "properties": {"expr": {"type": "string"}}},
            },
        }
    ]
    body = messages_to_responses_body(messages, model="gpt-5.4", tools=tools, tool_choice="auto")
    assert body["model"] == "gpt-5.4"
    assert body["instructions"] == "You are the KP."
    assert body["store"] is False
    assert body["include"] == ["reasoning.encrypted_content"]
    assert body["tool_choice"] == "auto"
    assert body["tools"] == tools_to_responses(tools)
    assert body["tools"][0]["name"] == "roll_dice"
    assert "function" not in body["tools"][0]  # flat Responses shape
    types = [item.get("type") or item.get("role") for item in body["input"]]
    assert "user" in types
    assert "function_call" in types
    assert "function_call_output" in types
    # No raw secrets
    blob = json.dumps(body)
    assert "access-token" not in blob


def test_responses_payload_to_chat_result_with_tool_calls_and_usage():
    payload = {
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "Rolling…"}],
            },
            {
                "type": "function_call",
                "call_id": "call_abc",
                "name": "roll_dice",
                "arguments": '{"expr":"1d20"}',
            },
        ],
        "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
    }
    result = responses_payload_to_chat_result(payload)
    assert result.content == "Rolling…"
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].id == "call_abc"
    assert result.tool_calls[0].name == "roll_dice"
    assert result.tool_calls[0].arguments == {"expr": "1d20"}
    assert result.usage is not None
    assert result.usage.prompt_tokens == 10
    assert result.usage.completion_tokens == 5


@pytest.mark.parametrize("status", ["failed", "incomplete", "cancelled", "in_progress"])
def test_responses_payload_rejects_noncompleted_status(status: str):
    with pytest.raises(OAuthError, match="subscription_bad_response"):
        responses_payload_to_chat_result({"status": status, "output": []})


# ---------------------------------------------------------------------------
# Transport via the official SDK surface
# ---------------------------------------------------------------------------


async def test_chatgpt_llm_creates_responses_and_parses():
    llm, client = _llm(lambda index, kwargs: ({}, [_completed([_message("Hello")], usage={"input_tokens": 1, "output_tokens": 1})]))

    result = await llm.chat([{"role": "user", "content": "hi"}])

    assert result.content == "Hello"
    # This backend is streaming-ONLY, and its `response.completed` event carries the
    # usage — so the room's meter (the chronicle fold's trigger) is fed here without
    # any OpenAI-chat-style opt-in parameter.
    assert result.usage is not None and result.usage.prompt_tokens == 1
    kwargs = client.calls[0]
    assert client.api_keys == ["access-token"]  # bearer lands on the SDK client per call
    assert kwargs["stream"] is True
    assert kwargs["model"] == "gpt-5.4"
    assert kwargs["store"] is False
    assert kwargs["include"] == ["reasoning.encrypted_content"]
    headers = kwargs["extra_headers"]
    assert headers["ChatGPT-Account-Id"] == "acc-1"
    assert headers["originator"] == "Codex Loreweaver"
    assert headers["User-Agent"] == "Codex Loreweaver"
    assert "x-codex-turn-state" not in headers


async def test_chatgpt_llm_streams_output_text_deltas():
    events = [
        {"type": "response.output_text.delta", "delta": "Hel"},
        {"type": "response.output_text.delta", "delta": "lo"},
        _completed([_message("Hello")]),
    ]
    llm, _ = _llm(lambda index, kwargs: ({}, list(events)))
    deltas: list[str] = []

    result = await llm.chat([{"role": "user", "content": "hi"}], on_text_delta=deltas.append)

    assert deltas == ["Hel", "lo"]
    assert result.content == "Hello"


async def test_chatgpt_llm_stream_replays_raw_reasoning_and_function_call_items():
    reasoning = {
        "id": "rs_1",
        "type": "reasoning",
        "summary": [],
        "encrypted_content": "cipher-A",
        "status": "completed",
    }
    function_call = {
        "id": "fc_1",
        "type": "function_call",
        "call_id": "call_1",
        "name": "roll_dice",
        "arguments": '{"expr":"1d20"}',
        "status": "completed",
    }

    def respond(index: int, kwargs: dict) -> Any:
        if index == 1:
            return (
                {"x-codex-turn-state": "sticky-turn-1"},
                [
                    {"type": "response.output_item.done", "item": reasoning},
                    {"type": "response.output_item.done", "item": function_call},
                    _completed([]),
                ],
            )
        return ({}, [_completed([_message("done")])])

    llm, client = _llm(respond)
    messages = [{"role": "user", "content": "roll"}]

    first = await llm.chat(messages)
    assert first.tool_calls[0].id == "call_1"
    messages.extend(
        [
            {
                "role": "assistant",
                "content": first.content,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "roll_dice", "arguments": '{"expr":"1d20"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "17"},
        ]
    )
    second = await llm.chat(messages)

    assert second.content == "done"
    first_headers = client.calls[0]["extra_headers"]
    second_headers = client.calls[1]["extra_headers"]
    assert first_headers["session_id"] == second_headers["session_id"]
    assert "x-codex-turn-state" not in first_headers
    assert second_headers["x-codex-turn-state"] == "sticky-turn-1"  # read from response headers
    assert client.calls[1]["input"][1:3] == [reasoning, function_call]
    assert client.calls[1]["input"][3] == {
        "type": "function_call_output",
        "call_id": "call_1",
        "output": "17",
    }


async def test_chatgpt_llm_replays_every_prior_raw_round_after_consecutive_tool_calls():
    raw_rounds = [
        [
            {
                "id": f"rs_{index}",
                "type": "reasoning",
                "encrypted_content": f"cipher-{index}",
                "status": "completed",
            },
            {
                "id": f"fc_{index}",
                "type": "function_call",
                "call_id": f"call_{index}",
                "name": "roll_dice",
                "arguments": f'{{"round":{index}}}',
                "status": "completed",
            },
        ]
        for index in (1, 2)
    ]

    def respond(index: int, kwargs: dict) -> Any:
        if index <= 2:
            return ({}, [_completed(raw_rounds[index - 1])])
        return ({}, [_completed([_message("complete")])])

    def append_tool_round(messages: list[dict], result, output: str) -> None:
        call = result.tool_calls[0]
        messages.extend(
            [
                {
                    "role": "assistant",
                    "content": result.content,
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {"name": call.name, "arguments": json.dumps(call.arguments)},
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": call.id, "content": output},
            ]
        )

    llm, client = _llm(respond)
    messages = [{"role": "user", "content": "use two tools"}]

    first = await llm.chat(messages)
    append_tool_round(messages, first, "first-output")
    second = await llm.chat(messages)
    append_tool_round(messages, second, "second-output")
    final = await llm.chat(messages)

    assert final.content == "complete"
    assert client.calls[1]["input"][1:3] == raw_rounds[0]
    assert client.calls[2]["input"][1:3] == raw_rounds[0]
    assert client.calls[2]["input"][4:6] == raw_rounds[1]
    assert llm._continuations == {}


async def test_chatgpt_llm_continuations_are_isolated_by_message_list():
    replayed: dict[str, str] = {}

    def respond(index: int, kwargs: dict) -> Any:
        body_input = kwargs["input"]
        output = next((item for item in body_input if item.get("type") == "function_call_output"), None)
        if output is not None:
            reasoning = next(item for item in body_input if item.get("type") == "reasoning")
            replayed[output["output"]] = reasoning["encrypted_content"]
            return ({}, [_completed([_message("done")])])
        suffix = body_input[0]["content"][0]["text"][-1]
        return (
            {},
            [
                _completed(
                    [
                        {"id": f"rs_{suffix}", "type": "reasoning", "encrypted_content": f"cipher-{suffix}"},
                        {
                            "id": f"fc_{suffix}",
                            "type": "function_call",
                            "call_id": "call_shared",
                            "name": "roll_dice",
                            "arguments": "{}",
                        },
                    ]
                )
            ],
        )

    llm, _ = _llm(respond)
    messages_a = [{"role": "user", "content": "session-A"}]
    messages_b = [{"role": "user", "content": "session-B"}]
    first_a, first_b = await asyncio.gather(llm.chat(messages_a), llm.chat(messages_b))
    for messages, result, output in ((messages_a, first_a, "tool-A"), (messages_b, first_b, "tool-B")):
        messages.extend(
            [
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_shared",
                            "type": "function",
                            "function": {"name": result.tool_calls[0].name, "arguments": "{}"},
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "call_shared", "content": output},
            ]
        )
    await asyncio.gather(llm.chat(messages_a), llm.chat(messages_b))

    assert replayed == {"tool-A": "cipher-A", "tool-B": "cipher-B"}
    assert llm._continuations == {}


async def test_chatgpt_llm_does_not_evict_active_continuations_and_clears_explicitly():
    def respond(index: int, kwargs: dict) -> Any:
        prompt = kwargs["input"][0]["content"][0]["text"]
        return (
            {},
            [
                _completed(
                    [
                        {"type": "reasoning", "id": f"rs_{prompt}", "encrypted_content": f"cipher-{prompt}"},
                        {
                            "type": "function_call",
                            "id": f"fc_{prompt}",
                            "call_id": f"call_{prompt}",
                            "name": "roll_dice",
                            "arguments": "{}",
                        },
                    ]
                )
            ],
        )

    llm, _ = _llm(respond)
    conversations = [[{"role": "user", "content": str(index)}] for index in range(130)]
    await asyncio.gather(*(llm.chat(messages) for messages in conversations))
    assert len(llm._continuations) == len(conversations)
    for messages in conversations:
        llm.clear_continuation(messages)
    assert llm._continuations == {}


@pytest.mark.parametrize(
    "terminal_event",
    ["error", "response.error", "response.cancelled", "response.failed", "response.incomplete"],
)
async def test_terminal_error_events_reject_the_turn(terminal_event: str):
    events = [
        {"type": "response.output_item.done", "item": {"type": "message"}},
        {"type": terminal_event, "error": {"code": "server_error"}},
    ]
    llm, client = _llm(lambda index, kwargs: ({}, list(events)))

    with pytest.raises(OAuthError) as exc:
        await llm.chat([{"role": "user", "content": "hi"}])

    assert exc.value.code == "subscription_bad_response"
    assert len(client.calls) == 2  # server_error classifies transient → one retry


@pytest.mark.parametrize(
    ("event", "category"),
    [
        (
            {
                "type": "error",
                "error": {"type": "authentication_error", "code": "invalid_token", "message": "login expired"},
            },
            "auth",
        ),
        (
            {
                "type": "response.failed",
                "response": {"status": "failed", "error": {"code": "insufficient_quota", "message": "quota exhausted"}},
            },
            "quota",
        ),
        (
            {
                "type": "response.incomplete",
                "response": {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}},
            },
            "content",
        ),
    ],
)
async def test_chatgpt_llm_preserves_terminal_error_payload_and_never_retries_non_transient(
    event: dict, category: str
):
    llm, client = _llm(lambda index, kwargs: ({}, [dict(event)]))

    with pytest.raises(OAuthError) as exc:
        await llm.chat([{"role": "user", "content": "hi"}])

    assert exc.value.code == "subscription_bad_response"
    assert exc.value.event_type == event["type"]
    assert exc.value.payload == event
    assert exc.value.category == category
    assert len(client.calls) == 1


async def test_chatgpt_llm_retries_transient_stream_error_once():
    transient = {
        "type": "response.failed",
        "response": {"status": "failed", "error": {"code": "server_error", "message": "temporarily overloaded"}},
    }

    def respond(index: int, kwargs: dict) -> Any:
        if index == 1:
            return ({}, [dict(transient)])
        return ({}, [_completed([_message("recovered")])])

    llm, client = _llm(respond)
    result = await llm.chat([{"role": "user", "content": "hi"}])

    assert result.content == "recovered"
    assert len(client.calls) == 2


async def test_chatgpt_llm_stops_after_one_transient_retry():
    transient = {
        "type": "response.failed",
        "response": {"status": "failed", "error": {"code": "server_error", "message": "still overloaded"}},
    }
    llm, client = _llm(lambda index, kwargs: ({}, [dict(transient)]))

    with pytest.raises(OAuthError) as exc:
        await llm.chat([{"role": "user", "content": "hi"}])

    assert exc.value.category == "transient"
    assert len(client.calls) == 2


async def test_chatgpt_llm_retries_connect_timeout_once_and_recovers():
    def respond(index: int, kwargs: dict) -> Any:
        if index == 1:
            return openai.APITimeoutError(request=_request())
        return ({}, [_completed([_message("recovered")])])

    llm, client = _llm(respond)
    result = await llm.chat([{"role": "user", "content": "hi"}])

    assert result.content == "recovered"
    assert len(client.calls) == 2


async def test_chatgpt_llm_stops_after_one_connect_timeout_retry():
    llm, client = _llm(lambda index, kwargs: openai.APITimeoutError(request=_request()))

    with pytest.raises(OAuthError) as exc:
        await llm.chat([{"role": "user", "content": "hi"}])

    assert exc.value.code == "subscription_http_error"
    assert exc.value.category == "transient"
    assert len(client.calls) == 2


@pytest.mark.parametrize(("status_code", "category"), [(402, "quota"), (403, "auth")])
async def test_chatgpt_llm_classifies_nonretryable_http_statuses(status_code: int, category: str):
    llm, client = _llm(lambda index, kwargs: _status_error(status_code))

    with pytest.raises(OAuthError) as exc:
        await llm.chat([{"role": "user", "content": "hi"}])

    assert exc.value.code == "subscription_http_error"
    assert exc.value.category == category
    assert len(client.calls) == 1


async def test_stream_that_ends_before_response_completed_is_rejected():
    events = [
        {
            "type": "response.output_item.done",
            "item": {"type": "function_call", "call_id": "call_1", "name": "roll_dice", "arguments": "{}"},
        }
    ]
    llm, _ = _llm(lambda index, kwargs: ({}, list(events)))

    with pytest.raises(OAuthError, match="subscription_bad_response"):
        await llm.chat([{"role": "user", "content": "hi"}])


async def test_nonterminal_output_snapshot_is_ignored_not_trusted():
    llm, _ = _llm(lambda index, kwargs: ({}, [{"type": "response.in_progress", "output": []}]))

    with pytest.raises(OAuthError, match="subscription_bad_response"):
        await llm.chat([{"role": "user", "content": "hi"}])


async def test_chatgpt_llm_401_refreshes_once():
    def respond(index: int, kwargs: dict) -> Any:
        if index == 1:
            return _status_error(401)
        return ({}, [_completed([_message("ok")])])

    manager = TokenManager(
        SubscriptionToken(
            access_token="stale",
            refresh_token="rt",
            expires_at=time.time() + 3600,  # not expired; 401 forces refresh
            account_id="acc",
        ),
        _StaticFlow(),  # type: ignore[arg-type]
    )
    llm, client = _llm(respond, manager=manager)
    result = await llm.chat([{"role": "user", "content": "hi"}])

    assert result.content == "ok"
    assert client.api_keys == ["stale", "refreshed-token"]


async def test_chatgpt_llm_double_401_raises_relogin():
    llm, client = _llm(lambda index, kwargs: _status_error(401))

    with pytest.raises(OAuthError) as exc:
        await llm.chat([{"role": "user", "content": "hi"}])

    assert exc.value.code == "subscription_relogin_required"
    assert len(client.calls) == 2


def test_default_construction_targets_the_codex_backend():
    llm = ChatGPTSubscriptionLLM(LLMSettings(provider="chatgpt", chat_model="gpt-5.4"), token_manager=_manager())
    assert str(llm._client.base_url).rstrip("/").endswith("backend-api/codex")
