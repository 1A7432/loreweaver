"""Structured messages shared by chat adapters."""

from __future__ import annotations

from dataclasses import dataclass, field, replace


@dataclass(frozen=True)
class ChatCapabilities:
    attachments: bool = False
    typing: bool = False
    max_text_chars: int = 2000


@dataclass(frozen=True)
class ChatAttachment:
    id: str = ""
    name: str = "attachment"
    mime: str = "application/octet-stream"
    size: int = 0
    url: str | None = None
    data: bytes | None = None


@dataclass(frozen=True)
class ChatComponent:
    """A native control whose value is always an existing router command."""

    id: str
    command: str = ""
    label: str = ""
    style: str = "secondary"


@dataclass(frozen=True)
class ChatField:
    name: str
    value: str
    inline: bool = False


@dataclass(frozen=True)
class ChatEmbed:
    title: str = ""
    description: str = ""
    fields: tuple[ChatField, ...] = ()
    footer: str = ""
    color: int | None = None


@dataclass
class ChatMessage:
    text: str = ""
    markdown: bool = False
    attachments: list[ChatAttachment] = field(default_factory=list)
    components: list[ChatComponent] = field(default_factory=list)
    embeds: list[ChatEmbed] = field(default_factory=list)
    private: bool = False
    coalesce_key: str | None = None


@dataclass(frozen=True)
class ChatInteraction:
    id: str
    locale: str = ""
    private: bool = False


def split_chat_message(message: ChatMessage, limit: int) -> list[ChatMessage]:
    """Split text without truncating it; rich content is attached to the last part."""
    balance_fences = message.markdown and "```" in message.text and limit >= 16
    text_limit = limit - 8 if balance_fences else limit
    chunks = split_text(message.text, text_limit)
    if balance_fences and len(chunks) > 1:
        chunks = _balance_code_fences(chunks)
    if len(chunks) <= 1:
        return [message]

    parts: list[ChatMessage] = []
    last = len(chunks) - 1
    for index, chunk in enumerate(chunks):
        parts.append(
            replace(
                message,
                text=chunk,
                attachments=list(message.attachments) if index == last else [],
                components=list(message.components) if index == last else [],
                embeds=list(message.embeds) if index == last else [],
            )
        )
    return parts


def _balance_code_fences(chunks: list[str]) -> list[str]:
    balanced: list[str] = []
    fence_open = False
    last = len(chunks) - 1
    for index, chunk in enumerate(chunks):
        prefix = "```\n" if fence_open else ""
        fence_open = fence_open != (chunk.count("```") % 2 == 1)
        suffix = "\n```" if fence_open and index != last else ""
        balanced.append(f"{prefix}{chunk}{suffix}")
    return balanced


def split_text(text: str, limit: int) -> list[str]:
    """Paragraph-first splitter used by every platform adapter."""
    if not text:
        return [""]
    if limit < 1:
        raise ValueError("max_text_chars must be positive")  # i18n-exempt: internal programmer error
    if len(text) <= limit:
        return [text]

    chunks: list[str] = []
    remaining = text
    while len(remaining) > limit:
        window = remaining[: limit + 1]
        cut = window.rfind("\n\n", 0, limit)
        separator = 2
        if cut < 1:
            cut = window.rfind("\n", 0, limit)
            separator = 1
        if cut < 1:
            cut = window.rfind(" ", 0, limit)
            separator = 1
        if cut < 1:
            cut = limit
            separator = 0
        else:
            cut += separator
        chunks.append(remaining[:cut])
        remaining = remaining[cut:]
    if remaining:
        chunks.append(remaining)
    return chunks
