from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from adapters.discord import DiscordAdapter
from adapters.discord.voice import DiscordVoiceManager
from gateway.chat import ChatAttachment, ChatEmbed, ChatField, ChatMessage
from gateway.events import InboundMessage
from gateway.hub import Event
from gateway.registry import AdapterContext
from gateway.rooms import set_keeper_binding
from gateway.session import SessionSource
from infra.config import DiscordSettings
from infra.store import Store


class FakeAllowedMentions:
    @staticmethod
    def none():
        return "no-mentions"


class FakeEmbed:
    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs
        self.fields = []
        self.footer = None
        self.image = None
        self.thumbnail = None

    def add_field(self, **kwargs) -> None:
        self.fields.append(kwargs)

    def set_footer(self, **kwargs) -> None:
        self.footer = kwargs

    def set_image(self, **kwargs) -> None:
        self.image = kwargs

    def set_thumbnail(self, **kwargs) -> None:
        self.thumbnail = kwargs


class FakeFile:
    def __init__(self, fp, *, filename) -> None:
        self.data = fp.read()
        self.filename = filename


class FakeButton:
    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs
        self.callback = None


class FakeView:
    def __init__(self, *, timeout=None) -> None:
        self.timeout = timeout
        self.children = []

    def add_item(self, item) -> None:
        self.children.append(item)


class FakeTree:
    def __init__(self, _client=None) -> None:
        self.commands = {}
        self.sync_calls = []
        self.copied_to = None
        if _client is not None:
            _client.tree = self

    def command(self, *, name, description):
        def decorate(callback):
            self.commands[name] = (description, callback)
            return callback

        return decorate

    def copy_global_to(self, *, guild) -> None:
        self.copied_to = guild

    async def sync(self, *, guild=None) -> None:
        self.sync_calls.append(guild)


class FakeIntents:
    message_content = False
    dm_messages = False
    guild_messages = False

    @classmethod
    def default(cls):
        return cls()


class FakeClient:
    def __init__(self, **_kwargs) -> None:
        self.user = SimpleNamespace(id=999)
        self.closed = False
        self.started = []
        self.views = []

    def event(self, callback):
        setattr(self, callback.__name__, callback)
        return callback

    async def start(self, token) -> None:
        self.started.append(token)

    async def close(self) -> None:
        self.closed = True

    def add_view(self, view) -> None:
        self.views.append(view)

    def get_channel(self, _channel_id):
        return None

    async def fetch_channel(self, _channel_id):
        return None

    def get_user(self, _user_id):
        return None

    async def fetch_user(self, _user_id):
        return None


class FakeSDK:
    AllowedMentions = FakeAllowedMentions
    Embed = FakeEmbed
    File = FakeFile
    Intents = FakeIntents
    Client = FakeClient
    Object = SimpleNamespace
    ButtonStyle = SimpleNamespace(primary="primary", secondary="secondary")
    ui = SimpleNamespace(View=FakeView, Button=FakeButton)
    app_commands = SimpleNamespace(CommandTree=FakeTree)

    @staticmethod
    def FFmpegPCMAudio(path, *, executable):
        return SimpleNamespace(path=path, executable=executable)

    @staticmethod
    def PCMVolumeTransformer(source, *, volume):
        return SimpleNamespace(source=source, volume=volume)


class FakeMessage:
    def __init__(self, message_id="101") -> None:
        self.id = message_id
        self.edits = []

    async def edit(self, **kwargs):
        self.edits.append(kwargs)
        return self


class FakeChannel:
    def __init__(self, channel_id=123) -> None:
        self.id = channel_id
        self.sent = []
        self.messages = {}
        self.typing = 0

    async def send(self, **kwargs):
        self.sent.append(kwargs)
        message = FakeMessage(str(100 + len(self.sent)))
        self.messages[int(message.id)] = message
        return message

    async def fetch_message(self, message_id):
        return self.messages[message_id]

    def get_partial_message(self, message_id):
        return f"partial:{message_id}"

    async def trigger_typing(self):
        self.typing += 1


class FakeResponse:
    def __init__(self) -> None:
        self.deferred = []

    def is_done(self):
        return bool(self.deferred)

    async def defer(self, **kwargs):
        self.deferred.append(kwargs)


class FakeFollowup:
    def __init__(self) -> None:
        self.sent = []

    async def send(self, **kwargs):
        self.sent.append(kwargs)
        return FakeMessage("302")


