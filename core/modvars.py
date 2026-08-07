"""Deterministic module variables — author/keeper-declared trackers with validated state.

Iron rule #1 (deterministic vs generative split): variable SPECS and VALUES are real code —
declared with a kind + range, validated, clamped, and persisted deterministically — the AI Keeper
only narrates around them (``agent.kp_tools_vars`` is the tool surface; ``agent.prompt_builder``
folds the current state into the main KP prompt; ``net.state`` ships the player-visible subset to
clients). This mirrors ``core.relationships``' layering and is intentionally self-contained
(stdlib + json only): no ``agent``/``infra`` imports, only a duck-typed store `Protocol`.

State shape is one JSON document per room: ``{"specs": {id: spec}, "values": {id: value}}``.
Python dicts preserve insertion order and JSON round-trips it, so definition order is stable and
meaningful — clients render variables in the order they were declared, no sorting anywhere.

Iron rule #3 (information isolation): every spec carries ``visibility`` — the `modvars`
document projection (`core.documents`) STRUCTURALLY drops ``"keeper"`` variables from every
player-grade view (they only ever reach the Keeper's own prompt), so a hidden tracker can
never leak by transport; `wire_entries` below formats an already-projected view.

Four kinds, all deterministic:
- ``number`` — integers, optionally clamped to ``[minimum, maximum]`` (each bound independent).
- ``bool`` — true/false.
- ``text``  — a short free string (truncated to `MAX_TEXT_LEN`).
- ``enum``  — one of a fixed option list (matched case-insensitively, stored canonically).
"""

from __future__ import annotations

import copy
import re
import unicodedata
from typing import Any, Protocol

# ---------------------------------------------------------------------------
# Limits and shapes
# ---------------------------------------------------------------------------

KINDS = ("number", "bool", "text", "enum")
VISIBILITIES = ("player", "keeper")

MAX_VARS = 64
MAX_TEXT_LEN = 200
MAX_LABEL_LEN = 50
MAX_OPTIONS = 20
MAX_OPTION_LEN = 50

# ASCII stays slug-strict (lowercase/digits/underscore); non-ASCII characters ride
# verbatim unless they are separators or controls -- CJK variable ids (理智, 怀疑度) are
# first-class for this audience, exactly as they already are on the MVU side of the same
# `state.variables` wire field. Spaces/hyphens normalize to `_` upstream (`normalize_id`).
_ID_ASCII_ALLOWED = frozenset("abcdefghijklmnopqrstuvwxyz0123456789_")


def _valid_id(slug: str) -> bool:
    if not 1 <= len(slug) <= 64:
        return False
    for char in slug:
        if ord(char) < 0x80:
            if char not in _ID_ASCII_ALLOWED:
                return False
        elif unicodedata.category(char).startswith(("Z", "C")):
            return False
    return True

# ``{"specs": {id: spec_dict}, "values": {id: value}}`` — see module docstring.
ModvarState = dict[str, dict[str, Any]]


class _I18nProtocol(Protocol):
    """Duck-typed shape of `infra.i18n.I18n` — just the lookup `describe` needs."""

    def t(self, key: str, **kwargs: Any) -> str: ...


def empty_state() -> ModvarState:
    return {"specs": {}, "values": {}}


# ---------------------------------------------------------------------------
# Coercion helpers — total functions, defensive against model/stored garbage
# ---------------------------------------------------------------------------


def normalize_id(raw: Any) -> str | None:
    """Normalize a model-supplied variable id to slug form: lowercase, spaces/hyphens
    become underscores. Returns `None` when the result isn't a valid slug."""
    if not isinstance(raw, str):
        return None
    slug = re.sub(r"[\s\-]+", "_", raw.strip().lower())
    return slug if _valid_id(slug) else None


