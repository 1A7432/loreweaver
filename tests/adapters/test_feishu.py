import asyncio
import json
import logging
import threading
import time
from copy import deepcopy
from types import SimpleNamespace

import httpx
import pytest

import adapters.feishu.adapter as feishu_adapter_module
from adapters.feishu import FeishuAdapter
from adapters.feishu.adapter import (
    LARK_OAPI_AVAILABLE,
    MAX_FILE_BYTES,
    MAX_TEXT_CHARS,
    _ControlledLarkWsClient,
    _LarkEventSource,
    _RecentIds,
    lark_ws_module,
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


class FakeMessageApi:
    def __init__(self) -> None:
        self.created: list[dict] = []
        self.replied: list[dict] = []
        self.response: dict = {"data": {"message_id": "om_sent"}}

    async def create(self, **kwargs):
        self.created.append(deepcopy(kwargs))
        return deepcopy(self.response)

    async def reply(self, **kwargs):
        self.replied.append(deepcopy(kwargs))
        return deepcopy(self.response)


class FakeTransport:
    def __init__(self, *, bot_open_id: str = "ou_bot") -> None:
        self.message = FakeMessageApi()
        self.im = SimpleNamespace(v1=SimpleNamespace(message=self.message))
        self.identity = bot_open_id
        self.identity_calls = 0
        self.closed = 0
        self.resources: dict[tuple[str, str, str], bytes] = {}
        self.resource_calls: list[dict] = []
        self.quotes: dict[str, str] = {}
        self.uploaded_images: list[bytes] = []
        self.uploaded_files: list[tuple[str, bytes]] = []

    async def bot_open_id(self) -> str:
        self.identity_calls += 1
        return self.identity

    async def fetch_resource(self, **kwargs) -> bytes:
        self.resource_calls.append(deepcopy(kwargs))
        return self.resources[(kwargs["message_id"], kwargs["file_key"], kwargs["resource_type"])]

    async def get_message_text(self, message_id: str) -> str:
        return self.quotes.get(message_id, "")

    async def upload_image(self, *, data: bytes) -> dict:
        self.uploaded_images.append(data)
        return {"data": {"image_key": f"img_{len(self.uploaded_images)}"}}

    async def upload_file(self, *, data: bytes, name: str) -> dict:
        self.uploaded_files.append((name, data))
        return {"data": {"file_key": f"file_{len(self.uploaded_files)}"}}

    async def close(self) -> None:
        self.closed += 1


class FakeEventSource:
    def __init__(self) -> None:
        self.callback = None
        self.started = 0
        self.stopped = 0

    def start(self, callback) -> bool:
        self.callback = callback
        self.started += 1
        return True

    def stop(self) -> None:
        self.stopped += 1


class SupervisedWsClient:
    def __init__(
        self,
        *,
        connect_error: BaseException | None = None,
        receive_error_delay: float | None = None,
        block_connect: bool = False,
    ) -> None:
        self.connect_error = connect_error
        self.receive_error_delay = receive_error_delay
        self.block_connect = block_connect
        self.connect_entered = threading.Event()
        self.connected = threading.Event()
        self.receive_cancelled = threading.Event()
        self.ping_cancelled = threading.Event()
        self.disconnected = threading.Event()

    async def connect(self) -> asyncio.Task:
        self.connect_entered.set()
        if self.block_connect:
            await asyncio.Future()
        if self.connect_error is not None:
            raise self.connect_error
        self.connected.set()
        return asyncio.create_task(self._receive())

    async def _receive(self) -> None:
        try:
            if self.receive_error_delay is not None:
                await asyncio.sleep(self.receive_error_delay)
                raise RuntimeError("receive failed")
            await asyncio.Future()
        finally:
            self.receive_cancelled.set()

    async def ping_loop(self) -> None:
        try:
            await asyncio.Future()
        finally:
            self.ping_cancelled.set()

    async def disconnect(self) -> None:
        self.disconnected.set()


def _mention(open_id: str, key: str, name: str) -> dict:
    return {"key": key, "id": {"open_id": open_id}, "name": name, "tenant_key": "tenant"}


def _group_event(
    chat_id: str = "oc_group",
    text: str = "hello from feishu",
    *,
    message_id: str = "om_msg",
    mentions: list[dict] | None = None,
    message_type: str = "text",
    content: dict | None = None,
    sender_type: str = "user",
    parent_id: str = "",
    thread_id: str = "",
) -> dict:
    if mentions is None:
        mentions = [_mention("ou_bot", "@_user_1", "Loreweaver")]
        text = f"@_user_1 {text}"
    return {
        "schema": "2.0",
        "header": {"event_type": "im.message.receive_v1"},
        "event": {
            "sender": {
                "sender_id": {"open_id": "ou_user"},
                "sender_type": sender_type,
                "name": "Nora",
            },
            "message": {
                "message_id": message_id,
                "parent_id": parent_id,
                "thread_id": thread_id,
                "chat_id": chat_id,
                "chat_type": "group",
                "message_type": message_type,
                "content": json.dumps(content if content is not None else {"text": text}, ensure_ascii=False),
                "mentions": mentions,
            },
        },
    }


def _dm_event(*, sender_type: str = "user") -> dict:
    event = _group_event(mentions=[], sender_type=sender_type)
    event["event"]["message"]["chat_type"] = "p2p"
    return event


def _adapter(
    transport: FakeTransport | None = None,
    event_source: FakeEventSource | None = None,
    **config,
) -> tuple[FeishuAdapter, FakeTransport]:
    transport = transport or FakeTransport()
    adapter = FeishuAdapter(
        {"app_id": "app", "app_secret": "secret", **config},
        transport=transport,
        event_source=event_source,
    )
    return adapter, transport


async def test_connect_resolves_bot_identity_and_owns_event_source_lifecycle() -> None:
    source = FakeEventSource()
    adapter, transport = _adapter(event_source=source)

    assert await adapter.connect() is True
    assert transport.identity_calls == 1
    assert source.started == 1
    assert source.callback is not None

    await adapter.disconnect()

    assert source.stopped == 1
    assert transport.closed == 1


async def test_group_event_normalizes_precise_mentions_sender_and_thread() -> None:
    adapter, _ = _adapter(bot_open_id="ou_bot")
    received: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        received.append(message)

    adapter.set_message_handler(handler)
    mentions = [
        _mention("ou_bot", "@_bot", "Loreweaver"),
        _mention("ou_friend", "@_friend", "Mira"),
    ]
    inbound = await adapter.handle_event(
        _group_event(
            text="unused",
            mentions=mentions,
            content={"text": "@_bot inspect this with @_friend"},
            thread_id="omt_thread",
        )
    )
    await adapter.wait_idle()

    assert inbound is received[0]
    assert inbound.source.chat_key() == "feishu:group:oc_group:omt_thread"
    assert inbound.source.user_id == "ou_user"
    assert inbound.source.user_name == "Nora"
    assert inbound.source.message_id == "om_msg"
    assert inbound.source.is_bot is False
    assert inbound.at_bot is True
    assert inbound.text == "inspect this with @Mira"


async def test_non_bot_mention_does_not_open_group_mention_gate() -> None:
    adapter, _ = _adapter(bot_open_id="ou_bot")
    received: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        received.append(message)

    adapter.set_message_handler(handler)

    inbound = await adapter.handle_event(
        _group_event(
            mentions=[_mention("ou_friend", "@_friend", "Mira")],
            content={"text": "hello @_friend"},
        )
    )
    await adapter.wait_idle()

    assert inbound is not None
    assert inbound.at_bot is False
    assert inbound.text == "hello @Mira"


async def test_p2p_and_app_sender_map_to_dm_and_bot() -> None:
    adapter, _ = _adapter(bot_open_id="ou_bot")
    inbound = adapter.to_inbound_message(_dm_event(sender_type="app"))

    assert inbound is not None
    assert inbound.source.chat_key() == "feishu:dm:oc_group"
    assert inbound.source.is_bot is True
    assert inbound.at_bot is False


@pytest.mark.parametrize(
    "event",
    [
        {"header": {"event_type": "im.chat.member.user.added_v1"}},
        _group_event(message_id=""),
        {"header": {"event_type": "im.message.receive_v1"}, "event": {"message": {}}},
    ],
)
async def test_non_message_and_malformed_events_are_ignored(event: dict) -> None:
    adapter, _ = _adapter(bot_open_id="ou_bot")

    assert await adapter.handle_event(event) is None
    assert not adapter._tasks


async def test_duplicate_message_id_is_dispatched_once() -> None:
    adapter, _ = _adapter(bot_open_id="ou_bot")
    received: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        received.append(message)

    adapter.set_message_handler(handler)
    event = _group_event(message_id="same")

    assert await adapter.handle_event(event) is not None
    assert await adapter.handle_event(event) is None
    await adapter.wait_idle()

    assert len(received) == 1


def test_recent_message_id_window_is_bounded() -> None:
    recent = _RecentIds(maximum=2)

    assert recent.add("one") is True
    assert recent.add("two") is True
    assert recent.add("two") is False
    assert recent.add("three") is True
    assert recent.add("one") is True


async def test_handle_event_does_not_wait_for_keeper_turn() -> None:
    adapter, _ = _adapter(bot_open_id="ou_bot")
    started = asyncio.Event()
    release = asyncio.Event()

    async def handler(_message: InboundMessage) -> None:
        started.set()
        await release.wait()

    adapter.set_message_handler(handler)

    inbound = await asyncio.wait_for(adapter.handle_event(_group_event()), timeout=0.2)
    assert inbound is not None
    await asyncio.wait_for(started.wait(), timeout=0.2)
    assert adapter._tasks

    release.set()
    await adapter.wait_idle()


async def test_sdk_thread_callback_returns_before_keeper_turn() -> None:
    source = FakeEventSource()
    adapter, _ = _adapter(event_source=source)
    started = asyncio.Event()
    release = asyncio.Event()

    async def handler(_message: InboundMessage) -> None:
        started.set()
        await release.wait()

    adapter.set_message_handler(handler)
    await adapter.connect()
    returned = threading.Event()

    def invoke() -> None:
        source.callback(_group_event())
        returned.set()

    thread = threading.Thread(target=invoke)
    thread.start()
    await asyncio.wait_for(asyncio.to_thread(returned.wait), timeout=0.5)
    await asyncio.wait_for(started.wait(), timeout=0.5)
    assert adapter._tasks

    release.set()
    await adapter.wait_idle()
    thread.join()
    await adapter.disconnect()


async def test_reply_quote_is_hydrated_off_the_callback_path() -> None:
    adapter, transport = _adapter(bot_open_id="ou_bot")
    transport.quotes["om_parent"] = "the earlier clue"
    received: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        received.append(message)

    adapter.set_message_handler(handler)
    await adapter.handle_event(_group_event(parent_id="om_parent"))
    await adapter.wait_idle()

    assert received[0].quoted_text == "the earlier clue"


async def test_post_text_and_image_resources_are_preserved() -> None:
    adapter, transport = _adapter(bot_open_id="ou_bot")
    content = {
        "zh_cn": {
            "title": "Clue",
            "content": [
                [{"tag": "text", "text": "A torn page"}],
                [{"tag": "img", "image_key": "img_clue"}],
            ],
        }
    }
    transport.resources[("om_msg", "img_clue", "image")] = b"image-bytes"

    inbound = adapter.to_inbound_message(
        _group_event(message_type="post", content=content, mentions=[])
    )

    assert inbound is not None
    assert inbound.text == "Clue\nA torn page"
    assert inbound.attachments == [
        ChatAttachment(
            id="om_msg:image:img_clue",
            name="img_clue.jpg",
            mime="image/jpeg",
        )
    ]
    assert await adapter.fetch_attachment(inbound.attachments[0]) == b"image-bytes"
    assert transport.resource_calls == [
        {"message_id": "om_msg", "file_key": "img_clue", "resource_type": "image"}
    ]


@pytest.mark.parametrize(
    ("message_type", "content", "name", "mime", "resource_type"),
    [
        ("file", {"file_key": "file_pdf", "file_name": "notes.pdf"}, "notes.pdf", "application/pdf", "file"),
        ("audio", {"file_key": "audio_key"}, "om_msg.opus", "audio/ogg", "file"),
        ("image", {"image_key": "image_key"}, "om_msg.jpg", "image/jpeg", "image"),
    ],
)
def test_media_messages_expose_lazy_attachment_metadata(
    message_type: str,
    content: dict,
    name: str,
    mime: str,
    resource_type: str,
) -> None:
    adapter, _ = _adapter(bot_open_id="ou_bot")

    inbound = adapter.to_inbound_message(
        _group_event(message_type=message_type, content=content, mentions=[])
    )

    assert inbound is not None
    assert inbound.text == ""
    assert inbound.attachments[0].name == name
    assert inbound.attachments[0].mime == mime
    assert f":{resource_type}:" in inbound.attachments[0].id


async def test_inline_attachment_data_does_not_call_feishu_resource_api() -> None:
    adapter, transport = _adapter()
    attachment = ChatAttachment(id="inline", data=b"inline")

    assert await adapter.fetch_attachment(attachment, max_bytes=6) == b"inline"
    assert transport.resource_calls == []

    with pytest.raises(ValueError, match="download_limit"):
        await adapter.fetch_attachment(attachment, max_bytes=5)


async def test_handler_reply_uses_native_reply_endpoint() -> None:
    adapter, transport = _adapter(bot_open_id="ou_bot")

    async def handler(_message: InboundMessage) -> ChatMessage:
        return ChatMessage(text="keeper reply")

    adapter.set_message_handler(handler)
    await adapter.handle_event(_group_event(message_id="om_original"))
    await adapter.wait_idle()

    assert transport.message.created == []
    assert transport.message.replied == [
        {
            "message_id": "om_original",
            "msg_type": "text",
            "content": json.dumps({"text": "keeper reply"}, ensure_ascii=False),
        }
    ]


async def test_structured_message_has_lossless_plain_text_fallback() -> None:
    adapter, transport = _adapter()
    source = SessionSource(platform="feishu", chat_type="group", chat_id="oc_group")
    message = ChatMessage(
        text="Status",
        markdown=True,
        embeds=[
            ChatEmbed(
                title="Investigator",
                description="Ready",
                fields=(ChatField("HP", "10", True),),
                footer="Round 2",
            )
        ],
        components=[ChatComponent(id="roll", label="Roll", command=".roll 1d20")],
    )

    result = await adapter.send_message(source, message)

    assert result.ok is True
    assert result.message_id == "om_sent"
    assert transport.message.created == [
        {
            "receive_id": "oc_group",
            "receive_id_type": "chat_id",
            "msg_type": "text",
            "content": json.dumps(
                {"text": "Status\nInvestigator\nReady\nHP: 10\nRound 2\n1. Roll — .roll 1d20"},
                ensure_ascii=False,
            ),
        }
    ]


async def test_public_reply_and_group_private_reply_have_distinct_targets() -> None:
    adapter, transport = _adapter()
    source = SessionSource(
        platform="feishu",
        chat_type="group",
        chat_id="oc_group",
        user_id="ou_user",
    )

    public = await adapter.send_message(source, ChatMessage(text="public"), reply_to="om_original")
    private = await adapter.send_message(
        source,
        ChatMessage(text="private", private=True),
        reply_to="om_original",
    )

    assert public.ok is True
    assert private.ok is True
    assert adapter.supports_private_reply(source) is True
    assert transport.message.replied[0]["message_id"] == "om_original"
    assert transport.message.created == [
        {
            "receive_id": "ou_user",
            "receive_id_type": "open_id",
            "msg_type": "text",
            "content": json.dumps({"text": "private"}, ensure_ascii=False),
        }
    ]


async def test_group_private_reply_without_sender_is_never_sent_to_group() -> None:
    adapter, transport = _adapter()
    source = SessionSource(platform="feishu", chat_type="group", chat_id="oc_group")

    result = await adapter.send_message(source, ChatMessage(text="secret", private=True))

    assert result.ok is False
    assert transport.message.created == []
    assert transport.message.replied == []


async def test_outbound_image_and_file_are_uploaded_before_delivery() -> None:
    adapter, transport = _adapter()
    source = SessionSource(platform="feishu", chat_type="group", chat_id="oc_group")
    message = ChatMessage(
        attachments=[
            ChatAttachment(name="map.png", mime="image/png", data=b"png"),
            ChatAttachment(name="notes.pdf", mime="application/pdf", data=b"pdf"),
        ]
    )

    result = await adapter.send_message(source, message)

    assert result.ok is True
    assert transport.uploaded_images == [b"png"]
    assert transport.uploaded_files == [("notes.pdf", b"pdf")]
    assert [call["msg_type"] for call in transport.message.created] == ["image", "file"]
    assert json.loads(transport.message.created[0]["content"]) == {"image_key": "img_1"}
    assert json.loads(transport.message.created[1]["content"]) == {"file_key": "file_1"}


@pytest.mark.parametrize(
    "attachment",
    [
        ChatAttachment(name="missing.pdf", mime="application/pdf"),
        ChatAttachment(name="huge.pdf", mime="application/pdf", data=b"x" * (MAX_FILE_BYTES + 1)),
    ],
)
async def test_invalid_outbound_attachment_fails_without_sending(attachment: ChatAttachment) -> None:
    adapter, transport = _adapter()
    source = SessionSource(platform="feishu", chat_type="dm", chat_id="oc_dm")

    result = await adapter.send_message(source, ChatMessage(attachments=[attachment]))

    assert result.ok is False
    assert transport.message.created == []


async def test_failed_api_response_is_returned_as_send_failure() -> None:
    adapter, transport = _adapter()
    transport.message.response = {"code": 999, "msg": "rejected"}
    source = SessionSource(platform="feishu", chat_type="dm", chat_id="oc_dm")

    result = await adapter.send_message(source, ChatMessage(text="hello"))

    assert result.ok is False
    assert result.message_id is None


async def test_sync_transport_call_does_not_block_gateway_event_loop() -> None:
    class BlockingMessageApi:
        def create(self, **_kwargs):
            time.sleep(0.3)
            return {"data": {"message_id": "sent"}}

    transport = FakeTransport()
    transport.im.v1.message = BlockingMessageApi()
    adapter = FeishuAdapter({}, transport=transport)
    source = SessionSource(platform="feishu", chat_type="dm", chat_id="oc_dm")
    ticked = asyncio.Event()

    async def ticker() -> None:
        await asyncio.sleep(0.01)
        ticked.set()

    send_task = asyncio.create_task(adapter.send_message(source, ChatMessage(text="hello")))
    asyncio.create_task(ticker())

    await asyncio.wait_for(ticked.wait(), timeout=0.15)
    assert (await send_task).ok is True


async def test_long_text_uses_base_adapter_split_without_truncation() -> None:
    adapter, transport = _adapter()
    source = SessionSource(platform="feishu", chat_type="dm", chat_id="oc_dm")
    text = "x" * (MAX_TEXT_CHARS + 17)

    result = await adapter.send_message(source, ChatMessage(text=text))

    assert result.ok is True
    sent = "".join(json.loads(call["content"])["text"] for call in transport.message.created)
    assert sent == text
    assert len(transport.message.created) == 2


async def test_ws_sources_are_isolated_and_never_mutate_sdk_global_loop() -> None:
    if lark_ws_module is None:
        pytest.skip("lark-oapi is not installed")
    sdk_loop = lark_ws_module.loop
    clients = [SupervisedWsClient(), SupervisedWsClient()]
    sources = [
        _LarkEventSource(
            lambda client=client: client,
            start_timeout=0.5,
            stop_timeout=0.5,
        )
        for client in clients
    ]

    assert await asyncio.gather(*(asyncio.to_thread(source.start) for source in sources)) == [
        True,
        True,
    ]
    threads = [source._thread for source in sources]
    assert all(thread is not None and thread.daemon for thread in threads)
    assert lark_ws_module.loop is sdk_loop

    await asyncio.gather(*(asyncio.to_thread(source.stop) for source in sources))

    assert all(thread is not None and not thread.is_alive() for thread in threads)
    assert all(source._loop is None for source in sources)
    assert lark_ws_module.loop is sdk_loop
    assert all(client.receive_cancelled.is_set() for client in clients)
    assert all(client.ping_cancelled.is_set() for client in clients)
    assert all(client.disconnected.is_set() for client in clients)


async def test_ws_source_retries_first_transient_failure_before_reporting_ready() -> None:
    clients = [
        SupervisedWsClient(connect_error=RuntimeError("temporary")),
        SupervisedWsClient(),
    ]
    calls = 0

    def factory() -> SupervisedWsClient:
        nonlocal calls
        client = clients[min(calls, len(clients) - 1)]
        calls += 1
        return client

    source = _LarkEventSource(
        factory,
        retry_delay=0.01,
        start_timeout=0.5,
        stop_timeout=0.5,
    )

    assert await asyncio.to_thread(source.start) is True
    assert calls == 2
    assert clients[0].disconnected.is_set()
    assert clients[1].connected.is_set()

    await asyncio.to_thread(source.stop)


async def test_ws_source_returns_false_for_permanent_client_exception() -> None:
    if lark_ws_module is None:
        pytest.skip("lark-oapi is not installed")
    client = SupervisedWsClient(
        connect_error=lark_ws_module.ClientException(403, "invalid credentials")
    )
    source = _LarkEventSource(
        lambda: client,
        permanent_exceptions=(lark_ws_module.ClientException,),
        retry_delay=0.01,
        start_timeout=0.5,
        stop_timeout=0.5,
    )

    assert await asyncio.to_thread(source.start) is False
    assert client.disconnected.is_set()
    assert source._thread is not None and not source._thread.is_alive()


async def test_ws_source_supervises_receive_failure_and_reconnects() -> None:
    clients = [
        SupervisedWsClient(receive_error_delay=0.02),
        SupervisedWsClient(),
    ]
    calls = 0

    def factory() -> SupervisedWsClient:
        nonlocal calls
        client = clients[min(calls, len(clients) - 1)]
        calls += 1
        return client

    source = _LarkEventSource(
        factory,
        retry_delay=0.01,
        start_timeout=0.5,
        stop_timeout=0.5,
    )

    assert await asyncio.to_thread(source.start) is True
    assert await asyncio.wait_for(
        asyncio.to_thread(clients[1].connected.wait),
        timeout=0.5,
    )
    assert calls >= 2
    assert clients[0].disconnected.is_set()
    assert source._thread is not None and source._thread.is_alive()

    await asyncio.to_thread(source.stop)


async def test_ws_stop_cancels_initial_connect_and_source_can_restart() -> None:
    clients = [SupervisedWsClient(block_connect=True), SupervisedWsClient()]
    calls = 0

    def factory() -> SupervisedWsClient:
        nonlocal calls
        client = clients[min(calls, len(clients) - 1)]
        calls += 1
        return client

    source = _LarkEventSource(
        factory,
        retry_delay=0.01,
        start_timeout=1.0,
        stop_timeout=0.5,
    )
    start_task = asyncio.create_task(asyncio.to_thread(source.start))
    assert await asyncio.wait_for(
        asyncio.to_thread(clients[0].connect_entered.wait),
        timeout=0.5,
    )
    first_thread = source._thread

    await asyncio.to_thread(source.stop)

    assert await start_task is False
    assert first_thread is not None and not first_thread.is_alive()
    assert clients[0].disconnected.is_set()

    assert await asyncio.to_thread(source.start) is True
    second_thread = source._thread
    assert second_thread is not None and second_thread is not first_thread
    assert clients[1].connected.is_set()

    await asyncio.to_thread(source.stop)
    assert not second_thread.is_alive()


async def test_adapter_connect_cancellation_stops_initial_ws_thread() -> None:
    client = SupervisedWsClient(block_connect=True)
    source = _LarkEventSource(
        lambda: client,
        start_timeout=1.0,
        stop_timeout=0.5,
    )
    adapter, _ = _adapter(
        event_source=source,
        bot_open_id="ou_configured",
    )
    connect_task = asyncio.create_task(adapter.connect())
    assert await asyncio.wait_for(
        asyncio.to_thread(client.connect_entered.wait),
        timeout=0.5,
    )
    thread = source._thread

    connect_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await connect_task

    assert thread is not None and not thread.is_alive()
    assert client.disconnected.is_set()
    assert adapter._main_loop is None
    assert adapter._accepting_events is False


async def test_controlled_client_bounds_websocket_close_and_uses_current_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not LARK_OAPI_AVAILABLE or lark_ws_module is None:
        pytest.skip("lark-oapi is not installed")
    calls: list[dict] = []

    class Connection:
        async def recv(self) -> bytes:
            await asyncio.Future()
            raise AssertionError("unreachable")

        async def close(self) -> None:
            await asyncio.Future()

    connection = Connection()

    async def connect(_url: str, **kwargs):
        calls.append(kwargs)
        return connection

    client = _ControlledLarkWsClient(
        "app",
        "secret",
        event_handler=SimpleNamespace(),
        endpoint_timeout=0.05,
        connect_timeout=0.05,
        close_timeout=0.02,
    )

    async def endpoint() -> str:
        return "ws://example.invalid/ws?device_id=device&service_id=1"

    monkeypatch.setattr(client, "_get_conn_url_async", endpoint)
    monkeypatch.setattr(lark_ws_module.websockets, "connect", connect)

    receive_task = await client.connect()

    assert receive_task.get_loop() is asyncio.get_running_loop()
    assert calls == [{"open_timeout": 0.05, "close_timeout": 0.02}]
    with pytest.raises(TimeoutError):
        await client.disconnect()
    assert receive_task.cancelled()


async def test_endpoint_request_is_async_cancellable_and_has_explicit_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if not LARK_OAPI_AVAILABLE:
        pytest.skip("lark-oapi is not installed")
    entered = asyncio.Event()
    observed_timeouts: list[httpx.Timeout] = []

    class HttpClient:
        def __init__(self, *, timeout: httpx.Timeout) -> None:
            observed_timeouts.append(timeout)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args) -> None:
            return None

        async def post(self, *_args, **_kwargs):
            entered.set()
            await asyncio.Future()

    monkeypatch.setattr(feishu_adapter_module.httpx, "AsyncClient", HttpClient)
    client = _ControlledLarkWsClient(
        "app",
        "secret",
        event_handler=SimpleNamespace(),
        endpoint_timeout=0.07,
    )
    task = asyncio.create_task(client._get_conn_url_async())
    await asyncio.wait_for(entered.wait(), timeout=0.2)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert len(observed_timeouts) == 1
    assert observed_timeouts[0].connect == 0.07
    assert observed_timeouts[0].read == 0.07


