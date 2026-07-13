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

import hashlib
import os
import secrets
import threading
import tomllib
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from infra.file_permissions import atomic_write_private, ensure_private_directory, restrict_file

_ROLES = ("player", "keeper")
_DEFAULT_ROLE = "player"
_PATH_LOCKS: dict[str, threading.RLock] = {}
_PATH_LOCKS_GUARD = threading.Lock()


@dataclass
class KeyEntry:
    """One keystore entry: an opaque key bound to a room, display name and role."""

    key: str
    room: str
    name: str = ""
    role: str = _DEFAULT_ROLE


class KeystoreConflictError(RuntimeError):
    """A locally-added exact key collided with a different entry on disk."""


def member_id_for_key(key: str) -> str:
    """Return the non-secret TUI member id derived during the join handshake."""
    return f"tui:{hashlib.sha1(key.encode('utf-8')).hexdigest()[:8]}"


def _copy_entry(entry: KeyEntry) -> KeyEntry:
    return KeyEntry(key=entry.key, room=entry.room, name=entry.name, role=entry.role)


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
        )
    return entries


def _render_entries(entries: dict[str, KeyEntry]) -> str:
    blocks = []
    for entry in entries.values():
        lines = [f"[{_toml_string(entry.key)}]", f"room = {_toml_string(entry.room)}"]
        if entry.name:
            lines.append(f"name = {_toml_string(entry.name)}")
        lines.append(f"role = {_toml_string(entry.role)}")
        blocks.append("\n".join(lines))
    return ("\n\n".join(blocks) + "\n") if blocks else ""