class FakeInteraction:
    def __init__(self, *, interaction_id=200, locale="en") -> None:
        self.id = interaction_id
        self.token = "token"
        self.channel_id = 123
        self.channel = FakeChannel()
        self.guild_id = 456
        self.user = SimpleNamespace(id=7, display_name="Ada", voice=None)
        self.locale = locale
        self.response = FakeResponse()
        self.followup = FakeFollowup()
        self.edits = []
        self.deleted = 0

    async def edit_original_response(self, **kwargs):
        self.edits.append(kwargs)
        return FakeMessage("301")

    async def delete_original_response(self):
        self.deleted += 1


class FakeAttachment:
    def __init__(self) -> None:
        self.id = 88
        self.filename = "map.png"
        self.content_type = "image/png"
        self.size = 3
        self.url = "https://cdn.example/map.png"
        self.read_calls = []

    async def read(self, *, use_cached=False):
        self.read_calls.append(use_cached)
        return b"png"


class FakeVoiceManager:
    def __init__(self) -> None:
        self.events = []
        self.joins = []
        self.leaves = []
        self.closed = False

    async def join(self, session_key, interaction):
        self.joins.append((session_key, interaction))
        return "joined"

    async def leave(self, session_key):
        self.leaves.append(session_key)
        return "left"

    async def handle_event(self, session_key, event, media_store):
        self.events.append((session_key, event, media_store))

    async def close(self):
        self.closed = True


def make_adapter(*, voice=None) -> DiscordAdapter:
    context = AdapterContext(services=SimpleNamespace(store=Store(":memory:")), command_router=None)
    return DiscordAdapter(
        DiscordSettings(token="t"),
        context,
        sdk=FakeSDK,
        voice_manager=voice or FakeVoiceManager(),
    )


async def test_connect_registers_native_commands_and_syncs_tree() -> None:
    adapter = make_adapter()

    assert await adapter.connect() is True
    await adapter._client.setup_hook()

    assert set(adapter._client.tree.commands) == {
        "roll",
        "check",
        "sheet",
        "character",
        "panel",
        "language",
        "help",
        "room",
        "model",
        "audio",
    }
    assert adapter._client.tree.sync_calls == [None]
    assert len(adapter._client.views) == 1
    assert {item.kwargs["custom_id"] for item in adapter._client.views[0].children} == {
        "lw:panel",
        "lw:sheet",
        "lw:roll",
    }
    await adapter.disconnect()
    assert adapter.voice.closed is True


async def test_disconnect_clears_client_bound_caches() -> None:
    adapter = make_adapter()
    adapter._channels["1"] = object()
    adapter._attachments["2"] = object()
    adapter._interactions["3"] = object()
    adapter._panels["4"] = "5"

    await adapter.disconnect()

    assert adapter._channels == {}
    assert adapter._attachments == {}
    assert adapter._interactions == {}
    assert adapter._panels == {}


async def test_failed_client_task_can_reconnect_without_stale_channels() -> None:
    class RestartClient(FakeClient):
        starts = 0

        async def start(self, token) -> None:
            type(self).starts += 1
            self.started.append(token)
            if type(self).starts == 1:
                raise RuntimeError("login failed")
            await asyncio.Event().wait()

    class RestartSDK(FakeSDK):
        Client = RestartClient

    context = AdapterContext(
        services=SimpleNamespace(store=Store(":memory:")),
        command_router=None,
    )
    adapter = DiscordAdapter(
        DiscordSettings(token="t"),
        context,
        sdk=RestartSDK,
        voice_manager=FakeVoiceManager(),
    )
    adapter._channels["stale"] = object()

    assert await adapter.connect() is True
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert adapter._client is None
    assert adapter._channels == {}
    assert await adapter.connect() is True
    await asyncio.sleep(0)
    assert adapter._client is not None
    assert RestartClient.starts == 2
    await adapter.disconnect()


