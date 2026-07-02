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
import tomllib
from dataclasses import dataclass
from pathlib import Path

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

    def __init__(self, entries: dict[str, KeyEntry] | None = None, *, path: str | Path | None = None) -> None:
        self._entries: dict[str, KeyEntry] = dict(entries) if entries else {}
        # The file this keystore was loaded from (if any). `persist()` writes back
        # to it, so a key minted at runtime (e.g. via the web admin panel) survives
        # a restart. An in-memory keystore (tests) has no path and never persists.
        self._path: Path | None = Path(path) if path is not None else None

    @classmethod
    def load(cls, path: str | Path) -> Keystore:
        """Load a keystore from `path`; a missing file loads as an empty keystore
        (still remembering `path`, so a later `persist()`/`add` can create it)."""
        file_path = Path(path)
        if not file_path.is_file():
            return cls(path=file_path)

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
        return cls(entries, path=file_path)

    @property
    def path(self) -> Path | None:
        """The file this keystore was loaded from / persists to, if any."""
        return self._path

    def get(self, key: str) -> KeyEntry | None:
        """Look up `key`, or `None` if it isn't registered."""
        return self._entries.get(key)

    def refresh(self) -> None:
        """Re-read the backing file, ADDING any keys not already in memory (never
        dropping in-memory entries). Lets a running server pick up keys minted after
        it booted — no restart needed. No-op for a pathless / missing-file keystore."""
        if self._path is None or not self._path.is_file():
            return
        for key, entry in Keystore.load(self._path)._entries.items():
            self._entries.setdefault(key, entry)

    def add(self, room: str, name: str = "", role: str = _DEFAULT_ROLE) -> str:
        """Mint a fresh url-safe key bound to `room`, register it, and return it."""
        key = secrets.token_urlsafe(18)
        self._entries[key] = KeyEntry(key=key, room=room, name=name, role=_normalize_role(role))
        return key

    def entries(self) -> list[KeyEntry]:
        """Every registered entry, in insertion order."""
        return list(self._entries.values())

    def save(self, path: str | Path | None = None) -> None:
        """Write every entry back out as TOML (one `[key]` table each).

        `path` defaults to the file this keystore was loaded from; passing one
        both writes there and remembers it as the new persistence target.
        """
        target = path if path is not None else self._path
        if target is None:
            raise ValueError("Keystore.save requires a path (this keystore has none).")  # i18n-exempt: internal misuse error
        file_path = Path(target)
        self._path = file_path
        file_path.parent.mkdir(parents=True, exist_ok=True)
        blocks = []
        for entry in self._entries.values():
            lines = [f"[{_toml_string(entry.key)}]", f"room = {_toml_string(entry.room)}"]
            if entry.name:
                lines.append(f"name = {_toml_string(entry.name)}")
            lines.append(f"role = {_toml_string(entry.role)}")
            blocks.append("\n".join(lines))
        file_path.write_text(("\n\n".join(blocks) + "\n") if blocks else "", encoding="utf-8")

    def persist(self) -> bool:
        """Save back to the remembered `path`, if any; return whether it wrote.

        A no-op (returning False) for an in-memory keystore, so runtime minting
        works in tests without a backing file.
        """
        if self._path is None:
            return False
        self.save(self._path)
        return True

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
