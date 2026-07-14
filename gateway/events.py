"""Gateway stream and transport event carriers.

Trimmed from the Hermes gateway stream-event design (MIT, Copyright 2025 Nous
Research) for the platform-independent transport layer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from gateway.chat import ChatAttachment, ChatInteraction
from gateway.session import SessionSource


@dataclass
class InboundMessage:
    source: SessionSource
    text: str
    at_bot: bool = False
    attachments: list[ChatAttachment] = field(default_factory=list)
    interaction: ChatInteraction | None = None
    quoted_text: str = ""
    raw: dict[str, Any] | None = None


@dataclass
class SendResult:
    ok: bool
    message_id: str | None = None
    error: str | None = None
