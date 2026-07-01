from gateway.base_adapter import BaseAdapter
from gateway.events import InboundMessage, SendResult
from gateway.session import SessionSource


class FakeAdapter(BaseAdapter):
    platform = "fake"

    def __init__(self, config=None, on_message=None) -> None:
        super().__init__(config=config, on_message=on_message)
        self.sent = []

    async def connect(self) -> bool:
        return True

    async def disconnect(self) -> None:
        return None

    async def send(self, source: SessionSource, content: str, *, reply_to: str | None = None) -> SendResult:
        self.sent.append((source, content, reply_to))
        return SendResult(ok=True, message_id="sent-1")


async def test_handle_inbound_sends_handler_reply_with_reply_to_message_id() -> None:
    adapter = FakeAdapter()
    source = SessionSource(platform="fake", chat_id="room", user_id="user", message_id="m1")

    async def handler(msg: InboundMessage) -> str | None:
        assert msg.source is source
        return "pong"

    adapter.set_message_handler(handler)

    await adapter.handle_inbound(InboundMessage(source=source, text="ping"))

    assert adapter.sent == [(source, "pong", "m1")]


async def test_handle_inbound_sends_nothing_for_none_reply() -> None:
    async def handler(msg: InboundMessage) -> str | None:
        return None

    adapter = FakeAdapter(on_message=handler)
    source = SessionSource(platform="fake", chat_id="room", message_id="m1")

    await adapter.handle_inbound(InboundMessage(source=source, text="ping"))

    assert adapter.sent == []


def test_supports_proactive_default_true() -> None:
    adapter = FakeAdapter()

    assert adapter.supports_proactive(SessionSource(platform="fake", chat_id="room")) is True
