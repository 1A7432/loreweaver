from __future__ import annotations

# Derived from the hermes-agent Discord platform design (MIT, Copyright 2025 Nous Research).
import asyncio
import io
import logging
import mimetypes
from contextlib import suppress
from dataclasses import dataclass, replace
from typing import Any

from adapters.discord.voice import DiscordVoiceManager
from gateway.base_adapter import BaseAdapter, MessageHandler
from gateway.chat import (
    ChatAttachment,
    ChatCapabilities,
    ChatComponent,
    ChatEmbed,
    ChatField,
    ChatInteraction,
    ChatMessage,
)
from gateway.events import InboundMessage, SendResult
from gateway.hub import Event
from gateway.registry import AdapterContext, PlatformEntry, platform_registry
from gateway.render_chat import render_chat_event
from gateway.rooms import get_keeper_binding, resolve_session_key, session_key_for_room
from gateway.session import SessionSource
from infra.config import DiscordSettings
from infra.i18n import get_i18n

try:  # pragma: no cover - optional runtime dependency
    import discord
except ImportError:  # pragma: no cover - import without the Discord extra
    discord = None


logger = logging.getLogger(__name__)


@dataclass
class _InteractionState:
    interaction: Any
    private: bool
    command: str = ""
    locale: str = "en"
    responded: bool = False