def _merge_local_changes(
    latest: dict[str, KeyEntry],
    baseline: dict[str, KeyEntry],
    current: dict[str, KeyEntry],
) -> dict[str, KeyEntry]:
    """Apply only local deltas to a freshly-read disk snapshot.

    Deltas are field-level, so a stale name edit cannot undo an independently persisted
    keeper-to-player downgrade. An external deletion is authoritative and is never resurrected by
    a stale local edit; explicit local deletions remain deletions.
    """
    merged = _copy_entries(latest)
    for key, before in baseline.items():
        after = current.get(key)
        if after is None:
            merged.pop(key, None)
            continue
        if after == before:
            continue
        target = merged.get(key)
        if target is None:
            # Revocation on disk wins over a stale local edit.
            continue
        for field in ("room", "name", "role"):
            value = getattr(after, field)
            if value != getattr(before, field):
                setattr(target, field, value)

    for key, entry in current.items():
        if key in baseline:
            continue
        existing = merged.get(key)
        if existing is None:
            merged[key] = _copy_entry(entry)
        elif existing != entry:
            # Never put the bearer key in an exception that an outer layer may log.
            raise KeystoreConflictError("keystore key collision")  # i18n-exempt: internal error
    return merged


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
    """In-memory `key -> KeyEntry` table, loadable from and savable back to a TOML file."""

    def __init__(self, entries: dict[str, KeyEntry] | None = None, *, path: str | Path | None = None) -> None:
        self._entries: dict[str, KeyEntry] = _copy_entries(entries or {})
        # Last authoritative disk snapshot. Comparing it with `_entries` lets `save()` merge a
        # direct `load(); add/update/remove(); save()` caller onto the newest file without losing
        # another process's changes.
        self._baseline: dict[str, KeyEntry] = _copy_entries(self._entries)
        # The file this keystore was loaded from (if any). `persist()` writes back
        # to it, so a key minted at runtime (e.g. via the web admin panel) survives
        # a restart. An in-memory keystore (tests) has no path and never persists.
        self._path: Path | None = Path(path) if path is not None else None

    @classmethod
    def load(cls, path: str | Path) -> Keystore:
        """Load a keystore from `path`; a missing file loads as an empty keystore
        (still remembering `path`, so a later `persist()`/`add` can create it)."""
        file_path = Path(path)
        return cls(_read_entries(file_path), path=file_path)

    @property
    def path(self) -> Path | None:
        """The file this keystore was loaded from / persists to, if any."""
        return self._path

    def get(self, key: str) -> KeyEntry | None:
        """Look up `key`, or `None` if it isn't registered."""
        return self._entries.get(key)

    def is_empty(self) -> bool:
        """True when no keys are registered — the first-run signal for bootstrapping."""
        return not self._entries

    def refresh(self) -> None:
        """Merge local pending edits onto the latest authoritative backing file.

        Unchanged memory never masks disk revocations, room moves, or role downgrades. Locally
        minted-but-not-yet-saved keys remain pending so legacy `add(); refresh(); save()` callers do
        not lose their own work. A missing backing file is an authoritative empty snapshot.
        """
        if self._path is None:
            return
        with _locked_keystore(self._path):
            latest = _read_entries(self._path)
            merged = _merge_local_changes(latest, self._baseline, self._entries)
        self._entries = merged
        self._baseline = _copy_entries(latest)

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
        optional live role. A collision, deletion, room move, or downgrade fails closed. Pathless
        test keystores use their in-memory entries; file-backed stores read disk under the same lock
        as writers so a long-lived connection cannot keep stale keeper power.
        """
        if self._path is None:
            entries = _copy_entries(self._entries)
        else:
            with _locked_keystore(self._path):
                entries = _read_entries(self._path)
            # Active authorization is deliberately authoritative rather than delta-preserving:
            # there must be no stale in-memory keeper role for adjacent code to observe afterward.
            self._entries = _copy_entries(entries)
            self._baseline = _copy_entries(entries)
        matches = [entry for key, entry in entries.items() if member_id_for_key(key) == member_id]
        if len(matches) != 1:
            return None
        entry = matches[0]
        if entry.room != room:
            return None
        if required_role is not None and entry.role != required_role:
            return None
        return _copy_entry(entry)

    def add(self, room: str, name: str = "", role: str = _DEFAULT_ROLE) -> str:
        """Mint a fresh url-safe key bound to `room`, register it, and return it."""
        key = secrets.token_urlsafe(18)
        self._entries[key] = KeyEntry(key=key, room=room, name=name, role=_normalize_role(role))
        return key

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

    def entries(self) -> list[KeyEntry]:
        """Every registered entry, in insertion order."""
        return list(self._entries.values())

    @contextmanager
    def persisted_mutation(self) -> Iterator[Keystore]:
        """Lock, re-read, mutate, and atomically persist one authoritative snapshot.

        Reloading happens *inside* the cross-process lock and before caller code runs, so runtime
        admin mutations do not overwrite an independently executed ``--tui-key add``. Any caller
        or write failure restores memory to the current on-disk snapshot.
        """
        if self._path is None:
            previous = _copy_entries(self._entries)
            previous_baseline = _copy_entries(self._baseline)
            try:
                yield self
            except BaseException:
                self._entries = previous
                self._baseline = previous_baseline
                raise
            return

        file_path = self._path
        rollback_baseline = _copy_entries(self._baseline)
        latest: dict[str, KeyEntry] | None = None
        try:
            with _locked_keystore(file_path):
                latest = _read_entries(file_path)
                # Preserve any pending local delta, but apply it field-by-field to the latest file.
                try:
                    before_mutation = _merge_local_changes(latest, self._baseline, self._entries)
                except BaseException:
                    self._entries = _copy_entries(latest)
                    self._baseline = _copy_entries(latest)
                    raise
                self._entries = before_mutation
                self._baseline = _copy_entries(latest)
                try:
                    yield self
                    atomic_write_private(file_path, _render_entries(self._entries))
                except BaseException:
                    # The atomic writer leaves `latest` intact. Match memory to that same authority,
                    # dropping both this mutation and any older unpersisted local delta.
                    self._entries = _copy_entries(latest)
                    self._baseline = _copy_entries(latest)
                    raise
                self._baseline = _copy_entries(self._entries)
        except BaseException:
            if latest is None:
                # Lock/read failures happen before a newer snapshot is available; at minimum, drop
                # all pending mutations back to the last known authoritative baseline.
                self._entries = rollback_baseline
                self._baseline = _copy_entries(rollback_baseline)
            raise

    def save(self, path: str | Path | None = None) -> None:
        """Merge local deltas onto the latest file, then atomically write TOML.

        `path` defaults to the file this keystore was loaded from; passing one
        both writes there and remembers it as the new persistence target.
        """
        target = path if path is not None else self._path
        if target is None:
            raise ValueError("Keystore.save requires a path (this keystore has none).")  # i18n-exempt: internal misuse error
        file_path = Path(target)
        previous_path = self._path
        previous_baseline = _copy_entries(self._baseline)
        same_target = previous_path is not None and file_path.resolve(strict=False) == previous_path.resolve(strict=False)
        baseline = self._baseline if same_target else {}
        latest: dict[str, KeyEntry] | None = None
        try:
            with _locked_keystore(file_path):
                latest = _read_entries(file_path)
                merged = _merge_local_changes(latest, baseline, self._entries)
                atomic_write_private(file_path, _render_entries(merged))
        except BaseException:
            if same_target and latest is not None:
                # Roll direct `add/update/remove(); save()` failures back to what remains on disk.
                self._entries = _copy_entries(latest)
                self._baseline = _copy_entries(latest)
            else:
                self._entries = _copy_entries(previous_baseline)
                self._baseline = _copy_entries(previous_baseline)
            self._path = previous_path
            raise
        self._entries = merged
        self._baseline = _copy_entries(merged)
        self._path = file_path

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
