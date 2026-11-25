"""Event hooks — sandboxed per-room JavaScript handlers on the turn lifecycle (Layer C).

This is the deliberate opening of the code-plugin layer, on the same trust stance as full EJS
(``core.ejs_full``): self-hosted, the operator's skills and cards, the operator's box — author
freedom first, with crash-protection guardrails rather than capability gates. A skill bundle may
ship a ``hooks.js`` next to its ``SKILL.md`` (active while the skill is enabled for the room),
and an imported card may carry ``extensions.loreweaver_hooks``; both register handlers with:

    on("turn_start",         (event) => { ... })   // event.user_message, event.actor
    on("reply_ready",        (event) => { ... })   // event.reply
    on("dice_rolled",        (event) => { ... })   // event.rolls: [{tool, result}]
    on("variables_changed",  (event) => { ... })   // event.writes: [{path, op}]
    on("clock_advanced",     (event) => { ... })   // event.from, event.to, event.delta
    on("tool_use",           (event) => { ... })   // event.tool, event.arguments — may denyTool(reason)

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

**A hook's ``globalThis`` lives for exactly ONE turn.** The interpreter is rebuilt per turn
(``agent.hook_runtime.load_room_hook_engine``), so a counter kept in a module-level JS variable
silently resets every turn — it does not raise, it just never advances, which is the worst way
for a bug to behave. A 2026-08-07 play-test lost a whole session's "tide sense" meter to exactly
this: ``globalThis.__turns = (globalThis.__turns || 0) + 1`` read ``1/40`` for six hours.

Anything that must survive a turn goes through one of the two engine-owned stores, and both
come back out as an effect buffer the engine validates, caps and PERSISTS:

- the variable bridge — ``setvar``/``incvar`` — for a tracker the table or the Keeper should
  see (declared module variables, the MVU tree: prompt, panels, conditions, the Scribe);
- the hook-private state store — ``getstate(key)``/``setstate(key, value)`` — for machinery
  state nobody but the hooks reads: any JSON value under a short key, never rendered into
  the Keeper prompt, never on a wire frame, never a ``variables_changed`` write. ``null``/
  ``undefined`` deletes the key. Caps are the ``MAX_STATE_*`` constants below; the engine
  half (validation + persistence) is ``plan_state_writes`` here and
  ``agent.hook_runtime.apply_hook_state_writes``.

That is not a workaround for the sandbox lifetime; it is iron rule #1 working as designed.
Durable state is the deterministic engine's, and a hook asks for it rather than keeping its own.

**Module actions** (`defineAction(name, spec, handler)`) are the in-turn channel: the Keeper
calls one through the `module_action` tool (`agent.hook_actions`) and reads the handler's
return value as the tool result in its next round. Registration is recorded in the sandbox
and validated here once all scripts have loaded (`ActionSpec`, `MAX_ACTION*`); `run_action`
runs one handler against views the caller has just refreshed from the store, with dice the
caller pre-rolled, and returns its effects as buffers — or, on any failure, nothing.

Every dispatch carries ``event.seed`` (`hook_seed`): derived from (room, turn in flight,
``<lane>:<event>:<ordinal>``), persisted inputs only, so a replayed turn draws the same seeds.

State snapshot semantics: the room's state is snapshotted into the interpreter when the
per-turn engine is built, and the caller re-syncs it from the store at the start of the
reply phases and before every module action (the view equals the store at the start of
each phase). ``getstate`` returns a fresh copy (mutating it changes nothing until
it is ``setstate``-d back); a handler sees its own earlier ``setstate`` writes at once. After
every dispatch the caller re-syncs the sandbox to what the engine actually persisted, so a
write the engine refused (over a cap, bad key) is visible only until the end of the dispatch
that made it. A ``tool_use`` dispatch persists nothing but its ``denyTool`` — its state writes
are dropped and the sandbox view rolled back, exactly like a failed dispatch.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
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

EVENTS = ("turn_start", "reply_ready", "dice_rolled", "variables_changed", "clock_advanced", "tool_use")

# A large simulation kernel must fit (owner 2026-11-25): one script up to 400k characters,
# and a room's scripts together up to 2M — scripts past the total are skipped, in order,
# with a load warning. Rules scripts (`core.rules_script`) keep their own, smaller cap.
MAX_HOOK_SOURCE_CHARS = 400_000
MAX_HOOK_TOTAL_SOURCE_CHARS = 2_000_000
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
MAX_UI_CAPTION_CHARS = 300
MAX_UI_BODY_CHARS = 4_000
# The M19 performance-grade templates. They are DECLARATIVE, not markup: a rich client
# styles a `letter` as stationery and a `title_card` as a full-bleed act card, while a
# text-first client prints the same fields as lines. The Stage Director's creativity is
# which template, what content, what moment — directors do not weld the stage.
UI_BLOCK_KINDS = frozenset(
    {
        "meter", "stat", "badge", "text", "divider", "choices",
        "image", "letter", "clipping", "map_pin", "title_card",
    }
)
# Blocks addressing a blob by content hash — every one passes the room reachability
# gate (`gateway.ui_media`) before it may reach the wire.
UI_HASH_BLOCK_KINDS = frozenset({"image", "map_pin"})
UI_PANELS = frozenset({"inline", "sidebar"})
UI_BADGE_TONES = frozenset({"info", "warn", "danger"})
UI_TEXT_STYLES = frozenset({"quote", "warning"})
# An `image` block names its picture by CONTENT HASH — the same address the media
# byte channel already answers (`{op:"get", hash}`). The shape check here is purely
# syntactic; whether the room may actually see that blob is decided later, by
# `gateway.ui_media.filter_ui_media` against real room media / enabled-pack assets.
UI_IMAGE_MIMES = frozenset({"image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"})
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

# emitPanel caps (protocol v1.8 `panel_event` frames, M15). The per-TURN budget is
# enforced where the phases' outcomes aggregate (`agent.loop`); the sanitize below
# additionally slices any single dispatch to the same budget. A payload is an opaque
# JSON value for the target panel's own code — size-capped, never schema'd.
MAX_PANEL_EVENTS_PER_TURN = 20
MAX_PANEL_EVENT_BYTES = 32 * 1024
# Wire panel id "<pack slug>/<panel slug>": two 64-char slugs + the separator.
MAX_PANEL_WIRE_ID_CHARS = 129

# Hook-private state store caps (`getstate`/`setstate`). Sizes are UTF-8 bytes of the value's
# compact JSON (`encode_state_value`). A write that breaks any of them is skipped and logged;
# it is never fatal and never shortens the rest of the dispatch's writes.
MAX_STATE_KEY_CHARS = 64
STATE_KEY_RE = re.compile(rf"[A-Za-z0-9_.:-]{{1,{MAX_STATE_KEY_CHARS}}}")
MAX_STATE_VALUE_BYTES = 1024 * 1024
MAX_STATE_KEYS = 64
MAX_STATE_TOTAL_BYTES = 4 * 1024 * 1024
MAX_STATE_WRITES = 32
# Own-property names a plain JS object treats specially: a top-level state key named one of
# these would set a prototype or shadow a builtin instead of storing a value.
RESERVED_STATE_KEYS = frozenset({"__proto__", "constructor", "prototype"})

# Module actions (`defineAction` → the Keeper's `module_action` tool). Registration caps are
# checked once, when the turn's engine is built; call caps per dispatch / per turn.
MODULE_ACTION_TOOL = "module_action"
ACTION_NAME_RE = re.compile(r"[a-z][a-z0-9_]{0,31}")
MAX_ACTIONS = 24
MAX_ACTION_DESCRIPTION_CHARS = 200
MAX_ACTION_PARAMS_CHARS = 400
MAX_ACTION_ROLL_SLOTS = 8
MAX_ACTION_ROLL_EXPR_CHARS = 64
MAX_ACTION_ARGS_BYTES = 8 * 1024
MAX_ACTION_RESULT_CHARS = 4_000
MAX_ACTION_CALLS_PER_TURN = 16
# `spec.label` (a player-invokable action's button text): a string, or an {en, zh} map.
MAX_ACTION_LABEL_CHARS = 60
ACTION_LABEL_LOCALES = ("en", "zh")
# Registrations read back from the sandbox at most; anything past this is a runaway loop.
_MAX_ACTION_REGISTRATIONS_READ = 256
# Hook warnings (handler errors, `log(text)`) written to the server log per dispatch.
MAX_LOGGED_WARNINGS = 32
# `event.seed` is a non-negative integer below 2**53 — exact in a JS number.
_SEED_MASK = (1 << 53) - 1

_HOOK_PRELUDE = r"""
globalThis.__handlers = {};
globalThis.__state = {};
globalThis.__state_writes = [];
globalThis.__state_warnings = [];
globalThis.__state_overflow = 0;
globalThis.__injections = [];
globalThis.__narrations = [];
globalThis.__ui = [];
globalThis.__panel_events = [];
globalThis.__rewrite = null;
globalThis.__deny = null;
globalThis.__action_regs = [];
globalThis.__action_handlers = [];
globalThis.__action_table = {};
globalThis.__action_result = null;

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
// M20: a `tool_use` handler may refuse the call by returning a reason. Refusals go
// through the SAME block-with-reason path as the engine's own end-of-turn checks — the
// reason is fed back to the model, which corrects itself — rather than a second mechanism.
function denyTool(reason) { globalThis.__deny = String(reason); }
function log(text) { globalThis.__warnings.push("log: " + String(text)); }

