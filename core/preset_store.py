"""Imported ST completion presets on disk — discovery + load (``data_dir/presets/``).

The persistence half of `core.preset` (which stays pure/stdlib, no I/O): a keeper's
``.preset import <path>`` lands the file VERBATIM as ``data_dir/presets/<id>.json``
(the imported file is the source of truth; normalization happens on every load), rooms
then enable ONE preset id (the ``preset_enabled.<chat_key>`` store flag, managed by
`gateway.ops`), and `agent.prompt_builder` folds `core.preset.style_segments` of the
enabled preset into the assembled system prompt.

Load failures ALWAYS degrade to ``None`` — a deleted, corrupt, oversized or
unparseable preset file must never break a room's turn; the prompt builder depends on
that contract the same way it tolerates a missing skill id.
"""

from __future__ import annotations

import re
from pathlib import Path

from core.preset import MAX_PRESET_BYTES, StPreset, parse_st_preset

PRESET_DIR_NAME = "presets"

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def presets_dir(data_dir: str | Path) -> Path:
    return Path(data_dir) / PRESET_DIR_NAME


def sanitize_preset_id(name: str) -> str:
    """A filesystem-safe preset id from a filename (or stem): lowercased, every run of
    characters outside ``[a-z0-9]`` collapsed to one dash, capped at 64 chars. A stem
    that leaves nothing usable (e.g. a fully-CJK title) falls back to ``"preset"``;
    an empty input stays ``""`` so callers can reject it."""
    stem = Path(str(name)).stem.strip().lower()
    if not stem:
        return ""
    slug = re.sub(r"[^a-z0-9]+", "-", stem).strip("-")[:64]
    return slug if slug and _ID_RE.match(slug) else "preset"


def list_preset_ids(data_dir: str | Path) -> list[str]:
    """Installed preset ids (sorted); tolerates a missing/unreadable directory."""
    try:
        return sorted(
            path.stem
            for path in presets_dir(data_dir).glob("*.json")
            if path.is_file() and _ID_RE.match(path.stem)
        )
    except OSError:
        return []


def save_preset_text(data_dir: str | Path, preset_id: str, text: str) -> Path:
    """Persist an ALREADY-PARSED preset's raw text under ``presets/<id>.json``.

    Callers must run `core.preset.parse_st_preset` first (the command surface does) —
    this function only writes. Raises ``ValueError`` on a malformed id; ``OSError``
    propagates to the caller's localized error path."""
    if not isinstance(preset_id, str) or not _ID_RE.match(preset_id):
        raise ValueError(f"not a preset id: {preset_id!r}")  # i18n-exempt: wrapped by the command's localized reply
    directory = presets_dir(data_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{preset_id}.json"
    path.write_text(text, encoding="utf-8")
    return path


def load_preset(data_dir: str | Path, preset_id: str) -> StPreset | None:
    """Parse ``presets/<id>.json`` through the real parser; ``None`` on ANY failure."""
    if not isinstance(preset_id, str) or not _ID_RE.match(preset_id):
        return None
    path = presets_dir(data_dir) / f"{preset_id}.json"
    try:
        if path.stat().st_size > MAX_PRESET_BYTES:
            return None
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    try:
        return parse_st_preset(text, preset_id)
    except ValueError:
        return None
