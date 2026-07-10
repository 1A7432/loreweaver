"""Offline tests for ChatGPTSubscriptionLLM (Responses API translation)."""

from __future__ import annotations

import asyncio
import json
import time

import httpx
import pytest

from infra.config import LLMSettings
from infra.llm_chatgpt import (
    ChatGPTSubscriptionLLM,
    _aggregate_sse,
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


async def test_chatgpt_llm_posts_responses_and_parses():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["account"] = request.headers.get("chatgpt-account-id")
        seen["originator"] = request.headers.get("originator")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": "Hello"}],
                    }
                ],
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    llm = ChatGPTSubscriptionLLM(
        LLMSettings(provider="chatgpt", chat_model="gpt-5.4"),
        token_manager=_manager(),
        client=client,
        responses_url="https://example.test/responses",
    )
    try:
        result = await llm.chat([{"role": "user", "content": "hi"}])
    finally:
        await client.aclose()

    assert result.content == "Hello"
    assert seen["auth"] == "Bearer access-token"
    assert seen["account"] == "acc-1"
    assert seen["body"]["model"] == "gpt-5.4"
    assert seen["body"]["store"] is False
    assert seen["body"]["stream"] is True
    assert seen["body"]["include"] == ["reasoning.encrypted_content"]
    assert seen["originator"] == "Codex Loreweaver"


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
    requests: list[dict] = []
    request_headers: list[httpx.Headers] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append(body)
        request_headers.append(request.headers)
        if len(requests) == 1:
            events = [
                {"type": "response.output_item.done", "item": reasoning},
                {"type": "response.output_item.done", "item": function_call},
                {
                    "type": "response.completed",
                    "response": {"id": "resp_1", "output": [], "usage": {}},
                },
            ]
            text = "\n\n".join(f"data: {json.dumps(event)}" for event in events)
            return httpx.Response(
                200,
                text=f"{text}\n\ndata: [DONE]\n\n",
                headers={
                    "content-type": "text/event-stream",
                    "x-codex-turn-state": "sticky-turn-1",
                },
            )
        return httpx.Response(
            200,
            json={
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "done"}],
                    }
                ]
            },
        )

    messages = [{"role": "user", "content": "roll"}]
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    llm = ChatGPTSubscriptionLLM(
        LLMSettings(chat_model="gpt-5.4"),
        token_manager=_manager(),
        client=client,
        responses_url="https://example.test/responses",
    )
    try:
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
                            "function": {
                                "name": "roll_dice",
                                "arguments": '{"expr":"1d20"}',
                            },
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "call_1", "content": "17"},
            ]
        )
        second = await llm.chat(messages)
    finally:
        await client.aclose()

    assert second.content == "done"
    assert request_headers[0]["session_id"] == request_headers[1]["session_id"]
    assert "x-codex-turn-state" not in request_headers[0]
    assert request_headers[1]["x-codex-turn-state"] == "sticky-turn-1"
    assert request_headers[0]["user-agent"] == "Codex Loreweaver"
    assert requests[1]["input"][1:3] == [reasoning, function_call]
    assert requests[1]["input"][3] == {
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
    requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append(body)
        if len(requests) <= 2:
            return httpx.Response(200, json={"output": raw_rounds[len(requests) - 1]})
        return httpx.Response(
            200,
            json={
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "complete"}],
                    }
                ]
            },
        )

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
                            "function": {
                                "name": call.name,
                                "arguments": json.dumps(call.arguments),
                            },
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": call.id, "content": output},
            ]
        )

    messages = [{"role": "user", "content": "use two tools"}]
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    llm = ChatGPTSubscriptionLLM(
        LLMSettings(chat_model="gpt-5.4"),
        token_manager=_manager(),
        client=client,
        responses_url="https://example.test/responses",
    )
    try:
        first = await llm.chat(messages)
        append_tool_round(messages, first, "first-output")
        second = await llm.chat(messages)
        append_tool_round(messages, second, "second-output")
        final = await llm.chat(messages)
    finally:
        await client.aclose()

    assert final.content == "complete"
    assert requests[1]["input"][1:3] == raw_rounds[0]
    assert requests[2]["input"][1:3] == raw_rounds[0]
    assert requests[2]["input"][4:6] == raw_rounds[1]
    assert llm._continuations == {}