// Hook-private state store. NOT the variable bridge: nothing here reaches the Keeper prompt,
// a wire frame or `variables_changed`. Values are copied through JSON both ways, so what a
// handler holds is never an alias of the snapshot, and what is buffered is the value AS OF
// the setstate call. The engine (Python) is the judge of keys and caps; this side only
// refuses what cannot be JSON at all.
function __defineOwn(target, key, value) {
    // Never `target[key] = value`: for key "__proto__" that sets a prototype instead.
    Object.defineProperty(target, key, { value: value, writable: true, enumerable: true, configurable: true });
}
function __errorText(e) { return String((e && e.message) || e); }
function __jsonText(value) {
    // JSON text of `value`, refusing NaN/Infinity anywhere inside; throws when not JSON.
    var text = JSON.stringify(value, function (_name, v) {
        if (typeof v === "number" && !isFinite(v)) throw new Error("non-finite number");
        return v;
    });
    if (typeof text !== "string") throw new Error("not a JSON value");
    return text;
}
function getstate(key) {
    var k = String(key);
    if (!Object.prototype.hasOwnProperty.call(globalThis.__state, k)) return undefined;
    return JSON.parse(JSON.stringify(globalThis.__state[k]));
}
function setstate(key, value) {
    var k = String(key);
    var copy = null;
    if (value !== undefined && value !== null) {
        try {
            copy = JSON.parse(__jsonText(value));
        } catch (e) {
            globalThis.__state_warnings.push("setstate(" + k + "): not a JSON value (" + __errorText(e) + ")");
            return;
        }
    }
    if (copy === null) {
        delete globalThis.__state[k];
    } else {
        __defineOwn(globalThis.__state, k, copy);
    }
    if (globalThis.__state_writes.length < __MAX_STATE_WRITES__) {
        globalThis.__state_writes.push([k, copy]);
    } else {
        globalThis.__state_overflow += 1;
    }
}

