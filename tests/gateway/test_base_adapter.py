from gateway.base_adapter import BaseAdapter
from gateway.chat import ChatCapabilities, ChatMessage
from gateway.events import InboundMessage, SendResult
from gateway.hub import Event
from gateway.session import SessionSource


class FakeAdapter(BaseAdapter):
    platform = "fake"
    capabilities = ChatCapabilities(max_text_chars=8)

    def __init__(self, config=None, on_message=None) -> None:
        super().__init__(config=config, on_message=on_message)
        self.sent = []

    async def connect(self) -> bool:
        return True

    async def disconnect(self) -> None:
        return None

    async def _send_message(
        self,
        source: SessionSource,
        message: ChatMessage,
        *,
        reply_to: str | None,
        session_key: str | None,
    ) -> SendResult:
        self.sent.append((source, message, reply_to, session_key))
        return SendResult(ok=True, message_id="sent-1")


async def test_handle_inbound_sends_handler_reply_with_reply_to_message_id() -> None:
    adapter = FakeAdapter()
    source = SessionSource(platform="fake", chat_id="room", user_id="user", message_id="m1")

    async def handler(msg: InboundMessage) -> ChatMessage | None:
        assert msg.source is source
        return ChatMessage(text="pong", private=True)

    adapter.set_message_handler(handler)

    await adapter.handle_inbound(InboundMessage(source=source, text="ping"))

    assert adapter.sent == [(source, ChatMessage(text="pong", private=True), "m1", None)]


async def test_handle_inbound_sends_nothing_for_none_reply() -> None:
    async def handler(msg: InboundMessage) -> ChatMessage | None:
        return None

    adapter = FakeAdapter(on_message=handler)
    source = SessionSource(platform="fake", chat_id="room", message_id="m1")

    await adapter.handle_inbound(InboundMessage(source=source, text="ping"))

    assert adapter.sent == []


async def test_typing_failure_does_not_block_the_handler_or_reply() -> None:
    adapter = FakeAdapter()
    adapter.capabilities = ChatCapabilities(typing=True, max_text_chars=100)
    source = SessionSource(platform="fake", chat_id="room", message_id="m1")

    async def broken_typing(_source: SessionSource, _active: bool) -> None:
        raise RuntimeError("typing unavailable")

    async def handler(_message: InboundMessage) -> ChatMessage:
        return ChatMessage(text="pong")

    adapter.set_typing = broken_typing
    adapter.set_message_handler(handler)

    await adapter.handle_inbound(InboundMessage(source=source, text="ping"))

    assert adapter.sent[0][1].text == "pong"


async def test_send_message_splits_without_losing_rich_content() -> None:
    adapter = FakeAdapter()
    source = SessionSource(platform="fake", chat_id="room")
    message = ChatMessage(text="alpha beta gamma", components=[])

    result = await adapter.send_message(source, message, session_key="room-a")

    assert result.ok
    assert "".join(part.text for _source, part, _reply, _room in adapter.sent) == message.text
    assert all(len(part.text) <= 8 for _source, part, _reply, _room in adapter.sent)
    assert {room for _source, _part, _reply, room in adapter.sent} == {"room-a"}


async def test_split_never_includes_a_separator_beyond_the_platform_limit() -> None:
    adapter = FakeAdapter()
    source = SessionSource(platform="fake", chat_id="room")

    await adapter.send_message(source, ChatMessage(text="12345678 9"))

    assert all(len(part.text) <= 8 for _source, part, _reply, _room in adapter.sent)


async def test_markdown_fences_are_balanced_across_parts() -> None:
    adapter = FakeAdapter()
    adapter.capabilities = ChatCapabilities(max_text_chars=16)
    source = SessionSource(platform="fake", chat_id="room")

    await adapter.send_message(source, ChatMessage(text="```\nabcdefghij\n```", markdown=True))

    parts = [part.text for _source, part, _reply, _room in adapter.sent]
    assert len(parts) > 1
    assert all(part.count("```") % 2 == 0 for part in parts)


async def test_missing_media_blob_degrades_to_text_without_failing_delivery() -> None:
    class MissingMedia:
        async def read_bytes(self, room: str, sha256: str):
            raise FileNotFoundError(f"{room}:{sha256}")

    adapter = FakeAdapter()
    adapter.capabilities = ChatCapabilities(attachments=True, max_text_chars=100)
    source = SessionSource(platform="fake", chat_id="room")

    result = await adapter.deliver_event(
        source,
        "room",
        Event(kind="media", data={"hash": "deadbeef", "name": "clue.png"}),
        locale="en",
        media_store=MissingMedia(),
    )

    assert result is not None and result.ok
    assert adapter.sent[0][1].text
    assert adapter.sent[0][1].attachments == []
