import re

from adapters.discord import DiscordAdapter
from agent.services import build_services
from gateway.commands import CommandRouter
from gateway.events import InboundMessage
from gateway.session import SessionSource
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM


class MockHTTP:
    def __init__(self) -> None:
        self.put_calls = []
        self.post_calls = []

    async def put(self, path, *, json=None, headers=None):
        self.put_calls.append((path, json, headers))
        return {"ok": True}

    async def post(self, path, *, json=None, headers=None):
        self.post_calls.append((path, json, headers))
        return {"id": "sent-1"}


def _router() -> CommandRouter:
    services = build_services(Settings(), llm=FakeLLM(script=[]), embeddings=FakeEmbeddings(64))
    return CommandRouter(services)


async def test_register_slash_commands_puts_valid_core_payload() -> None:
    http = MockHTTP()
    adapter = DiscordAdapter({"token": "t", "app_id": "app-1"}, http=http, command_router=_router())

    payload = await adapter.register_slash_commands("en")

    assert len(http.put_calls) == 1
    path, sent_payload, _headers = http.put_calls[0]
    assert path == "/applications/app-1/commands"
    assert sent_payload == payload
    assert isinstance(sent_payload, list)

    names = {command["name"] for command in sent_payload}
    assert {"roll", "check", "sheet", "init", "sc", "coc", "dnd", "setcoc", "help"}.issubset(names)
    assert {"roll", "check", "help"}.issubset(names)
    for command in sent_payload:
        assert re.fullmatch(r"^[a-z0-9_-]{1,32}$", command["name"])
        assert command["description"]


async def test_inbound_guild_message_reaches_handler_with_discord_group_chat_key() -> None:
    received: list[InboundMessage] = []
    adapter = DiscordAdapter({"token": "t", "app_id": "app-1"})

    async def handler(message: InboundMessage) -> None:
        received.append(message)

    adapter.set_message_handler(handler)

    await adapter.handle_message(
        {
            "id": "m-1",
            "channel_id": "c-1",
            "guild_id": "g-1",
            "author": {"id": "u-1", "username": "player"},
            "content": "/roll 1d20",
        }
    )

    assert len(received) == 1
    assert received[0].source.chat_key() == "discord:group:c-1"
    assert received[0].source.user_id == "u-1"
    assert received[0].source.message_id == "m-1"
    assert received[0].raw["prefix_command"] is True


async def test_send_posts_content_to_rest_transport_and_returns_ok() -> None:
    http = MockHTTP()
    adapter = DiscordAdapter({"token": "t", "app_id": "app-1"}, http=http)
    source = SessionSource(platform="discord", chat_type="group", chat_id="c-1", user_id="u-1")

    result = await adapter.send(source, "hello", reply_to="m-1")

    assert result.ok is True
    assert result.message_id == "sent-1"
    assert len(http.post_calls) == 1
    path, payload, _headers = http.post_calls[0]
    assert path == "/channels/c-1/messages"
    assert payload["content"] == "hello"
    assert payload["message_reference"] == {"message_id": "m-1"}


def test_inbound_message_with_inline_roll_is_recognized() -> None:
    adapter = DiscordAdapter({"token": "t", "app_id": "app-1"})

    message = adapter.to_inbound_message(
        {
            "id": "m-1",
            "channel_id": "c-1",
            "guild_id": "g-1",
            "author": {"id": "u-1", "username": "player"},
            "content": "attack [[1d20]] now",
        }
    )

    assert message.raw["inline_roll"] is True
    assert message.raw["inline_rolls"] == ["1d20"]
    assert adapter.contains_inline_roll(message.text) is True