@pytest.mark.parametrize("identity_mode", ["empty", "whitespace", "error"])
async def test_connect_rejects_missing_bot_identity(identity_mode: str) -> None:
    source = FakeEventSource()
    transport = FakeTransport(bot_open_id=" " if identity_mode == "whitespace" else "")
    if identity_mode == "error":

        async def fail_identity() -> str:
            raise RuntimeError("https://example.invalid?token=secret")

        transport.bot_open_id = fail_identity  # type: ignore[method-assign]
    adapter, _ = _adapter(transport=transport, event_source=source)

    assert await adapter.connect() is False
    assert source.started == 0
    assert adapter._main_loop is None


async def test_configured_bot_identity_is_a_fallback_when_lookup_is_unavailable() -> None:
    source = FakeEventSource()
    transport = FakeTransport(bot_open_id="")
    adapter, _ = _adapter(
        transport=transport,
        event_source=source,
        bot_open_id="ou_configured",
    )

    assert await adapter.connect() is True
    assert transport.identity_calls == 0
    assert source.started == 1

    await adapter.disconnect()


async def test_sdk_callback_rejects_events_after_disconnect() -> None:
    source = FakeEventSource()
    adapter, _ = _adapter(event_source=source)
    assert await adapter.connect() is True
    callback = source.callback

    await adapter.disconnect()

    with pytest.raises(RuntimeError, match="not_accepting"):
        callback(_group_event(message_id="late"))


