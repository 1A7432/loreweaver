"""Opaque media blob storage for the networked TUI.

The server stores and forwards media bytes, but never parses them. Validation is
limited to client-declared metadata, byte count, room quota, and sha256.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from infra.file_permissions import atomic_write_private, ensure_private_directory, restrict_file
from infra.store import Store
from infra.svg import SVG_MIME, SvgSafetyError, validate_svg_bytes

ALLOWED_IMAGE_MIMES = frozenset({"image/png", "image/jpeg", "image/webp", "image/gif", SVG_MIME})
ALLOWED_AUDIO_MIMES = frozenset({"audio/mpeg", "audio/ogg", "audio/wav", "audio/flac", "audio/mp4", "audio/aac"})
ALLOWED_MEDIA_MIMES = ALLOWED_IMAGE_MIMES | ALLOWED_AUDIO_MIMES
DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
DEFAULT_ROOM_QUOTA_BYTES = 512 * 1024 * 1024
# TODO: EXIF stripping is intentionally out of scope for media P1; blobs stay opaque.
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")


class MediaError(ValueError):
    """A media-specific rejection with a stable protocol error code."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code


@dataclass(frozen=True)
class MediaRecord:
    hash: str
    room: str
    mime: str
    size: int
    name: str
    uploader: str
    created_at: float

    def ref(self) -> dict[str, Any]:
        return {
            "hash": self.hash,
            "mime": self.mime,
            "size": self.size,
            "name": self.name,
        }


@dataclass(frozen=True)
class PendingUpload:
    upload_id: str
    room: str
    mime: str
    size: int
    name: str
    uploader: str
    sha256: str
    # The policy that accepted this specific offer. Network callers populate
    # these fields from their image/audio limits; internal callers can omit them
    # and use the store defaults. Keeping the snapshot on the pending upload is
    # both simpler and more accurate than a process-wide expiring policy cache.
    max_file_bytes: int | None = None
    room_quota_bytes: int | None = None
    allowed_mimes: frozenset[str] | None = None