async def test_slash_command_defers_then_maps_to_existing_router_text() -> None:
    adapter = make_adapter()
    tree = FakeTree()
    adapter.register_app_commands(tree)
    received: list[InboundMessage] = []

    async def handler(message: InboundMessage) -> ChatMessage:
        received.append(message)
        return ChatMessage(text="rolled")

    adapter.set_message_handler(handler)
    interaction = FakeInteraction()

    await tree.commands["roll"][1](interaction, "2d6+1")

    assert interaction.response.deferred == [{"ephemeral": False, "thinking": True}]
    assert received[0].text == ".roll 2d6+1"
    assert interaction.edits[0]["content"] is None
    assert interaction.edits[0]["embeds"][0].kwargs["title"] == "Ada's roll"
    assert interaction.edits[0]["embeds"][0].kwargs["description"] == "rolled"
    assert interaction.edits[0]["embeds"][0].fields[0]["value"] == "2d6+1"
    assert interaction.edits[0]["allowed_mentions"] == "no-mentions"


async def test_character_command_uses_existing_creation_commands() -> None:
    adapter = make_adapter()
    tree = FakeTree()
    adapter.register_app_commands(tree)
    received = []

    async def handler(message: InboundMessage) -> ChatMessage:
        received.append(message.text)
        return ChatMessage(text="created")

    adapter.set_message_handler(handler)
    await tree.commands["character"][1](FakeInteraction(), "dnd5e", "a careful scholar")
    await tree.commands["character"][1](FakeInteraction(interaction_id=201), "coc7", "")

    assert received == [".genchar dnd5e a careful scholar", ".coc"]


async def test_language_command_uses_existing_router_command() -> None:
    adapter = make_adapter()
    tree = FakeTree()
    adapter.register_app_commands(tree)
    received = []

    async def handler(message: InboundMessage) -> ChatMessage:
        received.append(message.text)
        return ChatMessage(text="ok")

    adapter.set_message_handler(handler)
    await tree.commands["language"][1](FakeInteraction(), "zh")

    assert received == [".language zh"]


async def test_sheet_and_character_interactions_are_private() -> None:
    adapter = make_adapter()
    tree = FakeTree()
    adapter.register_app_commands(tree)

    async def handler(_message: InboundMessage) -> ChatMessage:
        return ChatMessage(text="ok")

    adapter.set_message_handler(handler)
    sheet = FakeInteraction()
    character = FakeInteraction(interaction_id=201)
    await tree.commands["sheet"][1](sheet, "")
    await tree.commands["character"][1](character, "coc7", "")

    assert sheet.response.deferred[0]["ephemeral"] is True
    assert character.response.deferred[0]["ephemeral"] is True


async def test_guild_tree_omits_dm_only_binding_commands() -> None:
    adapter = make_adapter()
    tree = FakeTree()
    adapter.register_app_commands(tree)
    received = []

    async def handler(message: InboundMessage) -> ChatMessage:
        received.append(message.text)
        return ChatMessage(text="ok")

    adapter.set_message_handler(handler)
    model = FakeInteraction(interaction_id=203)

    await tree.commands["model"][1](model, "set", "openai gpt-5")

    assert "bind" not in tree.commands
    assert "unbind" not in tree.commands
    assert received == [".model set openai gpt-5"]
    assert model.response.deferred == [{"ephemeral": True, "thinking": True}]


async def test_interaction_uses_followup_after_first_room_event() -> None:
    adapter = make_adapter()

    async def handler(message: InboundMessage) -> None:
        await adapter.send_message(message.source, ChatMessage(text="first"))
        await adapter.send_message(message.source, ChatMessage(text="second"))

    adapter.set_message_handler(handler)
    interaction = FakeInteraction()

    await adapter.handle_interaction(interaction, ".help")

    assert interaction.edits[0]["content"] == "first"
    assert interaction.followup.sent[0]["content"] == "second"
    assert interaction.followup.sent[0]["wait"] is True


async def test_private_error_from_public_interaction_moves_to_ephemeral_followup() -> None:
    adapter = make_adapter()

    async def handler(_message: InboundMessage) -> ChatMessage:
        return ChatMessage(text="private error", private=True)

    adapter.set_message_handler(handler)
    interaction = FakeInteraction()
    await adapter.handle_interaction(interaction, ".roll 1d20")

    assert interaction.edits == []
    assert interaction.deleted == 1
    assert interaction.followup.sent[0]["ephemeral"] is True