def coerce_int(value: Any) -> int | None:
    """Tolerant int parse (mirrors ``core.relationships.coerce_int``): accepts int, float, or a
    numeric string; `None` on anything else, including inf/NaN a hostile stored blob may hold."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        try:
            return int(value)
        except (ValueError, OverflowError):
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return int(text)
        except ValueError:
            try:
                return int(float(text))
            except (ValueError, OverflowError):
                return None
    return None


def coerce_bool(value: Any) -> bool | None:
    """Tolerant bool parse: real bools, 0/1, and the usual true/false word forms; else `None`."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "y", "on"}:
            return True
        if lowered in {"false", "0", "no", "n", "off"}:
            return False
    return None


# ---------------------------------------------------------------------------
# Spec building and validation — pure, no I/O
# ---------------------------------------------------------------------------


def build_spec(
    var_id: str,
    kind: str,
    *,
    labels: dict[str, str] | None = None,
    visibility: str = "player",
    minimum: int | None = None,
    maximum: int | None = None,
    default: Any = None,
    options: list[str] | None = None,
) -> dict[str, Any]:
    """Build a validated spec dict, raising `ValueError` (with a concise reason) on bad input.

    This is the strict path used when DEFINING a variable; `normalize_spec` below is the
    tolerant sibling used when loading possibly-corrupt stored state.
    """
    slug = normalize_id(var_id)
    if slug is None:
        raise ValueError(f"invalid variable id {var_id!r} (want lowercase letters/digits/underscores)")
    if kind not in KINDS:
        raise ValueError(f"unknown kind {kind!r} (want one of: {', '.join(KINDS)})")
    if visibility not in VISIBILITIES:
        raise ValueError(f"unknown visibility {visibility!r} (want one of: {', '.join(VISIBILITIES)})")

    spec: dict[str, Any] = {"id": slug, "kind": kind, "visibility": visibility, "labels": {}}
    for locale, label in (labels or {}).items():
        if isinstance(locale, str) and isinstance(label, str) and label.strip():
            spec["labels"][locale.split("-")[0].lower()] = label.strip()[:MAX_LABEL_LEN]

    if kind == "number":
        low = coerce_int(minimum) if minimum is not None else None
        high = coerce_int(maximum) if maximum is not None else None
        if minimum is not None and low is None:
            raise ValueError(f"minimum {minimum!r} isn't a usable whole number")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
        if maximum is not None and high is None:
            raise ValueError(f"maximum {maximum!r} isn't a usable whole number")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
        if low is not None and high is not None and low > high:
            raise ValueError(f"minimum {low} is greater than maximum {high}")
        if low is not None:
            spec["minimum"] = low
        if high is not None:
            spec["maximum"] = high
    elif minimum is not None or maximum is not None:
        raise ValueError(f"minimum/maximum only apply to the number kind, not {kind!r}")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template

    if kind == "enum":
        cleaned = []
        for option in options or []:
            if isinstance(option, str) and option.strip():
                text = option.strip()[:MAX_OPTION_LEN]
                if text.lower() not in {existing.lower() for existing in cleaned}:
                    cleaned.append(text)
        if not cleaned:
            raise ValueError("enum kind needs a non-empty options list")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
        spec["options"] = cleaned[:MAX_OPTIONS]
    elif options:
        raise ValueError(f"options only apply to the enum kind, not {kind!r}")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template

    spec["default"] = _default_value(spec) if default is None else validate_value(spec, default)
    return spec


def _default_value(spec: dict[str, Any]) -> Any:
    kind = spec["kind"]
    if kind == "number":
        low = spec.get("minimum")
        if low is not None:
            return low
        high = spec.get("maximum")
        return min(0, high) if high is not None else 0
    if kind == "bool":
        return False
    if kind == "enum":
        return spec["options"][0]
    return ""


