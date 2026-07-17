"""Base adapter contract for gateway transports.

Trimmed from the Hermes gateway base adapter design (MIT, Copyright 2025 Nous
Research) for the platform-independent transport layer.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import TYPE_CHECKING, Any

from gateway.chat import ChatAttachment, ChatCapabilities, ChatMessage, split_chat_message
from gateway.events import InboundMessage, SendResult
from gateway.session import SessionSource

if TYPE_CHECKING:
    from gateway.hub import Event
    from infra.media_store import MediaStore

MessageHandler = Callable[[InboundMessage], Awaitable[ChatMessage | None]]
logger = logging.getLogger(__name__)


class BaseAdapter(ABC):
    platform: str = "base"
    capabilities = ChatCapabilities()

    def __init__(self, config: Any = None, on_message: MessageHandler | None = None) -> None:
        self.config = config
        self._message_handler = on_message
        self._handler_manages_typing = False

    @abstractmethod
    async def connect(self) -> bool:
        raise NotImplementedError

    @abstractmethod
    async def disconnect(self) -> None:
        raise NotImplementedError

    async def send_message(
        self,
        source: SessionSource,
        message: ChatMessage,
        *,
        reply_to: str | None = None,
        session_key: str | None = None,
    ) -> SendResult:
        result = SendResult(ok=True)
        for part in split_chat_message(message, self.capabilities.max_text_chars):
            result = await self._send_message(source, part, reply_to=reply_to, session_key=session_key)
            if not result.ok:
                return result
        return result

    @abstractmethod
    async def _send_message(
        self,
        source: SessionSource,
        message: ChatMessage,
        *,
        reply_to: str | None,
        session_key: str | None,
    ) -> SendResult:
        raise NotImplementedError

    async def edit_message(
        self, source: SessionSource, message_id: str, message: ChatMessage
    ) -> SendResult:
        return SendResult(ok=False, error=f"{self.platform}.message_edit.unsupported")

    async def set_typing(self, source: SessionSource, active: bool) -> None:
        del source, active

    async def fetch_attachment(
        self,
        attachment: ChatAttachment,
        *,
        max_bytes: int | None = None,
    ) -> bytes:
        if attachment.data is None:
            raise FileNotFoundError(attachment.id or attachment.name)
        if max_bytes is not None and len(attachment.data) > max_bytes:
            raise ValueError(f"{self.platform}.attachment.too_large")
        return attachment.data

    async def deliver_event(
        self,
        source: SessionSource,
        session_key: str,
        event: Event,
        *,
        locale: str,
        media_store: MediaStore | None = None,
    ) -> SendResult | None:
        """Render a room event and deliver it using this adapter's native codec."""
        from gateway.render_chat import render_chat_event
        from infra.i18n import get_i18n

        if event.kind == "panel" and source.chat_type.casefold() not in {
            "dm",
            "direct",
            "private",
            "c2c",
        }:
            event = replace(
                event,
                data={key: value for key, value in event.data.items() if key != "character"},
            )
        try:
            message = render_chat_event(event, get_i18n(locale))
        except Exception:
            logger.warning(
                "adapter.render_failed platform=%s event=%s",
                self.platform,
                event.kind,
                exc_info=True,
            )
            return None
        if message is None:
            return None
        if event.kind in {"media", "audio"} and self.capabilities.attachments and media_store is not None:
            sha256 = str(event.data.get("hash") or "")
            if sha256:
                try:
                    record, data = await media_store.read_bytes(session_key, sha256)
                except Exception:
                    logger.warning(
                        "adapter.media_unavailable platform=%s hash=%s",
                        self.platform,
                        sha256,
                    )
                else:
                    message.attachments.append(
                        ChatAttachment(
                            id=record.hash,
                            name=record.name,
                            mime=record.mime,
                            size=record.size,
                            data=data,
                        )
                    )
        message.private = message.private or event.private
        return await self.send_message(source, message, session_key=session_key)

    def set_message_handler(
        self,
        handler: MessageHandler,
        *,
        manages_typing: bool = False,
    ) -> None:
        self._message_handler = handler
        self._handler_manages_typing = manages_typing

    def supports_private_reply(self, source: SessionSource) -> bool:
        return source.chat_type.casefold() in {"dm", "direct", "private", "c2c"}

    async def handle_inbound(self, msg: InboundMessage) -> None:
        if self._message_handler is None:
            return

        manage_typing = self.capabilities.typing and not self._handler_manages_typing
        if manage_typing:
            await self._set_typing_safely(msg.source, True)
        try:
            reply = await self._message_handler(msg)
        finally:
            if manage_typing:
                await self._set_typing_safely(msg.source, False)
        if reply is not None:
            await self.send_message(msg.source, reply, reply_to=msg.source.message_id)

    async def _set_typing_safely(self, source: SessionSource, active: bool) -> None:
        try:
            await self.set_typing(source, active)
        except Exception:
            logger.warning("adapter.typing_failed platform=%s", self.platform)