async def test_interaction_failure_gets_a_private_localized_response() -> None:
    adapter = make_adapter()

    async def handler(_message: InboundMessage) -> ChatMessage:
        raise RuntimeError("broken command")

    adapter.set_message_handler(handler)
    interaction = FakeInteraction()

    await adapter.handle_interaction(interaction, ".roll 1d20")

    assert interaction.deleted == 1
    assert interaction.followup.sent[0]["embeds"][0].kwargs["description"] == (
        "Something went wrong handling that. Please try again."
    )
    assert interaction.followup.sent[0]["ephemeral"] is True


async def test_panel_interaction_creates_public_panel_and_private_acknowledgement() -> None:
    adapter = make_adapter()
    interaction = FakeInteraction(locale="zh-CN")

    async def handler(message: InboundMessage) -> None:
        assert message.interaction.locale == "zh"
        await adapter.deliver_event(
            message.source,
            "room",
            Event.panel({"character": {"name": "Ada"}, "party": [{"name": "Ada"}]}),
            locale="zh",
        )

    adapter.set_message_handler(handler)
    await adapter.handle_interaction(interaction, ".panel", private=True)

    assert interaction.response.deferred == [{"ephemeral": True, "thinking": True}]
    assert len(interaction.channel.sent) == 1
    assert interaction.edits[0]["content"] == "跑团面板已刷新。"
    assert all(field["name"] != "我的角色" for field in interaction.channel.sent[0]["embeds"][0].fields)


async def test_message_parses_reply_and_attachment() -> None:
    adapter = make_adapter()
    attachment = FakeAttachment()
    message = SimpleNamespace(
        id=55,
        channel_id=123,
        channel=FakeChannel(),
        guild_id=456,
        guild=SimpleNamespace(id=456),
        author=SimpleNamespace(id=7, display_name="Ada", bot=False),
        content="attack [[1d20]] now",
        attachments=[attachment],
        reference=SimpleNamespace(
            message_id=54,
            resolved=SimpleNamespace(content="the earlier clue"),
        ),
        mentions=[],
    )

    inbound = adapter.to_inbound_message(message)

    assert inbound.source.chat_key() == "discord:group:123"
    assert inbound.quoted_text == "the earlier clue"
    assert inbound.attachments[0].name == "map.png"
    assert await adapter.fetch_attachment(inbound.attachments[0]) == b"png"
    assert attachment.read_calls == [True]


@pytest.mark.parametrize("mention", ["<@999>", "<@!999>"])
def test_message_strips_the_bot_mention_before_routing(mention: str) -> None:
    adapter = make_adapter()
    adapter._client = SimpleNamespace(user=SimpleNamespace(id=999))
    message = SimpleNamespace(
        id=55,
        channel=FakeChannel(),
        guild=SimpleNamespace(id=456),
        author=SimpleNamespace(id=7, display_name="Ada", bot=False),
        content=f"{mention} attack the ghoul",
        attachments=[],
        reference=None,
        mentions=[SimpleNamespace(id=999)],
    )

    inbound = adapter.to_inbound_message(message)

    assert inbound.at_bot is True
    assert inbound.text == "attack the ghoul"


async def test_regular_message_keeps_typing_around_handler_and_replies_safely() -> None:
    adapter = make_adapter()
    channel = FakeChannel()
    message = SimpleNamespace(
        id=55,
        channel_id=123,
        channel=channel,
        guild_id=None,
        guild=None,
        author=SimpleNamespace(id=7, display_name="Ada", bot=False),
        content="hello",
        attachments=[],
        reference=None,
        mentions=[],
    )

    async def handler(_message: InboundMessage) -> ChatMessage:
        assert channel.typing == 1
        return ChatMessage(text="world")

    adapter.set_message_handler(handler)
    await adapter.handle_message(message)

    assert adapter._typing_tasks == {}
    assert channel.sent[0]["content"] == "world"
    assert channel.sent[0]["allowed_mentions"] == "no-mentions"


async def test_structured_send_uses_embed_file_component_reply_and_no_mentions() -> None:
    adapter = make_adapter()
    channel = FakeChannel()
    adapter._channels["123"] = channel
    source = SessionSource(platform="discord", chat_type="group", chat_id="123", user_id="7")
    message = ChatMessage(
        text="result",
        embeds=[ChatEmbed(title="Roll", fields=(ChatField("Total", "12", True),))],
        attachments=[ChatAttachment(name="map.png", mime="image/png", size=3, data=b"png")],
    )

    result = await adapter.send_message(source, message, reply_to="55")

    assert result.ok is True
    sent = channel.sent[0]
    assert sent["allowed_mentions"] == "no-mentions"
    assert sent["reference"] == "partial:55"
    assert sent["mention_author"] is False
    assert sent["embeds"][0].fields == [{"name": "Total", "value": "12", "inline": True}]
    assert sent["files"][0].filename == "map.png"
    assert sent["files"][0].data == b"png"


