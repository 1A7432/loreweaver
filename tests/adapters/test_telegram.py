import asyncio
from types import SimpleNamespace

import pytest

import adapters.telegram.adapter as telegram_module
from adapters.telegram.adapter import TelegramAdapter
from agent.services import build_services
from gateway.chat import (
    ChatAttachment,
    ChatComponent,
    ChatEmbed,
    ChatField,
    ChatMessage,
)
from gateway.commands import CommandRouter
from gateway.events import InboundMessage
from gateway.hub import Event
from gateway.registry import AdapterContext, platform_registry
from gateway.session import SessionSource
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from infra.store import Store


class BadRequest(Exception):
    pass


class NetworkError(Exception):
    pass


class BytearrayFile:
    async def download_as_bytearray(self):
        return bytearray(b"downloaded")


class MemoryFile:
    async def download_to_memory(self, *, out):
        out.write(b"in-memory")


class FakeTelegramTransport:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.command_payloads: list[list[tuple[str, str]]] = []
        self.files: dict[str, object] = {}
        self.failures: dict[str, list[Exception]] = {}
        self.closed = 0

    def fail_once(self, method: str, error: Exception) -> None:
        self.failures.setdefault(method, []).append(error)

    def _record(self, method: str, kwargs: dict):
        self.calls.append((method, kwargs))
        failures = self.failures.get(method, [])
        if failures:
            raise failures.pop(0)
        return {"message_id": f"{method}-{len(self.calls)}"}

    async def getMe(self):
        return {"id": 99, "username": "LoreBot"}

    async def sendMessage(self, **kwargs):
        return self._record("sendMessage", kwargs)

    async def sendPhoto(self, **kwargs):
        return self._record("sendPhoto", kwargs)

    async def sendVoice(self, **kwargs):
        return self._record("sendVoice", kwargs)

    async def sendAudio(self, **kwargs):
        return self._record("sendAudio", kwargs)

    async def sendVideo(self, **kwargs):
        return self._record("sendVideo", kwargs)

    async def sendDocument(self, **kwargs):
        return self._record("sendDocument", kwargs)

    async def editMessageText(self, **kwargs):
        return self._record("editMessageText", kwargs)

    async def sendChatAction(self, **kwargs):
        return self._record("sendChatAction", kwargs)

    async def answerCallbackQuery(self, **kwargs):
        return self._record("answerCallbackQuery", kwargs)

    async def getFile(self, **kwargs):
        self.calls.append(("getFile", kwargs))
        return self.files[kwargs["file_id"]]

    async def setMyCommands(self, *, commands):
        self.command_payloads.append(commands)
        return True

    async def close(self):
        self.closed += 1


class FakeUpdater:
    def __init__(self, trace: list[str], *, fail_start: bool = False) -> None:
        self.trace = trace
        self.fail_start = fail_start
        self.running = False
        self.allowed_updates = None

    async def start_polling(self, *, allowed_updates):
        self.trace.append("updater.start_polling")
        self.allowed_updates = allowed_updates
        self.running = True
        if self.fail_start:
            raise NetworkError("poll URL contains secret-token")

    async def stop(self):
        self.trace.append("updater.stop")
        self.running = False


class FakeApplication:
    def __init__(self, *, fail_polling: bool = False, fail_initialize: bool = False) -> None:
        self.trace: list[str] = []
        self.bot = FakeTelegramTransport()
        self.updater = FakeUpdater(self.trace, fail_start=fail_polling)
        self.fail_initialize = fail_initialize

    async def initialize(self):
        self.trace.append("application.initialize")
        if self.fail_initialize:
            raise NetworkError("https://api.telegram.org/botsecret-token/getMe")

    async def start(self):
        self.trace.append("application.start")

    async def stop(self):
        self.trace.append("application.stop")

    async def shutdown(self):
        self.trace.append("application.shutdown")


def _router() -> CommandRouter:
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    return CommandRouter(services)


def _adapter(transport: FakeTelegramTransport | None = None) -> TelegramAdapter:
    adapter = TelegramAdapter({"token": "token"}, transport=transport or FakeTelegramTransport())
    adapter._bot_id = "99"
    adapter._bot_username = "lorebot"
    return adapter


def _entity(text: str, token: str, entity_type: str, **extra) -> dict:
    start = text.index(token)
    return {
        "type": entity_type,
        "offset": len(text[:start].encode("utf-16-le")) // 2,
        "length": len(token.encode("utf-16-le")) // 2,
        **extra,
    }


