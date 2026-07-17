from __future__ import annotations

import asyncio
import base64
import json
import logging
from types import SimpleNamespace

import pytest
import websockets

import adapters.onebot.adapter as onebot_module
from adapters.onebot import (
    OneBotAdapter,
    OneBotAPIError,
    OneBotForwardWebSocketTransport,
    OneBotReverseWebSocketTransport,
)
from adapters.onebot.adapter import (
    EVENT_QUEUE_LIMIT,
    MAX_WEBSOCKET_FRAME_BYTES,
    _ActionWebSocketTransport,
    _PublicAddressResolver,
)
from gateway.chat import (
    ChatAttachment,
    ChatComponent,
    ChatEmbed,
    ChatField,
    ChatMessage,
)
from gateway.events import InboundMessage
from gateway.registry import platform_registry
from gateway.session import SessionSource


class FakeTransport:
    def __init__(self) -> None:
        self.handler = None
        self.calls: list[tuple[str, dict]] = []
        self.closed = False
        self.response = {"message_id": 101}
        self.error: Exception | None = None

    async def start(self, handler) -> None:
        self.handler = handler

    async def close(self) -> None:
        self.closed = True

    async def call(self, action, params):
        self.calls.append((action, params))
        if self.error is not None:
            raise self.error
        return self.response


def _group_event(
    *,
    message_id: int = 10,
    self_id: int = 42,
    user_id: int = 7,
    group_id: int = 99,
    message=None,
) -> dict:
    return {
        "time": 1,
        "self_id": self_id,
        "post_type": "message",
        "message_type": "group",
        "sub_type": "normal",
        "message_id": message_id,
        "group_id": group_id,
        "user_id": user_id,
        "message": message
        if message is not None
        else [{"type": "text", "data": {"text": "hello"}}],
        "sender": {"nickname": "Ada", "card": "Investigator"},
    }


async def _wait_for(predicate, timeout: float = 1.0) -> None:
    async def poll() -> None:
        while not predicate():
            await asyncio.sleep(0.005)

    await asyncio.wait_for(poll(), timeout)


async def test_array_group_event_maps_mentions_sender_and_attachments() -> None:
    seen: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        seen.append(message)

    adapter = OneBotAdapter(
        transport=FakeTransport(),
        on_message=handler,
    )
    encoded_audio = base64.b64encode(b"ogg").decode("ascii")
    event = _group_event(
        message=[
            {"type": "at", "data": {"qq": "42"}},
            {"type": "text", "data": {"text": "  /roll 1d20 "}},
            {"type": "at", "data": {"qq": "88"}},
            {"type": "text", "data": {"text": " now"}},
            {
                "type": "image",
                "data": {
                    "file": "map.png",
                    "url": "https://cdn.example/map.png",
                    "file_size": "12",
                },
            },
            {"type": "record", "data": {"file": f"base64://{encoded_audio}"}},
        ]
    )

    inbound = await adapter.handle_event(event)

    assert inbound is seen[0]
    assert inbound.source.chat_key() == "onebot:group:99"
    assert inbound.source.user_key() == "onebot:7"
    assert inbound.source.user_name == "Investigator"
    assert inbound.source.message_id == "10"
    assert inbound.text == "/roll 1d20 @88 now"
    assert inbound.at_bot is True
    assert inbound.raw is event
    assert inbound.attachments[0] == ChatAttachment(
        id="map.png",
        name="map.png",
        mime="image/png",
        size=12,
        url="https://cdn.example/map.png",
    )
    assert inbound.attachments[1].mime == "audio/ogg"
    assert inbound.attachments[1].data == b"ogg"


async def test_cq_string_private_event_unescapes_and_dispatches() -> None:
    seen: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        seen.append(message)

    adapter = OneBotAdapter(transport=FakeTransport(), on_message=handler)
    event = {
        "self_id": 42,
        "post_type": "message",
        "message_type": "private",
        "message_id": 11,
        "user_id": 8,
        "message": "[CQ:at,qq=42]  .help&#91;x&#93;&amp;[CQ:image,file=https://cdn.example/a.jpg]",
        "sender": {"nickname": "Lin"},
    }

    inbound = await adapter.handle_event(event)

    assert inbound is seen[0]
    assert inbound.source.chat_key() == "onebot:dm:8"
    assert inbound.text == ".help[x]&"
    assert inbound.at_bot is True
    assert inbound.attachments[0].url == "https://cdn.example/a.jpg"


