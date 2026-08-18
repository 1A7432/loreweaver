"""The interactive CLI's stdin reader must not block the event loop.

`python -m app --cli` ran `for raw in sys.stdin` directly inside the coroutine, so
between two keystrokes NO asyncio task moved. `.model login` starts a device-code
poll as a background task on a wall-clock deadline; it got one turn per typed line
and had timed out long before the operator finished authorizing. This pins the
property that broke: time passes for background tasks while stdin is quiet.
"""

from __future__ import annotations

import asyncio
import sys
import time

from app import _stdin_lines


class _SlowStdin:
    """Stdin that takes a beat before its first line, like a human at a prompt."""

    def __init__(self, lines: list[str], delay: float) -> None:
        self._lines = lines
        self._delay = delay
        self.unblocked_at: float | None = None

    def __iter__(self):
        time.sleep(self._delay)
        self.unblocked_at = time.monotonic()
        return iter(self._lines)


async def test_a_background_task_runs_while_stdin_is_quiet(monkeypatch) -> None:
    stdin = _SlowStdin(["look around\n"], delay=0.3)
    monkeypatch.setattr(sys, "stdin", stdin)

    ticked_at: dict[str, float] = {}

    async def _tick() -> None:
        await asyncio.sleep(0.05)
        ticked_at["at"] = time.monotonic()

    task = asyncio.create_task(_tick())
    lines = [line async for line in _stdin_lines()]
    await task

    assert lines == ["look around\n"]
    assert stdin.unblocked_at is not None
    # The whole point: the poll ticked DURING the wait, not after it.
    assert ticked_at["at"] < stdin.unblocked_at


async def test_the_reader_ends_on_eof_and_yields_every_line_in_order(monkeypatch) -> None:
    class _Stdin:
        def __iter__(self):
            return iter([".ra 侦查\n", "\n", "r 3d6\n"])

    monkeypatch.setattr(sys, "stdin", _Stdin())

    assert [line async for line in _stdin_lines()] == [".ra 侦查\n", "\n", "r 3d6\n"]