async def test_panel_is_created_once_then_state_only_edits_and_has_no_character() -> None:
    adapter = make_adapter()
    channel = FakeChannel()
    adapter._channels["123"] = channel
    source = SessionSource(platform="discord", chat_type="group", chat_id="123", user_id="7")
    snapshot = {
        "character": {"name": "Ada"},
        "party": [{"name": "Ada"}, {"name": "Bob"}],
        "online": 2,
        "usage": {"context_tokens": 10, "context_window": 100, "input_tokens": 20, "output_tokens": 3},
    }

    created = await adapter.deliver_event(source, "room", Event.panel(snapshot), locale="en")
    updated = await adapter.deliver_event(source, "room", Event.state(snapshot), locale="en")

    assert created.ok is True
    assert updated.ok is True
    assert len(channel.sent) == 1
    panel = channel.sent[0]
    assert all(field["name"] != "My character" for field in panel["embeds"][0].fields)
    assert panel["embeds"][0].footer is None
    assert any(field["value"] == "10/100 · 20+3" for field in panel["embeds"][0].fields)
    assert len(panel["view"].children) == 3
    assert channel.messages[101].edits


async def test_panel_message_id_survives_adapter_restart() -> None:
    store = Store(":memory:")
    context = AdapterContext(services=SimpleNamespace(store=store), command_router=None)
    channel = FakeChannel()
    source = SessionSource(platform="discord", chat_type="group", chat_id="123")
    first = DiscordAdapter(
        DiscordSettings(token="t"),
        context,
        sdk=FakeSDK,
        voice_manager=FakeVoiceManager(),
    )
    first._channels["123"] = channel
    await first.deliver_event(source, "room", Event.panel({"party": []}), locale="en")

    second = DiscordAdapter(
        DiscordSettings(token="t"),
        context,
        sdk=FakeSDK,
        voice_manager=FakeVoiceManager(),
    )
    second._channels["123"] = channel
    result = await second.deliver_event(source, "room", Event.state({"party": []}), locale="en")

    assert result.ok is True
    assert len(channel.sent) == 1
    assert channel.messages[101].edits
    store.close()


async def test_panel_button_reenters_the_same_command_handler() -> None:
    adapter = make_adapter()
    received = []

    async def handler(message: InboundMessage) -> ChatMessage:
        received.append(message.text)
        return ChatMessage(text="done")

    adapter.set_message_handler(handler)
    view = adapter._view(adapter._panel_message(Event.panel({"party": []}), "en").components)
    interaction = FakeInteraction()

    await view.children[2].callback(interaction)

    assert received == [".roll 1d20"]
    assert interaction.edits[0]["content"] is None
    assert interaction.edits[0]["embeds"][0].kwargs["description"] == "done"


async def test_state_does_not_create_unsolicited_panel() -> None:
    adapter = make_adapter()
    channel = FakeChannel()
    adapter._channels["123"] = channel
    source = SessionSource(platform="discord", chat_type="group", chat_id="123")

    result = await adapter.deliver_event(source, "room", Event.state({"party": []}), locale="en")

    assert result is None
    assert channel.sent == []


async def test_typing_and_audio_events_use_native_transports() -> None:
    voice = FakeVoiceManager()
    adapter = make_adapter(voice=voice)
    channel = FakeChannel()
    adapter._channels["123"] = channel
    source = SessionSource(platform="discord", chat_type="group", chat_id="123")
    event = Event.audio({"type": "audio_control", "action": "pause", "layer": "bgm"})

    await adapter.set_typing(source, True)
    result = await adapter.deliver_event(source, "logical-room", event, locale="en", media_store="media")
    await adapter.set_typing(source, False)

    assert channel.typing == 1
    assert result is None
    assert voice.events == [("logical-room", event, "media")]


