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
player-visible reply), ``rewriteReply(text)`` (replaces it), ``emitUI(blocks, opts?)``
(declarative UI blocks clients render as protocol-v1.7 ``ui`` frames — player-visible
authorial output, the same trust stance as ``narrate``; keeper secrets must never be
emitted), ``emitPanel(panelId, payload)`` (an opaque JSON payload for one module UI panel —
protocol-v1.8 ``panel_event`` frames, delivered only to viewers whose manifest contains
that panel; same trust stance as ``emitUI``), and ``log(text)``.

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
import math
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

# emitUI caps (protocol v1.7 `ui` frames). Slice-then-filter like the other effect
# buffers (`_read_texts`): extra emissions/blocks/options beyond the cap are dropped
# from the tail, oversized strings are truncated, and a block that fails its kind's
# schema is dropped — never fatal to the dispatch.
MAX_UI_EMISSIONS = 8
MAX_UI_BLOCKS = 16
MAX_UI_OPTIONS = 12
MAX_UI_LABEL_CHARS = 120
MAX_UI_PROMPT_CHARS = 200
MAX_UI_TEXT_CHARS = 2_000
MAX_UI_ID_CHARS = 64
MAX_UI_OPTION_INPUT_CHARS = 200
UI_BLOCK_KINDS = frozenset({"meter", "stat", "badge", "text", "divider", "choices"})
UI_PANELS = frozenset({"inline", "sidebar"})
UI_BADGE_TONES = frozenset({"info", "warn", "danger"})
UI_TEXT_STYLES = frozenset({"quote", "warning"})

# emitPanel caps (protocol v1.8 `panel_event` frames, M15). The per-TURN budget is
# enforced where the phases' outcomes aggregate (`agent.loop`); the sanitize below
# additionally slices any single dispatch to the same budget. A payload is an opaque
# JSON value for the target panel's own code — size-capped, never schema'd.
MAX_PANEL_EVENTS_PER_TURN = 20
MAX_PANEL_EVENT_BYTES = 32 * 1024
# Wire panel id "<pack slug>/<panel slug>": two 64-char slugs + the separator.
MAX_PANEL_WIRE_ID_CHARS = 129

_HOOK_PRELUDE = r"""
globalThis.__handlers = {};
globalThis.__injections = [];
globalThis.__narrations = [];
globalThis.__ui = [];
globalThis.__panel_events = [];
globalThis.__rewrite = null;

function on(eventType, handler) {
    if (typeof handler !== "function") return;
    var key = String(eventType);
    (globalThis.__handlers[key] = globalThis.__handlers[key] || []).push(handler);
}
function inject(text) { globalThis.__injections.push(String(text)); }
function narrate(text) { globalThis.__narrations.push(String(text)); }
function rewriteReply(text) { globalThis.__rewrite = String(text); }
function emitUI(blocks, opts) {
    globalThis.__ui.push({
        blocks: Array.isArray(blocks) ? blocks : [blocks],
        panel: opts && opts.panel,
        id: opts && opts.id,
        replace: opts && opts.replace,
    });
}
function emitPanel(panelId, payload) {
    globalThis.__panel_events.push({ panel: String(panelId), payload: payload });
}
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


def _capped_str(value: Any, cap: int) -> str | None:
    """`value` truncated to `cap` when it is a string, else `None` (callers drop)."""
    return value[:cap] if isinstance(value, str) else None


def _finite_number(value: Any) -> int | float | None:
    """`value` when it is a real, finite number (bool excluded), else `None`."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None


def _sanitize_ui_block(raw: Any) -> dict[str, Any] | None:
    """One validated, whitelist-rebuilt UI block, or `None` when `raw` fails its kind's
    schema (bad blocks drop). Required fields of the wrong type drop the block; invalid
    OPTIONAL fields (an unknown `tone`/`style`) are stripped and the block kept."""
    if not isinstance(raw, dict) or raw.get("kind") not in UI_BLOCK_KINDS:
        return None
    kind = raw["kind"]
    if kind == "divider":
        return {"kind": "divider"}
    if kind == "meter":
        label = _capped_str(raw.get("label"), MAX_UI_LABEL_CHARS)
        value = _finite_number(raw.get("value"))
        minimum = _finite_number(raw.get("min"))
        maximum = _finite_number(raw.get("max"))
        if label is None or value is None or minimum is None or maximum is None or maximum <= minimum:
            return None
        return {"kind": "meter", "label": label, "value": value, "min": minimum, "max": maximum}
    if kind == "stat":
        label = _capped_str(raw.get("label"), MAX_UI_LABEL_CHARS)
        value: Any = raw.get("value")
        if isinstance(value, str):
            value = value[:MAX_UI_LABEL_CHARS]
        elif not isinstance(value, bool):
            value = _finite_number(value)
        if label is None or value is None:
            return None
        return {"kind": "stat", "label": label, "value": value}
    if kind == "badge":
        label = _capped_str(raw.get("label"), MAX_UI_LABEL_CHARS)
        if label is None:
            return None
        block: dict[str, Any] = {"kind": "badge", "label": label}
        if raw.get("tone") in UI_BADGE_TONES:
            block["tone"] = raw["tone"]
        return block
    if kind == "text":
        text = _capped_str(raw.get("text"), MAX_UI_TEXT_CHARS)
        if text is None:
            return None
        block = {"kind": "text", "text": text}
        if raw.get("style") in UI_TEXT_STYLES:
            block["style"] = raw["style"]
        return block
    # kind == "choices": an option missing any of id/label/input is dropped; a choices
    # block with no valid option left renders nothing, so it drops entirely.
    raw_options = raw.get("options")
    if not isinstance(raw_options, list):
        return None
    options = []
    for raw_option in raw_options[:MAX_UI_OPTIONS]:
        if not isinstance(raw_option, dict):
            continue
        option_id = _capped_str(raw_option.get("id"), MAX_UI_ID_CHARS)
        option_label = _capped_str(raw_option.get("label"), MAX_UI_LABEL_CHARS)
        option_input = _capped_str(raw_option.get("input"), MAX_UI_OPTION_INPUT_CHARS)
        if option_id and option_label and option_input:
            options.append({"id": option_id, "label": option_label, "input": option_input})
    if not options:
        return None
    block = {"kind": "choices", "options": options}
    prompt = _capped_str(raw.get("prompt"), MAX_UI_PROMPT_CHARS)
    if prompt:
        block["prompt"] = prompt
    return block


