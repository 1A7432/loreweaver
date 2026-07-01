"""Auth keystore for the networked TUI (M4 spec §"Auth / keystore").

No registration: a deployer runs the admin CLI (``python -m app --tui-key
add --room R --name N [--role player|keeper]``, see ``app.py``) to mint an
opaque key and hands it to a player. ``net.tui_server.TuiServer`` looks the
key up on ``join`` to authenticate a connection and bind it to a room —
unknown keys are rejected, there is no sign-up flow.

Backed by a flat TOML file, one ``[key]`` table per entry (see the shipped
``keys.example.toml``): stdlib ``tomllib`` handles reading; ``save`` uses a
small dependency-free writer since ``tomllib`` is read-only.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from pathlib import Path

import tomllib

_ROLES = ("player", "keeper")
_DEFAULT_ROLE = "player"


@dataclass
class KeyEntry:
    """One keystore entry: an opaque key bound to a room, display name and role."""

    key: str
    room: str
    name: str = ""
    role: str = _DEFAULT_ROLE


class Keystore:
    """In-memory `key -> KeyEntry` table, loadable from and savable back to a TOML file."""

    def __init__(self, entries: dict[str, KeyEntry] | None = None) -> None:
        self._entries: dict[str, KeyEntry] = dict(entries) if entries else {}

    @classmethod
    def load(cls, path: str | Path) -> Keystore:
        """Load a keystore from `path`; a missing file loads as an empty keystore."""
        file_path = Path(path)
        if not file_path.is_file():
            return cls()

        with file_path.open("rb") as handle:
            raw = tomllib.load(handle)

        entries: dict[str, KeyEntry] = {}
        for key, table in raw.items():
            if not isinstance(table, dict):
                continue
            room = str(table.get("room", "") or "")
            if not room:
                continue
            entries[key] = KeyEntry(
                key=key,
                room=room,
                name=str(table.get("name", "") or ""),
                role=_normalize_role(table.get("role")),
            )
        return cls(entries)

    def get(self, key: str) -> KeyEntry | None:
        """Look up `key`, or `None` if it isn't registered."""
        return self._entries.get(key)

    def add(self, room: str, name: str = "", role: str = _DEFAULT_ROLE) -> str:
        """Mint a fresh url-safe key bound to `room`, register it, and return it."""
        key = secrets.token_urlsafe(18)
        self._entries[key] = KeyEntry(key=key, room=room, name=name, role=_normalize_role(role))
        return key

    def entries(self) -> list[KeyEntry]:
        """Every registered entry, in insertion order."""
        return list(self._entries.values())

    def save(self, path: str | Path) -> None:
        """Write every entry back out as TOML (one `[key]` table each)."""
        file_path = Path(path)
        file_path.parent.mkdir(parents=True, exist_ok=True)
        blocks = []
        for entry in self._entries.values():
            lines = [f"[{_toml_string(entry.key)}]", f"room = {_toml_string(entry.room)}"]
            if entry.name:
                lines.append(f"name = {_toml_string(entry.name)}")
            lines.append(f"role = {_toml_string(entry.role)}")
            blocks.append("\n".join(lines))
        file_path.write_text(("\n\n".join(blocks) + "\n") if blocks else "", encoding="utf-8")

    def __len__(self) -> int:
        return len(self._entries)


def _normalize_role(role: object) -> str:
    text = str(role or _DEFAULT_ROLE)
    return text if text in _ROLES else _DEFAULT_ROLE


def _toml_string(value: str) -> str:
    """Render `value` as a quoted TOML basic string."""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    escaped = escaped.replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return f'"{escaped}"'
