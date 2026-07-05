"""Opaque media blob storage for the networked TUI.

The server stores and forwards media bytes, but never parses them. Validation is
limited to client-declared metadata, byte count, room quota, and sha256.
"""

from __future__ import annotations

import hashlib
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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
        """Store uploaded bytes after verifying exact size and sha256."""
        if len(data) != pending.size:
            raise MediaError("media_size_mismatch")
        digest = hashlib.sha256(data).hexdigest()
        if digest != pending.sha256.lower():
            raise MediaError("media_hash_mismatch")
        if pending.mime == SVG_MIME:
            try:
                validate_svg_bytes(data)
            except SvgSafetyError as exc:
                raise MediaError("media_bad_svg") from exc

        existing = await self.get_record(pending.room, digest)
        if existing is not None:
            return existing

        media_path = self._path(pending.room, digest)
        media_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = media_path.with_name(f".{media_path.name}.{os.getpid()}.tmp")
        try:
            tmp_path.write_bytes(data)
            os.replace(tmp_path, media_path)
        finally:
            try:
                tmp_path.unlink()
            except FileNotFoundError:
                pass

        created_at = time.time()
        record = MediaRecord(
            hash=digest,
            room=pending.room,
            mime=pending.mime,
            size=pending.size,
            name=pending.name,
            uploader=pending.uploader,
            created_at=created_at,
        )
        await self._insert_record(record)
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

    async def _insert_record(self, record: MediaRecord) -> None:
        await self._ensure_schema()
        async with self._store._lock:
            conn = self._store._ensure_conn()
            conn.execute(
                """
                INSERT OR IGNORE INTO media_index
                    (hash, room, mime, size, name, uploader, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (record.hash, record.room, record.mime, record.size, record.name, record.uploader, record.created_at),
            )
            conn.commit()

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
            conn.commit()

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


def is_audio_mime(mime: str) -> bool:
    return str(mime or "").lower() in ALLOWED_AUDIO_MIMES


def is_image_mime(mime: str) -> bool:
    return str(mime or "").lower() in ALLOWED_IMAGE_MIMES