async def test_bot_loop_non_messages_and_empty_events_are_rejected() -> None:
    adapter = OneBotAdapter(transport=FakeTransport())

    own_message = _group_event(self_id=42, user_id=42)
    sent_message = {**_group_event(), "post_type": "message_sent"}
    meta_event = {"post_type": "meta_event", "meta_event_type": "heartbeat"}
    empty_event = _group_event(message=[{"type": "face", "data": {"id": "1"}}])

    assert await adapter.handle_event(own_message) is None
    assert await adapter.handle_event(sent_message) is None
    assert await adapter.handle_event(meta_event) is None
    assert await adapter.handle_event(empty_event) is None


async def test_duplicate_message_id_is_dispatched_once_but_missing_ids_are_not_dropped() -> None:
    seen: list[str] = []

    async def handler(message: InboundMessage) -> None:
        seen.append(message.text)

    adapter = OneBotAdapter(transport=FakeTransport(), on_message=handler)
    event = _group_event(message_id=25)

    assert await adapter.handle_event(event) is not None
    assert await adapter.handle_event(dict(event)) is None
    assert await adapter.handle_event({**event, "self_id": 43}) is not None
    assert await adapter.handle_event(_group_event(message_id=25, group_id=100)) is not None
    without_id = {key: value for key, value in event.items() if key != "message_id"}
    assert await adapter.handle_event(without_id) is not None
    assert await adapter.handle_event(dict(without_id)) is not None

    assert seen == ["hello", "hello", "hello", "hello", "hello"]


async def test_event_dispatch_is_ordered_per_chat_but_concurrent_across_chats() -> None:
    transport = _ActionWebSocketTransport()
    first_started = asyncio.Event()
    other_chat_done = asyncio.Event()
    release_first = asyncio.Event()
    seen: list[tuple[int, int]] = []

    async def handler(payload: dict) -> None:
        pair = (payload["group_id"], payload["message_id"])
        seen.append(pair)
        if pair == (99, 1):
            first_started.set()
            await release_first.wait()
        if pair == (100, 1):
            other_chat_done.set()

    transport._start_dispatcher(handler)
    assert transport._queue_event(_group_event(group_id=99, message_id=1))
    assert transport._queue_event(_group_event(group_id=99, message_id=2))
    assert transport._queue_event(_group_event(group_id=100, message_id=1))

    await first_started.wait()
    await asyncio.wait_for(other_chat_done.wait(), 0.5)
    assert (99, 2) not in seen

    release_first.set()
    await _wait_for(lambda: transport._pending_events == 0)
    assert seen.index((99, 1)) < seen.index((99, 2))
    await transport._stop_dispatcher()


async def test_event_backlog_exhaustion_closes_socket_instead_of_silent_drop() -> None:
    class BurstConnection:
        def __init__(self, payloads: list[dict]) -> None:
            self.payloads = iter(payloads)
            self.close_args: tuple[int, str] | None = None

        def __aiter__(self):
            return self

        async def __anext__(self):
            try:
                return json.dumps(next(self.payloads))
            except StopIteration:
                raise StopAsyncIteration from None

        async def close(self, *, code: int, reason: str) -> None:
            self.close_args = (code, reason)

    transport = _ActionWebSocketTransport()

    async def blocked_handler(_payload: dict) -> None:
        await asyncio.Future()

    transport._start_dispatcher(blocked_handler)
    connection = BurstConnection(
        [
            _group_event(group_id=99, message_id=index)
            for index in range(EVENT_QUEUE_LIMIT + 1)
        ]
    )

    await transport._consume(connection)

    assert connection.close_args == (1013, "event backlog exhausted")
    assert transport._pending_events == EVENT_QUEUE_LIMIT
    await transport._stop_dispatcher()
    assert transport._pending_events == 0


