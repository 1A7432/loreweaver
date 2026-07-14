from adapters.telegram.adapter import TelegramAdapter
from agent.services import build_services
from gateway.chat import ChatMessage
from gateway.commands import CommandRouter
from gateway.events import InboundMessage
from gateway.session import SessionSource
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM


class FakeTelegramTransport:
    def __init__(self) -> None:
        self.sent_messages = []
        self.command_payloads = []

    async def sendMessage(self, **kwargs):
        self.sent_messages.append(kwargs)
        return {"message_id": "sent-1"}

    async def setMyCommands(self, *, commands):
        self.command_payloads.append(commands)
        return True


def _router() -> CommandRouter:
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    return CommandRouter(services)


async def test_handle_update_parses_group_and_private_messages() -> None:
    seen: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> None:
        seen.append(message)

    adapter = TelegramAdapter({"token": "token"}, transport=FakeTelegramTransport(), on_message=handler)

    group_id = -1001234567890
    await adapter.handle_update(
        {
            "update_id": 1,
            "message": {
                "message_id": 11,
                "from": {"id": 7, "username": "keeper"},
                "chat": {"id": group_id, "type": "supergroup"},
                "text": "/roll 1d20",
            },
        }
    )
    await adapter.handle_update(
        {
            "update_id": 2,
            "message": {
                "message_id": 12,
                "from": {"id": 8, "first_name": "Ada"},
                "chat": {"id": 8, "type": "private"},
                "text": "/help",
            },
        }
    )

    assert seen[0].source.chat_key() == f"telegram:group:{group_id}"
    assert seen[0].text == "/roll 1d20"
    assert seen[0].source.user_id == "7"
    assert seen[0].source.message_id == "11"
    assert seen[1].source.chat_key() == "telegram:dm:8"
    assert seen[1].text == "/help"


async def test_send_calls_transport_send_message() -> None:
    transport = FakeTelegramTransport()
    adapter = TelegramAdapter({"token": "token"}, transport=transport)
    source = SessionSource(platform="telegram", chat_id="-1001234567890", chat_type="group")

    result = await adapter.send_message(source, ChatMessage(text="hello"))
    reply = await adapter.send_message(source, ChatMessage(text="with reply"), reply_to="11")

    assert result.ok is True
    assert reply.ok is True
    assert transport.sent_messages[0] == {"chat_id": "-1001234567890", "text": "hello"}
    assert transport.sent_messages[1] == {
        "chat_id": "-1001234567890",
        "text": "with reply",
        "reply_to_message_id": "11",
    }


async def test_register_commands_uses_command_router_slash_definitions() -> None:
    transport = FakeTelegramTransport()
    adapter = TelegramAdapter({"token": "token"}, transport=transport, command_router=_router())

    payload = await adapter.register_commands("en")

    assert transport.command_payloads == [payload]
    assert payload
    assert all(set(item) == {"command", "description"} for item in payload)
    commands = {item["command"] for item in payload}
    assert {"roll", "check", "help"} <= commands
