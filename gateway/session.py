"""Gateway session source primitives.

Trimmed from the Hermes gateway session design (MIT, Copyright 2025 Nous
Research) for the platform-independent transport layer.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class SessionSource:
    platform: str
    chat_id: str
    chat_type: str = "group"
    user_id: str | None = None
    user_name: str | None = None
    thread_id: str | None = None
    message_id: str | None = None
    is_bot: bool = False

    def chat_key(self) -> str:
        key = f"{self.platform}:{self.chat_type}:{self.chat_id}"
        if self.thread_id:
            key = f"{key}:{self.thread_id}"
        return key

    def user_key(self) -> str:
        if self.user_id is None:
            return f"{self.platform}:anon"
        return f"{self.platform}:{self.user_id}"