def validate_value(spec: dict[str, Any], value: Any) -> Any:
    """Coerce + validate `value` against `spec`, raising `ValueError` with a concise reason.

    number → int, clamped into any declared bounds; bool → bool; text → str truncated to
    `MAX_TEXT_LEN`; enum → the canonical option (matched case-insensitively).
    """
    kind = spec["kind"]
    if kind == "number":
        parsed = coerce_int(value)
        if parsed is None:
            raise ValueError(f"{value!r} isn't a usable whole number")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
        return clamp(spec, parsed)
    if kind == "bool":
        parsed_bool = coerce_bool(value)
        if parsed_bool is None:
            raise ValueError(f"{value!r} isn't a usable true/false value")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
        return parsed_bool
    if kind == "enum":
        text = str(value).strip()
        for option in spec.get("options", []):
            if option.lower() == text.lower():
                return option
        raise ValueError(f"{value!r} isn't one of: {', '.join(spec.get('options', []))}")
    if isinstance(value, (dict, list, tuple, set)):
        raise ValueError(f"{value!r} isn't usable text")
    return str(value)[:MAX_TEXT_LEN]


def clamp(spec: dict[str, Any], value: int) -> int:
    """Clamp an int into `spec`'s declared bounds (each side independent, absent = unbounded)."""
    low, high = spec.get("minimum"), spec.get("maximum")
    if low is not None:
        value = max(low, value)
    if high is not None:
        value = min(high, value)
    return value


def normalize_spec(var_id: Any, raw: Any) -> dict[str, Any] | None:
    """Tolerantly rebuild one stored spec; `None` (drop it) on anything structurally wrong."""
    if not isinstance(raw, dict):
        return None
    slug = normalize_id(var_id)
    if slug is None:
        return None
    kind = raw.get("kind")
    if kind not in KINDS:
        return None
    try:
        labels = raw.get("labels")
        return build_spec(
            slug,
            kind,
            labels=labels if isinstance(labels, dict) else None,
            visibility=raw.get("visibility") if raw.get("visibility") in VISIBILITIES else "player",
            minimum=raw.get("minimum") if kind == "number" else None,
            maximum=raw.get("maximum") if kind == "number" else None,
            default=raw.get("default"),
            options=raw.get("options") if kind == "enum" and isinstance(raw.get("options"), list) else None,
        )
    except ValueError:
        return None


def normalize_state(raw: Any) -> ModvarState:
    """Defensively coerce an arbitrary loaded object into a valid `ModvarState`: corrupt specs
    are dropped, values are re-validated against their spec (invalid → the spec default), and
    anything structurally wrong degrades to an empty state rather than raising."""
    state = empty_state()
    if not isinstance(raw, dict):
        return state
    specs = raw.get("specs")
    values = raw.get("values")
    if not isinstance(specs, dict):
        return state
    if not isinstance(values, dict):
        values = {}

    for var_id, raw_spec in specs.items():
        if len(state["specs"]) >= MAX_VARS:
            break
        spec = normalize_spec(var_id, raw_spec)
        if spec is None:
            continue
        try:
            value = validate_value(spec, values[spec["id"]]) if spec["id"] in values else spec["default"]
        except ValueError:
            value = spec["default"]
        state["specs"][spec["id"]] = spec
        state["values"][spec["id"]] = value
    return state


# ---------------------------------------------------------------------------
# State transitions — pure, never mutate their input
# ---------------------------------------------------------------------------


def apply_define(state: ModvarState, spec: dict[str, Any]) -> ModvarState:
    """Add (or redefine) `spec` in `state`. Redefinition keeps the variable's position and its
    current value when that value is still valid under the new spec (numbers re-clamp); an
    incompatible old value resets to the new default. Raises `ValueError` at the `MAX_VARS` cap.
    """
    new_state = copy.deepcopy(state)
    var_id = spec["id"]
    if var_id not in new_state["specs"] and len(new_state["specs"]) >= MAX_VARS:
        raise ValueError(f"variable limit reached ({MAX_VARS})")
    try:
        value = validate_value(spec, new_state["values"][var_id]) if var_id in new_state["values"] else spec["default"]
    except ValueError:
        value = spec["default"]
    new_state["specs"][var_id] = copy.deepcopy(spec)
    new_state["values"][var_id] = value
    return new_state