def _message_update(
    text: str | None = "hello",
    *,
    chat_type: str = "supergroup",
    chat_id: int = -1001234567890,
    sender: dict | None = None,
    **message,
) -> dict:
    payload = {
        "message_id": 11,
        "from": sender or {"id": 7, "username": "keeper", "is_bot": False},
        "chat": {"id": chat_id, "type": chat_type},
        **message,
    }
    if text is not None:
        payload["text"] = text
    return {"update_id": 1, "message": payload}


async def test_application_lifecycle_starts_and_stops_polling_in_official_order() -> None:
    application = FakeApplication()
    adapter = TelegramAdapter({"token": "token"}, application=application)

    assert await adapter.connect() is True
    assert await adapter.connect() is True
    assert application.trace == [
        "application.initialize",
        "application.start",
        "updater.start_polling",
    ]
    assert application.updater.allowed_updates == [
        "message",
        "edited_message",
        "channel_post",
        "edited_channel_post",
        "callback_query",
    ]
    assert adapter._bot_id == "99"
    assert adapter._bot_username == "lorebot"

    await adapter.disconnect()

    assert application.trace == [
        "application.initialize",
        "application.start",
        "updater.start_polling",
        "updater.stop",
        "application.stop",
        "application.shutdown",
    ]


async def test_polling_start_failure_rolls_back_started_application() -> None:
    application = FakeApplication(fail_polling=True)
    adapter = TelegramAdapter({"token": "token"}, application=application)

    assert await adapter.connect() is False

    assert application.trace == [
        "application.initialize",
        "application.start",
        "updater.start_polling",
        "updater.stop",
        "application.stop",
        "application.shutdown",
    ]
    assert adapter._initialized is False
    assert adapter._started is False
    assert adapter._polling is False


async def test_partial_application_initialize_closes_bot_resources(caplog) -> None:
    application = FakeApplication(fail_initialize=True)
    adapter = TelegramAdapter({"token": "token"}, application=application)

    assert await adapter.connect() is False

    assert application.trace == ["application.initialize"]
    assert application.bot.closed == 1
    assert "secret-token" not in caplog.text
    assert adapter._initialized is False


async def test_injected_transport_connects_without_claiming_a_polling_application() -> None:
    transport = FakeTelegramTransport()
    adapter = TelegramAdapter({"token": "token"}, transport=transport)

    assert await adapter.connect() is True
    assert adapter._bot_username == "lorebot"
    await adapter.disconnect()
    assert transport.closed == 1


@pytest.mark.skipif(not telegram_module.TELEGRAM_AVAILABLE, reason="telegram extra not installed")
async def test_real_sdk_update_to_dict_preserves_bot_api_field_names() -> None:
    transport = FakeTelegramTransport()
    adapter = _adapter(transport)
    seen: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        seen.append(message)

    adapter.set_message_handler(handler)
    raw = _message_update(
        "@LoreBot hello",
        sender={
            "id": 7,
            "first_name": "Keeper",
            "username": "keeper",
            "is_bot": False,
        },
        date=0,
        entities=[
            {
                "type": "mention",
                "offset": 0,
                "length": 8,
            }
        ],
    )
    update = telegram_module.telegram.Update.de_json(raw)

    await adapter._handle_sdk_update(update, None)

    assert seen[0].source.user_id == "7"
    assert seen[0].source.user_name == "keeper"
    assert seen[0].at_bot is True
    assert seen[0].text == "hello"


def test_group_mentions_use_utf16_entity_offsets_and_strip_only_self() -> None:
    adapter = _adapter()
    text = "🎲 @LoreBot open the door"
    inbound = adapter.parse_update(
        _message_update(
            text,
            entities=[_entity(text, "@LoreBot", "mention")],
            message_thread_id=321,
            reply_to_message={"caption": "the earlier clue"},
        )
    )

    assert inbound is not None
    assert inbound.at_bot is True
    assert inbound.text == "🎲 open the door"
    assert inbound.quoted_text == "the earlier clue"
    assert inbound.source.chat_key() == "telegram:group:-1001234567890:321"
    assert inbound.source.user_name == "keeper"

    other = "@OtherBot keep this mention"
    inbound = adapter.parse_update(
        _message_update(other, entities=[_entity(other, "@OtherBot", "mention")])
    )
    assert inbound is not None
    assert inbound.at_bot is False
    assert inbound.text == other


