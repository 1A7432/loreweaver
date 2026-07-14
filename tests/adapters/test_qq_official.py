import asyncio
import base64
from copy import deepcopy

import pytest

from adapters.qq_official import QQOfficialAdapter
from adapters.qq_official.adapter import (
    C2C_MESSAGE_CREATE,
    GROUP_AT_MESSAGE_CREATE,
    GROUP_MESSAGE_CREATE,
    INTENTS,
    MAX_ATTACHMENT_BYTES,
    MSG_TYPE_MARKDOWN,
    MSG_TYPE_MEDIA,
    MSG_TYPE_TEXT,
    QQAPIError,
    _DefaultQQTransport,
    _RecentIds,
)
from adapters.qq_official.gateway import HEARTBEAT, IDENTIFY, RESUME, QQGateway
from gateway.chat import ChatAttachment, ChatComponent, ChatMessage
from gateway.events import InboundMessage
from gateway.rooms import set_binding
from gateway.session import SessionSource
from infra.config import QQSettings
from infra.media_store import MediaStore
from infra.store import Store


class FakeTransport:
    def __init__(self) -> None:
        self.http: list[dict] = []
        self.websocket: list[dict] = []
        self.closed_ws = 0
        self.closed = 0
        self.downloads: dict[str, bytes] = {}
        self.fail = None
        self.ws_event = asyncio.Event()

    async def token(self) -> str:
        return "access-token"

    async def ws(self, _on_payload) -> None:
        await self.ws_event.wait()

    async def send_ws(self, payload) -> None:
        self.websocket.append(deepcopy(payload))

    async def close_ws(self) -> None:
        self.closed_ws += 1

    async def close(self) -> None:
        self.closed += 1
        self.ws_event.set()

    async def send(self, method, path, body):
        call = {"method": method, "path": path, "body": deepcopy(body)}
        self.http.append(call)
        if self.fail is not None:
            error = self.fail(call)
            if error is not None:
                raise error
        if path.endswith("/files"):
            return {"file_info": f"file-{len(self.http)}"}
        return {"id": f"message-{len(self.http)}"}

    async def fetch(self, url: str) -> bytes:
        return self.downloads[url]


class FakeResponse:
    def __init__(self, status: int, data: dict) -> None:
        self.status = status
        self.data = data

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args) -> None:
        return None

    async def json(self, *, content_type=None):
        del content_type
        return deepcopy(self.data)


class FakeHTTPSession:
    def __init__(self, statuses: list[int]) -> None:
        self.statuses = statuses
        self.authorizations: list[str] = []
        self.token_requests = 0

    def request(self, _method, _url, *, json, headers):
        del json
        self.authorizations.append(headers["Authorization"])
        status = self.statuses.pop(0)
        data = {"code": "unauthorized"} if status == 401 else {"id": "ok"}
        return FakeResponse(status, data)

    def post(self, _url, *, json):
        del json
        self.token_requests += 1
        return FakeResponse(200, {"access_token": "fresh", "expires_in": 7200})


def _adapter(
    store: Store | None = None,
    transport: FakeTransport | None = None,
    media_store: MediaStore | None = None,
    **config,
) -> tuple[QQOfficialAdapter, FakeTransport, Store]:
    store = store or Store(":memory:")
    transport = transport or FakeTransport()
    adapter = QQOfficialAdapter(
        QQSettings(app_id="app", secret="secret", **config),
        transport=transport,
        store=store,
        media_store=media_store,
    )
    return adapter, transport, store


def _group_payload(
    message_id: str,
    *,
    event_type: str = GROUP_AT_MESSAGE_CREATE,
    group_id: str = "group",
    user_id: str = "user",
    content: str = "<@bot> hello",
    **extra,
) -> dict:
    return {
        "op": 0,
        "t": event_type,
        "s": 1,
        "d": {
            "id": message_id,
            "group_openid": group_id,
            "content": content,
            "author": {"member_openid": user_id, "nick": "Nora"},
            **extra,
        },
    }


def _c2c_payload(message_id: str, *, user_id: str = "user", content: str = "hello", **extra) -> dict:
    return {
        "op": 0,
        "t": C2C_MESSAGE_CREATE,
        "s": 1,
        "d": {
            "id": message_id,
            "content": content,
            "author": {"user_openid": user_id},
            **extra,
        },
    }