async def test_voice_join_resolves_the_bound_logical_room() -> None:
    store = Store(":memory:")
    await store.set(store_key="bound_room.discord:group:123", value="tui:group:room")
    await set_keeper_binding(store, "discord", "7", "room")
    context = AdapterContext(services=SimpleNamespace(store=store), command_router=None)
    voice = FakeVoiceManager()
    adapter = DiscordAdapter(
        DiscordSettings(token="t"),
        context,
        sdk=FakeSDK,
        voice_manager=voice,
    )
    interaction = FakeInteraction()

    await adapter.handle_voice_interaction(interaction, "join")

    assert voice.joins == [("tui:group:room", interaction)]
    assert interaction.response.deferred == [{"ephemeral": True, "thinking": True}]
    store.close()


async def test_voice_join_rejects_an_unbound_user_in_a_guild() -> None:
    voice = FakeVoiceManager()
    adapter = make_adapter(voice=voice)
    interaction = FakeInteraction()

    await adapter.handle_voice_interaction(interaction, "join")

    assert voice.joins == []
    assert interaction.edits[0]["content"] == "Only an authenticated Keeper can use this command."


async def test_voice_failure_returns_a_private_localized_error() -> None:
    class FailingVoiceManager(FakeVoiceManager):
        async def join(self, session_key, interaction):
            raise RuntimeError("voice unavailable")

    store = Store(":memory:")
    await store.set(store_key="bound_room.discord:group:123", value="tui:group:room")
    await set_keeper_binding(store, "discord", "7", "room")
    context = AdapterContext(services=SimpleNamespace(store=store), command_router=None)
    adapter = DiscordAdapter(
        DiscordSettings(token="t"),
        context,
        sdk=FakeSDK,
        voice_manager=FailingVoiceManager(),
    )
    interaction = FakeInteraction()

    await adapter.handle_voice_interaction(interaction, "join")

    assert interaction.response.deferred == [{"ephemeral": True, "thinking": True}]
    assert interaction.edits[0]["content"] == "Something went wrong handling that. Please try again."
    store.close()


async def test_media_event_attaches_room_scoped_bytes() -> None:
    adapter = make_adapter()
    channel = FakeChannel()
    adapter._channels["123"] = channel
    source = SessionSource(platform="discord", chat_type="group", chat_id="123")
    record = SimpleNamespace(hash="a" * 64, name="handout.png", mime="image/png", size=3)

    class MediaStore:
        async def read_bytes(self, room, sha256):
            assert (room, sha256) == ("room", "a" * 64)
            return record, b"png"

    event = Event.media({"hash": record.hash, "name": record.name})
    result = await adapter.deliver_event(source, "room", event, locale="en", media_store=MediaStore())

    assert result.ok is True
    assert channel.sent[0]["files"][0].data == b"png"


async def test_voice_manager_joins_one_channel_per_room_and_leaves() -> None:
    class AvailableVoiceManager(DiscordVoiceManager):
        @property
        def available(self):
            return True

    class VoiceClient:
        def __init__(self, channel) -> None:
            self.channel = channel
            self.disconnected = False

        async def disconnect(self):
            self.disconnected = True

    class VoiceChannel:
        async def connect(self):
            return VoiceClient(self)

    manager = AvailableVoiceManager(FakeSDK)
    channel = VoiceChannel()
    interaction = SimpleNamespace(user=SimpleNamespace(voice=SimpleNamespace(channel=channel)))

    assert await manager.join("room", interaction) == "joined"
    client = manager.clients["room"]
    assert await manager.join("room", interaction) == "joined"
    assert manager.clients["room"] is client
    assert await manager.leave("room") == "left"
    assert client.disconnected is True


async def test_voice_manager_rejects_a_second_room_in_the_same_guild() -> None:
    class AvailableVoiceManager(DiscordVoiceManager):
        @property
        def available(self):
            return True

    class VoiceChannel:
        def __init__(self):
            self.connects = 0

        async def connect(self):
            self.connects += 1
            await asyncio.sleep(0)
            return VoiceClient(self)

    class VoiceClient:
        def __init__(self, channel):
            self.channel = channel

        async def disconnect(self):
            return None

    manager = AvailableVoiceManager(FakeSDK)
    channel = VoiceChannel()
    first = SimpleNamespace(
        guild_id=42,
        user=SimpleNamespace(voice=SimpleNamespace(channel=channel)),
    )
    second = SimpleNamespace(
        guild_id=42,
        user=SimpleNamespace(voice=SimpleNamespace(channel=channel)),
    )

    results = await asyncio.gather(
        manager.join("room-a", first),
        manager.join("room-b", second),
    )

    assert set(results) == {"joined", "busy"}
    assert channel.connects == 1


