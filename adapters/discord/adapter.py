from __future__ import annotations

# Trimmed from hermes-agent Discord platform design (MIT, Copyright 2025 Nous Research).
import asyncio
import inspect
import re
from contextlib import suppress
from copy import deepcopy
from typing import Any

from gateway.base_adapter import BaseAdapter, MessageHandler
from gateway.events import InboundMessage, SendResult
from gateway.registry import PlatformEntry, platform_registry
from gateway.session import SessionSource

try:  # pragma: no cover - optional runtime dependency
    import discord
    from discord.ext import commands
except ImportError:  # pragma: no cover - exercised by import without extra
    discord = None
    commands = None


_INLINE_ROLL_RE = re.compile(r"\[\[([^\[\]]+)\]\]")
_SLASH_NAME_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
_COMMAND_PREFIXES = ("/", ".", "。")


class DiscordAdapter(BaseAdapter):
    platform = "discord"
    typed_command_prefix = "/"

    def __init__(
        self,
        config: Any = None,
        on_message: MessageHandler | None = None,
        *,
        http: Any = None,
        command_router: Any = None,
        slash_definitions_provider: Any = None,
    ) -> None:
        super().__init__(config=config, on_message=on_message)
        self.http = http
        self.command_router = command_router
        self._slash_definitions_provider = slash_definitions_provider
        self.token = str(_config_value(config, "token", "bot_token", "discord_token") or "")
        self.app_id = str(_config_value(config, "app_id", "application_id", "client_id") or "")
        self.bot_id = str(_config_value(config, "bot_id", "user_id") or self.app_id)
        self._client: Any = None
        self._bot_task: asyncio.Task | None = None
        self._channels: dict[str, Any] = {}

    async def connect(self) -> bool:
        if self._client is not None:
            return True
        if commands is None or discord is None or not self.token:
            return self.http is not None

        intents = discord.Intents.default()
        intents.message_content = True
        intents.dm_messages = True
        intents.guild_messages = True

        bot = commands.Bot(command_prefix=self.typed_command_prefix, intents=intents)
        adapter = self

        @bot.event
        async def on_message(message: Any) -> None:
            if str(_nested_get(getattr(bot, "user", None), "id", "")) == str(
                _nested_get(getattr(message, "author", None), "id", None)
            ):
                return
            await adapter.handle_message(message)

        self._client = bot
        self._bot_task = asyncio.create_task(bot.start(self.token))
        return True

    async def disconnect(self) -> None:
        if self._client is not None and hasattr(self._client, "close"):
            await _maybe_await(self._client.close())
        if self._bot_task is not None and not self._bot_task.done():
            self._bot_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._bot_task
        self._bot_task = None
        self._client = None

    async def send(self, source: SessionSource, content: str, *, reply_to: str | None = None) -> SendResult:
        try:
            channel = await self._get_channel(source.chat_id)
            if channel is not None and hasattr(channel, "send"):
                sent = await _send_to_channel(channel, content, reply_to)
                return SendResult(ok=True, message_id=_response_message_id(sent))

            if self.http is None:
                return SendResult(ok=False, error="discord.transport.missing")

            payload: dict[str, Any] = {"content": content}
            if reply_to:
                payload["message_reference"] = {"message_id": str(reply_to)}
            response = await self._call_http("post", f"/channels/{source.chat_id}/messages", payload)
            return SendResult(ok=True, message_id=_response_message_id(response))
        except Exception as exc:  # pragma: no cover - defensive transport boundary
            return SendResult(ok=False, error=str(exc))

    async def register_slash_commands(self, locale: str = "en") -> list[dict[str, Any]]:
        if not self.app_id:
            raise ValueError("discord.app_id.missing")
        if self.http is None:
            raise ValueError("discord.http.missing")

        payload = [_validated_slash_command(item) for item in self._slash_definitions(locale)]
        await self._call_http("put", f"/applications/{self.app_id}/commands", payload)
        return payload

    async def handle_message(self, message: Any) -> InboundMessage:
        inbound = self.to_inbound_message(message)
        await self.handle_inbound(inbound)
        return inbound

    def to_inbound_message(self, message: Any) -> InboundMessage:
        channel = _nested_get(message, "channel", None)
        channel_id = _string_id(
            _nested_get(message, "channel_id", None)
            or _nested_get(channel, "id", None)
            or _nested_get(_nested_get(message, "channel", {}), "id", None)
        )
        if not channel_id:
            raise ValueError("discord.message.channel_id.missing")

        if channel is not None and not isinstance(channel, dict):
            self._channels[channel_id] = channel

        author = _nested_get(message, "author", {}) or {}
        guild = _nested_get(message, "guild", None) or _nested_get(channel, "guild", None)
        guild_id = (
            _nested_get(message, "guild_id", None)
            or _nested_get(guild, "id", None)
            or _nested_get(channel, "guild_id", None)
        )
        chat_type = "group" if guild_id else "dm"
        text = str(_nested_get(message, "content", "") or "")
        inline_rolls = _INLINE_ROLL_RE.findall(text)
        source = SessionSource(
            platform=self.platform,
            chat_type=chat_type,
            chat_id=channel_id,
            user_id=_string_id(_nested_get(author, "id", None)),
            user_name=_author_name(author),
            message_id=_string_id(_nested_get(message, "id", None)),
            is_bot=bool(_nested_get(author, "bot", False)),
        )
        return InboundMessage(
            source=source,
            text=text,
            at_bot=self._mentions_self(message, text),
            raw={
                "inline_roll": bool(inline_rolls),
                "inline_rolls": inline_rolls,
                "prefix_command": text.lstrip().startswith(_COMMAND_PREFIXES),
            },
        )

    @staticmethod
    def contains_inline_roll(text: str) -> bool:
        return bool(_INLINE_ROLL_RE.search(text))

    def _slash_definitions(self, locale: str) -> list[dict[str, Any]]:
        provider = self._slash_definitions_provider
        if provider is None:
            provider = self.command_router
        if provider is None:
            return []
        if callable(provider) and not hasattr(provider, "slash_definitions"):
            return list(provider(locale))
        return list(provider.slash_definitions(locale))

    async def _get_channel(self, channel_id: str) -> Any:
        if channel_id in self._channels:
            return self._channels[channel_id]

        for transport in (self._client, self.http):
            if transport is None:
                continue
            channel = await _lookup_channel(transport, channel_id)
            if channel is not None:
                self._channels[channel_id] = channel
                return channel
        return None

    async def _call_http(self, method: str, path: str, payload: Any) -> Any:
        if self.http is None:
            raise ValueError("discord.http.missing")
        headers = self._auth_headers()
        method_name = method.lower()
        if hasattr(self.http, method_name):
            fn = getattr(self.http, method_name)
            return await _call_transport(fn, path, payload, headers)
        if hasattr(self.http, "request"):
            return await _call_transport(self.http.request, method.upper(), path, payload, headers)
        raise ValueError("discord.http.method.missing")

    def _auth_headers(self) -> dict[str, str]:
        if not self.token:
            return {}
        return {"Authorization": f"Bot {self.token}"}

    def _mentions_self(self, message: Any, text: str) -> bool:
        if not self.bot_id:
            return False
        mentions = _nested_get(message, "mentions", None) or []
        if any(_string_id(_nested_get(item, "id", None)) == self.bot_id for item in mentions):
            return True
        return f"<@{self.bot_id}>" in text or f"<@!{self.bot_id}>" in text