class DiscordAdapter(BaseAdapter):
    platform = "discord"
    capabilities = ChatCapabilities(
        attachments=True,
        typing=True,
        max_text_chars=2000,
    )

    def __init__(
        self,
        config: DiscordSettings,
        context: AdapterContext,
        on_message: MessageHandler | None = None,
        *,
        sdk: Any = None,
        voice_manager: Any = None,
    ) -> None:
        super().__init__(config=config, on_message=on_message)
        self.context = context
        self.sdk = discord if sdk is None else sdk
        self.token = config.token
        self.guild_id = config.guild_id or None
        ffmpeg = config.ffmpeg or "ffmpeg"
        self.voice = voice_manager or DiscordVoiceManager(self.sdk, executable=ffmpeg)
        self._client: Any = None
        self._client_task: asyncio.Task | None = None
        self._channels: dict[str, Any] = {}
        self._attachments: dict[str, Any] = {}
        self._interactions: dict[str, _InteractionState] = {}
        self._typing_tasks: dict[str, asyncio.Task] = {}
        self._panels: dict[str, str] = {}

    async def connect(self) -> bool:
        if self._client is not None:
            if self._client_task is not None and not self._client_task.done():
                return True
            self._client = None
            self._channels.clear()
            self._attachments.clear()
            self._interactions.clear()
        if self.sdk is None or not self.token:
            return False

        intents = self.sdk.Intents.default()
        intents.message_content = True
        intents.dm_messages = True
        intents.guild_messages = True
        client = self.sdk.Client(intents=intents)
        tree = self.sdk.app_commands.CommandTree(client)
        self.register_app_commands(tree)
        client.add_view(self._view(self._panel_components("en")))
        adapter = self

        @client.event
        async def setup_hook() -> None:
            if adapter.guild_id:
                guild = adapter.sdk.Object(id=adapter.guild_id)
                tree.copy_global_to(guild=guild)
                await tree.sync(guild=guild)
            else:
                await tree.sync()

        @client.event
        async def on_message(message: Any) -> None:
            if getattr(getattr(client, "user", None), "id", None) == getattr(
                getattr(message, "author", None), "id", None
            ):
                return
            await adapter.handle_message(message)

        self._client = client
        self._client_task = asyncio.create_task(client.start(self.token))
        self._client_task.add_done_callback(self._client_stopped)
        return True

    def _client_stopped(self, task: asyncio.Task) -> None:
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            logger.error("discord.client_failed error=%s", type(error).__name__)
        if self._client_task is task:
            self._client_task = None
            self._client = None
            self._channels.clear()
            self._attachments.clear()
            self._interactions.clear()

    async def disconnect(self) -> None:
        await self.voice.close()
        typing_tasks = list(self._typing_tasks.values())
        for task in typing_tasks:
            task.cancel()
        self._typing_tasks.clear()
        if typing_tasks:
            await asyncio.gather(*typing_tasks, return_exceptions=True)
        if self._client is not None:
            await self._client.close()
        if self._client_task is not None and not self._client_task.done():
            self._client_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._client_task
        self._client_task = None
        self._client = None
        self._channels.clear()
        self._attachments.clear()
        self._interactions.clear()
        self._panels.clear()

    def register_app_commands(self, tree: Any) -> None:
        """Register thin Interaction wrappers over the existing command router dialect."""
        i18n = get_i18n("en")

        async def roll(interaction: Any, expression: str = "1d20") -> None:
            await self.handle_interaction(interaction, f".roll {expression}".rstrip())

        async def check(interaction: Any, name: str = "") -> None:
            await self.handle_interaction(interaction, f".check {name}".rstrip())

        async def sheet(interaction: Any, action: str = "") -> None:
            await self.handle_interaction(interaction, f".sheet {action}".rstrip(), private=True)

        async def character(
            interaction: Any,
            system: str = "coc7",
            description: str = "",
        ) -> None:
            system = "dnd5e" if system.casefold() == "dnd5e" else "coc7"
            command = f".genchar {system} {description}".rstrip() if description.strip() else f".{system[:3]}"
            await self.handle_interaction(interaction, command, private=True)

        async def panel(interaction: Any) -> None:
            await self.handle_interaction(interaction, ".panel", private=True)

        async def language(interaction: Any, locale: str) -> None:
            await self.handle_interaction(interaction, f".language {locale}")

        async def help_command(interaction: Any) -> None:
            await self.handle_interaction(interaction, ".help")

        async def room(interaction: Any, action: str = "", value: str = "") -> None:
            await self.handle_interaction(interaction, f".room {action} {value}".rstrip(), private=True)

        async def model(interaction: Any, action: str = "show", value: str = "") -> None:
            await self.handle_interaction(
                interaction,
                f".model {action} {value}".rstrip(),
                private=True,
            )

        async def audio(
            interaction: Any,
            action: str = "list",
            item: str = "",
            layer: str = "bgm",
            volume: int = 100,
        ) -> None:
            action = action.casefold()
            layer = layer.casefold() if layer.casefold() in {"bgm", "ambience", "sfx"} else "bgm"
            if action in {"join", "leave"}:
                await self.handle_voice_interaction(interaction, action)
                return
            if action == "play":
                command = f".{layer} play {item} --volume {volume}".rstrip()
            elif action == "volume":
                command = f".{layer} volume {volume}"
            elif action in {"pause", "resume", "stop"}:
                command = f".{layer} {action}"
            else:
                command = f".audio {action} {item}".rstrip()
            await self.handle_interaction(interaction, command)

        definitions = (
            ("roll", "commands.help.roll", roll),
            ("check", "commands.help.check", check),
            ("sheet", "commands.help.sheet", sheet),
            ("character", "charcard.commands.genchar.help", character),
            ("panel", "commands.help.panel", panel),
            ("language", "commands.help.language", language),
            ("help", "commands.help.help", help_command),
            ("room", "commands.help.room", room),
            ("model", "commands.help.model", model),
            ("audio", "commands.help.audio", audio),
        )
        for name, description_key, callback in definitions:
            tree.command(name=name, description=i18n.t(description_key))(callback)

    async def handle_message(self, message: Any) -> InboundMessage:
        inbound = self.to_inbound_message(message)
        try:
            await self.handle_inbound(inbound)
        finally:
            for attachment in inbound.attachments:
                self._attachments.pop(attachment.id, None)
        return inbound

    async def handle_interaction(self, interaction: Any, command: str, *, private: bool = False) -> None:
        inbound = self.to_interaction_message(interaction, command, private=private)
        interaction_id = inbound.interaction.id
        await interaction.response.defer(ephemeral=private, thinking=True)
        self._interactions[interaction_id] = _InteractionState(
            interaction=interaction,
            private=private,
            command=command,
            locale=inbound.interaction.locale or "en",
        )
        try:
            if self._message_handler is not None:
                reply = await self._message_handler(inbound)
                if reply is not None:
                    result = await self.send_message(inbound.source, reply, reply_to=interaction_id)
                    if not result.ok:
                        raise RuntimeError(result.error or "discord.interaction.send_failed")
            state = self._interactions.get(interaction_id)
            if state is not None and not state.responded:
                await interaction.delete_original_response()
        except Exception as exc:
            logger.warning("discord.interaction_failed error=%s", type(exc).__name__)
            state = self._interactions[interaction_id]
            await self._send_interaction(
                state,
                ChatMessage(text=get_i18n(state.locale).t("runner.error"), private=True),
            )
        finally:
            self._interactions.pop(interaction_id, None)

    async def handle_voice_interaction(self, interaction: Any, action: str) -> None:
        inbound = self.to_interaction_message(interaction, f".audio {action}", private=True)
        interaction_id = inbound.interaction.id
        await interaction.response.defer(ephemeral=True, thinking=True)
        state = _InteractionState(
            interaction=interaction,
            private=True,
            command=f".audio {action}",
            locale=inbound.interaction.locale or "en",
        )
        self._interactions[interaction_id] = state
        try:
            i18n = get_i18n(inbound.interaction.locale or "en")
            session_key = await resolve_session_key(self.context.services.store, inbound.source)
            binding = await get_keeper_binding(
                self.context.services.store,
                inbound.source.platform,
                inbound.source.user_id,
            )
            is_keeper = bool(binding is not None and session_key_for_room(binding) == session_key)
            if getattr(interaction, "guild_id", None) and not is_keeper:
                text = i18n.t("rooms.denied")
            else:
                result = (
                    await self.voice.join(session_key, interaction)
                    if action == "join"
                    else await self.voice.leave(session_key)
                )
                text = (
                    i18n.t("commands.audio.voice_busy")
                    if result == "busy"
                    else i18n.t("commands.audio.usage")
                    if result in {"unavailable", "no_channel"}
                    else i18n.t("commands.audio.control_done", layer="Discord", action=result)
                )
            send_result = await self.send_message(
                inbound.source,
                ChatMessage(text=text, private=True),
                reply_to=interaction_id,
            )
            if not send_result.ok:
                raise RuntimeError(send_result.error or "discord.interaction.send_failed")
        except Exception as exc:
            logger.warning("discord.voice_control_failed error=%s", type(exc).__name__)
            await self._send_interaction(
                state,
                ChatMessage(text=get_i18n(state.locale).t("runner.error"), private=True),
            )
        finally:
            self._interactions.pop(interaction_id, None)

    def to_inbound_message(self, message: Any) -> InboundMessage:
        channel = message.channel
        channel_id = _string_id(channel.id)
        if not channel_id:
            raise ValueError("discord.message.channel_id.missing")
        self._channels[channel_id] = channel

        author = message.author
        guild_id = getattr(message.guild, "id", None)
        text = self._strip_self_mention(str(message.content or ""))
        source = SessionSource(
            platform=self.platform,
            chat_type="group" if guild_id else "dm",
            chat_id=channel_id,
            user_id=_string_id(author.id),
            user_name=_author_name(author),
            message_id=_string_id(message.id),
            is_bot=bool(author.bot),
        )
        attachments = [self._attachment_from(item) for item in message.attachments]
        reference = message.reference
        resolved = getattr(reference, "resolved", None)
        quoted_text = str(getattr(resolved, "content", "") or "")
        return InboundMessage(
            source=source,
            text=text,
            at_bot=self._mentions_self(message),
            attachments=attachments,
            quoted_text=quoted_text,
        )

    def to_interaction_message(
        self,
        interaction: Any,
        command: str,
        *,
        private: bool = False,
    ) -> InboundMessage:
        channel = getattr(interaction, "channel", None)
        channel_id = _string_id(getattr(interaction, "channel_id", None) or getattr(channel, "id", None))
        user = getattr(interaction, "user", None)
        guild_id = getattr(interaction, "guild_id", None)
        interaction_id = _string_id(getattr(interaction, "id", None))
        locale = _locale_code(getattr(interaction, "locale", ""))
        source = SessionSource(
            platform=self.platform,
            chat_type="group" if guild_id else "dm",
            chat_id=channel_id,
            user_id=_string_id(getattr(user, "id", None)),
            user_name=_author_name(user),
            message_id=interaction_id,
        )
        if channel is not None:
            self._channels[channel_id] = channel
        chat_interaction = ChatInteraction(
            id=interaction_id,
            locale=locale,
            private=private,
        )
        return InboundMessage(
            source=source,
            text=command,
            at_bot=True,
            interaction=chat_interaction,
        )

    async def fetch_attachment(
        self,
        attachment: ChatAttachment,
        *,
        max_bytes: int | None = None,
    ) -> bytes:
        if attachment.data is not None:
            return await super().fetch_attachment(attachment, max_bytes=max_bytes)
        if max_bytes is not None and attachment.size > max_bytes:
            raise ValueError("discord.attachment.too_large")
        raw = self._attachments.get(attachment.id)
        if raw is None or not hasattr(raw, "read"):
            return await super().fetch_attachment(attachment, max_bytes=max_bytes)
        data = await raw.read(use_cached=True)
        if max_bytes is not None and len(data) > max_bytes:
            raise ValueError("discord.attachment.too_large")
        self._attachments.pop(attachment.id, None)
        return data

    def supports_private_reply(self, source: SessionSource) -> bool:
        return bool(source.user_id)

    async def _send_message(
        self,
        source: SessionSource,
        message: ChatMessage,
        *,
        reply_to: str | None,
        session_key: str | None,
    ) -> SendResult:
        del session_key
        try:
            interaction_state = self._interactions.get(source.message_id or "")
            if interaction_state is not None:
                return await self._send_interaction(interaction_state, message)
            target = await self._private_target(source) if message.private else await self._get_channel(source.chat_id)
            if target is None:
                return SendResult(ok=False, error="discord.target.missing")
            kwargs = self._message_kwargs(message)
            if reply_to and hasattr(target, "get_partial_message"):
                kwargs["reference"] = target.get_partial_message(int(reply_to))
                kwargs["mention_author"] = False
            sent = await target.send(**kwargs)
            return SendResult(ok=True, message_id=_response_message_id(sent))
        except Exception as exc:
            return SendResult(ok=False, error=str(exc))

    async def _send_interaction(self, state: _InteractionState, message: ChatMessage) -> SendResult:
        message = self._interaction_card(state, message)
        kwargs = self._message_kwargs(message)
        files = kwargs.pop("files", [])
        if not state.responded and message.private and not state.private:
            await state.interaction.delete_original_response()
            if files:
                kwargs["files"] = files
            sent = await state.interaction.followup.send(
                **kwargs,
                ephemeral=True,
                wait=True,
            )
            state.responded = True
            return SendResult(ok=True, message_id=_response_message_id(sent))
        if not state.responded:
            if files:
                kwargs["attachments"] = files
            sent = await state.interaction.edit_original_response(**kwargs)
            state.responded = True
        else:
            if files:
                kwargs["files"] = files
            sent = await state.interaction.followup.send(
                **kwargs,
                ephemeral=state.private or message.private,
                wait=True,
            )
        return SendResult(ok=True, message_id=_response_message_id(sent))

    def _interaction_card(self, state: _InteractionState, message: ChatMessage) -> ChatMessage:
        command, _, argument = state.command.partition(" ")
        if message.embeds:
            return message
        i18n = get_i18n(state.locale)
        if command == ".sheet":
            return replace(
                message,
                text="",
                embeds=[
                    ChatEmbed(
                        title=i18n.t("commands.help.sheet"),
                        description=message.text,
                        color=0x2B2D31,
                    )
                ],
            )
        if command not in {".roll", ".check"}:
            return message
        actor = _author_name(getattr(state.interaction, "user", None)) or "-"
        fields = ()
        if argument:
            fields = (ChatField(i18n.t("rooms.chat.dice.expression"), argument, True),)
        return replace(
            message,
            text="",
            embeds=[
                ChatEmbed(
                    title=i18n.t("rooms.chat.dice.title", actor=actor),
                    description=message.text,
                    fields=fields,
                    color=0x5865F2,
                )
            ],
        )

    async def edit_message(self, source: SessionSource, message_id: str, message: ChatMessage) -> SendResult:
        try:
            channel = await self._get_channel(source.chat_id)
            if channel is None:
                return SendResult(ok=False, error="discord.channel.missing")
            target = await channel.fetch_message(int(message_id))
            kwargs = self._message_kwargs(message)
            files = kwargs.pop("files", [])
            if files:
                kwargs["attachments"] = files
            edited = await target.edit(**kwargs)
            return SendResult(ok=True, message_id=_response_message_id(edited) or message_id)
        except Exception as exc:
            return SendResult(ok=False, error=str(exc))

    async def set_typing(self, source: SessionSource, active: bool) -> None:
        existing = self._typing_tasks.pop(source.chat_id, None)
        if existing is not None:
            existing.cancel()
            await asyncio.gather(existing, return_exceptions=True)
        if not active:
            return
        channel = await self._get_channel(source.chat_id)
        if channel is not None and hasattr(channel, "trigger_typing"):
            await channel.trigger_typing()
            self._typing_tasks[source.chat_id] = asyncio.create_task(_typing_loop(channel))

    async def deliver_event(
        self,
        source: SessionSource,
        session_key: str,
        event: Event,
        *,
        locale: str,
        media_store: Any = None,
    ) -> SendResult | None:
        if event.kind == "audio":
            try:
                await self.voice.handle_event(session_key, event, media_store)
            except Exception as exc:
                logger.warning("discord.voice_event_failed error=%s", type(exc).__name__)
        if event.kind == "state":
            panel_id = await self._panel_id(source)
            if panel_id is None:
                return None
            return await self.edit_message(source, panel_id, self._panel_message(event, locale))
        if event.kind == "panel":
            result = await self._upsert_panel(source, self._panel_message(event, locale))
            if (source.message_id or "") in self._interactions:
                acknowledgement = ChatMessage(
                    text=get_i18n(locale).t("commands.panel.ready"),
                    private=True,
                )
                await self._send_interaction(self._interactions[source.message_id or ""], acknowledgement)
            return result
        return await super().deliver_event(
            source,
            session_key,
            event,
            locale=locale,
            media_store=media_store,
        )

    def _panel_message(self, event: Event, locale: str) -> ChatMessage:
        data = dict(event.data)
        data.pop("character", None)
        panel = render_chat_event(Event.panel(data), get_i18n(locale))
        assert panel is not None
        panel.components = self._panel_components(locale)
        return panel

    def _panel_components(self, locale: str) -> list[ChatComponent]:
        return [
            ChatComponent(
                id="lw:panel",
                command=".panel",
                label=get_i18n(locale).t("rooms.chat.panel.title"),
                style="primary",
            ),
            ChatComponent(
                id="lw:sheet",
                command=".sheet",
                label=get_i18n(locale).t("commands.help.sheet"),
            ),
            ChatComponent(id="lw:roll", command=".roll 1d20", label="d20"),
        ]

    async def _upsert_panel(self, source: SessionSource, message: ChatMessage) -> SendResult:
        panel_id = await self._panel_id(source)
        if panel_id is not None:
            result = await self.edit_message(source, panel_id, message)
            if result.ok:
                return result
        channel = await self._get_channel(source.chat_id)
        if channel is None:
            return SendResult(ok=False, error="discord.channel.missing")
        sent = await channel.send(**self._message_kwargs(message))
        result = SendResult(ok=True, message_id=_response_message_id(sent))
        if result.message_id:
            self._panels[source.chat_id] = result.message_id
            await self.context.services.store.set(
                user_key="",
                store_key=f"discord.panel.{source.chat_key()}",
                value=result.message_id,
            )
        return result

    async def _panel_id(self, source: SessionSource) -> str | None:
        panel_id = self._panels.get(source.chat_id)
        if panel_id is None:
            panel_id = await self.context.services.store.get(
                user_key="",
                store_key=f"discord.panel.{source.chat_key()}",
            )
            if panel_id:
                self._panels[source.chat_id] = panel_id
        return panel_id

    def _message_kwargs(self, message: ChatMessage) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "content": message.text or None,
            "allowed_mentions": self.sdk.AllowedMentions.none(),
        }
        embeds = [self._embed(item) for item in message.embeds[:10]]
        if embeds:
            kwargs["embeds"] = embeds
        files = [
            self.sdk.File(io.BytesIO(item.data), filename=item.name)
            for item in message.attachments[:10]
            if item.data is not None
        ]
        if files:
            kwargs["files"] = files
        view = self._view(message.components)
        if view is not None:
            kwargs["view"] = view
        return kwargs

    def _embed(self, item: ChatEmbed) -> Any:
        embed = self.sdk.Embed(
            title=item.title[:256] or None,
            description=item.description[:4096] or None,
            color=item.color,
        )
        for field in item.fields[:25]:
            embed.add_field(name=field.name[:256], value=field.value[:1024], inline=field.inline)
        if item.footer:
            embed.set_footer(text=item.footer[:2048])
        return embed

    def _view(self, components: list[ChatComponent]) -> Any | None:
        if not components:
            return None
        view = self.sdk.ui.View(timeout=None)
        for component in components:
            if not component.command:
                continue
            style = getattr(self.sdk.ButtonStyle, component.style, self.sdk.ButtonStyle.secondary)
            button = self.sdk.ui.Button(
                label=component.label,
                custom_id=component.id,
                style=style,
            )

            async def callback(interaction: Any, command: str = component.command) -> None:
                await self.handle_interaction(
                    interaction,
                    command,
                    private=command in {".panel", ".sheet"},
                )

            button.callback = callback
            view.add_item(button)
        return view

    def _attachment_from(self, value: Any) -> ChatAttachment:
        attachment_id = _string_id(value.id)
        name = str(value.filename)
        attachment = ChatAttachment(
            id=attachment_id,
            name=name,
            mime=str(value.content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"),
            size=int(value.size or 0),
            url=str(value.url or "") or None,
        )
        self._attachments[attachment_id] = value
        return attachment

    async def _get_channel(self, channel_id: str) -> Any:
        if channel_id in self._channels:
            return self._channels[channel_id]
        if self._client is None:
            return None
        candidate = int(channel_id)
        channel = self._client.get_channel(candidate)
        if channel is None:
            channel = await self._client.fetch_channel(candidate)
        if channel is not None:
            self._channels[channel_id] = channel
        return channel

    async def _private_target(self, source: SessionSource) -> Any:
        if self._client is None or not source.user_id:
            return None
        candidate = int(source.user_id)
        user = self._client.get_user(candidate)
        return user if user is not None else await self._client.fetch_user(candidate)

    def _mentions_self(self, message: Any) -> bool:
        bot_id = _string_id(getattr(getattr(self._client, "user", None), "id", None))
        if not bot_id:
            return False
        return any(_string_id(item.id) == bot_id for item in message.mentions)

    def _strip_self_mention(self, text: str) -> str:
        bot_id = _string_id(getattr(getattr(self._client, "user", None), "id", None))
        if not bot_id:
            return text
        return text.replace(f"<@{bot_id}>", " ").replace(f"<@!{bot_id}>", " ").strip()

async def _typing_loop(channel: Any) -> None:
    try:
        while True:
            await asyncio.sleep(8)
            await channel.trigger_typing()
    except asyncio.CancelledError:
        pass


def _string_id(value: Any) -> str:
    return "" if value is None else str(value)


def _locale_code(value: Any) -> str:
    return "zh" if str(value or "").casefold().startswith("zh") else "en"


def _author_name(author: Any) -> str | None:
    for key in ("display_name", "global_name", "name", "username"):
        value = getattr(author, key, None)
        if value:
            return str(value)
    return None


def _response_message_id(response: Any) -> str | None:
    value = getattr(response, "id", None)
    return _string_id(value) or None


platform_registry.register(
    PlatformEntry(
        name="discord",
        label="Discord",
        adapter_factory=lambda config, context: DiscordAdapter(config, context),
        check_fn=lambda: discord is not None,
        required_env=["TRPG_DISCORD__TOKEN"],
        install_hint="uv sync --extra discord",
    )
)
