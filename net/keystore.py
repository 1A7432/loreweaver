"""Auth keystore for the networked TUI (M4 spec §"Auth / keystore").

No registration: a deployer runs the admin CLI (``python -m app --tui-key
add --room R --name N [--role player|keeper]``, see ``app.py``) to mint an
opaque key and hands it to a player. ``net.tui_server.TuiServer`` looks the
key up on ``join`` to authenticate a connection and bind it to a room —
unknown keys are rejected, there is no sign-up flow.

Backed by a flat TOML file, one ``[key]`` table per entry (see the shipped
``keys.example.toml``). Writers use ``persisted_mutation()`` so each update
starts from the latest file and ends in one atomic replacement.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import threading
import time
import tomllib
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from infra.file_permissions import atomic_write_private, ensure_private_directory, restrict_file

_ROLES = ("player", "keeper")
_DEFAULT_ROLE = "player"
_PURPOSES = ("join", "chat_bind")
_DEFAULT_PURPOSE = "join"
_PATH_LOCKS: dict[str, threading.RLock] = {}
_PATH_LOCKS_GUARD = threading.Lock()


@dataclass
class KeyEntry:
    """One opaque key bound to a room and a single authentication purpose."""

    key: str
    room: str
    name: str = ""
    role: str = _DEFAULT_ROLE
    purpose: str = _DEFAULT_PURPOSE
    expires_at: float | None = None


def member_id_for_key(key: str) -> str:
    """Return the non-secret TUI member id derived during the join handshake."""
    return f"tui:{hashlib.sha1(key.encode('utf-8')).hexdigest()[:8]}"


def _copy_entry(entry: KeyEntry) -> KeyEntry:
    return KeyEntry(
        key=entry.key,
        room=entry.room,
        name=entry.name,
        role=entry.role,
        purpose=entry.purpose,
        expires_at=entry.expires_at,
    )


def _copy_entries(entries: dict[str, KeyEntry]) -> dict[str, KeyEntry]:
    return {key: _copy_entry(entry) for key, entry in entries.items()}


def _read_entries(file_path: Path) -> dict[str, KeyEntry]:
    if not file_path.is_file():
        return {}
    # Self-heal a legacy/world-readable keystore before reading bearer keys.
    restrict_file(file_path)
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
            purpose=_normalize_purpose(table.get("purpose")),
            expires_at=_normalize_expires_at(table.get("expires_at")),
        )
    return entries


def _file_signature(file_path: Path) -> tuple[int, int, int] | None:
    """Cheap change token for an atomically replaced keystore file."""
    try:
        stat = file_path.stat()
    except FileNotFoundError:
        return None
    return (stat.st_ino, stat.st_size, stat.st_mtime_ns)


def _render_entries(entries: dict[str, KeyEntry]) -> str:
    blocks = []
    for entry in entries.values():
        lines = [f"[{_toml_string(entry.key)}]", f"room = {_toml_string(entry.room)}"]
        if entry.name:
            lines.append(f"name = {_toml_string(entry.name)}")
        lines.append(f"role = {_toml_string(entry.role)}")
        lines.append(f"purpose = {_toml_string(entry.purpose)}")
        if entry.expires_at is not None:
            lines.append(f"expires_at = {entry.expires_at}")
        blocks.append("\n".join(lines))
    return ("\n\n".join(blocks) + "\n") if blocks else ""


def _thread_lock_for(file_path: Path) -> threading.RLock:
    identity = str(file_path.resolve(strict=False))
    with _PATH_LOCKS_GUARD:
        return _PATH_LOCKS.setdefault(identity, threading.RLock())


@contextmanager
def _locked_keystore(file_path: Path) -> Iterator[None]:
    """Hold a process-wide and OS-level exclusive lock for one keystore path.

    The sidecar is deliberately persistent: unlinking a lock file lets late openers lock a new
    inode and bypass a holder of the old one. It contains no secrets and is owner-only.
    """
    ensure_private_directory(file_path.parent, tighten_existing=False)
    lock_path = file_path.with_name(f".{file_path.name}.lock")
    thread_lock = _thread_lock_for(file_path)
    with thread_lock:
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            restrict_file(lock_path)
            if os.name == "nt":
                import msvcrt

                if os.fstat(fd).st_size == 0:
                    os.write(fd, b"\0")
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                yield
            finally:
                if os.name == "nt":
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


class Keystore:
    """In-memory ``key -> KeyEntry`` table with optional TOML persistence."""

    def __init__(self, entries: dict[str, KeyEntry] | None = None, *, path: str | Path | None = None) -> None:
        self._entries: dict[str, KeyEntry] = _copy_entries(entries or {})
        self._path: Path | None = Path(path) if path is not None else None
        self._disk_signature = _file_signature(self._path) if self._path is not None else None

    @classmethod
    def load(cls, path: str | Path) -> Keystore:
        """Load ``path``; a missing file creates an empty file-backed keystore."""
        file_path = Path(path)
        # Remember the version observed *before* the read. If an atomic writer
        # replaces the file while it is being parsed, the next authorization
        # check sees a different signature and refreshes instead of caching old
        # entries under the replacement file's signature.
        disk_signature = _file_signature(file_path)
        loaded = cls(_read_entries(file_path), path=file_path)
        loaded._disk_signature = disk_signature
        return loaded

    @property
    def path(self) -> Path | None:
        """The file this keystore was loaded from / persists to, if any."""
        return self._path

    def get(self, key: str, *, purpose: str | None = _DEFAULT_PURPOSE) -> KeyEntry | None:
        """Look up a non-expired key for ``purpose``; ``None`` exposes all purposes to admin code."""
        entry = self._entries.get(key)
        if entry is None or (purpose is not None and entry.purpose != purpose):
            return None
        if purpose is not None and entry.expires_at is not None and entry.expires_at <= time.time():
            return None
        return entry

    def is_empty(self) -> bool:
        """True when no active TUI join keys exist."""
        return not self.entries()

    def refresh(self) -> None:
        """Replace memory with the current file, if this keystore is file-backed."""
        if self._path is None:
            return
        disk_signature = _file_signature(self._path)
        self._entries = _read_entries(self._path)
        self._disk_signature = disk_signature

    def refresh_if_changed(self) -> None:
        """Refresh only after an external atomic file replacement.

        Live authorization calls this frequently, so unchanged traffic pays one
        stat rather than an exclusive flock plus a full TOML parse.
        """
        if self._path is None:
            return
        if _file_signature(self._path) != self._disk_signature:
            self.refresh()

    def authorize_member(
        self,
        member_id: str,
        *,
        room: str,
        required_role: str | None = None,
    ) -> KeyEntry | None:
        """Resolve a connected member against current persistent authorization.

        `SessionCore` only retains the derived member id, not the bearer key. This method maps that
        id back to exactly one current key entry and validates its original room binding plus an
        optional live role. A collision, deletion, room move, or downgrade fails closed. A
        file-backed store reloads only when its atomic file signature changes.
        """
        self.refresh_if_changed()
        entries = self._entries
        now = time.time()
        matches = [
            entry
            for key, entry in entries.items()
            if entry.purpose == _DEFAULT_PURPOSE
            and (entry.expires_at is None or entry.expires_at > now)
            and member_id_for_key(key) == member_id
        ]
        if len(matches) != 1:
            return None
        entry = matches[0]
        if entry.room != room:
            return None
        if required_role is not None and entry.role != required_role:
            return None
        return _copy_entry(entry)

    def add(
        self,
        room: str,
        name: str = "",
        role: str = _DEFAULT_ROLE,
        *,
        purpose: str = _DEFAULT_PURPOSE,
        expires_at: float | None = None,
    ) -> str:
        """Mint a fresh url-safe key bound to `room`, register it, and return it."""
        key = secrets.token_urlsafe(18)
        self._entries[key] = KeyEntry(
            key=key,
            room=room,
            name=name,
            role=_normalize_role(role),
            purpose=_normalize_purpose(purpose),
            expires_at=_normalize_expires_at(expires_at),
        )
        return key

    def consume(
        self,
        key: str,
        *,
        purpose: str,
        required_role: str | None = None,
    ) -> KeyEntry | None:
        """Atomically consume one valid purpose-scoped token."""
        consumed: KeyEntry | None = None
        with self.persisted_mutation():
            entry = self._entries.get(key)
            if entry is None or entry.purpose != purpose:
                return None
            if entry.expires_at is not None and entry.expires_at <= time.time():
                self._entries.pop(key, None)
                return None
            if required_role is not None and entry.role != required_role:
                return None
            consumed = _copy_entry(entry)
            self._entries.pop(key, None)
        return consumed

    def update(self, key: str, *, room: str | None = None, name: str | None = None, role: str | None = None) -> bool:
        """Update an existing key entry in place; return whether it existed."""
        entry = self._entries.get(key)
        if entry is None:
            return False
        if room is not None:
            entry.room = room
        if name is not None:
            entry.name = name
        if role is not None:
            entry.role = _normalize_role(role)
        return True

    def remove(self, key: str) -> bool:
        """Delete one key entry; return whether it existed."""
        return self._entries.pop(key, None) is not None

    def remove_room(self, room: str) -> int:
        """Delete every key bound to `room`; return the number removed."""
        keys = [key for key, entry in self._entries.items() if entry.room == room]
        for key in keys:
            self._entries.pop(key, None)
        return len(keys)

    def restore(self, key: str, *, room: str, name: str = "", role: str = _DEFAULT_ROLE) -> bool:
        """Re-create an EXACT key entry from a backup snapshot (unlike `add`, which mints a
        fresh random key). The role is normalized; a blank key or room is rejected. Callers
        must themselves guard against clobbering a key that belongs to a different room."""
        key = key.strip()
        room = room.strip()
        if not key or not room:
            return False
        self._entries[key] = KeyEntry(key=key, room=room, name=name, role=_normalize_role(role))
        return True

    def entries(self, *, purpose: str | None = _DEFAULT_PURPOSE) -> list[KeyEntry]:
        """Non-expired entries in insertion order; normal callers see join keys only."""
        now = time.time()
        return [
            entry
            for entry in self._entries.values()
            if (purpose is None or entry.purpose == purpose)
            and (entry.expires_at is None or entry.expires_at > now)
        ]

    @contextmanager
    def persisted_mutation(self) -> Iterator[Keystore]:
        """Read the latest file, mutate it under one writer lock, then atomically replace it."""
        if self._path is None:
            yield self
            return

        file_path = self._path
        with _locked_keystore(file_path):
            latest = _read_entries(file_path)
            self._entries = _copy_entries(latest)
            try:
                yield self
                atomic_write_private(file_path, _render_entries(self._entries))
            except Exception:
                self._entries = latest
                raise
            self._disk_signature = _file_signature(file_path)

    def __len__(self) -> int:
        return len(self._entries)


def _normalize_role(role: object) -> str:
    text = str(role or _DEFAULT_ROLE)
    return text if text in _ROLES else _DEFAULT_ROLE


def _normalize_purpose(purpose: object) -> str:
    text = str(purpose or _DEFAULT_PURPOSE)
    return text if text in _PURPOSES else _DEFAULT_PURPOSE


def _normalize_expires_at(value: object) -> float | None:
    if value is None:
        return None
    try:
        expires_at = float(value)
    except (TypeError, ValueError):
        return None
    return expires_at if expires_at > 0 else None


def _toml_string(value: str) -> str:
    """Render `value` as a quoted TOML basic string."""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    escaped = escaped.replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return f'"{escaped}"'