def _validated_slash_command(command: dict[str, Any]) -> dict[str, Any]:
    name = str(command.get("name", "")).casefold()
    if not _SLASH_NAME_RE.fullmatch(name):
        raise ValueError(f"discord.slash.invalid_name:{name}")
    description = str(command.get("description", "")).strip()
    if not description:
        raise ValueError(f"discord.slash.missing_description:{name}")
    payload: dict[str, Any] = {"name": name, "description": description}
    if "options" in command:
        payload["options"] = deepcopy(command["options"])
    return payload


async def _send_to_channel(channel: Any, content: str, reply_to: str | None) -> Any:
    kwargs: dict[str, Any] = {"content": content}
    if reply_to:
        kwargs["reference"] = reply_to
    try:
        return await _maybe_await(channel.send(**kwargs))
    except TypeError:
        return await _maybe_await(channel.send(content))


async def _lookup_channel(transport: Any, channel_id: str) -> Any:
    candidates: list[Any] = [channel_id]
    if channel_id.isdigit():
        candidates.append(int(channel_id))
    for method_name in ("get_channel", "fetch_channel"):
        if not hasattr(transport, method_name):
            continue
        method = getattr(transport, method_name)
        for candidate in candidates:
            channel = await _maybe_await(method(candidate))
            if channel is not None:
                return channel
    return None


async def _call_transport(fn: Any, *args: Any) -> Any:
    headers = args[-1]
    payload = args[-2]
    path_args = args[:-2]
    try:
        return await _maybe_await(fn(*path_args, json=payload, headers=headers))
    except TypeError:
        return await _maybe_await(fn(*path_args, payload))


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _config_value(config: Any, *names: str) -> Any:
    if config is None:
        return None
    for name in names:
        if isinstance(config, dict) and name in config:
            return config[name]
        if hasattr(config, name):
            return getattr(config, name)
    return None


def _nested_get(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _string_id(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


def _author_name(author: Any) -> str | None:
    for key in ("display_name", "global_name", "name", "username"):
        value = _nested_get(author, key, None)
        if value:
            return str(value)
    return None


def _response_message_id(response: Any) -> str | None:
    if response is None:
        return None
    if isinstance(response, dict):
        value = response.get("id") or _nested_get(response.get("data", {}), "id", None)
        return _string_id(value) or None
    value = _nested_get(response, "id", None)
    return _string_id(value) or None


platform_registry.register(
    PlatformEntry(
        name="discord",
        label="Discord",
        adapter_factory=lambda cfg: DiscordAdapter(cfg),
        check_fn=lambda: True,
    )
)