def test_suffixed_bot_command_is_recognized_and_normalized_for_router() -> None:
    adapter = _adapter()
    text = "/roll@LoreBot 1d20"

    inbound = adapter.parse_update(
        _message_update(text, entities=[_entity(text, "/roll@LoreBot", "bot_command")])
    )

    assert inbound is not None
    assert inbound.at_bot is True
    assert inbound.text == "/roll 1d20"


def test_text_mention_matches_bot_id_and_sender_bot_flag_is_preserved() -> None:
    adapter = _adapter()
    text = "Keeper, act"
    inbound = adapter.parse_update(
        _message_update(
            text,
            sender={"id": 8, "first_name": "Relay", "is_bot": True},
            entities=[_entity(text, "Keeper", "text_mention", user={"id": 99})],
        )
    )

    assert inbound is not None
    assert inbound.at_bot is True
    assert inbound.text == ", act"
    assert inbound.source.is_bot is True
    assert inbound.source.user_name == "Relay"


def test_private_message_and_non_content_update_are_distinguished() -> None:
    adapter = _adapter()
    private = adapter.parse_update(
        _message_update(
            "/help",
            chat_type="private",
            chat_id=8,
            sender={"id": 8, "first_name": "Ada"},
        )
    )

    assert private is not None
    assert private.source.chat_key() == "telegram:dm:8"
    assert private.source.user_name == "Ada"
    assert adapter.parse_update(_message_update(None, location={"latitude": 1, "longitude": 2})) is None


def test_caption_media_uses_largest_photo_and_document_metadata() -> None:
    adapter = _adapter()
    caption = "@LoreBot inspect these"
    inbound = adapter.parse_update(
        _message_update(
            None,
            caption=caption,
            caption_entities=[_entity(caption, "@LoreBot", "mention")],
            photo=[
                {"file_id": "small", "file_size": 5},
                {"file_id": "large", "file_size": 50},
            ],
            document={
                "file_id": "doc",
                "file_name": "clue.pdf",
                "mime_type": "application/pdf",
                "file_size": "120",
            },
        )
    )

    assert inbound is not None
    assert inbound.text == "inspect these"
    assert inbound.at_bot is True
    assert inbound.attachments == [
        ChatAttachment(
            id="large",
            name="photo-large.jpg",
            mime="image/jpeg",
            size=50,
        ),
        ChatAttachment(
            id="doc",
            name="clue.pdf",
            mime="application/pdf",
            size=120,
        ),
    ]


def test_photo_without_file_size_uses_largest_resolution() -> None:
    inbound = _adapter().parse_update(
        _message_update(
            None,
            photo=[
                {"file_id": "thumb", "width": 90, "height": 90},
                {"file_id": "full", "width": 1280, "height": 720},
            ],
        )
    )

    assert inbound is not None
    assert inbound.attachments[0].id == "full"


async def test_callback_query_is_acknowledged_and_normalized_as_interaction() -> None:
    transport = FakeTelegramTransport()
    adapter = _adapter(transport)
    seen: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        seen.append(message)

    adapter.set_message_handler(handler)
    update = {
        "update_id": 2,
        "callback_query": {
            "id": "callback-1",
            "from": {"id": 7, "first_name": "Lin", "language_code": "zh-CN"},
            "data": ".panel",
            "message": {
                "message_id": 44,
                "message_thread_id": 9,
                "chat": {"id": -100, "type": "supergroup"},
            },
        },
    }

    inbound = await adapter.handle_update(update)

    assert inbound is seen[0]
    assert inbound is not None
    assert inbound.text == ".panel"
    assert inbound.at_bot is True
    assert inbound.interaction is not None
    assert inbound.interaction.id == "callback-1"
    assert inbound.interaction.locale == "zh"
    assert transport.calls[0] == (
        "answerCallbackQuery",
        {"callback_query_id": "callback-1"},
    )
    assert [name for name, _kwargs in transport.calls].count("sendChatAction") == 1
    assert adapter._typing_tasks == {}


async def test_handler_failure_still_cancels_typing_refresh() -> None:
    adapter = _adapter()

    async def handler(_message: InboundMessage) -> None:
        raise RuntimeError("turn failed")

    adapter.set_message_handler(handler)
    with pytest.raises(RuntimeError, match="turn failed"):
        await adapter.handle_update(_message_update())

    assert adapter._typing_tasks == {}


