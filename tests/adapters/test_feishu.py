import json
from types import SimpleNamespace

from adapters.feishu import FeishuAdapter
from gateway.chat import ChatMessage
from gateway.events import InboundMessage
from gateway.registry import platform_registry
from gateway.session import SessionSource


class FakeMessageApi:
    def __init__(self) -> None:
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return {"data": {"message_id": "om_sent"}}


class FakeTransport:
    def __init__(self) -> None:
        self.message = FakeMessageApi()
        self.im = SimpleNamespace(v1=SimpleNamespace(message=self.message))


def _group_event(chat_id: str = "oc_group", text: str = "hello from feishu") -> dict:
    return {
        "schema": "2.0",
        "header": {"event_type": "im.message.receive_v1"},
        "event": {
            "sender": {
                "sender_id": {"open_id": "ou_user"},
                "sender_type": "user",
            },
            "message": {
                "message_id": "om_msg",
                "chat_id": chat_id,
                "chat_type": "group",
                "message_type": "text",
                "content": json.dumps({"text": text}, ensure_ascii=False),
            },
        },
    }


async def test_group_receive_event_dispatches_inbound_message() -> None:
    received: list[InboundMessage] = []
    adapter = FeishuAdapter({"app_id": "app", "app_secret": "secret"}, transport=FakeTransport())

    async def handler(message: InboundMessage) -> None:
        received.append(message)

    adapter.set_message_handler(handler)

    inbound = await adapter.handle_event(_group_event(chat_id="oc_group", text="骰 1d20"))

    assert inbound is received[0]
    assert received[0].source.chat_key() == "feishu:group:oc_group"
    assert received[0].source.user_id == "ou_user"
    assert received[0].source.message_id == "om_msg"
    assert received[0].text == "骰 1d20"


async def test_send_calls_message_create_with_text_payload() -> None:
    transport = FakeTransport()
    adapter = FeishuAdapter({"app_id": "app", "app_secret": "secret"}, transport=transport)
    source = SessionSource(platform="feishu", chat_type="group", chat_id="oc_group")

    result = await adapter.send_message(source, ChatMessage(text="keeper reply"))

    assert result.ok is True
    assert result.message_id == "om_sent"
    assert transport.message.calls == [
        {
            "receive_id": "oc_group",
            "msg_type": "text",
            "content": json.dumps({"text": "keeper reply"}, ensure_ascii=False),
        }
    ]


def test_feishu_adapter_registers_on_import() -> None:
    entry = platform_registry.get("feishu")

    assert entry is not None
    assert entry.label == "Feishu"