async def test_sdk_callback_timeout_is_reported_and_cancelled() -> None:
    adapter, _ = _adapter(callback_timeout=0.02)
    blocked_loop = asyncio.new_event_loop()
    blocker_started = threading.Event()

    def block_loop() -> None:
        blocker_started.set()
        time.sleep(0.08)

    thread = threading.Thread(target=blocked_loop.run_forever, daemon=True)
    thread.start()
    blocked_loop.call_soon_threadsafe(block_loop)
    assert await asyncio.wait_for(
        asyncio.to_thread(blocker_started.wait),
        timeout=0.2,
    )
    adapter._main_loop = blocked_loop
    adapter._set_accepting_events(True)

    with pytest.raises(TimeoutError, match="acceptance_timeout"):
        adapter._on_sdk_event(_group_event(message_id="timeout"))

    await asyncio.sleep(0.1)
    blocked_loop.call_soon_threadsafe(blocked_loop.stop)
    await asyncio.to_thread(thread.join, 0.2)
    blocked_loop.close()


async def test_sdk_callback_propagates_main_loop_acceptance_failure() -> None:
    adapter, _ = _adapter()
    adapter._main_loop = asyncio.get_running_loop()
    adapter._set_accepting_events(True)

    async def fail(_event: dict) -> None:
        raise ValueError("bad event")

    adapter.handle_event = fail  # type: ignore[method-assign]

    with pytest.raises(RuntimeError, match="acceptance_failed") as exc_info:
        await asyncio.to_thread(adapter._on_sdk_event, _group_event())
    assert isinstance(exc_info.value.__cause__, ValueError)