async def test_group_send_uses_array_reply_rich_fallback_and_media() -> None:
    transport = FakeTransport()
    adapter = OneBotAdapter(transport=transport)
    source = SessionSource(
        platform="onebot",
        chat_type="group",
        chat_id="99",
        user_id="7",
    )
    message = ChatMessage(
        text="keeper",
        attachments=[ChatAttachment(name="map.png", mime="image/png", data=b"png")],
        components=[ChatComponent(id="panel", label="Panel", command=".panel")],
        embeds=[ChatEmbed(title="Result", fields=(ChatField("Total", "20"),))],
    )

    result = await adapter.send_message(source, message, reply_to="10")

    assert result.ok is True
    assert result.message_id == "101"
    action, params = transport.calls[0]
    assert action == "send_group_msg"
    assert params["group_id"] == 99
    assert params["message"][0] == {"type": "reply", "data": {"id": "10"}}
    assert params["message"][1]["type"] == "text"
    assert params["message"][1]["data"]["text"] == (
        "keeper\nResult\nTotal: 20\n1. Panel — .panel"
    )
    assert params["message"][2] == {
        "type": "image",
        "data": {"file": f"base64://{base64.b64encode(b'png').decode('ascii')}"},
    }


async def test_rendered_rich_text_is_split_to_onebot_limits_without_loss() -> None:
    transport = FakeTransport()
    adapter = OneBotAdapter(transport=transport)
    source = SessionSource(platform="onebot", chat_type="group", chat_id="99")
    message = ChatMessage(
        text="prefix",
        embeds=[ChatEmbed(description="x" * 5000)],
        components=[ChatComponent(id="help", label="Help", command=".help")],
    )

    result = await adapter.send_message(source, message)

    assert result.ok is True
    assert len(transport.calls) == 2
    rendered_parts = [
        next(
            segment["data"]["text"]
            for segment in params["message"]
            if segment["type"] == "text"
        )
        for _action, params in transport.calls
    ]
    assert all(len(part) <= adapter.capabilities.max_text_chars for part in rendered_parts)
    assert "".join(rendered_parts) == f"prefix\n{'x' * 5000}\n1. Help — .help"


async def test_private_group_reply_uses_user_without_invalid_group_reply_segment() -> None:
    transport = FakeTransport()
    adapter = OneBotAdapter(transport=transport)
    source = SessionSource(
        platform="onebot",
        chat_type="group",
        chat_id="99",
        user_id="7",
    )

    result = await adapter.send_message(
        source,
        ChatMessage(text="private sheet", private=True),
        reply_to="group-message-10",
    )

    assert adapter.supports_private_reply(source) is True
    assert result.ok is True
    assert transport.calls == [
        (
            "send_private_msg",
            {
                "user_id": 7,
                "message": [{"type": "text", "data": {"text": "private sheet"}}],
            },
        )
    ]

    unavailable = await adapter.send_message(
        SessionSource(platform="onebot", chat_type="group", chat_id="99"),
        ChatMessage(text="secret", private=True),
    )
    assert unavailable.ok is False
    assert unavailable.error == "onebot.private_target.unavailable"
    assert len(transport.calls) == 1


async def test_send_failures_are_stable_and_do_not_leak_transport_secrets(caplog) -> None:
    transport = FakeTransport()
    secret = "super-secret-token"
    transport.error = RuntimeError(f"wss://host/?access_token={secret}")
    adapter = OneBotAdapter(transport=transport)
    source = SessionSource(platform="onebot", chat_type="group", chat_id="99")

    with caplog.at_level(logging.WARNING):
        result = await adapter.send_message(source, ChatMessage(text="hello"))

    assert result.ok is False
    assert result.error == "onebot.send.failed"
    assert secret not in caplog.text
    assert secret not in str(result)

    transport.error = OneBotAPIError(1403, secret)
    result = await adapter.send_message(source, ChatMessage(text="hello"))
    assert result.error == "onebot.api.1403"
    assert secret not in str(result)


