"""Per-turn/per-call context threaded through every AI-KP tool invocation.

`AgentCtx` carries the resolved identity (chat/user/platform/locale) and an
optional `FsAdapter` for sandbox-path <-> host-path translation. This module
is intentionally standalone — stdlib + typing only, no `core`/`infra`
imports — so the agent layer stays embeddable in any host without dragging
in the rest of the stack.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger(__name__)


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
    dice_payloads: list[dict[str, Any]] = field(default_factory=list, init=False, repr=False, compare=False)
    npc_lines: list[dict[str, str]] = field(default_factory=list, init=False, repr=False, compare=False)
    # Optional progress channel for a long turn: `(activity, round_index)`, where activity is
    # one of four COARSE categories. The gateway injects a publisher on the player-turn path;
    # everywhere else it stays None and the loop's calls are no-ops. Deliberately coarse — a
    # tool's name or arguments would leak keeper-side material into a room-wide frame.
    activity_sink: Callable[[str, int], Awaitable[None]] | None = field(
        default=None, repr=False, compare=False
    )

    async def report_activity(self, activity: str, round_index: int) -> None:
        """Announce coarse turn progress, if anyone is listening. Never raises."""
        if self.activity_sink is None:
            return
        try:
            await self.activity_sink(activity, round_index)
        except Exception:  # a cosmetic progress frame must never take a turn down
            logger.debug("activity sink failed", exc_info=True)

    def uid(self) -> str:
        """Defensive accessor for the resolved user id."""
        return self.user_id

    def emit_dice(self, payload: dict[str, Any]) -> None:
        """Buffer one public, already-resolved dice payload for this turn."""
        self.dice_payloads.append(dict(payload))

    def consume_dice(self) -> list[dict[str, Any]]:
        """Return and clear every buffered dice payload in emission order."""
        payloads = self.dice_payloads
        self.dice_payloads = []
        return payloads

    def emit_npc_line(self, name: str, text: str) -> None:
        """Buffer one PERFORMED NPC line for this turn — the words the table hears.

        The same structural channel dice use: the room's `npc` narrative frame is built
        from what a tool EMITTED here, never re-read off the tool's return string, so a
        hook's refusal, an unknown-NPC error or a gated-tool notice can never become an
        NPC's line (`gateway.turn._npc_events`)."""
        self.npc_lines.append({"name": str(name), "text": str(text)})

    def consume_npc_lines(self) -> list[dict[str, str]]:
        """Return and clear every buffered NPC line in emission order."""
        lines = self.npc_lines
        self.npc_lines = []
        return lines


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
    """CLI/tests `FsAdapter`: identity-ish mapping over a plain base directory.

    ``extra_bases`` names additional allowed roots — the deployment's data_dir in
    production, so installed-pack content (``data_dir/packs/...``) stays importable
    when data_dir lives OUTSIDE the process cwd (systemd WorkingDirectory vs
    TRPG_DATA_DIR). Confinement stays a strict allowlist of resolved roots."""

    def __init__(self, base_dir: str | Path, *, extra_bases: tuple[str | Path, ...] = ()) -> None:
        self._base_dir = Path(base_dir)
        self._extra_bases = tuple(Path(extra) for extra in extra_bases)

    def get_file(self, path: str) -> str:
        # Confine every resolution to ``base_dir`` (or a declared extra base).
        # Absolute paths and ``../`` traversal are resolved first, then required
        # to land inside an allowed root so an attacker-supplied logical path
        # cannot read arbitrary host files (net.session's SessionCore hands the
        # production Iroh transport this adapter, so this is the real read
        # boundary, not just a hint).
        candidate = Path(path)
        base = self._base_dir.resolve()
        resolved = candidate.resolve() if candidate.is_absolute() else (base / candidate).resolve()
        allowed = (base, *(extra.resolve() for extra in self._extra_bases))
        if not any(resolved.is_relative_to(root) for root in allowed):
            raise ValueError(f"path escapes the allowed base directory: {path}")  # i18n-exempt: folded into localized *-failed messages
        return str(resolved)

    @property
    def shared_path(self) -> Path:
        shared = self._base_dir / "shared"
        shared.mkdir(parents=True, exist_ok=True)
        return shared

    def forward_file(self, host_path: str | Path) -> str:
        return str(host_path)