@pytest.mark.parametrize(
    ("file", "expected"),
    [(BytearrayFile(), b"downloaded"), (MemoryFile(), b"in-memory")],
)
async def test_fetch_attachment_uses_sdk_file_download_apis(file, expected: bytes) -> None:
    transport = FakeTelegramTransport()
    transport.files["file-1"] = file
    adapter = _adapter(transport)

    data = await adapter.fetch_attachment(ChatAttachment(id="file-1", name="clue.bin"))

    assert data == expected
    assert transport.calls == [("getFile", {"file_id": "file-1"})]


async def test_send_text_uses_thread_reply_and_markdown() -> None:
    transport = FakeTelegramTransport()
    adapter = _adapter(transport)
    source = SessionSource(
        platform="telegram",
        chat_id="-100",
        chat_type="group",
        thread_id="7",
    )

    result = await adapter.send_message(
        source,
        ChatMessage(text="**hello**", markdown=True),
        reply_to="11",
    )

    assert result.ok is True
    assert transport.calls == [
        (
            "sendMessage",
            {
                "chat_id": "-100",
                "message_thread_id": 7,
                "reply_parameters": {"message_id": 11},
                "text": "**hello**",
                "parse_mode": "Markdown",
            },
        )
    ]


async def test_markdown_bad_request_retries_plain_but_network_error_does_not_retry() -> None:
    transport = FakeTelegramTransport()
    transport.fail_once("sendMessage", BadRequest("invalid markdown"))
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_id="room")

    result = await adapter.send_message(source, ChatMessage(text="bad _ markdown", markdown=True))

    assert result.ok is True
    assert len(transport.calls) == 2
    assert transport.calls[0][1]["parse_mode"] == "Markdown"
    assert "parse_mode" not in transport.calls[1][1]

    transport.calls.clear()
    transport.fail_once(
        "sendMessage",
        NetworkError("https://api.telegram.org/botsecret-token/sendMessage"),
    )
    result = await adapter.send_message(source, ChatMessage(text="hello", markdown=True))

    assert result.ok is False
    assert result.error == "telegram.send_failed"
    assert "secret-token" not in (result.error or "")
    assert len(transport.calls) == 1


async def test_private_reply_targets_user_and_drops_group_reply_and_thread() -> None:
    transport = FakeTelegramTransport()
    adapter = _adapter(transport)
    source = SessionSource(
        platform="telegram",
        chat_id="group",
        chat_type="group",
        user_id="42",
        thread_id="9",
    )

    result = await adapter.send_message(
        source,
        ChatMessage(text="private sheet", private=True),
        reply_to="11",
    )

    assert result.ok is True
    assert adapter.supports_private_reply(source) is True
    assert transport.calls == [("sendMessage", {"chat_id": "42", "text": "private sheet"})]


async def test_sender_chat_is_never_treated_as_a_private_user_target() -> None:
    transport = FakeTelegramTransport()
    adapter = _adapter(transport)
    inbound = adapter.parse_update(
        {
            "update_id": 2,
            "channel_post": {
                "message_id": 12,
                "from": {"id": 1087968824, "first_name": "GroupAnonymousBot"},
                "sender_chat": {"id": -100777, "title": "Public Channel"},
                "chat": {"id": -100777, "type": "channel"},
                "text": "public post",
            },
        }
    )

    assert inbound is not None
    assert inbound.source.user_id is None
    assert inbound.source.user_name == "Public Channel"
    assert adapter.supports_private_reply(inbound.source) is False

    result = await adapter.send_message(
        inbound.source,
        ChatMessage(text="secret", private=True),
        reply_to=inbound.source.message_id,
    )

    assert result.ok is False
    assert result.error == "telegram.private_target.unavailable"
    assert transport.calls == []

    edit = await adapter.edit_message(
        inbound.source,
        "12",
        ChatMessage(text="secret edit", private=True),
    )
    assert edit.ok is False
    assert edit.error == "telegram.private_target.unavailable"
    assert transport.calls == []


async def test_embeds_and_components_degrade_to_text_and_inline_keyboard() -> None:
    transport = FakeTelegramTransport()
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_id="room")
    message = ChatMessage(
        text="fallback",
        embeds=[
            ChatEmbed(
                title="Status",
                description="Ready",
                fields=(ChatField("HP", "10/10"),),
                footer="footer",
            )
        ],
        components=[
            ChatComponent(id="roll", command=".roll 1d20", label="Roll"),
            ChatComponent(id="too-long", command="." + "x" * 64, label="Ignored"),
        ],
    )

    result = await adapter.send_message(source, message)

    assert result.ok is True
    params = transport.calls[0][1]
    assert params["text"] == "fallback\n\nStatus\nReady\nHP: 10/10\nfooter"
    assert params["reply_markup"] == {
        "inline_keyboard": [[{"text": "Roll", "callback_data": ".roll 1d20"}]]
    }


