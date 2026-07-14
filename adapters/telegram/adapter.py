"""Telegram platform adapter."""

from __future__ import annotations

import inspect
from typing import Any

from gateway.base_adapter import BaseAdapter, MessageHandler
from gateway.chat import ChatCapabilities, ChatMessage
from gateway.events import InboundMessage, SendResult
from gateway.registry import PlatformEntry, platform_registry
from gateway.session import SessionSource
from infra.i18n import t as localize

try:  # MIT-trimmed from hermes-agent Telegram adapter, Copyright 2025 Nous Research.
    import telegram
except ImportError:  # pragma: no cover - exercised implicitly by importability without SDK.
    telegram = None  # type: ignore[assignment]

TELEGRAM_AVAILABLE = telegram is not None

_GROUP_CHAT_TYPES = {"group", "supergroup"}


class TelegramAdapter(BaseAdapter):
    platform = "telegram"
    capabilities = ChatCapabilities(max_text_chars=4096)

    def __init__(
        self,
        config: Any = None,
        transport: Any | None = None,
        command_router: Any | None = None,
        on_message: MessageHandler | None = None,
    ) -> None:
        super().__init__(config=config, on_message=on_message)
        self.token = _config_value(config, "token") or _config_value(config, "bot_token") or ""
        self.locale = _config_value(config, "locale") or None
        self._transport = transport
        self.command_router = command_router

    async def connect(self) -> bool:
        if self._transport is not None:
            return True
        if not TELEGRAM_AVAILABLE or not self.token:
            return False

        self._transport = telegram.Bot(token=self.token)
        return True

    async def disconnect(self) -> None:
        transport = self._transport
        if transport is None:
            return

        for name in ("aclose", "close", "shutdown"):
            method = getattr(transport, name, None)
            if method is not None:
                await _maybe_await(method())
                return

    def parse_update(self, update: dict[str, Any]) -> InboundMessage | None:
        message = _extract_message(update)
        if message is None:
            return None

        text = message.get("text")
        if not isinstance(text, str):
            return None

        chat = message.get("chat") or {}
        sender = message.get("from") or {}
        chat_id = _string_id(chat.get("id"))
        if chat_id is None:
            return None

        source = SessionSource(
            platform=self.platform,
            chat_type="group" if str(chat.get("type", "")).casefold() in _GROUP_CHAT_TYPES else "dm",
            chat_id=chat_id,
            user_id=_string_id(sender.get("id")),
            user_name=_user_name(sender),
            message_id=_string_id(message.get("message_id")),
        )
        return InboundMessage(source=source, text=text, raw=update)

    async def handle_update(self, update: dict[str, Any]) -> InboundMessage | None:
        inbound = self.parse_update(update)
        if inbound is None:
            return None

        await self.handle_inbound(inbound)
        return inbound

    async def _send_message(
        self,
        source: SessionSource,
        message: ChatMessage,
        *,
        reply_to: str | None,
        session_key: str | None,
    ) -> SendResult:
        del session_key
        params: dict[str, Any] = {
            "chat_id": source.chat_id,
            "text": message.text,
        }
        if reply_to is not None:
            params["reply_to_message_id"] = reply_to

        try:
            response = await self._call_transport("sendMessage", "send_message", **params)
        except RuntimeError as exc:
            return SendResult(ok=False, error=str(exc))

        return SendResult(ok=True, message_id=_message_id_from_response(response))

    async def register_commands(self, locale: str = "en") -> list[dict[str, str]]:
        definitions = [] if self.command_router is None else self.command_router.slash_definitions(locale)
        payload = [
            {
                "command": str(item["name"]).casefold(),
                "description": str(item["description"]),
            }
            for item in definitions
            if item.get("name") and item.get("description")
        ]
        await self._call_set_commands(payload)
        return payload

    async def _call_transport(self, bot_api_name: str, sdk_name: str, **kwargs: Any) -> Any:
        if self._transport is None:
            raise RuntimeError(localize("telegram.error.missing_transport", locale=self.locale))

        method = getattr(self._transport, bot_api_name, None) or getattr(self._transport, sdk_name, None)
        if method is None:
            raise RuntimeError(localize("telegram.error.missing_transport", locale=self.locale))

        return await _maybe_await(method(**kwargs))

    async def _call_set_commands(self, payload: list[dict[str, str]]) -> Any:
        if self._transport is None:
            raise RuntimeError(localize("telegram.error.missing_transport", locale=self.locale))

        method = getattr(self._transport, "setMyCommands", None) or getattr(self._transport, "set_my_commands", None)
        if method is None:
            raise RuntimeError(localize("telegram.error.missing_transport", locale=self.locale))

        if _accepts_keyword(method, "commands"):
            return await _maybe_await(method(commands=payload))
        return await _maybe_await(method(payload))


def register() -> None:
    platform_registry.register(
        PlatformEntry(
            name="telegram",
            label="Telegram",
            adapter_factory=lambda cfg, context: TelegramAdapter(
                cfg,
                command_router=context.command_router,
            ),
            check_fn=lambda: True,
        )
    )


def _extract_message(update: dict[str, Any]) -> dict[str, Any] | None:
    for key in ("message", "edited_message", "channel_post"):
        message = update.get(key)
        if isinstance(message, dict):
            return message
    return None


def _config_value(config: Any, key: str) -> Any:
    if isinstance(config, dict):
        return config.get(key)
    return getattr(config, key, None)


def _string_id(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _user_name(sender: dict[str, Any]) -> str | None:
    username = sender.get("username")
    if isinstance(username, str) and username:
        return username

    first_name = sender.get("first_name")
    last_name = sender.get("last_name")
    names = [item for item in (first_name, last_name) if isinstance(item, str) and item]
    return " ".join(names) or None


def _message_id_from_response(response: Any) -> str | None:
    if isinstance(response, dict):
        value = response.get("message_id")
    else:
        value = getattr(response, "message_id", None)
    return None if value is None else str(value)


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _accepts_keyword(method: Any, name: str) -> bool:
    try:
        parameters = inspect.signature(method).parameters.values()
    except (TypeError, ValueError):
        return True

    for parameter in parameters:
        if parameter.kind is inspect.Parameter.VAR_KEYWORD:
            return True
        if parameter.name == name and parameter.kind is not inspect.Parameter.POSITIONAL_ONLY:
            return True
    return False


register()