def _source(group_id: str = "group") -> SessionSource:
    return SessionSource(platform="qq", chat_type="group", chat_id=group_id)


async def _dispatch(adapter: QQOfficialAdapter, payload: dict) -> None:
    await adapter.dispatch_payload(payload)
    await adapter.gateway.wait_idle()


def test_store_is_required() -> None:
    with pytest.raises(ValueError, match="qq.store.required"):
        QQOfficialAdapter(QQSettings(app_id="app", secret="secret"), transport=FakeTransport())


async def test_group_message_normalizes_quote_and_attachment_metadata() -> None:
    adapter, _, _ = _adapter()
    received: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        received.append(message)

    adapter.set_message_handler(handler)
    await _dispatch(
        adapter,
        _group_payload(
            "m1",
            attachments=[
                {
                    "filename": "clue.png",
                    "content_type": "image/png",
                    "size": 12,
                    "url": "https://cdn.example/clue.png",
                }
            ],
            message_scene={"ext": ["msg_idx=current", "ref_msg_idx=quoted"]},
            msg_elements=[{"msg_idx": "quoted", "content": "the earlier clue"}],
        )
    )

    message = received[0]
    assert message.text == "hello"
    assert message.at_bot is True
    assert message.quoted_text == "the earlier clue"
    assert message.source.user_name == "Nora"
    assert message.attachments == [
        ChatAttachment(
            id="https://cdn.example/clue.png",
            name="clue.png",
            mime="image/png",
            size=12,
            url="https://cdn.example/clue.png",
        )
    ]


async def test_message_elements_without_quote_marker_are_not_treated_as_a_quote() -> None:
    adapter, _, _ = _adapter()
    received: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        received.append(message)

    adapter.set_message_handler(handler)
    await _dispatch(
        adapter,
        _group_payload(
            "plain-elements",
            msg_elements=[{"msg_idx": "normal", "content": "not a quote"}],
        ),
    )

    assert received[0].quoted_text == ""


async def test_voice_uses_wav_url_and_includes_platform_asr_text() -> None:
    adapter, _, _ = _adapter()
    received: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        received.append(message)

    adapter.set_message_handler(handler)
    await _dispatch(
        adapter,
        _group_payload(
            "voice",
            attachments=[
                {
                    "filename": "voice.silk",
                    "content_type": "audio/silk",
                    "url": "https://cdn.example/voice.silk",
                    "voice_wav_url": "https://cdn.example/voice.wav",
                    "asr_refer_text": "open the old door",
                    "size": 12,
                }
            ],
        ),
    )

    message = received[0]
    assert message.text == "hello\nopen the old door"
    assert message.attachments == [
        ChatAttachment(
            id="https://cdn.example/voice.wav",
            name="voice.wav",
            mime="audio/wav",
            size=12,
            url="https://cdn.example/voice.wav",
        )
    ]