async def test_rendered_embed_text_is_split_to_telegram_limits_without_loss() -> None:
    transport = FakeTelegramTransport()
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_id="room")
    message = ChatMessage(
        text="prefix",
        embeds=[ChatEmbed(description="x" * 5000)],
        components=[ChatComponent(id="help", command=".help", label="Help")],
    )

    result = await adapter.send_message(source, message)

    assert result.ok is True
    calls = [kwargs for name, kwargs in transport.calls if name == "sendMessage"]
    assert len(calls) == 2
    assert all(len(call["text"]) <= adapter.capabilities.max_text_chars for call in calls)
    assert "".join(call["text"] for call in calls) == f"prefix\n\n{'x' * 5000}"
    assert all("reply_markup" not in call for call in calls[:-1])
    assert "reply_markup" in calls[-1]


async def test_edit_rejects_rendered_content_over_platform_limit() -> None:
    transport = FakeTelegramTransport()
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_id="room")

    result = await adapter.edit_message(
        source,
        "12",
        ChatMessage(embeds=[ChatEmbed(description="x" * 5000)]),
    )

    assert result.ok is False
    assert result.error == "telegram.edit_too_long"
    assert transport.calls == []


async def test_native_attachment_uses_caption_and_in_memory_filename() -> None:
    transport = FakeTelegramTransport()
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_id="room", thread_id="3")
    attachment = ChatAttachment(
        id="image",
        name="map.png",
        mime="image/png",
        size=3,
        data=b"png",
    )

    result = await adapter.send_message(
        source,
        ChatMessage(text="map", attachments=[attachment]),
        reply_to="5",
    )

    assert result.ok is True
    assert result.message_id == "sendPhoto-1"
    assert [name for name, _kwargs in transport.calls] == ["sendPhoto"]
    params = transport.calls[0][1]
    assert params["chat_id"] == "room"
    assert params["message_thread_id"] == 3
    assert params["reply_parameters"] == {"message_id": 5}
    assert params["caption"] == "map"
    assert params["photo"].name == "map.png"
    assert params["photo"].getvalue() == b"png"


async def test_long_attachment_caption_sends_text_once_then_document() -> None:
    transport = FakeTelegramTransport()
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_id="room")
    text = "x" * 1025

    result = await adapter.send_message(
        source,
        ChatMessage(
            text=text,
            attachments=[
                ChatAttachment(
                    id="doc",
                    name="clue.pdf",
                    mime="application/pdf",
                    data=b"pdf",
                )
            ],
        ),
        reply_to="8",
    )

    assert result.ok is True
    assert result.message_id == "sendMessage-1"
    assert [name for name, _kwargs in transport.calls] == ["sendMessage", "sendDocument"]
    assert transport.calls[0][1]["reply_parameters"] == {"message_id": 8}
    assert "caption" not in transport.calls[1][1]
    assert "reply_parameters" not in transport.calls[1][1]


async def test_media_network_failure_is_not_retried_as_document_and_error_is_sanitized() -> None:
    transport = FakeTelegramTransport()
    transport.fail_once(
        "sendPhoto",
        NetworkError("https://api.telegram.org/botsecret-token/sendPhoto"),
    )
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_id="room")

    result = await adapter.send_message(
        source,
        ChatMessage(
            attachments=[
                ChatAttachment(name="map.png", mime="image/png", data=b"png")
            ]
        ),
    )

    assert result.ok is False
    assert result.error == "telegram.send_failed"
    assert [name for name, _kwargs in transport.calls] == ["sendPhoto"]


async def test_unsupported_media_format_is_sent_as_document_without_failed_probe() -> None:
    transport = FakeTelegramTransport()
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_id="room")

    result = await adapter.send_message(
        source,
        ChatMessage(
            attachments=[
                ChatAttachment(name="sound.wav", mime="audio/wav", data=b"wav")
            ]
        ),
    )

    assert result.ok is True
    assert [name for name, _kwargs in transport.calls] == ["sendDocument"]


