"""The interactive CLI's stdin reader must not block the event loop.

`python -m app --cli` ran `for raw in sys.stdin` directly inside the coroutine, so
between two keystrokes NO asyncio task moved. `.model login` starts a device-code
poll as a background task on a wall-clock deadline; it got one turn per typed line
and had timed out long before the operator finished authorizing. This pins the
property that broke: time passes for background tasks while stdin is quiet.

Moving the read into a thread must not change what the CLI does with input, so the
tests below also pin the two properties a naive hand-off loses: a read error is not
EOF, and a piped file is not slurped into memory ahead of the consumer.
"""

from __future__ import annotations

import asyncio
import sys
import time

import pytest

from app import _STDIN_QUEUE_MAX, _stdin_lines


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


class _FailingStdin:
    """A piped transcript with one undecodable byte partway through it."""

    error = UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")

    def __iter__(self):
        yield ".ra 侦查\n"
        yield "r 3d6\n"
        raise self.error


async def test_a_mid_stream_read_error_is_raised_not_mistaken_for_eof(monkeypatch) -> None:
    """`except Exception: pass` + EOF made a bad byte look like a clean end of input:
    the remaining lines silently never ran and `--cli` exited 0. The lines read
    BEFORE the failure still arrive, in order, and then the error surfaces."""
    monkeypatch.setattr(sys, "stdin", _FailingStdin())

    lines = _stdin_lines()
    assert await anext(lines) == ".ra 侦查\n"
    assert await anext(lines) == "r 3d6\n"
    with pytest.raises(UnicodeDecodeError):
        await anext(lines)


async def test_a_closed_pipe_is_still_a_clean_end_of_input(monkeypatch) -> None:
    """The one error class that IS end of input: the writer went away."""

    class _ClosedPipeStdin:
        def __iter__(self):
            yield "look around\n"
            raise BrokenPipeError(32, "Broken pipe")

    monkeypatch.setattr(sys, "stdin", _ClosedPipeStdin())

    assert [line async for line in _stdin_lines()] == ["look around\n"]


class _CountingStdin:
    """Counts how far ahead of the consumer the reader thread has run."""

    def __init__(self, count: int) -> None:
        self.count = count
        self.pulled = 0

    def __iter__(self):
        for index in range(self.count):
            self.pulled += 1
            yield f"line {index}\n"


async def test_a_long_piped_file_is_read_lazily_not_slurped(monkeypatch) -> None:
    """An unbounded queue read a 200k-line transcript into memory ahead of the
    per-line consumer. The bounded queue blocks the reader instead: at most one
    queue's worth of lines (plus the one taken and the one blocked on `put`) can
    be ahead of the consumer, no matter how long the file is."""
    stdin = _CountingStdin(_STDIN_QUEUE_MAX * 8)
    monkeypatch.setattr(sys, "stdin", stdin)

    lines = _stdin_lines()
    assert await anext(lines) == "line 0\n"
    # Give the reader every chance to run away with the file before measuring.
    for _ in range(50):
        await asyncio.sleep(0)
    await asyncio.sleep(0.05)
    assert stdin.pulled <= _STDIN_QUEUE_MAX + 2, stdin.pulled

    rest = [line async for line in lines]
    assert ["line 0\n", *rest] == [f"line {index}\n" for index in range(stdin.count)]
    assert stdin.pulled == stdin.count