async def test_voice_manager_moves_a_room_without_leaving_the_old_guild_busy() -> None:
    class AvailableVoiceManager(DiscordVoiceManager):
        @property
        def available(self):
            return True

    class VoiceClient:
        def __init__(self, channel):
            self.channel = channel
            self.disconnected = False

        async def disconnect(self):
            self.disconnected = True

    class VoiceChannel:
        async def connect(self):
            return VoiceClient(self)

    manager = AvailableVoiceManager(FakeSDK)
    first_channel = VoiceChannel()
    second_channel = VoiceChannel()
    first = SimpleNamespace(
        guild_id=1,
        user=SimpleNamespace(voice=SimpleNamespace(channel=first_channel)),
    )
    second = SimpleNamespace(
        guild_id=2,
        user=SimpleNamespace(voice=SimpleNamespace(channel=second_channel)),
    )

    assert await manager.join("room", first) == "joined"
    old_client = manager.clients["room"]
    assert await manager.join("room", second) == "joined"

    assert old_client.disconnected is True
    assert manager._guild_rooms == {"2": "room"}


async def test_voice_manager_drops_disconnected_state_when_reconnect_fails() -> None:
    class AvailableVoiceManager(DiscordVoiceManager):
        @property
        def available(self):
            return True

    class VoiceClient:
        def __init__(self, channel):
            self.channel = channel

        async def disconnect(self):
            return None

    class VoiceChannel:
        async def connect(self):
            return VoiceClient(self)

    class FailingChannel:
        async def connect(self):
            raise RuntimeError("connect failed")

    manager = AvailableVoiceManager(FakeSDK)
    first = SimpleNamespace(
        guild_id=1,
        user=SimpleNamespace(voice=SimpleNamespace(channel=VoiceChannel())),
    )
    second = SimpleNamespace(
        guild_id=2,
        user=SimpleNamespace(voice=SimpleNamespace(channel=FailingChannel())),
    )
    await manager.join("room", first)

    with pytest.raises(RuntimeError, match="connect failed"):
        await manager.join("room", second)

    assert "room" not in manager.clients
    assert manager._guild_rooms == {}


def test_voice_manager_cleans_temp_file_when_source_creation_fails() -> None:
    class FailingSDK(FakeSDK):
        @staticmethod
        def FFmpegPCMAudio(path, *, executable):
            raise RuntimeError("ffmpeg failed")

    client = SimpleNamespace(stop=lambda: None)
    manager = DiscordVoiceManager(FailingSDK)

    with pytest.raises(RuntimeError, match="ffmpeg failed"):
        manager._play("room", client, "broken.ogg", b"audio", 1.0)

    assert manager._temp_files == {}


async def test_voice_manager_maps_audio_controls_and_playback() -> None:
    class VoiceClient:
        def __init__(self) -> None:
            self.source = SimpleNamespace(volume=1.0)
            self.calls = []

        def pause(self):
            self.calls.append("pause")

        def resume(self):
            self.calls.append("resume")

        def stop(self):
            self.calls.append("stop")

        def play(self, source, *, after):
            self.source = source
            self.after = after
            self.calls.append("play")

    class MediaStore:
        async def read_bytes(self, room, sha256):
            assert (room, sha256) == ("room", "hash")
            return SimpleNamespace(name="bgm.ogg"), b"audio"

    manager = DiscordVoiceManager(FakeSDK)
    client = VoiceClient()
    manager.clients["room"] = client
    for action in ("pause", "resume", "stop"):
        await manager.handle_event(
            "room",
            Event.audio({"type": "audio_control", "action": action}),
            MediaStore(),
        )
    await manager.handle_event(
        "room",
        Event.audio({"type": "audio_control", "action": "volume", "volume": 0.25}),
        MediaStore(),
    )
    await manager.handle_event(
        "room",
        Event.audio({"type": "audio_control", "action": "play", "hash": "hash", "volume": 0.5}),
        MediaStore(),
    )

    assert client.calls == ["pause", "resume", "stop", "stop", "play"]
    assert client.source.volume == 0.5
    client.after(None)
    assert manager._temp_files == {}