@pytest.mark.parametrize(
    ("filename", "mime"),
    [
        ("keeper-notes.pdf", "application/pdf"),
        ("scenario.md", "text/markdown"),
        ("module.json", "application/json"),
        ("clues.txt", "text/plain"),
        (
            "module.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
    ],
)
async def test_generic_file_content_type_uses_filename_mime(filename: str, mime: str) -> None:
    adapter, _, _ = _adapter()
    received: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        received.append(message)

    adapter.set_message_handler(handler)

    await _dispatch(
        adapter,
        _group_payload(
            f"file-{filename}",
            attachments=[
                {
                    "filename": filename,
                    "content_type": "file",
                    "size": 12,
                    "url": f"https://cdn.example/{filename}",
                }
            ],
        ),
    )

    assert received[0].attachments[0].mime == mime


async def test_unknown_generic_file_uses_octet_stream() -> None:
    adapter, _, _ = _adapter()
    received: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        received.append(message)

    adapter.set_message_handler(handler)

    await _dispatch(
        adapter,
        _group_payload(
            "unknown-file",
            attachments=[
                {
                    "filename": "module.unknown-extension",
                    "content_type": "file",
                    "url": "https://cdn.example/module.unknown-extension",
                }
            ],
        ),
    )

    assert received[0].attachments[0].mime == "application/octet-stream"


async def test_group_extension_and_c2c_have_distinct_sources() -> None:
    adapter, _, _ = _adapter()
    received: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        received.append(message)

    adapter.set_message_handler(handler)
    await _dispatch(adapter, _group_payload("g1", event_type=GROUP_MESSAGE_CREATE, content="plain"))
    await _dispatch(adapter, _c2c_payload("d1"))

    assert received[0].at_bot is False
    assert received[0].source.chat_key() == "qq:group:group"
    assert received[1].source.chat_key() == "qq:dm:user"


async def test_duplicate_message_id_is_not_dispatched_twice() -> None:
    adapter, _, _ = _adapter()
    received: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        received.append(message)

    adapter.set_message_handler(handler)
    await _dispatch(adapter, _group_payload("same"))
    await _dispatch(adapter, _group_payload("same"))

    assert len(received) == 1


async def test_rest_401_refreshes_token_and_retries_once() -> None:
    transport = _DefaultQQTransport(app_id="app", secret="secret")
    session = FakeHTTPSession([401, 200])
    transport._session = session
    transport._access_token = "stale"
    transport._token_expires_at = float("inf")

    result = await transport.send("GET", "/gateway", None)

    assert result == {"id": "ok"}
    assert session.authorizations == ["QQBot stale", "QQBot fresh"]
    assert session.token_requests == 1


async def test_rest_second_401_is_returned_without_another_retry() -> None:
    transport = _DefaultQQTransport(app_id="app", secret="secret")
    session = FakeHTTPSession([401, 401])
    transport._session = session
    transport._access_token = "stale"
    transport._token_expires_at = float("inf")

    with pytest.raises(QQAPIError, match="qq.api.401.unauthorized"):
        await transport.send("GET", "/gateway", None)

    assert session.authorizations == ["QQBot stale", "QQBot fresh"]
    assert session.token_requests == 1


async def test_dispatch_payload_does_not_wait_for_game_turn() -> None:
    adapter, _, _ = _adapter()
    started = asyncio.Event()
    release = asyncio.Event()

    async def handler(_message: InboundMessage) -> None:
        started.set()
        await release.wait()

    adapter.set_message_handler(handler)
    await asyncio.wait_for(adapter.dispatch_payload(_group_payload("slow")), timeout=0.1)
    await asyncio.wait_for(started.wait(), timeout=0.1)

    release.set()
    await adapter.gateway.wait_idle()


def test_recent_id_window_is_bounded() -> None:
    recent = _RecentIds(maximum=2)
    assert recent.add("one") is True
    assert recent.add("two") is True
    assert recent.add("two") is False
    assert recent.add("three") is True
    assert recent.add("one") is True


def test_interaction_intent_is_not_requested_without_an_interaction_handler() -> None:
    assert INTENTS & (1 << 26) == 0


async def test_handler_reply_uses_only_current_passive_window() -> None:
    adapter, transport, _ = _adapter()

    async def handler(_message: InboundMessage) -> ChatMessage:
        return ChatMessage(text="reply")

    adapter.set_message_handler(handler)
    await _dispatch(adapter, _group_payload("window-1"))

    assert transport.http == [
        {
            "method": "POST",
            "path": "/v2/groups/group/messages",
            "body": {"content": "reply", "msg_type": MSG_TYPE_TEXT, "msg_id": "window-1", "msg_seq": 1},
        }
    ]


async def test_no_window_queues_and_next_inbound_drains_after_restart() -> None:
    store = Store(":memory:")
    first, _, _ = _adapter(store=store)
    source = _source()

    result = await first.send_message(source, ChatMessage(text="queued"), session_key=source.chat_key())
    assert result.ok is True

    second_transport = FakeTransport()
    second, _, _ = _adapter(store=store, transport=second_transport)
    await _dispatch(second, _group_payload("window-2"))

    assert second_transport.http[0]["body"]["content"] == "queued"
    assert second_transport.http[0]["body"]["msg_id"] == "window-2"
    assert await second.outbox_size(source, source.chat_key()) == 0


async def test_rebinding_does_not_flush_another_logical_rooms_outbox() -> None:
    adapter, transport, store = _adapter()
    source = _source()
    old_room = "tui:group:old"
    new_room = "tui:group:new"
    await set_binding(store, source.chat_key(), old_room)
    await adapter.send_message(source, ChatMessage(text="old-room-secret"), session_key=old_room)
    await set_binding(store, source.chat_key(), new_room)

    await _dispatch(adapter, _group_payload("window-new"))

    assert transport.http == []
    assert await adapter.outbox_size(source, old_room) == 1
    assert await adapter.outbox_size(source, new_room) == 0


async def test_failed_send_keeps_failed_item_and_following_items() -> None:
    adapter, transport, _ = _adapter()
    source = _source()
    room = source.chat_key()
    await adapter.send_message(source, ChatMessage(text="first"), session_key=room)
    await adapter.send_message(source, ChatMessage(text="second"), session_key=room)
    message_posts = 0

    def fail_second(call):
        nonlocal message_posts
        if call["path"].endswith("/messages"):
            message_posts += 1
            if message_posts == 2:
                return RuntimeError("offline")
        return None

    transport.fail = fail_second
    await _dispatch(adapter, _group_payload("window-fail"))

    assert [call["body"]["content"] for call in transport.http] == ["first", "second"]
    assert await adapter.outbox_size(source, room) == 1

    transport.fail = None
    await _dispatch(adapter, _group_payload("window-retry"))
    assert transport.http[-1]["body"]["content"] == "second"
    assert await adapter.outbox_size(source, room) == 0


async def test_current_passive_send_reports_failure_without_dropping_queue() -> None:
    adapter, transport, _ = _adapter()
    source = _source()
    results = []

    def fail_message(call):
        return RuntimeError("offline") if call["path"].endswith("/messages") else None

    transport.fail = fail_message

    async def handler(_message: InboundMessage) -> None:
        results.append(
            await adapter.send_message(
                source,
                ChatMessage(text="current"),
                session_key=source.chat_key(),
            )
        )

    adapter.set_message_handler(handler)
    await _dispatch(adapter, _group_payload("window-hard-fail"))

    assert len(results) == 1
    assert results[0].ok is False
    assert results[0].error == "offline"
    assert await adapter.outbox_size(source, source.chat_key()) == 1


async def test_reply_window_keeps_strict_outbox_order() -> None:
    adapter, transport, _ = _adapter()
    source = _source()
    room = source.chat_key()
    for index in range(5):
        await adapter.send_message(source, ChatMessage(text=f"old-{index}"), session_key=room)

    async def handler(_message: InboundMessage) -> ChatMessage:
        return ChatMessage(text="current")

    adapter.set_message_handler(handler)
    await _dispatch(adapter, _group_payload("window-current"))

    assert [call["body"]["content"] for call in transport.http] == [
        "old-0",
        "old-1",
        "old-2",
        "old-3",
    ]
    assert await adapter.outbox_size(source, room) == 2
    queued = await adapter._load_outbox(adapter._outbox_key(source, room))
    assert [item["message"]["text"] for item in queued] == ["old-4", "current"]


async def test_long_markdown_is_split_without_truncation() -> None:
    adapter, transport, _ = _adapter()
    source = _source()
    room = source.chat_key()
    text = ("paragraph line\n\n" * 300) + "end"

    result = await adapter.send_message(source, ChatMessage(text=text, markdown=True), session_key=room)
    assert result.ok is True
    assert await adapter.outbox_size(source, room) > 1

    await _dispatch(adapter, _group_payload("window-long"))
    sent = "".join(call["body"]["content"] for call in transport.http)
    assert sent == text
    assert all(len(call["body"]["content"]) <= adapter.capabilities.max_text_chars for call in transport.http)


async def test_panel_entries_coalesce_and_outbox_stays_bounded() -> None:
    adapter, _, _ = _adapter()
    source = _source()
    room = source.chat_key()
    await adapter.send_message(source, ChatMessage(text="old", coalesce_key="panel"), session_key=room)
    await adapter.send_message(source, ChatMessage(text="new", coalesce_key="panel"), session_key=room)
    for index in range(70):
        await adapter.send_message(source, ChatMessage(text=f"narrative-{index}"), session_key=room)

    key = adapter._outbox_key(source, room)
    items = await adapter._load_outbox(key)
    texts = [item["message"]["text"] for item in items]
    assert len(items) == 64
    assert "old" not in texts
    assert items[0]["message"]["coalesce_key"] == "outbox_overflow"
    assert texts[-1] == "narrative-69"


async def test_markdown_keyboard_uses_commands_and_permission_error_falls_back_to_plain() -> None:
    adapter, transport, _ = _adapter(markdown_template_id="tpl", keyboard_enabled=True)

    def reject_rich(call):
        if call["path"].endswith("/messages") and call["body"].get("msg_type") == MSG_TYPE_MARKDOWN:
            return QQAPIError(403, "no_permission")
        return None

    transport.fail = reject_rich

    async def handler(_message: InboundMessage) -> ChatMessage:
        return ChatMessage(
            text="Choose",
            markdown=True,
            components=[ChatComponent(id="roll", label="Roll", command="/roll 1d20")],
        )

    adapter.set_message_handler(handler)
    await _dispatch(adapter, _group_payload("window-rich"))

    rich, plain = transport.http
    assert rich["body"]["msg_type"] == MSG_TYPE_MARKDOWN
    assert rich["body"]["markdown"]["params"][0]["values"] == ["Choose"]
    button = rich["body"]["keyboard"]["content"]["rows"][0]["buttons"][0]
    assert button["action"]["data"] == "/roll 1d20"
    assert button["action"]["permission"] == {"type": 0}
    assert plain["body"]["msg_type"] == MSG_TYPE_TEXT
    assert "1. Roll — /roll 1d20" in plain["body"]["content"]
    assert rich["body"]["msg_seq"] == plain["body"]["msg_seq"] == 1


async def test_image_upload_is_two_step_and_sends_file_info() -> None:
    adapter, transport, _ = _adapter()

    async def handler(_message: InboundMessage) -> ChatMessage:
        return ChatMessage(
            text="handout",
            attachments=[ChatAttachment(id="image", name="map.png", mime="image/png", size=3, data=b"png")],
        )

    adapter.set_message_handler(handler)
    await _dispatch(adapter, _group_payload("window-media"))

    upload, message = transport.http
    assert upload["path"] == "/v2/groups/group/files"
    assert upload["body"] == {
        "srv_send_msg": False,
        "file_data": base64.b64encode(b"png").decode("ascii"),
        "file_type": 1,
    }
    assert message["body"]["msg_type"] == MSG_TYPE_MEDIA
    assert message["body"]["media"] == {"file_info": "file-1"}
    assert message["body"]["content"] == "handout"


async def test_generic_file_upload_includes_filename() -> None:
    adapter, transport, _ = _adapter()

    async def handler(_message: InboundMessage) -> ChatMessage:
        return ChatMessage(
            text="module",
            attachments=[
                ChatAttachment(
                    id="module",
                    name="module.pdf",
                    mime="application/pdf",
                    size=3,
                    data=b"pdf",
                )
            ],
        )

    adapter.set_message_handler(handler)
    await _dispatch(adapter, _group_payload("window-file"))

    assert transport.http[0]["body"] == {
        "srv_send_msg": False,
        "file_data": base64.b64encode(b"pdf").decode("ascii"),
        "file_type": 4,
        "file_name": "module.pdf",
    }


async def test_audio_upload_falls_back_to_generic_file() -> None:
    adapter, transport, _ = _adapter()

    def reject_voice(call):
        if call["path"].endswith("/files") and call["body"]["file_type"] == 3:
            return QQAPIError(400, "bad_voice_format")
        return None

    transport.fail = reject_voice

    async def handler(_message: InboundMessage) -> ChatMessage:
        return ChatMessage(
            text="ambience",
            attachments=[ChatAttachment(id="audio", name="rain.ogg", mime="audio/ogg", size=3, data=b"ogg")],
        )

    adapter.set_message_handler(handler)
    await _dispatch(adapter, _c2c_payload("window-audio"))

    assert [call["body"]["file_type"] for call in transport.http[:2]] == [3, 4]
    assert transport.http[1]["body"]["file_name"] == "rain.ogg"
    assert transport.http[2]["path"] == "/v2/users/user/messages"


@pytest.mark.parametrize("failure_stage", ["upload", "message"])
async def test_media_failure_stays_queued_and_never_claims_caption_success(
    tmp_path,
    failure_stage: str,
) -> None:
    store = Store(":memory:")
    media = MediaStore(store, tmp_path)
    adapter, transport, _ = _adapter(store=store, media_store=media)
    results = []

    def reject_media(call):
        is_upload = call["path"].endswith("/files")
        is_media_message = call["path"].endswith("/messages") and call["body"].get("msg_type") == MSG_TYPE_MEDIA
        if (failure_stage == "upload" and is_upload) or (
            failure_stage == "message" and is_media_message
        ):
            return QQAPIError(403, "media_denied")
        return None

    transport.fail = reject_media

    async def handler(message: InboundMessage) -> None:
        results.append(
            await adapter.send_message(
                message.source,
                ChatMessage(
                    text="handout",
                    attachments=[
                        ChatAttachment(
                            id="image",
                            name="map.png",
                            mime="image/png",
                            size=3,
                            data=b"png",
                        )
                    ],
                ),
                session_key=message.source.chat_key(),
            )
        )

    adapter.set_message_handler(handler)
    await _dispatch(adapter, _group_payload(f"media-{failure_stage}"))

    assert results[0].ok is False
    assert await adapter.outbox_size(_source(), _source().chat_key()) == 1
    assert not any(
        call["path"].endswith("/messages") and call["body"].get("msg_type") == MSG_TYPE_TEXT
        for call in transport.http
    )


async def test_attachment_over_20_mib_is_rejected_before_queue_or_transport() -> None:
    adapter, transport, _ = _adapter()
    source = _source()
    data = b"x" * (MAX_ATTACHMENT_BYTES + 1)

    result = await adapter.send_message(
        source,
        ChatMessage(
            attachments=[
                ChatAttachment(
                    id="large",
                    name="large.wav",
                    mime="audio/wav",
                    size=len(data),
                    data=data,
                )
            ]
        ),
        session_key=source.chat_key(),
    )

    assert result.ok is False
    assert result.error == "qq.media.too_large"
    assert transport.http == []
    assert await adapter.outbox_size(source, source.chat_key()) == 0


async def test_first_attachment_error_stops_before_later_parts_are_queued() -> None:
    adapter, _, _ = _adapter()
    source = _source()

    result = await adapter.send_message(
        source,
        ChatMessage(
            attachments=[
                ChatAttachment(id="inline", name="inline.png", mime="image/png", data=b"png"),
                ChatAttachment(
                    id="remote",
                    name="remote.png",
                    mime="image/png",
                    url="https://cdn.example/remote.png",
                ),
            ]
        ),
        session_key=source.chat_key(),
    )

    assert result.ok is False
    assert result.error == "qq.media_store.required"
    assert await adapter.outbox_size(source, source.chat_key()) == 0


async def test_queued_media_is_read_from_room_store_after_adapter_restart(tmp_path) -> None:
    store = Store(":memory:")
    media = MediaStore(store, tmp_path)
    source = _source()
    room = source.chat_key()
    record = await media.register_blob(
        room=room,
        data=b"image-data",
        mime="image/png",
        name="clue.png",
        uploader="keeper",
    )
    first, _, _ = _adapter(store=store, media_store=media)
    result = await first.send_message(
        source,
        ChatMessage(
            text="clue",
            attachments=[
                ChatAttachment(id=record.hash, name=record.name, mime=record.mime, size=record.size)
            ],
        ),
        session_key=room,
    )
    assert result.ok is True

    transport = FakeTransport()
    second, _, _ = _adapter(store=store, transport=transport, media_store=media)
    await _dispatch(second, _group_payload("window-restart-media"))

    assert transport.http[0]["path"].endswith("/files")
    assert base64.b64decode(transport.http[0]["body"]["file_data"]) == b"image-data"
    assert await second.outbox_size(source, room) == 0


async def test_fetch_attachment_downloads_remote_bytes() -> None:
    adapter, transport, _ = _adapter()
    transport.downloads["https://cdn.example/a.png"] = b"image"

    data = await adapter.fetch_attachment(ChatAttachment(url="https://cdn.example/a.png"))

    assert data == b"image"


async def test_private_message_is_never_queued_to_group() -> None:
    adapter, _, _ = _adapter()
    source = _source()

    result = await adapter.send_message(source, ChatMessage(text="secret", private=True), session_key="room")

    assert result.ok is False
    assert result.error == "qq.private.c2c_required"
    assert await adapter.outbox_size(source, "room") == 0


class GatewayTransport(FakeTransport):
    pass


async def test_gateway_hello_identifies_and_heartbeats_latest_sequence() -> None:
    transport = GatewayTransport()
    ticks: asyncio.Queue[None] = asyncio.Queue()

    async def sleep(_delay: float) -> None:
        await ticks.get()

    gateway = QQGateway(transport, _ignore, intents=123, sleep=sleep)
    await gateway.dispatch_payload({"op": 10, "d": {"heartbeat_interval": 1000}})
    assert transport.websocket[0]["op"] == IDENTIFY
    assert transport.websocket[0]["d"]["intents"] == 123

    await gateway.dispatch_payload({"op": 0, "t": "MESSAGE", "s": 42, "d": {}})
    await gateway.wait_idle()
    ticks.put_nowait(None)
    await asyncio.sleep(0)
    assert transport.websocket[-1] == {"op": HEARTBEAT, "d": 42}
    await gateway.stop()


async def test_gateway_resumes_and_handles_reconnect_and_invalid_session() -> None:
    transport = GatewayTransport()
    gateway = QQGateway(transport, _ignore, intents=1)
    gateway.session_id = "session"
    gateway.sequence = 9

    await gateway.dispatch_payload({"op": 10, "d": {"heartbeat_interval": 60000}})
    assert transport.websocket[-1]["op"] == RESUME
    assert transport.websocket[-1]["d"]["session_id"] == "session"
    await gateway.dispatch_payload({"op": 7})
    assert transport.closed_ws == 1

    await gateway.dispatch_payload({"op": 9, "d": False})
    assert gateway.session_id is None
    assert gateway.sequence is None
    assert transport.closed_ws == 2
    await gateway.stop()


class ReconnectingTransport(FakeTransport):
    def __init__(self) -> None:
        super().__init__()
        self.attempts = 0
        self.second = asyncio.Event()

    async def ws(self, _on_payload) -> None:
        self.attempts += 1
        if self.attempts == 1:
            raise RuntimeError("disconnected")
        self.second.set()
        await self.ws_event.wait()


async def test_gateway_supervisor_reconnects_with_backoff_and_closes_cleanly() -> None:
    transport = ReconnectingTransport()
    delays: list[float] = []

    async def sleep(delay: float) -> None:
        delays.append(delay)

    gateway = QQGateway(transport, _ignore, intents=1, sleep=sleep)
    await gateway.start()
    await asyncio.wait_for(transport.second.wait(), timeout=1)

    assert transport.attempts == 2
    assert delays == [1.0]
    await gateway.stop()
    assert transport.closed == 1


async def test_gateway_isolates_a_bad_business_event() -> None:
    transport = GatewayTransport()
    calls = 0

    async def broken(_payload) -> None:
        nonlocal calls
        calls += 1
        raise RuntimeError("bad event")

    gateway = QQGateway(transport, broken, intents=1)
    await gateway.dispatch_payload({"op": 0, "t": "A", "s": 1, "d": {}})
    await gateway.dispatch_payload({"op": 0, "t": "B", "s": 2, "d": {}})
    await gateway.wait_idle()

    assert calls == 2
    assert gateway.sequence == 2


async def test_ready_and_resumed_are_not_business_events() -> None:
    transport = GatewayTransport()
    handled: list[str] = []

    async def handler(payload) -> None:
        handled.append(payload["t"])

    gateway = QQGateway(transport, handler, intents=1)
    await gateway.dispatch_payload({"op": 0, "t": "READY", "s": 1, "d": {"session_id": "s"}})
    await gateway.dispatch_payload({"op": 0, "t": "RESUMED", "s": 2, "d": {}})
    await gateway.wait_idle()

    assert handled == []
    assert gateway.session_id == "s"
    await gateway.stop()


async def test_gateway_stop_discards_pending_events_before_restart() -> None:
    transport = GatewayTransport()
    started = asyncio.Event()
    handled: list[str] = []

    async def handler(payload) -> None:
        if payload["t"] == "first":
            started.set()
            await asyncio.Event().wait()
        handled.append(payload["t"])

    gateway = QQGateway(transport, handler, intents=1)
    await gateway.dispatch_payload({"op": 0, "t": "first", "s": 1, "d": {}})
    await asyncio.wait_for(started.wait(), timeout=0.1)
    await gateway.dispatch_payload({"op": 0, "t": "stale", "s": 2, "d": {}})

    await gateway.stop()
    await asyncio.wait_for(gateway.wait_idle(), timeout=0.1)

    transport.ws_event = asyncio.Event()
    await gateway.start()
    await gateway.dispatch_payload({"op": 0, "t": "fresh", "s": 3, "d": {}})
    await asyncio.wait_for(gateway.wait_idle(), timeout=0.1)

    assert handled == ["fresh"]
    await gateway.stop()


async def _ignore(_payload) -> None:
    return None
