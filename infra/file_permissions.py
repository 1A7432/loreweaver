"""Best-effort local permission hardening for sensitive persisted data.

The server is cross-platform, so permission changes must never make startup or
shutdown fail on a filesystem that does not implement POSIX modes.  On systems
that do support them, secret-bearing files are owner read/write only and
dedicated private directories are owner-only.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


def restrict_file(path: str | Path) -> None:
    """Best-effort ``0600`` for an existing sensitive file."""
    try:
        os.chmod(Path(path), 0o600)
    except OSError:
        pass


def atomic_write_private(path: str | Path, data: str | bytes, *, encoding: str = "utf-8") -> None:
    """Atomically replace ``path`` with owner-only bytes.

    The temporary file is created as ``0600`` in the destination directory, so
    secret material is never briefly exposed through the process umask.  The
    old file remains intact if writing or replacing fails.
    """
    target = Path(path)
    ensure_private_directory(target.parent, tighten_existing=False)
    payload = data.encode(encoding) if isinstance(data, str) else data
    fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    temp_path = Path(temp_name)
    try:
        try:
            os.chmod(temp_path, 0o600)
        except OSError:
            pass
        with os.fdopen(fd, "wb") as handle:
            fd = -1
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, target)
        restrict_file(target)
        # Persist the directory entry where the platform supports directory fsync.
        try:
            directory_fd = os.open(target.parent, os.O_RDONLY)
        except OSError:
            directory_fd = -1
        if directory_fd >= 0:
            try:
                os.fsync(directory_fd)
            except OSError:
                pass
            finally:
                os.close(directory_fd)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            temp_path.unlink()
        except OSError:
            # The tempfile is already owner-only. Cleanup failure must not mask the
            # original write/replace error (or turn a successful atomic replace into one).
            pass


def ensure_private_directory(
    path: str | Path, *, tighten_existing: bool = True
) -> Path:
    """Create private directories and best-effort enforce ``0700``.

    Newly created ancestors are always tightened.  ``tighten_existing=False``
    is for a user-selected parent (for example ``--keys`` in an existing shared
    directory), where changing pre-existing directory policy would be surprising.
    """
    directory = Path(path)
    created: list[Path] = []
    candidate = directory
    while not candidate.exists():
        created.append(candidate)
        if candidate.parent == candidate:
            break
        candidate = candidate.parent
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    targets = created
    if tighten_existing and directory not in targets:
        targets.append(directory)
    for target in targets:
        try:
            os.chmod(target, 0o700)
        except OSError:
            pass
    return directory


def restrict_sqlite_files(path: str | Path | None) -> None:
    """Best-effort ``0600`` for a file-backed SQLite DB and its sidecars."""
    if path is None:
        return
    raw = str(path)
    if raw == ":memory:" or raw.startswith("file::memory:"):
        return
    for candidate in (raw, f"{raw}-wal", f"{raw}-shm", f"{raw}-journal"):
        if os.path.exists(candidate):
            restrict_file(candidate)