async def test_edit_message_supports_components_and_sanitizes_failure() -> None:
    transport = FakeTelegramTransport()
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_id="room")
    message = ChatMessage(
        text="updated",
        components=[ChatComponent(id="help", command=".help", label="Help")],
    )

    result = await adapter.edit_message(source, "12", message)

    assert result.ok is True
    assert result.message_id == "editMessageText-1"
    assert transport.calls[0][1]["reply_markup"] == {
        "inline_keyboard": [[{"text": "Help", "callback_data": ".help"}]]
    }

    transport.calls.clear()
    transport.fail_once(
        "editMessageText",
        NetworkError("https://api.telegram.org/botsecret-token/editMessageText"),
    )
    result = await adapter.edit_message(source, "12", message)
    assert result.ok is False
    assert result.error == "telegram.edit_failed"
    assert "secret-token" not in (result.error or "")
    assert len(transport.calls) == 1


async def test_panel_is_created_once_then_state_edits_it_without_leaking_character() -> None:
    transport = FakeTelegramTransport()
    store = Store(":memory:")
    adapter = TelegramAdapter({"token": "token"}, transport=transport, store=store)
    source = SessionSource(
        platform="telegram",
        chat_id="room",
        chat_type="group",
        thread_id="7",
    )
    snapshot = {
        "character": {"name": "Private Investigator"},
        "party": [{"name": "Ada", "hp": 8, "hpmax": 10}],
        "online": 2,
    }

    created = await adapter.deliver_event(source, "table", Event.panel(snapshot), locale="en")
    updated = await adapter.deliver_event(source, "table", Event.state(snapshot), locale="en")

    assert created is not None and created.ok is True
    assert updated is not None and updated.ok is True
    assert [name for name, _kwargs in transport.calls] == ["sendMessage", "editMessageText"]
    sent = transport.calls[0][1]
    assert sent["message_thread_id"] == 7
    assert "Private Investigator" not in sent["text"]
    assert "Ada" in sent["text"]
    assert sent["reply_markup"]["inline_keyboard"][0][0]["callback_data"] == ".panel"
    assert transport.calls[1][1]["message_id"] == "sendMessage-1"
    assert (
        await store.get(
            user_key="",
            store_key="telegram.panel.telegram:group:room:7",
        )
        == "sendMessage-1"
    )
    store.close()


async def test_unchanged_panel_edit_is_success_without_creating_a_duplicate() -> None:
    transport = FakeTelegramTransport()
    transport.fail_once("editMessageText", BadRequest("Message is not modified"))
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_id="room")
    adapter._panels[source.chat_key()] = "12"

    result = await adapter.deliver_event(
        source,
        "table",
        Event.panel({"party": []}),
        locale="en",
    )

    assert result is not None and result.ok is True
    assert result.message_id == "12"
    assert [name for name, _kwargs in transport.calls] == ["editMessageText"]


async def test_panel_message_id_survives_adapter_restart_and_is_topic_scoped() -> None:
    store = Store(":memory:")
    source = SessionSource(
        platform="telegram",
        chat_id="room",
        chat_type="group",
        thread_id="7",
    )
    first_transport = FakeTelegramTransport()
    first = TelegramAdapter({"token": "token"}, transport=first_transport, store=store)
    await first.deliver_event(source, "table", Event.panel({"party": []}), locale="en")

    second_transport = FakeTelegramTransport()
    second = TelegramAdapter({"token": "token"}, transport=second_transport, store=store)
    updated = await second.deliver_event(
        source,
        "table",
        Event.state({"party": [{"name": "Ada"}]}),
        locale="en",
    )
    other_topic = await second.deliver_event(
        SessionSource(
            platform="telegram",
            chat_id="room",
            chat_type="group",
            thread_id="8",
        ),
        "table",
        Event.state({"party": []}),
        locale="en",
    )

    assert updated is not None and updated.ok is True
    assert second_transport.calls[0][0] == "editMessageText"
    assert second_transport.calls[0][1]["message_id"] == "sendMessage-1"
    assert other_topic is None
    assert len(second_transport.calls) == 1
    store.close()


async def test_deleted_panel_is_recreated_only_on_explicit_panel_event() -> None:
    transport = FakeTelegramTransport()
    transport.fail_once("editMessageText", NetworkError("message not found"))
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_id="room")
    adapter._panels[source.chat_key()] = "12"

    result = await adapter.deliver_event(
        source,
        "table",
        Event.panel({"party": []}),
        locale="en",
    )

    assert result is not None and result.ok is True
    assert [name for name, _kwargs in transport.calls] == ["editMessageText", "sendMessage"]
    assert adapter._panels[source.chat_key()] == "sendMessage-2"