class MediaStore:
    """File-backed, room-scoped media store with a SQLite metadata index."""

    def __init__(
        self,
        store: Store,
        data_dir: str | Path,
        *,
        max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
        room_quota_bytes: int = DEFAULT_ROOM_QUOTA_BYTES,
        allowed_mimes: set[str] | frozenset[str] = ALLOWED_IMAGE_MIMES,
    ) -> None:
        self._store = store
        self._base = Path(data_dir) / "media"
        self.max_file_bytes = int(max_file_bytes)
        self.room_quota_bytes = int(room_quota_bytes)
        self.allowed_mimes = frozenset(allowed_mimes)

    async def validate_offer(
        self,
        *,
        room: str,
        mime: str,
        size: int,
        sha256: str,
        max_file_bytes: int | None = None,
        room_quota_bytes: int | None = None,
        allowed_mimes: set[str] | frozenset[str] | None = None,
    ) -> MediaRecord | None:
        """Validate offer metadata. Return an existing room record for duplicate hashes."""
        mime = str(mime or "").lower()
        sha256 = str(sha256 or "").lower()
        if mime not in (self.allowed_mimes if allowed_mimes is None else frozenset(allowed_mimes)):
            raise MediaError("media_bad_mime")
        file_limit = self.max_file_bytes if max_file_bytes is None else int(max_file_bytes)
        quota_limit = self.room_quota_bytes if room_quota_bytes is None else int(room_quota_bytes)
        if size <= 0 or size > file_limit:
            raise MediaError("media_too_large")
        if not _SHA256_RE.fullmatch(sha256):
            raise MediaError("media_bad_hash")

        await self._ensure_schema()
        existing = await self.get_record(room, sha256)
        if existing is not None:
            return existing

        total = await self.room_total_size(room)
        if total + size > quota_limit:
            raise MediaError("media_quota_exceeded")
        return None

    async def register_blob(
        self,
        *,
        room: str,
        data: bytes,
        mime: str,
        name: str,
        uploader: str,
    ) -> MediaRecord:
        """Register already-available bytes, used for Tavern-card avatar PNGs."""
        sha256 = hashlib.sha256(data).hexdigest()
        existing = await self.validate_offer(room=room, mime=mime, size=len(data), sha256=sha256)
        if existing is not None:
            return existing
        pending = PendingUpload(
            upload_id="",
            room=room,
            mime=mime,
            size=len(data),
            name=name,
            uploader=uploader,
            sha256=sha256,
        )
        return await self.commit_bytes(pending, data)

    async def commit_bytes(self, pending: PendingUpload, data: bytes) -> MediaRecord:
        """Store uploaded bytes after verifying content and quota atomically.

        Offer validation is advisory: several clients may have valid pending offers
        at once. The authoritative duplicate/quota check and metadata insert therefore
        run under one SQLite ``BEGIN IMMEDIATE`` transaction. File publication happens
        before the metadata commit, but a newly-created blob is removed if that commit
        fails; a blob that predated this call is never removed by compensation.
        """
        if len(data) != pending.size:
            raise MediaError("media_size_mismatch")
        digest = hashlib.sha256(data).hexdigest()
        if digest != pending.sha256.lower():
            raise MediaError("media_hash_mismatch")
        allowed_mimes = pending.allowed_mimes if pending.allowed_mimes is not None else self.allowed_mimes
        max_file_bytes = pending.max_file_bytes if pending.max_file_bytes is not None else self.max_file_bytes
        room_quota_bytes = (
            pending.room_quota_bytes
            if pending.room_quota_bytes is not None
            else self.room_quota_bytes
        )
        if pending.mime not in allowed_mimes:
            raise MediaError("media_bad_mime")
        if pending.size <= 0 or pending.size > max_file_bytes:
            raise MediaError("media_too_large")
        if pending.mime == SVG_MIME:
            try:
                validate_svg_bytes(data)
            except SvgSafetyError as exc:
                raise MediaError("media_bad_svg") from exc

        await self._ensure_schema()
        media_path = self._path(pending.room, digest)
        ensure_private_directory(media_path.parent)
        created_blob = False
        async with self._store._lock:
            conn = self._store._ensure_conn()
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    """
                    SELECT hash, room, mime, size, name, uploader, created_at
                    FROM media_index
                    WHERE room = ? AND hash = ?
                    """,
                    (pending.room, digest),
                ).fetchone()
                if row is not None:
                    conn.rollback()
                    return _row_to_record(row)

                total_row = conn.execute(
                    "SELECT COALESCE(SUM(size), 0) FROM media_index WHERE room = ?",
                    (pending.room,),
                ).fetchone()
                total = int(total_row[0] or 0) if total_row else 0
                if total + pending.size > room_quota_bytes:
                    raise MediaError("media_quota_exceeded")

                created_blob = _publish_blob(media_path, data)
                record = MediaRecord(
                    hash=digest,
                    room=pending.room,
                    mime=pending.mime,
                    size=pending.size,
                    name=pending.name,
                    uploader=pending.uploader,
                    created_at=time.time(),
                )
                await self._insert_record(record, conn=conn)
                self._store._commit(conn)
            except Exception:
                if conn.in_transaction:
                    conn.rollback()
                if created_blob:
                    _remove_new_blob(media_path)
                raise
        return record

    async def get_record(self, room: str, sha256: str) -> MediaRecord | None:
        await self._ensure_schema()
        async with self._store._lock:
            conn = self._store._ensure_conn()
            row = conn.execute(
                """
                SELECT hash, room, mime, size, name, uploader, created_at
                FROM media_index
                WHERE room = ? AND hash = ?
                """,
                (room, sha256.lower()),
            ).fetchone()
        return _row_to_record(row) if row else None

    async def read_bytes(self, room: str, sha256: str) -> tuple[MediaRecord, bytes]:
        record = await self.get_record(room, sha256.lower())
        if record is None:
            raise MediaError("media_not_found")
        path = self._path(room, record.hash)
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise MediaError("media_not_found") from exc
        if len(data) != record.size or hashlib.sha256(data).hexdigest() != record.hash:
            raise MediaError("media_not_found")
        return record, data

    async def room_total_size(self, room: str) -> int:
        await self._ensure_schema()
        async with self._store._lock:
            conn = self._store._ensure_conn()
            row = conn.execute("SELECT COALESCE(SUM(size), 0) FROM media_index WHERE room = ?", (room,)).fetchone()
        return int(row[0] or 0) if row else 0

    async def list_room_records(self, room: str) -> list[MediaRecord]:
        """Return every indexed blob owned by ``room`` in stable hash order."""
        await self._ensure_schema()
        async with self._store._lock:
            conn = self._store._ensure_conn()
            rows = conn.execute(
                """
                SELECT hash, room, mime, size, name, uploader, created_at
                FROM media_index
                WHERE room = ?
                ORDER BY hash
                """,
                (room,),
            ).fetchall()
        return [_row_to_record(row) for row in rows]

    async def delete_room(self, room: str) -> int:
        """Delete ``room``'s index entries and blobs as one recoverable operation.

        Blobs are first moved to an owner-only staging directory while the SQLite
        write transaction is held. A staging or DB failure rolls those moves back,
        so live index rows never point at files an ordinary failed call removed.
        Only after the metadata delete commits is the private staging directory
        discarded. A post-commit cleanup failure can leave private quarantine data,
        but cannot leave a dangling live index or delete another room's shared blob.
        """
        await self._ensure_schema()
        records: list[MediaRecord] = []
        moved: list[tuple[Path, Path]] = []
        staging_dir: Path | None = None
        async with self._store._lock:
            conn = self._store._ensure_conn()
            conn.execute("BEGIN IMMEDIATE")
            try:
                rows = conn.execute(
                    """
                    SELECT hash, room, mime, size, name, uploader, created_at
                    FROM media_index
                    WHERE room = ?
                    ORDER BY hash
                    """,
                    (room,),
                ).fetchall()
                records = [_row_to_record(row) for row in rows]
                if not records:
                    conn.rollback()
                    return 0

                # Sanitized directory names can theoretically collide. Preserve a
                # shared content-addressed file if another exact room resolves to it.
                other_rows = conn.execute(
                    "SELECT room, hash FROM media_index WHERE room != ?",
                    (room,),
                ).fetchall()
                protected = {
                    str(hash_value)
                    for other_room, hash_value in other_rows
                    if _safe_room(str(other_room)) == _safe_room(room)
                }

                for record in records:
                    source = self._path(room, record.hash)
                    if record.hash in protected or not source.exists():
                        continue
                    if staging_dir is None:
                        staging_root = ensure_private_directory(self._base / ".delete-staging")
                        staging_dir = Path(tempfile.mkdtemp(prefix="room-", dir=staging_root))
                        ensure_private_directory(staging_dir)
                    staged = staging_dir / record.hash
                    os.replace(source, staged)
                    moved.append((source, staged))

                if staging_dir is not None:
                    _fsync_directory(staging_dir)
                    _fsync_directory(self._base / _safe_room(room))
                conn.execute("DELETE FROM media_index WHERE room = ?", (room,))
                self._store._commit(conn)
            except Exception:
                if conn.in_transaction:
                    conn.rollback()
                _restore_staged_blobs(moved)
                _discard_staging(staging_dir)
                raise

        _discard_staging(staging_dir)
        room_dir = self._base / _safe_room(room)
        try:
            room_dir.rmdir()
        except (FileNotFoundError, OSError):
            pass
        else:
            _fsync_directory(room_dir.parent)
        return len(records)

    async def _insert_record(self, record: MediaRecord, *, conn: Any | None = None) -> None:
        if conn is not None:
            conn.execute(
                """
                INSERT INTO media_index
                    (hash, room, mime, size, name, uploader, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.hash,
                    record.room,
                    record.mime,
                    record.size,
                    record.name,
                    record.uploader,
                    record.created_at,
                ),
            )
            return
        await self._ensure_schema()
        async with self._store._lock:
            store_conn = self._store._ensure_conn()
            store_conn.execute(
                """
                INSERT OR IGNORE INTO media_index
                    (hash, room, mime, size, name, uploader, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (record.hash, record.room, record.mime, record.size, record.name, record.uploader, record.created_at),
            )
            self._store._commit(store_conn)

    async def _ensure_schema(self) -> None:
        async with self._store._lock:
            conn = self._store._ensure_conn()
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS media_index (
                    hash TEXT NOT NULL,
                    room TEXT NOT NULL,
                    mime TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    uploader TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    PRIMARY KEY (room, hash)
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_media_index_room ON media_index(room)")
            self._store._commit(conn)

    def _path(self, room: str, sha256: str) -> Path:
        return self._base / _safe_room(room) / sha256.lower()


def _safe_room(room: str) -> str:
    text = str(room or "room")
    return re.sub(r"[^A-Za-z0-9_.:-]+", "_", text).strip("._") or "room"


def _row_to_record(row: Any) -> MediaRecord:
    return MediaRecord(
        hash=str(row[0]),
        room=str(row[1]),
        mime=str(row[2]),
        size=int(row[3]),
        name=str(row[4]),
        uploader=str(row[5]),
        created_at=float(row[6]),
    )


def _publish_blob(path: Path, data: bytes) -> bool:
    """Durably publish ``data`` and return whether this call created the path.

    A valid content-addressed blob may already exist because another exact room
    whose sanitized directory collides references the same hash, or because a
    previous metadata commit failed. Reusing/replacing that path is safe, but it
    must not be removed if the caller's later DB insert fails.
    """
    existed = path.exists()
    if existed:
        try:
            if path.read_bytes() == data:
                restrict_file(path)
                return False
        except OSError:
            # Let the durable atomic replacement below either repair the path or
            # surface the filesystem error to the caller.
            pass
    atomic_write_private(path, data)
    return not existed


def _remove_new_blob(path: Path) -> None:
    """Best-effort compensation for a blob created before a failed DB commit."""
    try:
        path.unlink()
    except FileNotFoundError:
        return
    _fsync_directory(path.parent)


def _restore_staged_blobs(moved: list[tuple[Path, Path]]) -> None:
    """Reverse delete staging while the room's SQLite write lock is still held."""
    touched: set[Path] = set()
    for original, staged in reversed(moved):
        if not staged.exists():
            continue
        ensure_private_directory(original.parent)
        os.replace(staged, original)
        touched.add(original.parent)
        touched.add(staged.parent)
    for directory in touched:
        _fsync_directory(directory)


def _discard_staging(path: Path | None) -> None:
    """Discard committed/rolled-back private staging without masking the main result."""
    if path is None:
        return
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        return
    except OSError:
        # Metadata is already authoritative at this point. Leaving owner-only
        # quarantine is safer than resurrecting rows or masking a successful DB
        # commit; a later operator cleanup can remove the hidden directory.
        return
    _fsync_directory(path.parent)
    try:
        path.parent.rmdir()
    except (FileNotFoundError, OSError):
        pass
    else:
        _fsync_directory(path.parent.parent)


def _fsync_directory(path: Path) -> None:
    """Best-effort persistence barrier for directory entry changes."""
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def is_audio_mime(mime: str) -> bool:
    return str(mime or "").lower() in ALLOWED_AUDIO_MIMES


def is_image_mime(mime: str) -> bool:
    return str(mime or "").lower() in ALLOWED_IMAGE_MIMES
