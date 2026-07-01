"""Per-turn/per-call context threaded through every AI-KP tool invocation.

`AgentCtx` carries the resolved identity (chat/user/platform/locale) and an
optional `FsAdapter` for sandbox-path <-> host-path translation. This module
is intentionally standalone — stdlib + typing only, no `core`/`infra`
imports — so the agent layer stays embeddable in any host without dragging
in the rest of the stack.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


@dataclass
class AgentCtx:
    """Everything an `@tool` method needs about the caller and the current turn.

    `user_id` is already resolved by the gateway (platform-specific identity
    lookup happens upstream); tools should call `uid()` rather than reaching
    for platform-specific attributes via `getattr` gymnastics.
    """

    chat_key: str
    user_id: str = ""
    platform: str = "cli"
    locale: str = "en"
    fs: FsAdapter | None = None
    extra: dict = field(default_factory=dict)

    def uid(self) -> str:
        """Defensive accessor for the resolved user id."""
        return self.user_id


class FsAdapter(Protocol):
    """Sandbox/logical path <-> host path translation, supplied by the gateway."""

    def get_file(self, path: str) -> str:
        """Resolve a sandbox/logical path to a host filesystem path."""
        ...

    @property
    def shared_path(self) -> Path:
        """Host directory for files shared between the agent and the host app."""
        ...

    def forward_file(self, host_path: str | Path) -> str:
        """Turn a host path into a deliverable reference back to the platform."""
        ...


class LocalFs:
    """CLI/tests `FsAdapter`: identity-ish mapping over a plain base directory."""

    def __init__(self, base_dir: str | Path) -> None:
        self._base_dir = Path(base_dir)

    def get_file(self, path: str) -> str:
        candidate = Path(path)
        if candidate.is_absolute():
            return str(candidate)
        return str((self._base_dir / candidate).resolve())

    @property
    def shared_path(self) -> Path:
        shared = self._base_dir / "shared"
        shared.mkdir(parents=True, exist_ok=True)
        return shared

    def forward_file(self, host_path: str | Path) -> str:
        return str(host_path)
