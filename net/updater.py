"""Keeper-triggered in-place server self-update (see `infra.config.TuiSettings.update_command`).

The server runs the OPERATOR-configured command — never anything a client supplies — and
then re-execs its own interpreter so the freshly pulled code is loaded. Re-exec keeps the
same PID (so the Iroh node id / shareable ticket is unchanged) and needs no supervisor
restart, working the same whether the process is `python -m app --serve` or a frozen binary.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# `git pull` + a dependency sync can be slow; bound it so a hung update can't wedge the room.
_UPDATE_TIMEOUT_SECONDS = 600
_OUTPUT_TAIL_CHARS = 2000
# Give the "restarting" reply time to flush over the socket before we replace the image.
_REEXEC_DELAY_SECONDS = 2.0


@dataclass
class UpdateResult:
    ok: bool
    output: str


async def run_update_command(command: str) -> UpdateResult:
    """Run the configured update command; return ``ok`` plus the tail of its combined output."""
    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=_UPDATE_TIMEOUT_SECONDS)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return UpdateResult(False, "update command timed out")  # i18n-exempt: diagnostic tail
    text = (stdout or b"").decode("utf-8", "replace")
    return UpdateResult(proc.returncode == 0, text[-_OUTPUT_TAIL_CHARS:])


def _reexec_argv() -> list[str]:
    """The exact argv to re-launch this server with (interpreter + original flags)."""
    orig = list(getattr(sys, "orig_argv", None) or [])
    tail = orig[1:] if orig else list(sys.argv)
    return [sys.executable, *tail]


def schedule_reexec() -> None:
    """Replace this process image with a fresh interpreter after a short delay.

    Scheduled on the event loop so the just-sent 'restarting' reply flushes first. ``os.execv``
    reloads every module from the (now-updated) files and preserves the PID, so no supervisor
    restart is needed. If exec itself fails, exit non-zero so a ``Restart=on-failure`` supervisor
    still brings the updated code up.
    """
    argv = _reexec_argv()

    def _do() -> None:
        try:
            os.execv(argv[0], argv)
        except OSError:
            logger.exception("server self-update re-exec failed; exiting for supervisor restart")
            os._exit(1)

    try:
        loop = asyncio.get_running_loop()
        loop.call_later(_REEXEC_DELAY_SECONDS, _do)
    except RuntimeError:  # no running loop (shouldn't happen from an admin handler)
        _do()
