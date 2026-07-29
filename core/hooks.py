"""Event hooks — sandboxed per-room JavaScript handlers on the turn lifecycle (Layer C).

This is the deliberate opening of the code-plugin layer, on the same trust stance as full EJS
(``core.ejs_full``): self-hosted, the operator's skills and cards, the operator's box — author
freedom first, with crash-protection guardrails rather than capability gates. A skill bundle may
ship a ``hooks.js`` next to its ``SKILL.md`` (active while the skill is enabled for the room),
and an imported card may carry ``extensions.loreweaver_hooks``; both register handlers with:

    on("turn_start",         (event) => { ... })   // event.user_message, event.actor
    on("reply_ready",        (event) => { ... })   // event.reply
    on("dice_rolled",        (event) => { ... })   // event.rolls: [{tool, result}]
    on("variables_changed",  (event) => { ... })   // event.writes: [{path, value}]

Inside a handler the full template bridge is available (``getvar``/``setvar``/``incvar``/
``variables``/``stat_data``, lodash as ``_``) plus the effect emitters ``inject(text)``
(turn_start: adds a section to THIS turn's keeper prompt), ``narrate(text)`` (appends to the
player-visible reply), ``rewriteReply(text)`` (replaces it), and ``log(text)``.

Architecture is the proven zero-callable one: snapshots are serialized INTO the QuickJS sandbox
(which is why the hard per-eval time limit can stay armed — the binding cannot combine time
limits with Python callables), handlers run against them, and every effect comes back OUT as a
buffer that deterministic engine code validates, caps, and applies (``agent.hook_runtime``).
Iron rule #1 holds: hooks REQUEST effects; real code applies them. A broken handler, a hostile
infinite loop, or a missing `ejs` extra degrades to "hooks inert (logged)", never to a broken
turn. Snapshots are taken once per turn — a hook sees its OWN earlier writes (the bridge updates
the in-sandbox view) but not mid-turn tool writes; that staleness is documented, not hidden.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from core.ejs_full import _PRELUDE as _BRIDGE_PRELUDE
from core.ejs_full import (
    _VENDOR_DIR,
    MAX_PENDING_JOBS,
    MAX_TEMPLATE_WRITES,
    MEMORY_LIMIT_BYTES,
    TIME_LIMIT_SECONDS,
    quickjs_available,
)

logger = logging.getLogger(__name__)

EVENTS = ("turn_start", "reply_ready", "dice_rolled", "variables_changed")

MAX_HOOK_SOURCE_CHARS = 40_000
MAX_SCRIPTS = 16
MAX_INJECTIONS = 8
MAX_INJECT_CHARS = 4_000
MAX_NARRATIONS = 8
MAX_NARRATION_CHARS = 2_000

_HOOK_PRELUDE = r"""
globalThis.__handlers = {};
globalThis.__injections = [];
globalThis.__narrations = [];
globalThis.__rewrite = null;

function on(eventType, handler) {
    if (typeof handler !== "function") return;
    var key = String(eventType);
    (globalThis.__handlers[key] = globalThis.__handlers[key] || []).push(handler);
}
function inject(text) { globalThis.__injections.push(String(text)); }
function narrate(text) { globalThis.__narrations.push(String(text)); }
function rewriteReply(text) { globalThis.__rewrite = String(text); }
function log(text) { globalThis.__warnings.push("log: " + String(text)); }