async def test_typing_action_is_thread_scoped_and_stopped_without_extra_call() -> None:
    transport = FakeTelegramTransport()
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_id="room", thread_id="5")

    await adapter.set_typing(source, True)
    assert adapter._typing_tasks
    await adapter.set_typing(source, False)

    assert adapter._typing_tasks == {}
    assert transport.calls == [
        (
            "sendChatAction",
            {"chat_id": "room", "action": "typing", "message_thread_id": 5},
        )
    ]


async def test_concurrent_typing_in_same_chat_has_one_owned_refresh_task(monkeypatch) -> None:
    class BlockingTypingTransport(FakeTelegramTransport):
        def __init__(self) -> None:
            super().__init__()
            self.entered = asyncio.Event()
            self.release = asyncio.Event()

        async def sendChatAction(self, **kwargs):
            self.calls.append(("sendChatAction", kwargs))
            if len(self.calls) == 1:
                self.entered.set()
                await self.release.wait()
            return {"message_id": "typing"}

    monkeypatch.setattr(telegram_module, "_TYPING_REFRESH_SECONDS", 0.01)
    transport = BlockingTypingTransport()
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_id="room", thread_id="5")

    first = asyncio.create_task(adapter.set_typing(source, True))
    await transport.entered.wait()
    second = asyncio.create_task(adapter.set_typing(source, True))
    await asyncio.sleep(0)
    assert len(transport.calls) == 1

    transport.release.set()
    await asyncio.gather(first, second)
    assert len(adapter._typing_tasks) == 1
    await adapter.set_typing(source, False)
    assert len(adapter._typing_tasks) == 1
    await adapter.set_typing(source, False)
    assert adapter._typing_tasks == {}
    calls_after_stop = len(transport.calls)
    await asyncio.sleep(0.03)
    assert len(transport.calls) == calls_after_stop


async def test_disconnect_during_initial_typing_never_creates_orphan_refresh() -> None:
    class BlockingTypingTransport(FakeTelegramTransport):
        def __init__(self) -> None:
            super().__init__()
            self.entered = asyncio.Event()
            self.release = asyncio.Event()

        async def sendChatAction(self, **kwargs):
            self.calls.append(("sendChatAction", kwargs))
            self.entered.set()
            await self.release.wait()
            return {"message_id": "typing"}

    transport = BlockingTypingTransport()
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_id="room")
    starting = asyncio.create_task(adapter.set_typing(source, True))
    await transport.entered.wait()

    await adapter.disconnect()
    transport.release.set()
    await starting

    assert transport.closed == 1
    assert adapter._typing_tasks == {}
    assert adapter._typing_counts == {}


async def test_register_commands_uses_router_and_telegram_description_limit() -> None:
    transport = FakeTelegramTransport()
    router = SimpleNamespace(
        slash_definitions=lambda locale: [
            {"name": "HELP", "description": f"{locale}:" + "x" * 300},
            {"name": "", "description": "ignored"},
        ]
    )
    adapter = TelegramAdapter(
        {"token": "token"},
        transport=transport,
        command_router=router,
    )

    payload = await adapter.register_commands("zh")

    assert transport.command_payloads == [[("help", payload[0]["description"])]]
    assert payload[0]["command"] == "help"
    assert payload[0]["description"].startswith("zh:")
    assert len(payload[0]["description"]) == 256


async def test_real_command_router_definitions_remain_telegram_compatible() -> None:
    transport = FakeTelegramTransport()
    adapter = TelegramAdapter(
        {"token": "token"},
        transport=transport,
        command_router=_router(),
    )

    payload = await adapter.register_commands("en")

    assert payload
    assert {"roll", "check", "help"} <= {item["command"] for item in payload}
    assert all(set(item) == {"command", "description"} for item in payload)


@pytest.mark.skipif(not telegram_module.TELEGRAM_AVAILABLE, reason="telegram SDK not installed")
async def test_command_payload_uses_official_sdk_tuple_contract(monkeypatch) -> None:
    captured: dict = {}

    async def fake_post(_bot, endpoint, data, **_kwargs):
        captured["endpoint"] = endpoint
        captured["data"] = data
        return True

    bot = telegram_module.telegram.Bot("123456:TEST_TOKEN")
    monkeypatch.setattr(type(bot), "_post", fake_post)
    adapter = TelegramAdapter(
        {"token": "token"},
        transport=bot,
        command_router=SimpleNamespace(
            slash_definitions=lambda _locale: [
                {"name": "HELP", "description": "Show help"},
            ]
        ),
    )

    payload = await adapter.register_commands("en")

    assert payload == [{"command": "help", "description": "Show help"}]
    assert captured["endpoint"] == "setMyCommands"
    assert captured["data"]["commands"][0].to_dict() == payload[0]