// Module actions: `defineAction(name, spec, handler)` only RECORDS the registration; the
// engine (Python) validates name, spec and caps once all scripts have loaded and publishes
// the accepted names in `__action_table` (name -> registration index).
function defineAction(name, spec, handler) {
    var specCopy = null;
    try { specCopy = JSON.parse(__jsonText(spec)); } catch (e) { specCopy = null; }
    globalThis.__action_regs.push({ name: String(name), spec: specCopy, handler: typeof handler === "function" });
    globalThis.__action_handlers.push(typeof handler === "function" ? handler : null);
}
function __runAction(name, args, event) {
    globalThis.__action_result = null;
    function fail(message) { globalThis.__action_result = { ok: false, error: message }; }
    function settle(value) {
        if (value === undefined) { globalThis.__action_result = { ok: true, text: null }; return; }
        if (typeof value === "string") { globalThis.__action_result = { ok: true, text: value }; return; }
        try {
            globalThis.__action_result = { ok: true, text: __jsonText(value) };
        } catch (e) {
            fail("result is not JSON (" + __errorText(e) + ")");
        }
    }
    var index = Object.prototype.hasOwnProperty.call(globalThis.__action_table, name)
        ? globalThis.__action_table[name] : -1;
    var handler = index >= 0 ? globalThis.__action_handlers[index] : null;
    if (typeof handler !== "function") { fail("unknown action"); return; }
    try {
        var result = handler(args, event);
        if (result && typeof result.then === "function") {
            result.then(settle, function (e) { fail(__errorText(e)); });
        } else {
            settle(result);
        }
    } catch (e) {
        fail(__errorText(e));
    }
}

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
""".replace("__MAX_STATE_WRITES__", str(MAX_STATE_WRITES))


def _capped_str(value: Any, cap: int) -> str | None:
    """`value` truncated to `cap` when it is a string, else `None` (callers drop)."""
    return value[:cap] if isinstance(value, str) else None


def _finite_number(value: Any) -> int | float | None:
    """`value` when it is a real, finite number (bool excluded), else `None`."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None


# One table drives every performance template: required fields (the block drops without
# them) then optional ones, each with its cap. Adding a template is a row here plus a
# renderer per client — deliberately no per-kind branching to keep in sync.
_PERFORMANCE_FIELDS: dict[str, tuple[tuple[str, int], ...]] = {
    "letter": (("body", MAX_UI_BODY_CHARS),),
    "clipping": (("headline", MAX_UI_LABEL_CHARS), ("body", MAX_UI_BODY_CHARS)),
    "map_pin": (("label", MAX_UI_LABEL_CHARS),),
    "title_card": (("title", MAX_UI_LABEL_CHARS),),
}
_PERFORMANCE_OPTIONAL: dict[str, tuple[tuple[str, int], ...]] = {
    "letter": (("from", MAX_UI_LABEL_CHARS), ("to", MAX_UI_LABEL_CHARS), ("date", MAX_UI_LABEL_CHARS)),
    "clipping": (("source", MAX_UI_LABEL_CHARS), ("date", MAX_UI_LABEL_CHARS)),
    "map_pin": (("note", MAX_UI_CAPTION_CHARS),),
    "title_card": (("subtitle", MAX_UI_CAPTION_CHARS), ("act", MAX_UI_LABEL_CHARS)),
}


def _sanitize_performance_block(kind: str, raw: dict[str, Any]) -> dict[str, Any] | None:
    """One M19 performance template (`letter`/`clipping`/`map_pin`/`title_card`).

    Same stance as every other kind: a missing/mistyped REQUIRED field drops the block,
    an invalid OPTIONAL one is stripped and the block kept."""
    block: dict[str, Any] = {"kind": kind}
    for name, cap in _PERFORMANCE_FIELDS[kind]:
        value = _capped_str(raw.get(name), cap)
        if not value or not value.strip():
            return None
        block[name] = value
    if kind == "map_pin":
        # The pin needs a map to sit on and a place to sit: fractional coordinates
        # (0..1 of the image's own box) so a client scales the marker to any render size.
        raw_hash = raw.get("hash")
        if not isinstance(raw_hash, str) or not _SHA256_RE.match(raw_hash.strip().casefold()):
            return None
        x, y = _finite_number(raw.get("x")), _finite_number(raw.get("y"))
        if x is None or y is None:
            return None
        block["hash"] = raw_hash.strip().casefold()
        block["x"] = min(1.0, max(0.0, float(x)))
        block["y"] = min(1.0, max(0.0, float(y)))
    for name, cap in _PERFORMANCE_OPTIONAL[kind]:
        value = _capped_str(raw.get(name), cap)
        if value and value.strip():
            block[name] = value
    return block


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
    if kind == "image":
        # The hash is matched WHOLE, never truncated into shape: a 128-char string
        # sliced to 64 hex chars would address a different blob than the author meant.
        raw_hash = raw.get("hash")
        if not isinstance(raw_hash, str) or not _SHA256_RE.match(raw_hash.strip().casefold()):
            return None
        block = {"kind": "image", "hash": raw_hash.strip().casefold()}
        mime = raw.get("mime")
        if isinstance(mime, str) and mime.strip().casefold() in UI_IMAGE_MIMES:
            block["mime"] = mime.strip().casefold()
        caption = _capped_str(raw.get("caption"), MAX_UI_CAPTION_CHARS)
        if caption:
            block["caption"] = caption
        alt = _capped_str(raw.get("alt"), MAX_UI_LABEL_CHARS)
        if alt:
            block["alt"] = alt
        return block
    if kind in ("letter", "clipping", "map_pin", "title_card"):
        return _sanitize_performance_block(kind, raw)
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
    # `tool_use` only: the reason a hook refused this tool call, or None to allow it.
    # A hook that fails, times out, or says nothing ALLOWS — see `HookEngine.fire`.
    deny: str | None = None
    # Validated emitUI() emissions (see `sanitize_ui_emissions`) — each dict is one
    # protocol-v1.7 `ui` wire-frame payload the caller broadcasts as-is.
    ui_blocks: list[dict[str, Any]] = field(default_factory=list)
    # Validated emitPanel() emissions (see `sanitize_panel_events`) — each dict is one
    # protocol-v1.8 `panel_event` payload; delivery is manifest-filtered per viewer.
    panel_events: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    # Buffered setstate() writes in call order — `(key, value)`, value `None` = delete. Not yet
    # validated against keys/caps: `plan_state_writes` is the judge, and the caller applies
    # (`agent.hook_runtime.apply_hook_state_writes`). Always empty for `tool_use`.
    state_writes: list[tuple[str, Any]] = field(default_factory=list)
    # Why a setstate() did not make it into `state_writes` (not JSON, over the per-dispatch
    # write cap, dropped by a `tool_use` dispatch). Logged by the caller with its own.
    state_warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ActionSpec:
    """One accepted `defineAction` registration, as the Keeper's tool describes it."""

    name: str
    description: str
    params: str = ""
    # slot -> dice expression, pre-rolled by the real dice engine before the handler runs.
    rolls: tuple[tuple[str, str], ...] = ()
    # `spec.player`: any room member may invoke it directly (`.act`), and then its result is
    # PLAYER-VISIBLE authorial output. Every action stays callable by the Keeper's tool.
    player: bool = False
    # `spec.label`, as (locale, text) pairs; ("", text) for a plain-string label.
    labels: tuple[tuple[str, str], ...] = ()

    def label_for(self, locale: str) -> str:
        """The label in `locale` (zh* → zh, else en), falling back to any label, then the name."""
        by_locale = dict(self.labels)
        wanted = "zh" if str(locale or "").casefold().startswith("zh") else "en"
        for key in (wanted, "", "en", "zh"):
            if by_locale.get(key):
                return by_locale[key]
        return self.name

    def manifest_entry(self) -> dict[str, Any]:
        """This action as the room's cached player-action manifest stores it (labels
        unresolved — each viewer's state frame resolves its own)."""
        entry: dict[str, Any] = {"id": self.name, "description": self.description}
        if self.labels:
            entry["labels"] = {key or "*": text for key, text in self.labels}
        if self.params:
            entry["params"] = self.params
        return entry


