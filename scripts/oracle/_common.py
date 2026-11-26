"""Engine-aware helpers shared by the exporters (import ``_io`` first, then this)."""

from __future__ import annotations

import copy
import json
from typing import Any

from . import _io  # noqa: F401  (must be imported before the engine; installs the guards)
from ._io import jsonable

from core.character_manager import CharacterSheet  # isort: skip

# Wall-clock stamps the engine writes; never part of a vector.
_VOLATILE_SHEET_KEYS = ("created_time", "last_updated")
_VOLATILE_RECORD_KEYS = ("timestamp", "start_time", "end_time", "session_id")


def sheet_dict(sheet: CharacterSheet) -> dict[str, Any]:
    """``CharacterSheet.to_dict()`` without the timestamps, as plain JSON data."""
    data = copy.deepcopy(sheet.to_dict())
    for key in _VOLATILE_SHEET_KEYS:
        data.pop(key, None)
    return jsonable(data)


def fresh_sheet_input(system: str, name: str = "Vera", **patch: Any) -> dict[str, Any]:
    """The ``to_dict`` shape of a brand-new sheet for ``system``, with section patches merged in.

    ``patch`` keys are sheet sections (``attributes``/``skills``/``secondary_attributes``/``fields``)
    whose entries replace or add to the fresh values, or any top-level key that is simply replaced.
    A value of ``None`` inside a section deletes that entry.
    """
    data = sheet_dict(CharacterSheet(name, system))
    for key, value in patch.items():
        if key in ("attributes", "skills", "secondary_attributes", "fields") and isinstance(value, dict):
            section = dict(data.get(key) or {})
            for entry, entry_value in value.items():
                if entry_value is None:
                    section.pop(entry, None)
                else:
                    section[entry] = entry_value
            data[key] = section
        else:
            data[key] = value
    return data


def clean_session_record(raw: str | None) -> dict[str, Any] | None:
    """A stored ``session_record.current`` row without its wall-clock fields."""
    if not raw:
        return None
    record = json.loads(raw)

    def _strip(node: Any) -> Any:
        if isinstance(node, dict):
            return {key: _strip(value) for key, value in node.items() if key not in _VOLATILE_RECORD_KEYS}
        if isinstance(node, list):
            return [_strip(item) for item in node]
        return node

    return _strip(record)
