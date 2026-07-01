"""Headless CLI gateway adapter."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import TextIO

from agent.context import LocalFs
from gateway.base_adapter import BaseAdapter
from gateway.events import InboundMessage, SendResult
from gateway.session import SessionSource

CLI_CHAT_ID = "local"
CLI_USER_ID = "player"


class CliAdapter(BaseAdapter):
    platform = "cli"

    def __init__(
        self,
        config=None,
        on_message=None,
        *,
        cwd: str | Path | None = None,
        stdout: TextIO | None = None,
    ) -> None:
        super().__init__(config=config, on_message=on_message)
        self.stdout = stdout or sys.stdout
        self.fs = LocalFs(cwd or Path.cwd())
        self.sent: list[str] = []

    async def connect(self) -> bool:
        return True

    async def disconnect(self) -> None:
        return None

    async def send(self, source: SessionSource, content: str, *, reply_to: str | None = None) -> SendResult:
        self.sent.append(content)
        print(content, file=self.stdout, flush=True)
        return SendResult(ok=True)

    def supports_proactive(self, source: SessionSource) -> bool:
        return True

    def source(self, *, message_id: str | None = None) -> SessionSource:
        return SessionSource(
            platform=self.platform,
            chat_id=CLI_CHAT_ID,
            chat_type="dm",
            user_id=CLI_USER_ID,
            message_id=message_id,
        )

    def inbound(self, text: str, *, message_id: str | None = None) -> InboundMessage:
        return InboundMessage(source=self.source(message_id=message_id), text=text, at_bot=True)
