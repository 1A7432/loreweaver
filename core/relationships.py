"""Deterministic relationship tracks (好感/情欲) between named entities.

Iron rule #1 (deterministic vs generative split): the relationship VALUES are real code —
clamped, persisted, and read back deterministically — the AI Keeper only narrates around them
(``agent.kp_tools_relationships`` is the tool surface; ``agent.prompt_builder`` folds the current
state into the main KP prompt). This module is intentionally self-contained (stdlib + json only):
no ``agent``/``infra`` imports, only a duck-typed store `Protocol` so it can be unit-tested and
reused without dragging in the rest of the stack (mirrors ``core.worldbook``'s layering).

State shape is a nested, directional dict: ``{subject: {target: {track_id: int}}}`` — "subject's
feeling toward target". Directional and asymmetric by design (Alice's affection for Bob need not
equal Bob's for Alice); subject/target are arbitrary entity display-name strings (PC/NPC/companion
names), not ids.

``TRACKS`` is a small registry so a new track is trivial to add later without touching the pure
functions below, which all operate generically over ``TRACKS``.
"""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from typing import Any, Protocol

# ---------------------------------------------------------------------------
# Track registry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RelationshipTrack:
    """One relationship dimension's valid range, default, and localized label key."""

    min: int
    max: int
    default: int
    label_key: str


TRACKS: dict[str, RelationshipTrack] = {
    "affection": RelationshipTrack(min=-100, max=100, default=0, label_key="relationships.track.affection"),
    "desire": RelationshipTrack(min=0, max=100, default=0, label_key="relationships.track.desire"),
}

RelationshipState = dict[str, dict[str, dict[str, int]]]


class _StoreProtocol(Protocol):
    """Duck-typed shape of `infra.store.Store` — just enough to load/save relationship state."""

    async def get(self, user_key: str = "", store_key: str = "") -> str | None: ...

    async def set(self, user_key: str = "", store_key: str = "", value: str | None = None) -> None: ...


class _I18nProtocol(Protocol):
    """Duck-typed shape of `infra.i18n.I18n` — just the lookup `describe` needs."""

    def t(self, key: str, **kwargs: Any) -> str: ...


# ---------------------------------------------------------------------------
# Pure functions — no I/O, fully unit-tested
# ---------------------------------------------------------------------------


def known_track(track_id: str) -> bool:
    """Whether `track_id` is a registered track in `TRACKS`."""
    return track_id in TRACKS


def clamp(track_id: str, value: int) -> int:
    """Clamp `value` to `track_id`'s ``[min, max]``. Raises `ValueError` for an unknown track."""
    track = TRACKS.get(track_id)
    if track is None:
        raise ValueError(f"unknown relationship track: {track_id!r}")
    return max(track.min, min(track.max, value))