function __dispatch(eventType, payload) {
    var handlers = globalThis.__handlers[String(eventType)] || [];
    for (var i = 0; i < handlers.length; i++) {
        try {
            var result = handlers[i](payload);
            if (result && typeof result.then === "function") {
                result.then(function () {}, function (e) {
                    globalThis.__warnings.push(
                        "async handler error (" + eventType + "): " + String((e && e.message) || e));
                });
            }
        } catch (e) {
            globalThis.__warnings.push(
                "handler error (" + eventType + "): " + String((e && e.message) || e));
        }
    }
    return handlers.length;
}
"""


@dataclass
class HookScript:
    """One registered script: `source_id` names where it came from (skill id / card name)."""

    source_id: str
    code: str


@dataclass
class HookOutcome:
    """Everything one event dispatch asked for — validated and applied by the caller."""

    handlers: int = 0
    writes: list[tuple[str, Any]] = field(default_factory=list)
    injections: list[str] = field(default_factory=list)
    narrations: list[str] = field(default_factory=list)
    rewrite: str | None = None
    warnings: list[str] = field(default_factory=list)


class HookEngine:
    """One QuickJS interpreter holding a room's registered handlers for one turn.

    Build via `create_hook_engine` (None when quickjs is unavailable or nothing registered).
    `fire()` never raises — a broken dispatch returns an empty outcome with warnings.
    """

    def __init__(self, scripts: list[HookScript], *, flat_variables: dict[str, Any], tree: dict[str, Any]) -> None:
        import quickjs

        self._context = quickjs.Context()
        self._context.set_memory_limit(MEMORY_LIMIT_BYTES)
        self._context.eval((_VENDOR_DIR / "lodash.min.js").read_text(encoding="utf-8"))
        self._context.eval(_BRIDGE_PRELUDE)
        self._context.eval(_HOOK_PRELUDE)
        for name, payload in (("__flat", flat_variables), ("__tree", tree), ("__wi", {}), ("__char", {}), ("__chat", {})):
            self._context.eval(f"globalThis.{name} = {json.dumps(payload, ensure_ascii=False)};")
        # Registration scripts are UNTRUSTED user code: the time limit arms BEFORE they run, so a
        # top-level infinite loop in a hooks.js times out instead of hanging the server.
        self._context.set_time_limit(TIME_LIMIT_SECONDS)
        self.load_warnings: list[str] = []
        for script in scripts[:MAX_SCRIPTS]:
            if len(script.code) > MAX_HOOK_SOURCE_CHARS:
                self.load_warnings.append(f"{script.source_id}: script too large, skipped")
                continue
            try:
                self._context.eval(script.code)
            except Exception as exc:
                self.load_warnings.append(f"{script.source_id}: {exc}")

    def fire(self, event_type: str, payload: dict[str, Any]) -> HookOutcome:
        """Dispatch one event to every registered handler and collect the effect buffers."""
        outcome = HookOutcome()
        if event_type not in EVENTS:
            outcome.warnings.append(f"unknown event {event_type!r}")
            return outcome
        try:
            self._context.eval(
                "globalThis.__writes = []; globalThis.__injections = [];"  # i18n-exempt: JavaScript source, not UI text
                " globalThis.__narrations = []; globalThis.__rewrite = null;"
            )
            outcome.handlers = int(
                self._context.eval(
                    f"__dispatch({json.dumps(event_type)}, {json.dumps(payload, ensure_ascii=False)})"
                )
            )
            for _ in range(MAX_PENDING_JOBS):
                if not self._context.execute_pending_job():
                    break
            outcome.writes = self._read_writes()
            outcome.injections = self._read_texts("__injections", MAX_INJECTIONS, MAX_INJECT_CHARS)
            outcome.narrations = self._read_texts("__narrations", MAX_NARRATIONS, MAX_NARRATION_CHARS)
            rewrite = self._read_json("globalThis.__rewrite")
            outcome.rewrite = rewrite[:MAX_INJECT_CHARS] if isinstance(rewrite, str) else None
            warnings = self._read_json("globalThis.__warnings") or []
            self._context.eval("globalThis.__warnings = [];")
            outcome.warnings = [str(warning) for warning in warnings]
        except Exception as exc:  # time/memory limit, JS engine error — hooks never break a turn
            outcome.warnings.append(f"dispatch failed: {exc}")
        return outcome

    def _read_writes(self) -> list[tuple[str, Any]]:
        raw = self._read_json("globalThis.__writes") or []
        writes: list[tuple[str, Any]] = []
        for item in raw[:MAX_TEMPLATE_WRITES]:
            if isinstance(item, list) and len(item) == 2 and isinstance(item[0], str) and item[0]:
                writes.append((item[0], item[1]))
        return writes

    def _read_texts(self, name: str, cap: int, char_cap: int) -> list[str]:
        raw = self._read_json(f"globalThis.{name}") or []
        return [str(item)[:char_cap] for item in raw[:cap] if isinstance(item, str) and item.strip()]

    def _read_json(self, expression: str) -> Any:
        try:
            raw = self._context.eval(f"JSON.stringify({expression})")
            return json.loads(raw) if isinstance(raw, str) else None
        except Exception:
            return None


def create_hook_engine(
    scripts: list[HookScript], *, flat_variables: dict[str, Any], tree: dict[str, Any]
) -> HookEngine | None:
    """Build a `HookEngine`, or `None` when quickjs is missing, nothing is registered, or init
    fails — callers treat `None` as "hooks inert this turn"."""
    if not scripts or not quickjs_available():
        return None
    try:
        return HookEngine(scripts, flat_variables=flat_variables, tree=tree)
    except Exception:
        logger.warning("hook engine unavailable, hooks inert this turn", exc_info=True)
        return None