async def test_chatgpt_llm_continuations_are_isolated_by_message_list():
    replayed: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        output = next(
            (item for item in body["input"] if item.get("type") == "function_call_output"),
            None,
        )
        if output is not None:
            reasoning = next(item for item in body["input"] if item.get("type") == "reasoning")
            replayed[output["output"]] = reasoning["encrypted_content"]
            return httpx.Response(
                200,
                json={
                    "output": [
                        {
                            "type": "message",
                            "content": [{"type": "output_text", "text": "done"}],
                        }
                    ]
                },
            )
        prompt = body["input"][0]["content"][0]["text"]
        suffix = prompt[-1]
        return httpx.Response(
            200,
            json={
                "output": [
                    {
                        "id": f"rs_{suffix}",
                        "type": "reasoning",
                        "encrypted_content": f"cipher-{suffix}",
                    },
                    {
                        "id": f"fc_{suffix}",
                        "type": "function_call",
                        "call_id": "call_shared",
                        "name": "roll_dice",
                        "arguments": "{}",
                    },
                ]
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    llm = ChatGPTSubscriptionLLM(
        LLMSettings(chat_model="gpt-5.4"),
        token_manager=_manager(),
        client=client,
        responses_url="https://example.test/responses",
    )
    messages_a = [{"role": "user", "content": "session-A"}]
    messages_b = [{"role": "user", "content": "session-B"}]
    try:
        first_a, first_b = await asyncio.gather(llm.chat(messages_a), llm.chat(messages_b))
        for messages, result, output in (
            (messages_a, first_a, "tool-A"),
            (messages_b, first_b, "tool-B"),
        ):
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
    finally:
        await client.aclose()

    assert replayed == {"tool-A": "cipher-A", "tool-B": "cipher-B"}
    assert llm._continuations == {}


async def test_chatgpt_llm_does_not_evict_active_continuations_and_clears_explicitly():
    def handler(request: httpx.Request) -> httpx.Response:
        prompt = json.loads(request.content)["input"][0]["content"][0]["text"]
        return httpx.Response(
            200,
            json={
                "output": [
                    {
                        "type": "reasoning",
                        "id": f"rs_{prompt}",
                        "encrypted_content": f"cipher-{prompt}",
                    },
                    {
                        "type": "function_call",
                        "id": f"fc_{prompt}",
                        "call_id": f"call_{prompt}",
                        "name": "roll_dice",
                        "arguments": "{}",
                    },
                ]
            },
        )

    conversations = [[{"role": "user", "content": str(index)}] for index in range(130)]
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    llm = ChatGPTSubscriptionLLM(
        LLMSettings(chat_model="gpt-5.4"),
        token_manager=_manager(),
        client=client,
        responses_url="https://example.test/responses",
    )
    try:
        await asyncio.gather(*(llm.chat(messages) for messages in conversations))
        assert len(llm._continuations) == len(conversations)
        for messages in conversations:
            llm.clear_continuation(messages)
        assert llm._continuations == {}
    finally:
        await client.aclose()


@pytest.mark.parametrize(
    "terminal_event",
    ["error", "response.error", "response.cancelled", "response.failed", "response.incomplete"],
)
def test_aggregate_sse_rejects_terminal_error_events(terminal_event: str):
    body = "\n".join(
        [
            'data: {"type":"response.output_item.done","item":{"type":"message"}}',
            f'data: {{"type":"{terminal_event}"}}',
            "data: [DONE]",
        ]
    )

    with pytest.raises(OAuthError) as exc:
        _aggregate_sse(body)

    assert exc.value.code == "subscription_bad_response"


def test_aggregate_sse_rejects_stream_that_ends_before_response_completed():
    body = "\n".join(
        [
            (
                'data: {"type":"response.output_item.done","item":'
                '{"type":"function_call","call_id":"call_1","name":"roll_dice",'
                '"arguments":"{}"}}'
            ),
            "data: [DONE]",
        ]
    )

    with pytest.raises(OAuthError) as exc:
        _aggregate_sse(body)

    assert exc.value.code == "subscription_bad_response"


def test_aggregate_sse_rejects_nonterminal_output_snapshot():
    body = "\n".join(
        [
            'data: {"type":"response.in_progress","output":[]}',
            "data: [DONE]",
        ]
    )

    with pytest.raises(OAuthError) as exc:
        _aggregate_sse(body)

    assert exc.value.code == "subscription_bad_response"


async def test_chatgpt_llm_401_refreshes_once():
    state = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        state["n"] += 1
        auth = request.headers.get("authorization")
        if state["n"] == 1:
            assert auth == "Bearer stale"
            return httpx.Response(401, text="unauthorized")
        assert auth == "Bearer refreshed-token"
        return httpx.Response(
            200,
            json={"output": [{"type": "message", "content": [{"type": "output_text", "text": "ok"}]}]},
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    mgr = TokenManager(
        SubscriptionToken(
            access_token="stale",
            refresh_token="rt",
            expires_at=time.time() + 3600,  # not expired; 401 forces refresh
            account_id="acc",
        ),
        _StaticFlow(),  # type: ignore[arg-type]
    )
    llm = ChatGPTSubscriptionLLM(
        LLMSettings(chat_model="gpt-5.4"),
        token_manager=mgr,
        client=client,
        responses_url="https://example.test/responses",
    )
    try:
        result = await llm.chat([{"role": "user", "content": "hi"}])
    finally:
        await client.aclose()

    assert result.content == "ok"
    assert state["n"] == 2


async def test_chatgpt_llm_double_401_raises_relogin():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="nope")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    llm = ChatGPTSubscriptionLLM(
        LLMSettings(chat_model="gpt-5.4"),
        token_manager=_manager(access="x"),
        client=client,
        responses_url="https://example.test/responses",
    )
    try:
        with pytest.raises(OAuthError) as exc:
            await llm.chat([{"role": "user", "content": "hi"}])
        assert exc.value.code == "subscription_relogin_required"
    finally:
        await client.aclose()