async def test_oversize_attachment_returns_failure_instead_of_escaping() -> None:
    transport = FakeTransport()
    adapter = OneBotAdapter(transport=transport)
    source = SessionSource(platform="onebot", chat_type="group", chat_id="99")
    message = ChatMessage(
        attachments=[
            ChatAttachment(
                name="huge.png",
                mime="image/png",
                data=b"x" * (20 * 1024 * 1024 + 1),
            )
        ]
    )

    result = await adapter.send_message(source, message)

    assert result.ok is False
    assert result.error == "onebot.send.failed"
    assert transport.calls == []


async def test_connect_and_disconnect_delegate_to_injected_transport() -> None:
    transport = FakeTransport()
    adapter = OneBotAdapter(transport=transport)

    assert await adapter.connect() is True
    assert transport.handler == adapter.handle_event
    await adapter.disconnect()
    assert transport.closed is True
    assert await OneBotAdapter({}).connect() is False


async def test_forward_websocket_auth_events_actions_and_reconnect() -> None:
    received: list[dict] = []
    handler_responses: list[dict] = []
    headers: list[str] = []
    connection_count = 0
    first_event = asyncio.Event()
    second_connection = asyncio.Event()

    async def on_payload(payload) -> None:
        received.append(payload)
        handler_responses.append(await transport.call("get_status", {}))
        first_event.set()

    async def server_handler(connection) -> None:
        nonlocal connection_count
        connection_count += 1
        index = connection_count
        headers.append(str(connection.request.headers.get("Authorization") or ""))
        if index == 1:
            await connection.send(json.dumps(_group_event(message_id=30)))
            handler_request = json.loads(await connection.recv())
            assert handler_request["action"] == "get_status"
            await connection.send(
                json.dumps(
                    {
                        "status": "ok",
                        "retcode": 0,
                        "data": {"online": True},
                        "echo": handler_request["echo"],
                    }
                )
            )
            request = json.loads(await connection.recv())
            await connection.send(
                json.dumps(
                    {
                        "status": "ok",
                        "retcode": 0,
                        "data": {"message_id": 31},
                        "echo": request["echo"],
                    }
                )
            )
            await connection.close()
        else:
            second_connection.set()
            await connection.wait_closed()

    server = await websockets.serve(server_handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    transport = OneBotForwardWebSocketTransport(
        f"ws://127.0.0.1:{port}/",
        access_token="token",
        request_timeout=0.5,
        reconnect_delay=0.01,
    )
    try:
        await transport.start(on_payload)
        await transport.wait_connected()
        await asyncio.wait_for(first_event.wait(), 1)

        response = await transport.call("send_group_msg", {"group_id": 99, "message": "hello"})

        assert response == {"message_id": 31}
        assert received == [_group_event(message_id=30)]
        assert handler_responses == [{"online": True}]
        await asyncio.wait_for(second_connection.wait(), 1)
        assert connection_count == 2
        assert headers == ["Bearer token", "Bearer token"]
        await _wait_for(lambda: transport.connected)
        assert transport.connected is True
    finally:
        await transport.close()
        server.close()
        await server.wait_closed()
    assert transport.connected is False


async def test_forward_websocket_accepts_bounded_frame_above_library_default() -> None:
    raw = b"x" * 800_000
    event = _group_event(
        message_id=35,
        message=[
            {
                "type": "image",
                "data": {"file": f"base64://{base64.b64encode(raw).decode('ascii')}"},
            }
        ],
    )
    encoded = json.dumps(event)
    assert 1024 * 1024 < len(encoded) < MAX_WEBSOCKET_FRAME_BYTES
    received: list[dict] = []

    async def server_handler(connection) -> None:
        await connection.send(encoded)
        await connection.wait_closed()

    server = await websockets.serve(server_handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    transport = OneBotForwardWebSocketTransport(
        f"ws://127.0.0.1:{port}/",
        request_timeout=0.5,
    )
    try:
        await transport.start(received.append)
        await transport.wait_connected()
        await _wait_for(lambda: received == [event])
    finally:
        await transport.close()
        server.close()
        await server.wait_closed()


async def test_forward_disconnect_fails_pending_call_without_reissuing_it() -> None:
    action_count = 0

    async def server_handler(connection) -> None:
        nonlocal action_count
        await connection.recv()
        action_count += 1
        await connection.close()

    server = await websockets.serve(server_handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    transport = OneBotForwardWebSocketTransport(
        f"ws://127.0.0.1:{port}/",
        request_timeout=0.5,
        reconnect_delay=0.01,
    )
    try:
        await transport.start(lambda payload: None)
        await transport.wait_connected()

        with pytest.raises(ConnectionError, match="onebot.websocket.disconnected"):
            await transport.call("send_group_msg", {"group_id": 99, "message": "hello"})
        await asyncio.sleep(0.05)

        assert action_count == 1
        assert transport.pending_count == 0
    finally:
        await transport.close()
        server.close()
        await server.wait_closed()


async def test_forward_timeout_drops_late_echo_instead_of_dispatching_it() -> None:
    received: list[dict] = []
    event = _group_event(message_id=40)

    async def server_handler(connection) -> None:
        request = json.loads(await connection.recv())
        await asyncio.sleep(0.05)
        await connection.send(
            json.dumps(
                {
                    "status": "ok",
                    "retcode": 0,
                    "data": {"message_id": 41},
                    "echo": request["echo"],
                }
            )
        )
        await connection.send(json.dumps(event))
        await connection.wait_closed()

    server = await websockets.serve(server_handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    transport = OneBotForwardWebSocketTransport(
        f"ws://127.0.0.1:{port}/",
        request_timeout=0.01,
        reconnect_delay=0.1,
    )
    try:
        await transport.start(received.append)
        await transport.wait_connected()
        with pytest.raises(TimeoutError):
            await transport.call("send_group_msg", {})
        await _wait_for(lambda: received == [event])
        assert transport.pending_count == 0
    finally:
        await transport.close()
        server.close()
        await server.wait_closed()


async def test_reverse_websocket_auth_event_action_and_pending_disconnect() -> None:
    received: list[dict] = []
    event = _group_event(message_id=50)
    transport = OneBotReverseWebSocketTransport(
        "127.0.0.1",
        0,
        access_token="token",
        request_timeout=0.5,
    )
    await transport.start(received.append)
    port = transport.bound_port
    assert port is not None
    url = f"ws://127.0.0.1:{port}/onebot/v11/ws"
    try:
        with pytest.raises(websockets.exceptions.InvalidStatus) as rejected:
            async with websockets.connect(
                url,
                additional_headers={"Authorization": "Bearer wrong"},
            ):
                pass
        assert rejected.value.response.status_code == 401

        async with websockets.connect(
            url,
            additional_headers={
                "Authorization": "Bearer token",
                "X-Client-Role": "Universal",
            },
        ) as client:
            await transport.wait_connected()
            await client.send(json.dumps(event))
            await _wait_for(lambda: received == [event])

            action_task = asyncio.create_task(
                transport.call("send_private_msg", {"user_id": 7, "message": "hello"})
            )
            request = json.loads(await client.recv())
            assert request["action"] == "send_private_msg"
            await client.send(
                json.dumps(
                    {
                        "status": "ok",
                        "retcode": 0,
                        "data": {"message_id": 51},
                        "echo": request["echo"],
                    }
                )
            )
            assert await action_task == {"message_id": 51}

            pending = asyncio.create_task(transport.call("get_status", {}))
            await client.recv()
            await client.close()
            with pytest.raises(ConnectionError, match="onebot.websocket.disconnected"):
                await pending

        await _wait_for(lambda: not transport.connected)
        assert transport.pending_count == 0
    finally:
        await transport.close()


async def test_reverse_websocket_accepts_bounded_frame_above_library_default() -> None:
    raw = b"x" * 800_000
    event = _group_event(
        message_id=55,
        message=[
            {
                "type": "image",
                "data": {"file": f"base64://{base64.b64encode(raw).decode('ascii')}"},
            }
        ],
    )
    encoded = json.dumps(event)
    assert 1024 * 1024 < len(encoded) < MAX_WEBSOCKET_FRAME_BYTES
    received: list[dict] = []
    transport = OneBotReverseWebSocketTransport("127.0.0.1", 0)
    await transport.start(received.append)
    port = transport.bound_port
    assert port is not None
    try:
        async with websockets.connect(
            f"ws://127.0.0.1:{port}/onebot/v11/ws",
            additional_headers={"X-Client-Role": "Universal"},
        ) as client:
            await client.send(encoded)
            await _wait_for(lambda: received == [event])
    finally:
        await transport.close()


class FakeContent:
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks

    async def iter_chunked(self, _size):
        for chunk in self.chunks:
            yield chunk


class FakeResponse:
    def __init__(
        self,
        chunks: list[bytes],
        *,
        status: int = 200,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.content = FakeContent(chunks)
        self.status = status
        self.headers = headers or {}
        self.status_checked = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    def raise_for_status(self) -> None:
        self.status_checked = True


class FakeHTTPSession:
    def __init__(self, *responses: FakeResponse) -> None:
        self.responses = list(responses)
        self.urls: list[str] = []
        self.requests: list[dict] = []

    def get(self, url: str, **kwargs) -> FakeResponse:
        self.urls.append(url)
        self.requests.append(kwargs)
        return self.responses.pop(0)


async def test_fetch_attachment_streams_onebot_http_url(monkeypatch) -> None:
    async def resolve_public(_host: str, _port: int) -> set[str]:
        return {"93.184.216.34"}

    monkeypatch.setattr(onebot_module, "_resolve_addresses", resolve_public)
    response = FakeResponse([b"im", b"age"])
    session = FakeHTTPSession(response)
    adapter = OneBotAdapter(transport=FakeTransport(), http_session=session)
    attachment = ChatAttachment(
        id="map.png",
        name="map.png",
        mime="image/png",
        url="https://cdn.example/map.png",
    )

    data = await adapter.fetch_attachment(attachment)

    assert data == b"image"
    assert session.urls == ["https://cdn.example/map.png"]
    assert session.requests == [{"allow_redirects": False}]
    assert response.status_checked is True


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/private",
        "http://10.0.0.1/private",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]/private",
        "https://user:password@8.8.8.8/private",
        "https://8.8.8.8/file#fragment",
    ],
)
async def test_fetch_attachment_rejects_unsafe_literal_urls_before_request(url: str) -> None:
    session = FakeHTTPSession(FakeResponse([b"secret"]))
    adapter = OneBotAdapter(transport=FakeTransport(), http_session=session)

    with pytest.raises(ValueError, match="onebot.attachment.unsafe_url"):
        await adapter.fetch_attachment(ChatAttachment(id="remote", url=url))

    assert session.urls == []


async def test_fetch_attachment_rejects_hostname_with_any_private_dns_answer(monkeypatch) -> None:
    async def resolve_mixed(_host: str, _port: int) -> set[str]:
        return {"93.184.216.34", "127.0.0.1"}

    monkeypatch.setattr(onebot_module, "_resolve_addresses", resolve_mixed)
    session = FakeHTTPSession(FakeResponse([b"secret"]))
    adapter = OneBotAdapter(transport=FakeTransport(), http_session=session)

    with pytest.raises(ValueError, match="onebot.attachment.unsafe_url"):
        await adapter.fetch_attachment(
            ChatAttachment(id="remote", url="https://mixed.example/file")
        )

    assert session.urls == []


async def test_fetch_attachment_validates_every_redirect_before_following(monkeypatch) -> None:
    async def resolve_public(_host: str, _port: int) -> set[str]:
        return {"93.184.216.34"}

    monkeypatch.setattr(onebot_module, "_resolve_addresses", resolve_public)
    session = FakeHTTPSession(
        FakeResponse([], status=302, headers={"Location": "http://127.0.0.1/private"}),
        FakeResponse([b"secret"]),
    )
    adapter = OneBotAdapter(transport=FakeTransport(), http_session=session)

    with pytest.raises(ValueError, match="onebot.attachment.unsafe_url"):
        await adapter.fetch_attachment(
            ChatAttachment(id="remote", url="https://public.example/redirect")
        )

    assert session.urls == ["https://public.example/redirect"]


async def test_fetch_attachment_follows_a_bounded_public_redirect(monkeypatch) -> None:
    async def resolve_public(_host: str, _port: int) -> set[str]:
        return {"93.184.216.34"}

    monkeypatch.setattr(onebot_module, "_resolve_addresses", resolve_public)
    session = FakeHTTPSession(
        FakeResponse([], status=307, headers={"Location": "https://8.8.8.8/final"}),
        FakeResponse([b"public"]),
    )
    adapter = OneBotAdapter(transport=FakeTransport(), http_session=session)

    data = await adapter.fetch_attachment(
        ChatAttachment(id="remote", url="https://public.example/redirect")
    )

    assert data == b"public"
    assert session.urls == ["https://public.example/redirect", "https://8.8.8.8/final"]


async def test_fetch_attachment_rejects_oversize_content_length_before_streaming() -> None:
    response = FakeResponse(
        [b"not-read"],
        headers={"Content-Length": str(20 * 1024 * 1024 + 1)},
    )
    session = FakeHTTPSession(response)
    adapter = OneBotAdapter(transport=FakeTransport(), http_session=session)

    with pytest.raises(ValueError, match="onebot.attachment.too_large"):
        await adapter.fetch_attachment(
            ChatAttachment(id="remote", url="https://8.8.8.8/large")
        )


async def test_fetch_attachment_timeout_bounds_the_whole_download() -> None:
    class SlowContent:
        async def iter_chunked(self, _size):
            await asyncio.sleep(1)
            yield b"late"

    response = FakeResponse([])
    response.content = SlowContent()
    session = FakeHTTPSession(response)
    adapter = OneBotAdapter(
        {"request_timeout": 0.01},
        transport=FakeTransport(),
        http_session=session,
    )

    with pytest.raises(FileNotFoundError):
        await adapter.fetch_attachment(
            ChatAttachment(id="remote", url="https://8.8.8.8/slow")
        )


async def test_public_address_resolver_rejects_dns_rebinding_targets() -> None:
    class Resolver:
        async def resolve(self, host, port, *, family):
            del host, port, family
            return [
                {"host": "93.184.216.34"},
                {"host": "169.254.169.254"},
            ]

        async def close(self):
            return None

    resolver = _PublicAddressResolver(Resolver())

    with pytest.raises(OSError, match="unsafe_address"):
        await resolver.resolve("rebind.example", 443)


def test_onebot_registers_on_import_and_factory_builds_configured_transport() -> None:
    entry = platform_registry.get("onebot")

    assert entry is not None
    assert entry.label == "OneBot 11"
    adapter = entry.adapter_factory(
        {
            "mode": "forward",
            "ws_url": "ws://127.0.0.1:6700/",
            "access_token": "token",
        },
        SimpleNamespace(),
    )
    assert isinstance(adapter, OneBotAdapter)
    assert isinstance(adapter._transport, OneBotForwardWebSocketTransport)


@pytest.mark.parametrize(
    "config",
    [
        {"mode": "forward", "ws_url": "not-a-url"},
        {"mode": "forward", "ws_url": "https://example.test/ws"},
        {"mode": "forward", "ws_url": "ws://"},
        {"mode": "forward", "ws_url": "ws://example.test/path#fragment"},
        {"mode": "forward", "ws_url": "ws://localhost:6700", "request_timeout": 0},
        {"mode": "forward", "ws_url": "ws://localhost:6700", "reconnect_delay": -1},
    ],
)
def test_onebot_factory_rejects_invalid_forward_configuration(config: dict) -> None:
    assert OneBotAdapter(config)._transport is None


def test_onebot_reverse_factory_requires_token_for_public_listener() -> None:
    unauthenticated = OneBotAdapter(
        {"mode": "reverse", "listen_host": "0.0.0.0", "listen_port": 6700}
    )
    authenticated = OneBotAdapter(
        {
            "mode": "reverse",
            "listen_host": "0.0.0.0",
            "listen_port": 6700,
            "access_token": "secret",
        }
    )

    assert unauthenticated._transport is None
    assert isinstance(authenticated._transport, OneBotReverseWebSocketTransport)

    with pytest.raises(ValueError, match="public_auth_required"):
        OneBotReverseWebSocketTransport("0.0.0.0", 6700)