def coerce_int(value: Any) -> int | None:
    """Tolerant int parse: accepts an `int`, an `float`, or a numeric string like ``"+10"``,
    ``"-5"``, or ``" 3 "``. Returns `None` on anything that isn't a plausible integer, rather than
    raising — callers use this to validate model-supplied tool arguments defensively."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        # ``int(nan)`` raises ValueError and ``int(inf)`` raises OverflowError — both are
        # "not a plausible integer", so degrade to None rather than propagating (this function
        # is documented as total; a hostile stored ``Infinity``/``NaN`` reaches here via
        # ``normalize_state`` because ``json.loads`` accepts those constants by default).
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
                # ``float("inf")``/``float("1e400")`` parse fine, but ``int(inf)`` overflows —
                # catch that alongside the plain non-numeric ValueError.
                return int(float(text))
            except (ValueError, OverflowError):
                return None
    return None


def normalize_state(raw: Any) -> RelationshipState:
    """Defensively coerce an arbitrary loaded object into the ``{subject: {target: {track: int}}}``
    shape: unknown tracks and non-int values are dropped, and any structurally wrong input (not a
    dict, wrong nesting, etc.) degrades to an empty dict rather than raising."""
    result: RelationshipState = {}
    if not isinstance(raw, dict):
        return result

    for subject, targets in raw.items():
        if not isinstance(subject, str) or not isinstance(targets, dict):
            continue
        cleaned_targets: dict[str, dict[str, int]] = {}
        for target, tracks in targets.items():
            if not isinstance(target, str) or not isinstance(tracks, dict):
                continue
            cleaned_tracks: dict[str, int] = {}
            for track_id, value in tracks.items():
                if not isinstance(track_id, str) or not known_track(track_id):
                    continue
                coerced = coerce_int(value)
                if coerced is None:
                    continue
                cleaned_tracks[track_id] = clamp(track_id, coerced)
            if cleaned_tracks:
                cleaned_targets[target] = cleaned_tracks
        if cleaned_targets:
            result[subject] = cleaned_targets
    return result


def apply_delta(
    state: RelationshipState, subject: str, target: str, track_id: str, delta: int
) -> tuple[RelationshipState, int, int]:
    """Apply a signed `delta` to `subject`'s `track_id` feeling toward `target`.

    Returns ``(new_state, old_value, new_value)``: `old_value` defaults to the track's default
    when unset, `new_value` is ``clamp(old_value + delta)``. `state` is never mutated — a deep
    copy is returned. Raises `ValueError` for an unknown `track_id`.
    """
    if not known_track(track_id):
        raise ValueError(f"unknown relationship track: {track_id!r}")

    new_state = copy.deepcopy(state)
    tracks = new_state.setdefault(subject, {}).setdefault(target, {})
    old_value = tracks.get(track_id, TRACKS[track_id].default)
    new_value = clamp(track_id, old_value + delta)
    tracks[track_id] = new_value
    return new_state, old_value, new_value


def set_value(state: RelationshipState, subject: str, target: str, track_id: str, value: int) -> tuple[RelationshipState, int]:
    """Set `subject`'s `track_id` feeling toward `target` to an exact (clamped) `value`.

    Returns ``(new_state, clamped_value)``. `state` is never mutated. Raises `ValueError` for an
    unknown `track_id`.
    """
    if not known_track(track_id):
        raise ValueError(f"unknown relationship track: {track_id!r}")

    new_state = copy.deepcopy(state)
    clamped = clamp(track_id, value)
    new_state.setdefault(subject, {}).setdefault(target, {})[track_id] = clamped
    return new_state, clamped


def describe(state: RelationshipState, i18n: _I18nProtocol) -> list[str]:
    """Render every subject->target pair's non-default tracks as one localized line each.

    Deterministic ordering: subjects, then targets, then tracks, all sorted — so the same state
    always renders identically (load-bearing for the prompt-builder fold-in's byte-identical
    invariant). A subject/target pair with every track at its default contributes nothing; an
    empty or all-default `state` renders as `[]`.
    """
    lines: list[str] = []
    for subject in sorted(state):
        targets = state[subject]
        for target in sorted(targets):
            tracks = targets[target]
            pairs = []
            for track_id in sorted(tracks):
                track = TRACKS.get(track_id)
                if track is None:
                    continue
                value = tracks[track_id]
                if value == track.default:
                    continue
                label = i18n.t(track.label_key)
                pairs.append(i18n.t("relationships.describe.pair", label=label, value=value))
            if not pairs:
                continue
            lines.append(
                i18n.t("relationships.describe.line", subject=subject, target=target, tracks=", ".join(pairs))
            )
    return lines


# ---------------------------------------------------------------------------
# RelationshipManager — thin async persistence wrapper over the pure functions
# ---------------------------------------------------------------------------


def _store_key(chat_key: str) -> str:
    return f"relationships.{chat_key}"


class RelationshipManager:
    """Async load/save wrapper over the pure state functions above, keyed by `chat_key`."""

    def __init__(self, store: _StoreProtocol) -> None:
        self._store = store

    async def load(self, chat_key: str) -> RelationshipState:
        """Load and normalize this chat's relationship state; `{}` on a miss or corrupt value."""
        raw = await self._store.get(user_key="", store_key=_store_key(chat_key))
        if not raw:
            return {}
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return {}
        return normalize_state(data)

    async def save(self, chat_key: str, state: RelationshipState) -> None:
        """Persist `state` verbatim (already normalized/clamped by the caller)."""
        await self._store.set(user_key="", store_key=_store_key(chat_key), value=json.dumps(state, ensure_ascii=False))

    async def adjust(self, chat_key: str, subject: str, target: str, track_id: str, delta: int) -> tuple[int, int]:
        """Load, apply `delta`, save, and return ``(old_value, new_value)``."""
        state = await self.load(chat_key)
        new_state, old_value, new_value = apply_delta(state, subject, target, track_id, delta)
        await self.save(chat_key, new_state)
        return old_value, new_value

    async def set(self, chat_key: str, subject: str, target: str, track_id: str, value: int) -> int:
        """Load, set the exact (clamped) `value`, save, and return the clamped value."""
        state = await self.load(chat_key)
        new_state, clamped = set_value(state, subject, target, track_id, value)
        await self.save(chat_key, new_state)
        return clamped

    async def describe(self, chat_key: str, i18n: _I18nProtocol) -> list[str]:
        """Load this chat's state and render it via `describe`."""
        state = await self.load(chat_key)
        return describe(state, i18n)