def test_registry_requires_sdk_and_factory_consumes_adapter_context(monkeypatch) -> None:
    entry = platform_registry.get("telegram")
    assert entry is not None

    monkeypatch.setattr(telegram_module, "TELEGRAM_AVAILABLE", False)
    store = object()
    context = AdapterContext(
        services=SimpleNamespace(settings=SimpleNamespace(locale="zh"), store=store),
        command_router=object(),
    )
    assert platform_registry.create_adapter("telegram", {"token": "token"}, context) is None

    monkeypatch.setattr(telegram_module, "TELEGRAM_AVAILABLE", True)
    adapter = platform_registry.create_adapter("telegram", {"token": "token"}, context)

    assert isinstance(adapter, TelegramAdapter)
    assert adapter.locale == "zh"
    assert adapter.command_router is context.command_router
    assert adapter._store is store
    assert entry.required_env == ["TRPG_TELEGRAM__TOKEN"]
    assert entry.install_hint == "uv sync --extra telegram"


async def test_connect_fails_closed_when_identity_lookup_fails() -> None:
    transport = FakeTelegramTransport()

    async def broken_get_me():
        raise NetworkError("getMe down")

    transport.getMe = broken_get_me
    adapter = TelegramAdapter({"token": "token"}, transport=transport)

    assert await adapter.connect() is False

    # A later attempt with a healthy getMe succeeds.
    del transport.getMe
    assert await adapter.connect() is True


async def test_send_retries_once_after_flood_control() -> None:
    class RetryAfter(Exception):
        def __init__(self, retry_after: float) -> None:
            super().__init__("flood")
            self.retry_after = retry_after

    transport = FakeTelegramTransport()
    transport.fail_once("sendMessage", RetryAfter(0.01))
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_type="group", chat_id="-100", user_id="7")

    result = await adapter.send_message(source, ChatMessage(text="hello"))

    assert result.ok is True
    sends = [call for call in transport.calls if call[0] == "sendMessage"]
    assert len(sends) == 2


def test_split_message_utf16_respects_unit_budget() -> None:
    emoji = "\N{GRINNING FACE}" * 3000  # 3000 code points, 6000 UTF-16 units
    message = ChatMessage(text=emoji)

    parts = telegram_module._split_message_utf16(message, 4096)

    assert len(parts) >= 2
    assert all(telegram_module._utf16_len(part.text) <= 4096 for part in parts)
    assert "".join(part.text for part in parts) == emoji


async def test_state_event_recreates_panel_after_edit_failure() -> None:
    transport = FakeTelegramTransport()
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_type="group", chat_id="-100", user_id="7")
    key = source.chat_key()
    adapter._panels[key] = "31"
    transport.fail_once("editMessageText", NetworkError("message to edit not found"))

    result = await adapter.deliver_event(
        source,
        "session",
        Event.state({"scene": "docks"}),
        locale="en",
    )

    assert result is not None and result.ok is True
    assert [call[0] for call in transport.calls if call[0] in {"editMessageText", "sendMessage"}] == [
        "editMessageText",
        "sendMessage",
    ]
    assert adapter._panels[key] != "31"


async def test_private_reply_forbidden_notifies_origin_chat() -> None:
    class Forbidden(Exception):
        pass

    transport = FakeTelegramTransport()
    transport.fail_once("sendMessage", Forbidden("bot can't initiate conversation"))
    adapter = _adapter(transport)
    source = SessionSource(platform="telegram", chat_type="group", chat_id="-100", user_id="7")

    result = await adapter.send_message(source, ChatMessage(text="secret sheet", private=True))

    assert result.ok is False
    assert result.error == "telegram.private_reply_blocked"
    sends = [call for call in transport.calls if call[0] == "sendMessage"]
    assert len(sends) == 2
    assert sends[0][1]["chat_id"] == "7"
    assert sends[1][1]["chat_id"] == "-100"
    assert "secret sheet" not in sends[1][1]["text"]