@dataclass
class ActionOutcome(HookOutcome):
    """One `run_action` call. `ok` False means the handler threw, timed out, did not settle or
    returned something that is not JSON — and then every effect list is EMPTY: a failed
    action applies nothing. `text` is the handler's return value as tool-result text (None for
    `undefined`), already cut to `MAX_ACTION_RESULT_CHARS` (`truncated` says so)."""

    ok: bool = False
    text: str | None = None
    truncated: bool = False
    error: str | None = None


def hook_seed(chat_key: str, turn: int, stream: str) -> int:
    """`event.seed`: derived from persisted inputs only, like `agent.prompt_builder.turn_rng`.

    sha256 over (room, turn in flight, stream), cut to 53 bits so a JS number holds it
    exactly. Nothing new is stored: the same room state re-derives the same seeds, so an
    undo-and-retry of a turn replays them — intended, it is what makes a hook replayable."""
    digest = hashlib.sha256(f"{chat_key}\x00{turn}\x00{stream}".encode()).digest()
    return int.from_bytes(digest[:8], "big") & _SEED_MASK


class HookEngine:
    """One QuickJS interpreter holding a room's registered handlers for one turn.

    Build via `create_hook_engine` (None when quickjs is unavailable or nothing registered).
    `fire()` and `run_action()` never raise — a broken dispatch returns an empty outcome with
    warnings, and the warnings are written to the server log here (the one place every
    dispatch site shares).
    """

    def __init__(
        self,
        scripts: list[HookScript],
        *,
        flat_variables: dict[str, Any],
        tree: dict[str, Any],
        state: dict[str, Any] | None = None,
        room: str = "",
        turn: int = 0,
        lane: str = "hooks",
        ordinal_offset: int = 0,
    ) -> None:
        import quickjs

        self._room = room
        self._turn = int(turn)
        self._lane = lane
        # Where every stream's ordinal starts: a lane whose engine is rebuilt per dispatch
        # (`.act`) passes a persisted counter so its seeds do not repeat within a turn.
        self._ordinal_offset = max(0, int(ordinal_offset))
        # Per-stream dispatch ordinals for `event.seed` (`<lane>:<event>:<ordinal>`).
        self._ordinals: dict[str, int] = {}
        self._context = quickjs.Context()
        self._context.set_memory_limit(MEMORY_LIMIT_BYTES)
        self._context.eval((_VENDOR_DIR / "lodash.min.js").read_text(encoding="utf-8"))
        self._context.eval(_BRIDGE_PRELUDE)
        self._context.eval(_HOOK_PRELUDE)
        self._flat: dict[str, Any] = dict(flat_variables)
        self._tree: dict[str, Any] = dict(tree)
        self._push_variables()
        for name in ("__wi", "__char", "__chat"):
            self._context.eval(f"globalThis.{name} = {{}};")
        # The hook-private state the engine has PERSISTED — what the sandbox view is reset to
        # after a dispatch whose writes did not (all) persist. See `sync_state`.
        self._committed_state: dict[str, Any] = dict(state or {})
        self._context.eval(f"globalThis.__state = {_state_view_expression(self._committed_state)};")
        # Registration scripts are UNTRUSTED user code: the time limit arms BEFORE they run, so a
        # top-level infinite loop in a hooks.js times out instead of hanging the server.
        self._context.set_time_limit(TIME_LIMIT_SECONDS)
        self.load_warnings: list[str] = []
        loaded_chars = 0
        for script in scripts[:MAX_SCRIPTS]:
            if len(script.code) > MAX_HOOK_SOURCE_CHARS:
                self.load_warnings.append(f"{script.source_id}: script too large, skipped")
                continue
            if loaded_chars + len(script.code) > MAX_HOOK_TOTAL_SOURCE_CHARS:
                self.load_warnings.append(
                    f"{script.source_id}: the room's scripts would pass {MAX_HOOK_TOTAL_SOURCE_CHARS} characters in total, skipped"  # i18n-exempt: operator log text
                )
                continue
            loaded_chars += len(script.code)
            try:
                self._context.eval(script.code)
            except Exception as exc:
                self.load_warnings.append(f"{script.source_id}: {exc}")
        # A top-level `setstate` (outside any handler) belongs to no dispatch, so nothing would
        # ever persist it — drop it and give the handlers the snapshot they were promised.
        if self._read_json("globalThis.__state_writes.length"):
            self.load_warnings.append("setstate outside a handler is not persisted")  # i18n-exempt: operator log text
            self._restore_committed_state()
        self._actions: tuple[ActionSpec, ...] = self._register_actions()

    # -- module actions --------------------------------------------------------------------

    @property
    def actions(self) -> tuple[ActionSpec, ...]:
        """The accepted module actions, in registration order (the tool lists them so)."""
        return self._actions

    def action(self, name: str) -> ActionSpec | None:
        return next((spec for spec in self._actions if spec.name == name), None)

    def _register_actions(self) -> tuple[ActionSpec, ...]:
        """Validate every `defineAction` registration once all scripts have loaded, and tell
        the sandbox which registration each accepted name runs. A bad registration is a load
        warning, never a failed engine."""
        total = self._read_json("globalThis.__action_regs.length")
        if not isinstance(total, int) or total <= 0:
            return ()
        raw = self._read_json(f"globalThis.__action_regs.slice(0, {_MAX_ACTION_REGISTRATIONS_READ})") or []
        accepted: list[ActionSpec] = []
        table: dict[str, int] = {}
        for index, entry in enumerate(raw if isinstance(raw, list) else []):
            spec, problem = _parse_action_registration(entry)
            if spec is None:
                name = str(entry.get("name", ""))[:40] if isinstance(entry, dict) else ""
                self.load_warnings.append(f"defineAction({name!r}): {problem}; dropped")  # i18n-exempt: operator log text
                continue
            if spec.name in table:
                self.load_warnings.append(f"defineAction({spec.name!r}): duplicate name; the first registration wins")  # i18n-exempt: operator log text
                continue
            if len(accepted) >= MAX_ACTIONS:
                self.load_warnings.append(f"defineAction({spec.name!r}): over the {MAX_ACTIONS}-action cap; dropped")  # i18n-exempt: operator log text
                continue
            table[spec.name] = index
            accepted.append(spec)
        if total > _MAX_ACTION_REGISTRATIONS_READ:
            self.load_warnings.append(
                f"defineAction: {total - _MAX_ACTION_REGISTRATIONS_READ} registration(s) past the first {_MAX_ACTION_REGISTRATIONS_READ} ignored"  # i18n-exempt: operator log text
            )
        try:
            self._context.eval(f"globalThis.__action_table = JSON.parse({json.dumps(json.dumps(table))});")
        except Exception:  # noqa: BLE001 — an engine without actions is still an engine
            logger.warning("module action table could not be published", exc_info=True)
            return ()
        return tuple(accepted)

    def run_action(
        self,
        name: str,
        args: dict[str, Any],
        *,
        actor: str = "",
        rolls: dict[str, Any] | None = None,
        source: str = "keeper",
    ) -> ActionOutcome:
        """Run one module action's handler against the current sandbox views.

        The caller has already validated `name` and `args`, refreshed the views
        (`refresh_variables` / `sync_state`) and pre-rolled the declared dice. Effects come
        back as buffers like `fire()`'s; `inject`/`narrate`/`rewriteReply`/`denyTool` are
        ignored (warned) because the result text is the action's voice. On ANY failure the
        outcome carries no effects and the sandbox views are rolled back. Never raises."""
        outcome = ActionOutcome()
        if self.action(name) is None:
            outcome.error = "unknown action"  # i18n-exempt: operator log text
            return outcome
        try:
            event = {
                "actor": actor,
                "seed": self._next_seed("action"),
                "rolls": dict(rolls or {}),
                "source": "player" if source == "player" else "keeper",
            }
            self._reset_buffers()
            self._context.eval(
                f"__runAction({json.dumps(name)}, JSON.parse({json.dumps(_compact_json(args))}),"
                f" JSON.parse({json.dumps(_compact_json(event))}))"
            )
            for _ in range(MAX_PENDING_JOBS):
                if not self._context.execute_pending_job():
                    break
            result = self._read_json("globalThis.__action_result")
            outcome.warnings = self._drain_warnings()
            if not isinstance(result, dict):
                raise _ActionFailed("the handler did not settle")  # i18n-exempt: operator log text
            if not result.get("ok"):
                raise _ActionFailed(str(result.get("error") or "the handler failed"))  # i18n-exempt: operator log text
            text = result.get("text")
            outcome.writes = self._read_writes()
            outcome.state_writes, outcome.state_warnings = self._read_state_writes()
            outcome.ui_blocks = sanitize_ui_emissions(self._read_json("globalThis.__ui"))
            outcome.panel_events = sanitize_panel_events(self._read_json("globalThis.__panel_events"))
            for buffer, label in (
                ("globalThis.__injections.length", "inject"),
                ("globalThis.__narrations.length", "narrate"),
                ("globalThis.__rewrite !== null", "rewriteReply"),
                ("globalThis.__deny !== null", "denyTool"),
            ):
                if self._read_json(buffer):
                    outcome.warnings.append(f"action {name}: {label}() is ignored inside an action")  # i18n-exempt: operator log text
            outcome.ok = True
            if isinstance(text, str):
                outcome.truncated = len(text) > MAX_ACTION_RESULT_CHARS
                outcome.text = text[:MAX_ACTION_RESULT_CHARS]
        except Exception as exc:  # throw, time/memory limit, unsettled, unserializable
            failed = ActionOutcome(error=str(exc)[:500] or exc.__class__.__name__)
            failed.warnings = [*outcome.warnings, f"action {name} failed: {failed.error}"]  # i18n-exempt: operator log text
            outcome = failed
            try:
                self._context.eval("globalThis.__warnings = [];")
            except Exception:  # noqa: BLE001 — best effort; the next dispatch drains anyway
                pass
            self._push_variables()
            self._restore_committed_state()
        self._log_warnings(f"action:{name}", outcome.warnings)
        return outcome

    # -- views -----------------------------------------------------------------------------

    def refresh_variables(self, flat_variables: dict[str, Any], tree: dict[str, Any]) -> None:
        """Re-snapshot the variable views from the store (before a module action, so it sees
        mid-turn Keeper-tool writes). Never raises."""
        self._flat = dict(flat_variables)
        self._tree = dict(tree)
        self._push_variables()

    def _push_variables(self) -> None:
        try:
            for name, payload in (("__flat", self._flat), ("__tree", self._tree)):
                self._context.eval(f"globalThis.{name} = {json.dumps(payload, ensure_ascii=False)};")
        except Exception:  # noqa: BLE001 — hooks never break a turn
            logger.warning("hook variable views could not be reset", exc_info=True)

    # -- events ----------------------------------------------------------------------------

    def _next_seed(self, stream: str) -> int:
        ordinal = self._ordinals.get(stream, getattr(self, "_ordinal_offset", 0))
        self._ordinals[stream] = ordinal + 1
        return hook_seed(self._room, self._turn, f"{self._lane}:{stream}:{ordinal}")

    def _reset_buffers(self) -> None:
        self._context.eval(
            "globalThis.__writes = []; globalThis.__injections = [];"  # i18n-exempt: JavaScript source, not UI text
            " globalThis.__narrations = []; globalThis.__rewrite = null; globalThis.__deny = null;"
            " globalThis.__ui = []; globalThis.__panel_events = [];"
            " globalThis.__state_writes = []; globalThis.__state_warnings = [];"
            " globalThis.__state_overflow = 0; globalThis.__action_result = null;"
        )

    def _drain_warnings(self) -> list[str]:
        warnings = self._read_json("globalThis.__warnings") or []
        self._context.eval("globalThis.__warnings = [];")
        return [str(warning) for warning in warnings] if isinstance(warnings, list) else []

    def _log_warnings(self, where: str, warnings: list[str]) -> None:
        """Handler errors and `log(text)` lines, at warning level (docs/hooks.md promises it)."""
        room = getattr(self, "_room", "") or "?"
        for warning in warnings[:MAX_LOGGED_WARNINGS]:
            logger.warning("hook %s [%s]: %s", room, where, warning)
        if len(warnings) > MAX_LOGGED_WARNINGS:
            logger.warning("hook %s [%s]: %d more warning(s) not shown", room, where, len(warnings) - MAX_LOGGED_WARNINGS)

    def fire(self, event_type: str, payload: dict[str, Any]) -> HookOutcome:
        """Dispatch one event to every registered handler and collect the effect buffers.
        Every handler receives `event.seed` (see `hook_seed`) on top of `payload`."""
        outcome = HookOutcome()
        if event_type not in EVENTS:
            outcome.warnings.append(f"unknown event {event_type!r}")
            return outcome
        try:
            event = {**payload, "seed": self._next_seed(event_type)}
            self._reset_buffers()
            outcome.handlers = int(
                self._context.eval(
                    f"__dispatch({json.dumps(event_type)}, {json.dumps(event, ensure_ascii=False)})"
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
            deny = self._read_json("globalThis.__deny")
            outcome.deny = deny[:MAX_INJECT_CHARS] if isinstance(deny, str) and deny.strip() else None
            outcome.ui_blocks = sanitize_ui_emissions(self._read_json("globalThis.__ui"))
            outcome.panel_events = sanitize_panel_events(self._read_json("globalThis.__panel_events"))
            outcome.warnings = self._drain_warnings()
            outcome.state_writes, outcome.state_warnings = self._read_state_writes()
            if event_type == "tool_use" and outcome.state_writes:
                # Only `denyTool` is honoured from a tool_use dispatch (the Scribe's veto path
                # runs outside the turn lock, so nothing it fires may write). Roll the sandbox
                # view back so no later handler reads state that was never persisted.
                outcome.state_warnings.append(
                    f"tool_use: {len(outcome.state_writes)} setstate write(s) not persisted"  # i18n-exempt: operator log text
                )
                outcome.state_writes = []
                self._restore_committed_state()
        except Exception as exc:  # time/memory limit, JS engine error — hooks never break a turn
            outcome.warnings.append(f"dispatch failed: {exc}")
            # The dispatch's effects are lost, its setstate writes included — and the sandbox
            # view may hold some of them, so it goes back to what the engine persisted.
            outcome.state_writes = []
            self._restore_committed_state()
            # FAIL OPEN, and specifically here. Every hook failure is harmless today: a
            # broken handler loses its effects and the turn continues. The moment hooks can
            # VETO a tool call, the same failure could instead deny it — so a failed or
            # timed-out dispatch leaves `deny` at None. A hook that cannot run does not get
            # to stop the game. (`quickjs`'s own time limit is what bounds the execution,
            # which is why there is no second timeout wrapped around this.)
            outcome.deny = None
        self._log_warnings(event_type, outcome.warnings)
        return outcome

    def _read_writes(self) -> list[tuple[str, Any]]:
        raw = self._read_json("globalThis.__writes") or []
        writes: list[tuple[str, Any]] = []
        for item in raw[:MAX_TEMPLATE_WRITES]:
            if isinstance(item, list) and len(item) == 2 and isinstance(item[0], str) and item[0]:
                writes.append((item[0], item[1]))
        return writes

    def _read_state_writes(self) -> tuple[list[tuple[str, Any]], list[str]]:
        """The dispatch's buffered setstate() writes (at most `MAX_STATE_WRITES`, the prelude
        stops buffering there) and the sandbox-side refusals."""
        raw = self._read_json("globalThis.__state_writes") or []
        writes: list[tuple[str, Any]] = []
        for item in raw[:MAX_STATE_WRITES] if isinstance(raw, list) else []:
            if isinstance(item, list) and len(item) == 2 and isinstance(item[0], str):
                writes.append((item[0], item[1]))
        raw_warnings = self._read_json("globalThis.__state_warnings") or []
        warnings = [str(item) for item in raw_warnings] if isinstance(raw_warnings, list) else []
        overflow = self._read_json("globalThis.__state_overflow")
        if isinstance(overflow, int) and overflow > 0:
            warnings.append(
                f"setstate: {overflow} write(s) over the {MAX_STATE_WRITES}-per-dispatch cap dropped"  # i18n-exempt: operator log text
            )
        return writes, warnings

    @property
    def committed_state(self) -> dict[str, Any]:
        """A copy of the hook-private state as the engine last persisted it."""
        return dict(self._committed_state)

    def sync_state(self, state: dict[str, Any]) -> None:
        """Adopt `state` — the PERSISTED state — as the committed state, and reset the sandbox
        view to it. Called after every dispatch that produced state writes (so a write the
        engine refused stops being visible to later handlers) and at the start of each later
        phase (so a write another engine made meanwhile — a nested companion turn — is seen).
        Never raises."""
        self._committed_state = dict(state)
        self._restore_committed_state()

    def _restore_committed_state(self) -> None:
        try:
            self._context.eval(f"globalThis.__state = {_state_view_expression(self._committed_state)};")
        except Exception:  # noqa: BLE001 — hooks never break a turn
            logger.warning("hook state view could not be reset", exc_info=True)

    def _read_texts(self, name: str, cap: int, char_cap: int) -> list[str]:
        raw = self._read_json(f"globalThis.{name}") or []
        return [str(item)[:char_cap] for item in raw[:cap] if isinstance(item, str) and item.strip()]

    def _read_json(self, expression: str) -> Any:
        try:
            raw = self._context.eval(f"JSON.stringify({expression})")
            return json.loads(raw) if isinstance(raw, str) else None
        except Exception:
            return None


class _ActionFailed(Exception):
    """A handler that settled as a failure (threw, rejected, unserializable result)."""


def _compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _parse_action_registration(entry: Any) -> tuple[ActionSpec | None, str]:
    """One sandbox registration record → an `ActionSpec`, or `(None, why)`. Unknown spec
    keys are ignored (forward compatible); a missing/oversized field drops the action."""
    if not isinstance(entry, dict):
        return None, "unreadable registration"  # i18n-exempt: operator log text
    name = entry.get("name")
    if not isinstance(name, str) or ACTION_NAME_RE.fullmatch(name) is None:
        return None, "name must match [a-z][a-z0-9_]{0,31}"  # i18n-exempt: operator log text
    if entry.get("handler") is not True:
        return None, "handler is not a function"  # i18n-exempt: operator log text
    spec = entry.get("spec")
    if not isinstance(spec, dict):
        return None, "spec must be a JSON object"  # i18n-exempt: operator log text
    description = spec.get("description")
    if not isinstance(description, str) or not description.strip() or len(description) > MAX_ACTION_DESCRIPTION_CHARS:
        return None, f"spec.description must be 1-{MAX_ACTION_DESCRIPTION_CHARS} characters"  # i18n-exempt: operator log text
    params = spec.get("params", "")
    if params is None:
        params = ""
    if not isinstance(params, str) or len(params) > MAX_ACTION_PARAMS_CHARS:
        return None, f"spec.params must be a string of at most {MAX_ACTION_PARAMS_CHARS} characters"  # i18n-exempt: operator log text
    rolls_raw = spec.get("rolls") or {}
    if not isinstance(rolls_raw, dict) or len(rolls_raw) > MAX_ACTION_ROLL_SLOTS:
        return None, f"spec.rolls must map at most {MAX_ACTION_ROLL_SLOTS} slots to dice expressions"  # i18n-exempt: operator log text
    rolls: list[tuple[str, str]] = []
    for slot, expression in rolls_raw.items():
        if not slot.isidentifier() or not slot.isascii():
            return None, f"spec.rolls slot {slot!r} must be an identifier"  # i18n-exempt: operator log text
        if not isinstance(expression, str) or not expression.strip() or len(expression) > MAX_ACTION_ROLL_EXPR_CHARS:
            return None, f"spec.rolls.{slot} must be a dice expression"  # i18n-exempt: operator log text
        rolls.append((slot, expression.strip()))
    player = spec.get("player", False)
    if not isinstance(player, bool):
        return None, "spec.player must be true or false"  # i18n-exempt: operator log text
    labels, problem = _parse_action_label(spec.get("label"))
    if problem:
        return None, problem
    return (
        ActionSpec(
            name=name,
            description=description.strip(),
            params=params.strip(),
            rolls=tuple(rolls),
            player=player,
            labels=labels,
        ),
        "",
    )


def _parse_action_label(raw: Any) -> tuple[tuple[tuple[str, str], ...], str]:
    """`spec.label`: absent, a string, or an `{en, zh}` map — each text 1–60 characters."""
    if raw is None:
        return (), ""
    problem = f"spec.label must be a string or an {{en, zh}} map of 1-{MAX_ACTION_LABEL_CHARS}-character strings"  # i18n-exempt: operator log text
    if isinstance(raw, str):
        text = raw.strip()
        return ((("", text),), "") if 0 < len(text) <= MAX_ACTION_LABEL_CHARS else ((), problem)
    if not isinstance(raw, dict) or not raw or set(raw) - set(ACTION_LABEL_LOCALES):
        return (), problem
    labels: list[tuple[str, str]] = []
    for locale in ACTION_LABEL_LOCALES:
        if locale not in raw:
            continue
        text = raw[locale].strip() if isinstance(raw[locale], str) else ""
        if not 0 < len(text) <= MAX_ACTION_LABEL_CHARS:
            return (), problem
        labels.append((locale, text))
    return tuple(labels), ""


def _state_view_expression(state: dict[str, Any]) -> str:
    """A JavaScript expression building the state view: `JSON.parse("<json>")`, never an
    object literal — in a literal a `"__proto__"` member sets a prototype instead of an own
    property, so a stored value would read back absent or mangled. Values are JSON already
    (they came out of the sandbox or out of `decode_state_value`); anything that is not
    degrades to an empty view rather than an engine that cannot be built."""
    try:
        text = json.dumps(state, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError):
        logger.warning("hook state snapshot is not JSON; the sandbox starts with no state")
        text = "{}"
    return f"JSON.parse({json.dumps(text)})"


def valid_state_key(key: Any) -> bool:
    """True for a key `setstate` may write: 1–64 chars of ``[A-Za-z0-9_.:-]``, and not one of
    `RESERVED_STATE_KEYS` (`__proto__`, `constructor`, `prototype`)."""
    return isinstance(key, str) and STATE_KEY_RE.fullmatch(key) is not None and key not in RESERVED_STATE_KEYS


def encode_state_value(value: Any) -> str:
    """The stored form of one state value: compact JSON, NaN/Infinity refused, and it must
    encode as UTF-8 (a lone surrogate from JS does not). Raises `ValueError`/`TypeError`."""
    text = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    text.encode("utf-8")  # UnicodeEncodeError is a ValueError
    return text


def decode_state_value(text: Any) -> Any:
    """One stored value, or `None` when the row is unusable (absent, not JSON, JSON null) —
    a corrupt row degrades to "key absent", never to a broken turn."""
    if not isinstance(text, str):
        return None
    try:
        return json.loads(text, parse_constant=_reject_json_constant)
    except (json.JSONDecodeError, ValueError, RecursionError):
        return None


def _reject_json_constant(name: str) -> Any:
    # Python's json accepts NaN/Infinity; a stored row carrying one is corrupt (the encoder
    # refuses them), and letting it through would make the whole snapshot unserializable.
    raise ValueError(f"non-finite JSON constant {name}")


@dataclass
class StatePlan:
    """The deterministic verdict on one dispatch's setstate writes.

    `state` is the room's whole hook-private state after the accepted writes; `upserts` (key →
    stored text) and `deletes` are exactly the rows that must change to get there; `applied`
    names each accepted key once, in first-write order; `warnings` says why every refused
    write was refused."""

    state: dict[str, Any] = field(default_factory=dict)
    upserts: dict[str, str] = field(default_factory=dict)
    deletes: list[str] = field(default_factory=list)
    applied: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def plan_state_writes(current: dict[str, Any], writes: list[tuple[str, Any]]) -> StatePlan:
    """Validate buffered setstate writes against the caps, in call order, on top of `current`.

    Each write is judged against the state the earlier accepted writes produced, so a delete
    frees room for a later write in the same dispatch. A refused write is skipped and reported;
    it never stops the writes after it. Pure and deterministic — persistence is the caller's.
    """
    plan = StatePlan(state=dict(current))
    sizes: dict[str, int] = {}
    for key, value in plan.state.items():
        try:
            sizes[key] = len(encode_state_value(value).encode("utf-8"))
        except (TypeError, ValueError):
            sizes[key] = 0
    touched: list[str] = []
    for index, (key, value) in enumerate(writes):
        if index >= MAX_STATE_WRITES:
            plan.warnings.append(
                f"setstate: {len(writes) - MAX_STATE_WRITES} write(s) over the {MAX_STATE_WRITES}-per-dispatch cap dropped"  # i18n-exempt: operator log text
            )
            break
        if not valid_state_key(key):
            plan.warnings.append(f"setstate({str(key)[:80]!r}): invalid key, skipped")  # i18n-exempt: operator log text
            continue
        if value is None:
            plan.state.pop(key, None)
            sizes.pop(key, None)
            plan.upserts.pop(key, None)
            touched.append(key)
            continue
        try:
            text = encode_state_value(value)
        except (TypeError, ValueError) as exc:
            plan.warnings.append(f"setstate({key}): not storable JSON ({exc}), skipped")  # i18n-exempt: operator log text
            continue
        size = len(text.encode("utf-8"))
        if size > MAX_STATE_VALUE_BYTES:
            plan.warnings.append(
                f"setstate({key}): value is {size} bytes, over the {MAX_STATE_VALUE_BYTES}-byte cap, skipped"  # i18n-exempt: operator log text
            )
            continue
        if key not in plan.state and len(plan.state) >= MAX_STATE_KEYS:
            plan.warnings.append(f"setstate({key}): room already holds {MAX_STATE_KEYS} keys, skipped")  # i18n-exempt: operator log text
            continue
        total = sum(sizes.values()) - sizes.get(key, 0) + size
        if total > MAX_STATE_TOTAL_BYTES:
            plan.warnings.append(
                f"setstate({key}): room total would be {total} bytes, over the {MAX_STATE_TOTAL_BYTES}-byte cap, skipped"  # i18n-exempt: operator log text
            )
            continue
        plan.state[key] = json.loads(text)
        sizes[key] = size
        plan.upserts[key] = text
        touched.append(key)
    seen: set[str] = set()
    for key in touched:
        if key in seen:
            continue
        seen.add(key)
        plan.applied.append(key)
        if key not in plan.state:
            plan.deletes.append(key)
    return plan


def create_hook_engine(
    scripts: list[HookScript],
    *,
    flat_variables: dict[str, Any],
    tree: dict[str, Any],
    state: dict[str, Any] | None = None,
    room: str = "",
    turn: int = 0,
    lane: str = "hooks",
    ordinal_offset: int = 0,
) -> HookEngine | None:
    """Build a `HookEngine`, or `None` when quickjs is missing, nothing is registered, or init
    fails — callers treat `None` as "hooks inert this turn". `state` is the room's hook-private
    state snapshot (`agent.hook_runtime.load_hook_state`); `room`/`turn`/`lane` feed
    `event.seed` (`hook_seed`) and label the engine's log lines."""
    if not scripts or not quickjs_available():
        return None
    try:
        return HookEngine(
            scripts,
            flat_variables=flat_variables,
            tree=tree,
            state=state,
            room=room,
            turn=turn,
            lane=lane,
            ordinal_offset=ordinal_offset,
        )
    except Exception:
        logger.warning("hook engine unavailable, hooks inert this turn", exc_info=True)
        return None
