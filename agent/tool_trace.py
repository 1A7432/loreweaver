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
import time
from pathlib import Path
from typing import Any

from infra.file_permissions import ensure_private_directory, restrict_file

logger = logging.getLogger(__name__)

MAX_TRACE_FIELD_CHARS = 20_000

_TRACE_PATH: Path | None = None


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


def tool_trace_enabled() -> bool:
    return _TRACE_PATH is not None


def _capped(value: Any) -> Any:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= MAX_TRACE_FIELD_CHARS else text[:MAX_TRACE_FIELD_CHARS] + "…"


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
        with _TRACE_PATH.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
        restrict_file(_TRACE_PATH)
    except Exception:  # noqa: BLE001 — see module docstring
        logger.debug("tool trace write failed", exc_info=True)