def sanitize_ui_emissions(raw: Any) -> list[dict[str, Any]]:
    """Validate a fire()'s buffered `emitUI()` payloads into wire-ready `ui` frame payloads.

    Each returned dict is one protocol-v1.7 ``ui`` frame minus its ``type`` key:
    ``{"blocks": [...], "panel": "inline"|"sidebar", "id"?: str, "replace"?: True}``.
    ``panel`` defaults to ``"inline"`` (unknown values included); ``id``/``replace``
    pass through only when a non-empty string / literally ``True``.
    """
    if not isinstance(raw, list):
        return []
    emissions: list[dict[str, Any]] = []
    for entry in raw[:MAX_UI_EMISSIONS]:
        if not isinstance(entry, dict) or not isinstance(entry.get("blocks"), list):
            continue
        blocks = [
            block
            for raw_block in entry["blocks"][:MAX_UI_BLOCKS]
            if (block := _sanitize_ui_block(raw_block)) is not None
        ]
        if not blocks:
            continue
        emission: dict[str, Any] = {
            "blocks": blocks,
            "panel": entry.get("panel") if entry.get("panel") in UI_PANELS else "inline",
        }
        region_id = _capped_str(entry.get("id"), MAX_UI_ID_CHARS)
        if region_id:
            emission["id"] = region_id
        if entry.get("replace") is True:
            emission["replace"] = True
        emissions.append(emission)
    return emissions


def sanitize_panel_events(raw: Any) -> list[dict[str, Any]]:
    """Validate a fire()'s buffered `emitPanel()` calls into wire-ready `panel_event`
    frame payloads (protocol v1.8, minus the ``type`` key): ``{"panel": <wire id>,
    "payload": <JSON value>}``.

    Same slice-then-filter stance as `sanitize_ui_emissions`: entries past the budget
    drop from the tail, and an entry with a bad panel id or an oversized payload
    (> `MAX_PANEL_EVENT_BYTES` serialized) drops entirely — a payload is opaque JSON
    for the target panel's own code, so truncating it would corrupt it. The per-TURN
    budget across phases is the caller's job (`agent.loop`).
    """
    if not isinstance(raw, list):
        return []
    events: list[dict[str, Any]] = []
    for entry in raw[:MAX_PANEL_EVENTS_PER_TURN]:
        if not isinstance(entry, dict):
            continue
        panel = entry.get("panel")
        if not isinstance(panel, str) or not panel.strip() or len(panel) > MAX_PANEL_WIRE_ID_CHARS:
            continue
        payload = entry.get("payload")
        try:
            # allow_nan=False: NaN/Infinity would serialize as non-standard JSON that a
            # client-side JSON.parse rejects — drop the entry instead of poisoning the wire.
            serialized = json.dumps(payload, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError):
            continue
        if len(serialized.encode("utf-8")) > MAX_PANEL_EVENT_BYTES:
            continue
        events.append({"panel": panel.strip(), "payload": payload})
    return events


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
    # Validated emitUI() emissions (see `sanitize_ui_emissions`) — each dict is one
    # protocol-v1.7 `ui` wire-frame payload the caller broadcasts as-is.
    ui_blocks: list[dict[str, Any]] = field(default_factory=list)
    # Validated emitPanel() emissions (see `sanitize_panel_events`) — each dict is one
    # protocol-v1.8 `panel_event` payload; delivery is manifest-filtered per viewer.
    panel_events: list[dict[str, Any]] = field(default_factory=list)
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
                " globalThis.__ui = []; globalThis.__panel_events = [];"
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
            outcome.ui_blocks = sanitize_ui_emissions(self._read_json("globalThis.__ui"))
            outcome.panel_events = sanitize_panel_events(self._read_json("globalThis.__panel_events"))
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