async def test_disconnect_rejects_new_events_then_drains_and_cancels_keeper() -> None:
    order: list[str] = []

    class RacingEventSource(FakeEventSource):
        def stop(self) -> None:
            order.append("source_stop")
            with pytest.raises(RuntimeError, match="not_accepting"):
                self.callback(_group_event(message_id="during-stop"))
            super().stop()

    source = RacingEventSource()
    adapter, _ = _adapter(event_source=source, inbound_drain_timeout=0.02)
    keeper_started = asyncio.Event()

    async def handler(_message: InboundMessage) -> None:
        keeper_started.set()
        try:
            await asyncio.Future()
        finally:
            order.append("keeper_cancelled")

    adapter.set_message_handler(handler)
    assert await adapter.connect() is True
    await adapter.handle_event(_group_event())
    await asyncio.wait_for(keeper_started.wait(), timeout=0.2)

    await adapter.disconnect()

    assert order == ["source_stop", "keeper_cancelled"]
    assert not adapter._tasks


async def test_resource_fetch_failure_is_sanitized_and_can_be_retried(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, transport = _adapter()
    inbound = adapter.to_inbound_message(
        _group_event(
            message_type="image",
            content={"image_key": "img_retry"},
            mentions=[],
        )
    )
    assert inbound is not None
    attachment = inbound.attachments[0]
    attempts = 0

    async def fetch_resource(**_kwargs) -> bytes:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("https://example.invalid?token=top-secret")
        return b"retry-success"

    transport.fetch_resource = fetch_resource  # type: ignore[method-assign]
    caplog.set_level(logging.WARNING)

    with pytest.raises(FileNotFoundError) as exc_info:
        await adapter.fetch_attachment(attachment)

    assert exc_info.value.__cause__ is None
    assert "top-secret" not in caplog.text
    assert attachment.id in adapter._resources
    assert await adapter.fetch_attachment(attachment) == b"retry-success"
    assert attempts == 2
    assert attachment.id not in adapter._resources


async def test_oversized_resource_is_rejected_without_losing_retry_metadata() -> None:
    adapter, transport = _adapter()
    transport.resources[("om_msg", "img_large", "image")] = b"large"
    inbound = adapter.to_inbound_message(
        _group_event(
            message_type="image",
            content={"image_key": "img_large"},
            mentions=[],
        )
    )
    assert inbound is not None
    attachment = inbound.attachments[0]

    with pytest.raises(ValueError, match="download_limit"):
        await adapter.fetch_attachment(attachment, max_bytes=4)

    assert attachment.id in adapter._resources
    assert await adapter.fetch_attachment(attachment, max_bytes=5) == b"large"


def test_feishu_adapter_registry_reflects_optional_sdk_availability() -> None:
    entry = platform_registry.get("feishu")

    assert entry is not None
    assert entry.label == "Feishu"
    assert entry.check_fn() is LARK_OAPI_AVAILABLE
    assert entry.required_env == ["TRPG_FEISHU__APP_ID", "TRPG_FEISHU__APP_SECRET"]
    assert entry.install_hint == "uv sync --extra feishu"