def apply_set(state: ModvarState, var_id: str, value: Any) -> tuple[ModvarState, Any, Any]:
    """Set `var_id` to a validated `value`. Returns ``(new_state, old_value, new_value)``.
    Raises `ValueError` for an unknown id or an invalid value."""
    spec = state["specs"].get(var_id)
    if spec is None:
        raise ValueError(f"unknown variable: {var_id!r}")
    new_value = validate_value(spec, value)
    new_state = copy.deepcopy(state)
    old_value = new_state["values"].get(var_id, spec["default"])
    new_state["values"][var_id] = new_value
    return new_state, old_value, new_value


def apply_adjust(state: ModvarState, var_id: str, delta: int) -> tuple[ModvarState, int, int]:
    """Apply a signed `delta` to a number variable (clamped). Returns
    ``(new_state, old_value, new_value)``. Raises `ValueError` for an unknown id, a non-number
    kind, or a non-integer delta."""
    spec = state["specs"].get(var_id)
    if spec is None:
        raise ValueError(f"unknown variable: {var_id!r}")
    if spec["kind"] != "number":
        raise ValueError(f"variable {var_id!r} is {spec['kind']}, not number — use set instead")
    parsed_delta = coerce_int(delta)
    if parsed_delta is None:
        raise ValueError(f"delta {delta!r} isn't a usable whole number")  # i18n-exempt: developer diagnostic; tool layer wraps it in a localized template
    new_state = copy.deepcopy(state)
    raw_old = new_state["values"].get(var_id, spec["default"])
    old_value = coerce_int(raw_old)
    old_value = old_value if old_value is not None else int(spec["default"])
    new_value = clamp(spec, old_value + parsed_delta)
    new_state["values"][var_id] = new_value
    return new_state, old_value, new_value


def apply_remove(state: ModvarState, var_id: str) -> ModvarState:
    """Remove `var_id` entirely. Raises `ValueError` for an unknown id."""
    if var_id not in state["specs"]:
        raise ValueError(f"unknown variable: {var_id!r}")
    new_state = copy.deepcopy(state)
    new_state["specs"].pop(var_id, None)
    new_state["values"].pop(var_id, None)
    return new_state


# ---------------------------------------------------------------------------
# Rendering — label resolution, player wire entries, keeper prompt lines
# ---------------------------------------------------------------------------


def label_for(spec: dict[str, Any], locale: str) -> str:
    """Resolve `spec`'s display label for `locale`: exact language → English → any → the id."""
    labels = spec.get("labels") or {}
    language = (locale or "en").split("-")[0].lower()
    for candidate in (labels.get(language), labels.get("en")):
        if candidate:
            return candidate
    for candidate in labels.values():
        if candidate:
            return candidate
    return spec["id"]


def wire_entries(view: dict[str, Any], locale: str) -> list[dict[str, Any]]:
    """Wire-ready entries from an already-PROJECTED modvars view (``{"specs", "values"}``),
    in definition order, labels resolved to `locale`.

    This function does NO visibility filtering: the anti-metagaming filter (iron rule #3)
    is the `modvars` document projection in `core.documents` — a player viewer's view
    already lacks every keeper-only spec AND value, so they can never leave the server."""
    specs = view.get("specs")
    values = view.get("values")
    specs = specs if isinstance(specs, dict) else {}
    values = values if isinstance(values, dict) else {}
    entries: list[dict[str, Any]] = []
    for var_id, spec in specs.items():
        if not isinstance(spec, dict):
            continue
        entry: dict[str, Any] = {
            "id": var_id,
            "label": label_for(spec, locale),
            "kind": spec.get("kind", "text"),
            "value": values.get(var_id, spec.get("default")),
        }
        if spec.get("kind") == "number":
            if spec.get("minimum") is not None:
                entry["min"] = spec["minimum"]
            if spec.get("maximum") is not None:
                entry["max"] = spec["maximum"]
        entries.append(entry)
    return entries


