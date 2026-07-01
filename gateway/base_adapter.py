"""Base adapter contract for gateway transports.

Trimmed from the Hermes gateway base adapter design (MIT, Copyright 2025 Nous
Research) for the platform-independent transport layer.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from typing import Any

from gateway.events import InboundMessage, SendResult
from gateway.session import SessionSource

MessageHandler = Callable[[InboundMessage], Awaitable[str | None]]


class BaseAdapter(ABC):
    platform: str = "base"
    typed_command_prefix: str = "/"

    def __init__(self, config: Any = None, on_message: MessageHandler | None = None) -> None:
        self.config = config
        self._message_handler = on_message

    @abstractmethod
    async def connect(self) -> bool:
        raise NotImplementedError

    @abstractmethod
    async def disconnect(self) -> None:
        raise NotImplementedError

    @abstractmethod
    async def send(self, source: SessionSource, content: str, *, reply_to: str | None = None) -> SendResult:
        raise NotImplementedError

    def set_message_handler(self, handler: MessageHandler) -> None:
        self._message_handler = handler

    def supports_proactive(self, source: SessionSource) -> bool:
        return True

    async def handle_inbound(self, msg: InboundMessage) -> None:
        if self._message_handler is None:
            return

        reply = await self._message_handler(msg)
        if isinstance(reply, str) and reply:
            await self.send(msg.source, reply, reply_to=msg.source.message_id)
