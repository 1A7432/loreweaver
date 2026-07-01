"""Gateway stream and transport event carriers.

Trimmed from the Hermes gateway stream-event design (MIT, Copyright 2025 Nous
Research) for the platform-independent transport layer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from gateway.session import SessionSource


@dataclass(frozen=True)
class MessageChunk:
    text: str


@dataclass(frozen=True)
class MessageStop:
    final: bool = False


@dataclass(frozen=True)
class Commentary:
    text: str


@dataclass(frozen=True)
class ToolCallChunk:
    tool_name: str
    preview: str | None = None
    args: dict[str, Any] | None = None
    index: int = 0


@dataclass(frozen=True)
class ToolCallFinished:
    tool_name: str
    duration: float = 0.0
    ok: bool = True
    index: int = 0


@dataclass(frozen=True)
class GatewayNotice:
    kind: str
    text: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


StreamEvent = MessageChunk | MessageStop | Commentary | ToolCallChunk | ToolCallFinished | GatewayNotice


@dataclass
class InboundMessage:
    source: SessionSource
    text: str
    at_bot: bool = False
    raw: dict[str, Any] | None = None


@dataclass
class SendResult:
    ok: bool
    message_id: str | None = None
    error: str | None = None
