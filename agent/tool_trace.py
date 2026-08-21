"""TRPG_DEBUG__TOOL_TRACE — one JSON line per AI-KP tool call, off unless configured.

`agent.loop._dispatch_one` is the seam every model-issued tool call passes through —
`Toolset` tools, a rulepack's subsystem tools, a hook's veto — and it holds the room
(`chat_key`) and the turn's phase, which is why the trace hangs off it rather than off
`Toolset.dispatch` (which sees only its own entries and no room). The 2026-08-18
《安土》 play-test harness monkey-patched the dispatcher from outside to find five root
causes (a wrong pool size, a same-turn write a hook could not see, tools that could only
fail); keeping the trace in-tree means the next investigation does not have to.

The file holds keeper-grade content by construction — tool ARGUMENTS and RESULTS carry
secret lore, module truths and private NPC knowledge — so it is off by default, lands
under the private `data_dir` unless an absolute path is given, and nothing turns it on
but an operator (`infra.config.DebugSettings`). Best-effort throughout: a debugging aid
never breaks a turn.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from infra import model_call_trace
from infra.file_permissions import ensure_private_directory, restrict_file

logger = logging.getLogger(__name__)

MAX_TRACE_FIELD_CHARS = 20_000

_TRACE_PATH: Path | None = None


def _open_private(path: str, flags: int) -> int:
    """`opener=` hook for `open()`: create (or reopen) the trace file at `0600`.

    Default umask leaves a freshly CREATED file at `0644` until `restrict_file`
    chmods it after the write returns — a window in which the first keeper-grade
    line sat in a world-readable file. Passing an explicit mode to `os.open`
    closes that window from the very first byte; `restrict_file` below still
    handles a pre-existing file whose mode predates this fix.
    """
    return os.open(path, flags, 0o600)


def enable_tool_trace(path: str | Path | None) -> None:
    """Point the trace at `path` (absolute), or disable it with `None`/empty.

    The directory is created private (`0700`, like every other secret-bearing writer in
    the repo — keystore, media store, backups) and the file is held at `0600` after each
    write: under `data_dir` that is defense in depth, on an operator's absolute path it is
    the only thing keeping keeper-grade content off a shared box's world-readable files.
    An existing, user-chosen parent keeps its own policy (`tighten_existing=False`)."""
    global _TRACE_PATH
    _TRACE_PATH = Path(path) if path else None
    if _TRACE_PATH is not None:
        try:
            ensure_private_directory(_TRACE_PATH.parent, tighten_existing=False)
        except OSError:
            logger.warning("tool trace directory is unwritable; tracing off: %s", _TRACE_PATH, exc_info=True)
            _TRACE_PATH = None
    # The per-model-call rows ride the same file (`tool: "model_call"`), so one reader
    # serves tool calls, lane decisions and the calls that paid for them. Installed and
    # removed together with the path: no trace, no sink, no cost.
    model_call_trace.set_sink(_model_call_sink if _TRACE_PATH is not None else None)


def _model_call_sink(payload: dict[str, Any]) -> None:
    """`infra.model_call_trace` → one probe row. `chat_key` becomes the row's room column."""
    row = dict(payload)
    chat_key = str(row.pop("chat_key", "") or "")
    trace_event("model_call", row, chat_key=chat_key)


def tool_trace_enabled() -> bool:
    return _TRACE_PATH is not None


def _capped(value: Any) -> Any:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= MAX_TRACE_FIELD_CHARS else text[:MAX_TRACE_FIELD_CHARS] + "…"


def trace_event(kind: str, payload: dict[str, Any], *, chat_key: str = "") -> None:
    """Append one NON-tool decision to the same trace, under `tool: <kind>`.

    The tool seam only sees what the model asked for. Two lanes decide things that never
    become a tool call — the Scribe's per-turn 场记 verdict and the Stage Director's
    performance decision — and the 2026-08-19 run-2 could not explain why the whole
    session produced zero images, because neither lane left a trace. One reader, one
    file, one shape: a consumer filters on `tool` exactly as it does for a real call.

    Zero cost when the trace is off (the guard is the first statement) and best-effort
    when it is on, like every other writer here.
    """
    if _TRACE_PATH is None:
        return
    try:
        line = json.dumps(
            {
                "ts": round(time.time(), 3),
                "room": chat_key,
                "tool": str(kind),
                "event": _capped(payload or {}),
            },
            ensure_ascii=False,
        )
        with open(_TRACE_PATH, "a", encoding="utf-8", opener=_open_private) as handle:
            handle.write(line + "\n")
        restrict_file(_TRACE_PATH)
    except Exception:  # noqa: BLE001 — see module docstring
        logger.debug("tool trace event write failed", exc_info=True)


def record_tool_call(
    *,
    chat_key: str,
    phase: str | None,
    name: str,
    arguments: Any,
    result: str,
    keeper_only: bool | None,
    started: float,
) -> None:
    """Append one call to the trace (`started` is a `time.perf_counter()` reading)."""
    if _TRACE_PATH is None:
        return
    try:
        line = json.dumps(
            {
                "ts": round(time.time(), 3),
                "ms": round((time.perf_counter() - started) * 1000, 1),
                "room": chat_key,
                "tool": name,
                "phase": phase or "",
                "keeper_only": keeper_only,
                "args": _capped(arguments or {}),
                "result": _capped(result),
            },
            ensure_ascii=False,
        )
        with open(_TRACE_PATH, "a", encoding="utf-8", opener=_open_private) as handle:
            handle.write(line + "\n")
        restrict_file(_TRACE_PATH)
    except Exception:  # noqa: BLE001 — see module docstring
        logger.debug("tool trace write failed", exc_info=True)