def describe(state: ModvarState, i18n: _I18nProtocol, locale: str) -> list[str]:
    """Render every variable as one localized line for the Keeper's prompt, in definition order.

    The Keeper sees ALL variables; keeper-only ones carry a localized secrecy tag reminding the
    model the value is for its own reasoning, never to be revealed. An empty state renders `[]`.
    """
    lines: list[str] = []
    for var_id, spec in state["specs"].items():
        value = state["values"].get(var_id, spec["default"])
        if spec["kind"] == "bool":
            shown = i18n.t("modvars.describe.bool_true") if value else i18n.t("modvars.describe.bool_false")
        else:
            shown = str(value)
        if spec["kind"] == "number" and (spec.get("minimum") is not None or spec.get("maximum") is not None):
            low = spec.get("minimum")
            high = spec.get("maximum")
            shown = i18n.t(
                "modvars.describe.bounded",
                value=shown,
                minimum="-∞" if low is None else low,
                maximum="∞" if high is None else high,
            )
        line = i18n.t("modvars.describe.line", label=label_for(spec, locale), id=var_id, value=shown)
        if spec.get("visibility") == "keeper":
            line = i18n.t("modvars.describe.keeper_tagged", line=line)
        lines.append(line)
    return lines


# ---------------------------------------------------------------------------
# Document persistence (M17) — the whole modvar state is ONE `modvars`
# document (``data = {"specs", "values"}``); its projection in
# `core.documents` is the structural keeper-visibility filter.
# ---------------------------------------------------------------------------

MODVARS_DOC_TYPE = "modvars"
MODVARS_DOC_ID = "modvars"


async def load_modvars(documents: Any, chat_key: str) -> ModvarState:
    """Load and normalize this room's variable state; empty on a miss or corrupt value."""
    doc = await documents.get(chat_key, MODVARS_DOC_TYPE, MODVARS_DOC_ID)
    return normalize_state(doc.data) if doc is not None else empty_state()


async def save_modvars(documents: Any, chat_key: str, state: ModvarState) -> None:
    """Persist `state` verbatim (already normalized/validated by the caller)."""
    await documents.put(chat_key, MODVARS_DOC_TYPE, MODVARS_DOC_ID, state)


async def define_modvar(documents: Any, chat_key: str, spec: dict[str, Any]) -> None:
    """Load, add/redefine `spec`, save."""
    state = await load_modvars(documents, chat_key)
    await save_modvars(documents, chat_key, apply_define(state, spec))


async def set_modvar(documents: Any, chat_key: str, var_id: str, value: Any) -> tuple[Any, Any]:
    """Load, set the validated `value`, save, and return ``(old_value, new_value)``."""
    state = await load_modvars(documents, chat_key)
    new_state, old_value, new_value = apply_set(state, var_id, value)
    await save_modvars(documents, chat_key, new_state)
    return old_value, new_value


async def adjust_modvar(documents: Any, chat_key: str, var_id: str, delta: int) -> tuple[int, int]:
    """Load, apply `delta` to a number variable, save, and return ``(old_value, new_value)``."""
    state = await load_modvars(documents, chat_key)
    new_state, old_value, new_value = apply_adjust(state, var_id, delta)
    await save_modvars(documents, chat_key, new_state)
    return old_value, new_value


async def remove_modvar(documents: Any, chat_key: str, var_id: str) -> None:
    """Load, remove `var_id`, save."""
    state = await load_modvars(documents, chat_key)
    await save_modvars(documents, chat_key, apply_remove(state, var_id))


async def describe_modvars(documents: Any, chat_key: str, i18n: _I18nProtocol, locale: str) -> list[str]:
    """Load this room's state and render it via `describe`."""
    state = await load_modvars(documents, chat_key)
    return describe(state, i18n, locale)
