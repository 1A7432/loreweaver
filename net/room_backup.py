"""Room snapshot export/import/delete helpers for keeper admin operations."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import math
import os
import re
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from agent.document_manager import document_point_id
from agent.services import Services
from gateway.session import SessionSource
from infra.file_permissions import atomic_write_private, ensure_private_directory, restrict_file
from infra.media_store import (
    ALLOWED_AUDIO_MIMES,
    ALLOWED_IMAGE_MIMES,
    ALLOWED_MEDIA_MIMES,
    MediaRecord,
    MediaStore,
    PendingUpload,
)
from infra.room_facets import (
    RESET_SCOPES,
    STORAGE_DOCUMENTS,
    STORAGE_HISTORY,
    STORAGE_MEDIA,
    STORAGE_ROOM_STATE,
    STORAGE_SNAPSHOTS,
    STORAGE_VECTORS,
    FacetContext,
)
from infra.svg import SVG_MIME, SvgSafetyError, validate_svg_bytes
from net.keystore import Keystore
from net.room_lifecycle import room_registry

# Snapshot format 3 (M20 D): the `chat_history` section carries the append-only history
# tree, so a named save is still a WHOLE-room checkpoint after the conversation stopped
# living in a room_state blob. Restoring one cannot produce the "state at turn 30, summary
# at turn 190" tear, because every half moves together.
# Snapshot format 2 (M17): content rides `documents` + `room_state` sections; the
# KV `store_rows` section carries only cross-transport bindings. Per the M16
# addendum every 2.0-era format carries a version and a designed migration slot —
# empty until a future version needs one (v1 KV-era snapshots are pre-adoption and
# deliberately unmigratable, zero-compat for the past).
SNAPSHOT_VERSION = 3
SNAPSHOT_MIGRATIONS: dict[int, object] = {}

# A snapshot is deliberately much smaller than the live media quota (which may be 2 GiB
# for audio).  JSON + base64 is not a streaming container: letting the live quota dictate
# this limit would require several GiB of transient Python objects and can OOM the server.
# These limits are part of the server-side trust boundary, not client suggestions.
MAX_BACKUP_FILE_BYTES = 64 * 1024 * 1024
MAX_BACKUP_MEDIA_BYTES = 32 * 1024 * 1024
MAX_BACKUP_MEDIA_FILES = 1_024
MAX_BACKUP_STORE_ROWS = 20_000
MAX_BACKUP_STORE_BYTES = 12 * 1024 * 1024
MAX_BACKUP_VECTOR_POINTS = 10_000
MAX_BACKUP_VECTOR_VALUES = 750_000
MAX_BACKUP_VECTOR_BYTES = 16 * 1024 * 1024
MAX_BACKUP_KEYS = 10_000

logger = logging.getLogger(__name__)

_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9_.-]+")
_TUI_CHAT_KEY_PREFIX = "tui:group:"
_VECTOR_OWNERSHIP_FIELDS = frozenset({"chat_key", "namespace"})

# --- `.reset` scope groups -----------------------------------------------------
# M17: room CONTENT lives in the documents table and room-scoped RUNTIME state in
# the room_state table — both room-scoped by COLUMN, so backup/export/delete simply
# dump whole rooms and need NO per-store key allowlist (the drift bug class died
# with the KV era). What remains is the SEMANTIC partition `.reset` scopes need:
# which document types and which runtime keys each scope wipes.
#
# M23 WS1 moved that partition OUT of this file. It used to be four hand-maintained
# frozensets here, and they drifted from the code that wrote the state three times in
# one month. Now each family is declared as a `RoomStateFacet` BY the module that owns
# it (`infra/room_facets.py`, collected in `net/room_lifecycle.py`), an architecture
# test fails the build on state no facet claims, and this file asks the registry.
# Room SETTINGS (language, house rules, enabled skills/presets/panels, media/bot
# toggles) are configuration rather than campaign content, so their facets declare
# `reset_scope=None` and survive every level.
#
# What did NOT move: the order the legs run in and what happens when one fails. Those
# stay here, with the operations.

# Which snapshot section carries each room-scoped storage. The export manifest is built
# from this map, so a storage a facet lives in cannot quietly go uncarried — the
# architecture test requires every facet storage to appear here or to be export-exempt,
# and an export-exempt storage must be CLEARED on import (below) instead. A load is a
# whole-room checkpoint: each carried storage is replaced, not merged, so live rows the
# snapshot does not name disappear with the export-exempt ones.
EXPORT_SECTIONS: dict[str, str] = {
    STORAGE_DOCUMENTS: "documents",
    STORAGE_ROOM_STATE: "room_state",
    STORAGE_HISTORY: "chat_history",
    STORAGE_VECTORS: "vector_points",
    STORAGE_MEDIA: "media",
}

# How the import transaction clears a storage no snapshot carries. State a backup cannot
# restore must not survive that backup being loaded over the room: the undo ring is the
# case that motivated the rule — before M23 WS1 `.save load` left the ring intact, so
# `.undo` could rewind THROUGH the import back into the room's pre-import life.
_IMPORT_CLEAR_SQL: dict[str, str] = {
    STORAGE_SNAPSHOTS: "DELETE FROM room_snapshots WHERE room = ?",
}


def chat_key_for_room(room: str) -> str:
    return SessionSource(platform="tui", chat_type="group", chat_id=room).chat_key()


def room_for_chat_key(chat_key: str) -> str:
    """The room name a TUI chat key was built from — the inverse of `chat_key_for_room`.

    A room-scoped command knows its chat key; every backup entry point is named by ROOM,
    because that is also what the keystore scopes bearer keys by.
    """
    return chat_key.rsplit(":", 1)[-1]


def _safe_room(room: str) -> str:
    return _SAFE_NAME_RE.sub("_", room.strip()) or "room"


def _backup_base(services: Services) -> Path:
    """The ONE directory room snapshots may be written to / read from. Every export/import
    path is confined here: a client-supplied `path` is treated as a bare filename, never an
    arbitrary filesystem location — this is what defuses `..`/absolute-path traversal, so a
    networked keeper can't write (or read) files outside the backups directory."""
    return (Path(services.settings.data_dir) / "room_backups").resolve()


def _room_backup_dir(services: Services, room: str) -> Path:
    """Return a collision-resistant directory owned by exactly one logical room.

    Sanitizing alone is insufficient (``a/b`` and ``a_b`` collide), so the human-readable
    prefix is paired with a digest of the exact room id.  A keeper resolving a filename for
    room A never even opens room B's directory.
    """
    base = _backup_base(services)
    digest = hashlib.sha256(room.encode("utf-8")).hexdigest()[:16]
    target = base / f"{_safe_room(room)}-{digest}"
    # The sanitized, digest-suffixed name cannot traverse. The one meaningful
    # filesystem guard here is rejecting a room directory symlink: even a link to
    # another directory *inside* the backup root would break room isolation.
    if target.is_symlink():
        raise ValueError("backup room directory must not be a symlink")  # i18n-exempt: internal invariant
    return target


def _default_path(services: Services, room: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    nonce = uuid.uuid4().hex[:12]
    return _room_backup_dir(services, room) / f"{_safe_room(room)}_{stamp}_{nonce}.json"


def _backup_filename(raw: str, fallback: str) -> str:
    """Reduce a client-supplied path to a safe `<name>.json` filename with no directory parts."""
    name = Path(raw.strip()).name  # discards directories, absolute roots, and `..` components
    stem = name[:-5] if name.endswith(".json") else name
    stem = _SAFE_NAME_RE.sub("_", stem).strip("_")
    return f"{stem or fallback}.json"


def _resolve_export_path(services: Services, room: str, path: str = "") -> Path:
    base = _room_backup_dir(services, room)
    if not path.strip():
        return _default_path(services, room)
    # `_backup_filename` has already removed every directory component. Keeping
    # this path unresolved also lets the atomic writer replace a final symlink
    # itself instead of following it.
    return base / _backup_filename(path, _safe_room(room))


def _resolve_import_path(services: Services, path: str, expected_room: str) -> Path:
    """Resolve an import without probing another room's snapshot namespace."""
    filename = _backup_filename(path, "room")
    if expected_room:
        base = _room_backup_dir(services, expected_room)
        candidate = base / filename
        # Imports open an existing file, so unlike atomic export a final symlink
        # would be followed. Reject it, then retain one resolved containment check
        # for a concurrently prepared or legacy filesystem layout.
        source = candidate.resolve()
        if candidate.is_symlink() or not source.is_relative_to(base) or not source.is_file():
            raise ValueError("import source is not a room backup file")  # i18n-exempt: admin op detail
        return source

    # There is no network caller for the unscoped form, but keep the internal helper useful:
    # a filename must identify exactly one snapshot rather than silently selecting a room.
    root = _backup_base(services)
    candidates = []
    for candidate in root.glob(f"*/{filename}"):
        source = candidate.resolve()
        if (
            not candidate.is_symlink()
            and source.is_relative_to(root)
            and source.is_file()
        ):
            candidates.append(source)
    if len(candidates) != 1:
        raise ValueError("import source is not a unique room backup file")  # i18n-exempt: internal CLI detail
    return candidates[0]


def _matches_room_store_key(store_key: str, value: str | None, chat_key: str) -> bool:
    """M17: the only room-owned KV rows left are cross-transport bindings, which
    store the target session key as the VALUE (content lives in the documents
    table, runtime state in room_state — both room-scoped by column)."""
    return store_key.startswith("bound_room.") and value == chat_key


def _rewrite_room_row(row: dict[str, Any], old_chat_key: str, new_chat_key: str) -> dict[str, Any]:
    copied = dict(row)
    copied["store_key"] = str(copied.get("store_key", "")).replace(old_chat_key, new_chat_key)
    if copied["store_key"].startswith("bound_room.") and copied.get("value") == old_chat_key:
        copied["value"] = new_chat_key
    return copied


def _vector_scope_field(payload: dict[str, Any]) -> str:
    """The ownership field a point of THIS kind must carry to be attributable at all.

    Vector payloads come in two lanes, distinguishable by SHAPE: a named
    ``collection`` (worldbook, chronicle, …) shares one namespace-scoped payload
    scheme, while the document-RAG lane declares no collection and is chat-key
    scoped. Reading the lane off the shape — rather than off a list of known
    collection names — is the point: a name list is exactly what silently filed
    the M18 chronicle under the chat-key lane, where it matched nothing and made
    every room-wide vector path fail closed on a perfectly well-owned point.
    """
    collection = payload.get("collection")
    return "namespace" if isinstance(collection, str) and collection else "chat_key"


def _rewrite_payload_ownership(value: Any, old_chat_key: str, new_chat_key: str) -> Any:
    """Re-home every ownership field of a point onto the target room.

    Field-set driven (``_VECTOR_OWNERSHIP_FIELDS``) exactly like the predicate
    below, so both stay true for any lane: a rewrite makes every field the point
    DOES carry name the new room, and never invents the scope field it lacks."""
    if isinstance(value, dict):
        return {
            key: (
                new_chat_key
                if key in _VECTOR_OWNERSHIP_FIELDS and item == old_chat_key
                else _rewrite_payload_ownership(item, old_chat_key, new_chat_key)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_rewrite_payload_ownership(item, old_chat_key, new_chat_key) for item in value]
    return value


def _vector_payload_owned_by_room(payload: dict[str, Any], chat_key: str) -> bool:
    """Require both the vector kind's own scope field and every ownership field to agree.

    A point is owned by the room iff (a) every ownership field it carries — at any
    nesting depth, so a forged payload cannot smuggle a foreign owner through backup —
    names that room, and (b) it carries its lane's scope field (`_vector_scope_field`).
    Clause (b) keeps an unattributed point (no `namespace` on a collection point, no
    `chat_key` on a document point) from being adopted by whichever room happens to
    scroll past it; clause (a) keeps a point that names two rooms failing closed.
    """

    def _all_ownership_fields_match(value: Any) -> bool:
        if isinstance(value, dict):
            for key, item in value.items():
                if key in _VECTOR_OWNERSHIP_FIELDS and item != chat_key:
                    return False
                if not _all_ownership_fields_match(item):
                    return False
        elif isinstance(value, list):
            return all(_all_ownership_fields_match(item) for item in value)
        return True

    if not _all_ownership_fields_match(payload):
        return False
    return payload.get(_vector_scope_field(payload)) == chat_key


def _document_point_id_from_payload(payload: dict[str, Any]) -> str | None:
    """Recover the canonical id used by ``VectorDatabaseManager`` when possible."""
    document_id = payload.get("document_id")
    chunk_index = payload.get("chunk_index")
    if (
        not isinstance(document_id, str)
        or not document_id
        or isinstance(chunk_index, bool)
        or not isinstance(chunk_index, int)
        or chunk_index < 0
    ):
        return None
    return document_point_id(document_id, chunk_index)


def _rewrite_vector_point(point: dict[str, Any], old_chat_key: str, new_chat_key: str) -> dict[str, Any]:
    copied = dict(point)
    copied["payload"] = _rewrite_payload_ownership(
        dict(copied.get("payload") or {}), old_chat_key, new_chat_key
    )
    canonical_document_id = _document_point_id_from_payload(copied["payload"])
    if canonical_document_id is not None:
        # Older backup code namespaced these ids during import even though the
        # document manager writes `<document_id>:<chunk_index>`. Normalize both
        # fresh and legacy snapshots back to the one deterministic contract.
        copied["id"] = canonical_document_id
        return copied

    point_id = str(copied.get("id") or "")
    if old_chat_key == new_chat_key:
        # A same-room restore must remain an upsert of the original point, not
        # manufacture an alias that makes retrieval return the chunk twice.
        copied["id"] = point_id
    elif point_id.startswith(f"{old_chat_key}:"):
        copied["id"] = f"{new_chat_key}:{point_id[len(old_chat_key) + 1:]}"
    elif point_id:
        # Unknown legacy vector kinds lack a canonical payload-derived id. If an
        # internal caller ever enables cross-room cloning, keep those global ids
        # target-scoped; collision checks below still protect every known kind.
        digest = hashlib.sha256(point_id.encode("utf-8")).hexdigest()[:32]
        copied["id"] = f"{new_chat_key}:backup:{digest}"
    return copied


async def _preflight_vector_import(
    vector_store: Any,
    points: list[tuple[str, list[float], dict[str, Any]]],
    chat_key: str,
) -> list[str]:
    """Reject global id collisions before import mutates live state.

    Vector ids are global even though retrieval is payload-scoped. A same-room
    point with the same id is an ordinary replace; the same id owned by any other
    room must fail closed. Legacy backup aliases for the same document/chunk are
    still returned, but a checkpoint load wipes every room-owned point first, so
    the caller no longer has to delete that list separately.
    """
    if not points:
        return []
    if not hasattr(vector_store, "count") or not hasattr(vector_store, "scroll"):
        raise ValueError("vector store cannot validate point ownership")  # i18n-exempt: internal detail

    incoming_ids = {point_id for point_id, _vector, _payload in points}
    total = await vector_store.count()
    existing = await vector_store.scroll(
        limit=max(1, total + MAX_BACKUP_VECTOR_POINTS + 1)
    )
    stale_aliases: list[str] = []
    for hit in existing:
        point_id = str(getattr(hit, "id", "") or "")
        payload = getattr(hit, "payload", None)
        if not isinstance(payload, dict):
            if point_id in incoming_ids:
                raise ValueError("snapshot vector id belongs to another room")  # i18n-exempt
            continue
        owned_by_target = _vector_payload_owned_by_room(payload, chat_key)
        if point_id in incoming_ids and not owned_by_target:
            raise ValueError("snapshot vector id belongs to another room")  # i18n-exempt
        canonical_id = _document_point_id_from_payload(payload)
        if owned_by_target and canonical_id in incoming_ids and point_id != canonical_id:
            stale_aliases.append(point_id)
    return stale_aliases


def _json_bytes(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _bounded_section(items: list[Any], *, count_limit: int, byte_limit: int, name: str) -> None:
    if len(items) > count_limit:
        raise ValueError(f"{name} entry limit exceeded")
    total = 0
    for item in items:
        total += _json_bytes(item)
        if total > byte_limit:
            raise ValueError(f"{name} byte limit exceeded")


def _list_field(raw: dict[str, Any], name: str) -> list[Any]:
    value = raw.get(name, [])
    if not isinstance(value, list):
        raise ValueError(f"snapshot {name} is not a list")
    return value


async def room_rows(
    services: Services,
    chat_key: str,
    *,
    enforce_limits: bool = False,
) -> list[dict[str, str | None]]:
    rows = await services.store.list_rows(store_key_prefixes=("bound_room.",))
    selected = [
        row
        for row in rows
        if _matches_room_store_key(str(row["store_key"]), row.get("value"), chat_key)
    ]
    if enforce_limits:
        _bounded_section(
            selected,
            count_limit=MAX_BACKUP_STORE_ROWS,
            byte_limit=MAX_BACKUP_STORE_BYTES,
            name="store rows",
        )
    return selected


async def room_documents(
    services: Services,
    chat_key: str,
    *,
    enforce_limits: bool = False,
) -> list[dict[str, Any]]:
    """Every document row of the room, verbatim (data/meta/grants stay JSON strings)."""
    rows = await services.store.doc_list(chat_key)
    if enforce_limits:
        _bounded_section(
            rows,
            count_limit=MAX_BACKUP_STORE_ROWS,
            byte_limit=MAX_BACKUP_STORE_BYTES,
            name="documents",
        )
    return rows


async def room_state_rows(
    services: Services,
    chat_key: str,
    *,
    enforce_limits: bool = False,
) -> list[dict[str, str | None]]:
    """Every room_state row of the room."""
    rows = await services.store.state_list(chat_key)
    if enforce_limits:
        _bounded_section(
            rows,
            count_limit=MAX_BACKUP_STORE_ROWS,
            byte_limit=MAX_BACKUP_STORE_BYTES,
            name="room state rows",
        )
    return rows


async def room_history_rows(
    services: Services,
    chat_key: str,
    *,
    enforce_limits: bool = False,
) -> list[dict[str, Any]]:
    """Every append-only history row of the room (M20 D)."""
    rows = await services.store.history_rows(chat_key)
    if enforce_limits:
        _bounded_section(
            rows,
            count_limit=MAX_BACKUP_STORE_ROWS,
            byte_limit=MAX_BACKUP_STORE_BYTES,
            name="chat history rows",
        )
    return rows


async def room_vector_points(
    services: Services,
    chat_key: str,
    *,
    enforce_limits: bool = False,
) -> list[dict[str, Any]]:
    vector_store = getattr(services.vector_db, "vector_store", None)
    if vector_store is None or not hasattr(vector_store, "dump"):
        return []
    dim = max(1, int(getattr(vector_store, "dim", 1) or 1))
    point_limit = min(MAX_BACKUP_VECTOR_POINTS, max(1, MAX_BACKUP_VECTOR_VALUES // dim))
    points_by_id: dict[str, dict[str, Any]] = {}
    for query in (
        {"chat_key": chat_key},
        {"namespace": chat_key},
    ):
        if enforce_limits:
            query_limit = point_limit + 1
        else:
            # Cleanup/rollback must not inherit the JSON export cap. Ask the store for exactly
            # the live set rather than imposing an arbitrary second ceiling on room deletion.
            query_limit = max(1, await vector_store.count(filter=query))
        for point in await vector_store.dump(filter=query, limit=query_limit):
            payload = point.get("payload")
            if not isinstance(payload, dict) or not _vector_payload_owned_by_room(payload, chat_key):
                # A point selected through one owner field that names another room through a
                # second field is corrupt/ambiguous. Export/delete must fail closed rather than
                # disclose or erase it on behalf of either room.
                raise ValueError(
                    "vector point has conflicting room ownership"  # i18n-exempt: internal invariant
                )
            point_id = str(point.get("id") or "")
            if point_id:
                points_by_id[point_id] = point
            if enforce_limits and len(points_by_id) > point_limit:
                raise ValueError("vector point limit exceeded")
    points = list(points_by_id.values())
    if enforce_limits:
        if sum(len(point.get("vector") or []) for point in points) > MAX_BACKUP_VECTOR_VALUES:
            raise ValueError("vector value limit exceeded")
        _bounded_section(
            points,
            count_limit=point_limit,
            byte_limit=MAX_BACKUP_VECTOR_BYTES,
            name="vector points",
        )
    return points


def _media_store(services: Services) -> MediaStore:
    tui = services.settings.tui
    return MediaStore(
        services.store,
        services.settings.data_dir,
        max_file_bytes=max(tui.media_max_file_bytes, tui.audio_max_file_bytes),
        room_quota_bytes=max(tui.media_room_quota_bytes, tui.audio_room_quota_bytes),
        allowed_mimes=ALLOWED_MEDIA_MIMES,
    )


def _media_policy(
    services: Services,
    mime: str,
) -> tuple[int, int, frozenset[str]]:
    """Mirror SessionCore's MIME-specific upload policy for backup restores."""
    tui = services.settings.tui
    if mime in ALLOWED_IMAGE_MIMES:
        return tui.media_max_file_bytes, tui.media_room_quota_bytes, ALLOWED_IMAGE_MIMES
    if mime in ALLOWED_AUDIO_MIMES:
        return tui.audio_max_file_bytes, tui.audio_room_quota_bytes, ALLOWED_AUDIO_MIMES
    raise ValueError("unsupported backup media MIME")


async def room_media_entries(services: Services, chat_key: str) -> list[dict[str, Any]]:
    """Serialize room-owned media into the private, self-contained snapshot."""
    media = _media_store(services)
    records = await media.list_room_records(chat_key)
    if len(records) > MAX_BACKUP_MEDIA_FILES:
        raise ValueError("media entry limit exceeded")
    declared_total = sum(record.size for record in records)
    if declared_total > MAX_BACKUP_MEDIA_BYTES:
        raise ValueError("media backup byte limit exceeded")
    entries: list[dict[str, Any]] = []
    actual_total = 0
    for record in records:
        _, data = await media.read_bytes(chat_key, record.hash)
        actual_total += len(data)
        if actual_total > MAX_BACKUP_MEDIA_BYTES:
            raise ValueError("media backup byte limit exceeded")
        entries.append(
            {
                "hash": record.hash,
                "mime": record.mime,
                "size": record.size,
                "name": record.name,
                "uploader": record.uploader,
                "data": base64.b64encode(data).decode("ascii"),
            }
        )
    return entries


def room_key_entries(
    keystore: Keystore,
    room: str,
    *,
    enforce_limits: bool = False,
) -> list[dict[str, str]]:
    entries = [
        {"key": entry.key, "room": entry.room, "name": entry.name, "role": entry.role}
        for entry in keystore.entries()
        if entry.room == room
    ]
    if enforce_limits and len(entries) > MAX_BACKUP_KEYS:
        raise ValueError("room key limit exceeded")
    return entries


async def export_room(services: Services, keystore: Keystore, room: str, path: str = "") -> dict[str, Any]:
    room = room.strip()
    if not room:
        raise ValueError("snapshot room is empty")
    chat_key = chat_key_for_room(room)
    rows = await room_rows(services, chat_key, enforce_limits=True)
    documents = await room_documents(services, chat_key, enforce_limits=True)
    state_rows = await room_state_rows(services, chat_key, enforce_limits=True)
    history_rows = await room_history_rows(services, chat_key, enforce_limits=True)
    vectors = await room_vector_points(services, chat_key, enforce_limits=True)
    media = await room_media_entries(services, chat_key)
    # A file-backed keystore may have been changed by a simultaneous operations CLI.
    # Refresh immediately before taking this point-in-time key snapshot so a moved or
    # revoked bearer key is not copied from stale process memory into the backup.
    keystore.refresh()
    keys = room_key_entries(keystore, room, enforce_limits=True)
    target = _resolve_export_path(services, room, path)
    ensure_private_directory(target.parent)

    snapshot = {
        "version": SNAPSHOT_VERSION,
        "exported_at": datetime.now().isoformat(),
        "room": room,
        "chat_key": chat_key,
        # Bearer keys and the KV bindings are not facet storages: they are the room's
        # identity and its cross-transport wiring, carried whatever the content is.
        "keys": keys,
        "store_rows": rows,
        # One section per room-scoped storage a facet can live in. Naming them through
        # `EXPORT_SECTIONS` is what lets the architecture test prove no facet's storage
        # was left uncarried without also being export-exempt.
        EXPORT_SECTIONS[STORAGE_DOCUMENTS]: documents,
        EXPORT_SECTIONS[STORAGE_ROOM_STATE]: state_rows,
        EXPORT_SECTIONS[STORAGE_HISTORY]: history_rows,
        EXPORT_SECTIONS[STORAGE_VECTORS]: vectors,
        EXPORT_SECTIONS[STORAGE_MEDIA]: media,
    }
    encoded = json.dumps(snapshot, ensure_ascii=False, indent=2)
    if len(encoded.encode("utf-8")) > MAX_BACKUP_FILE_BYTES:
        raise ValueError("room snapshot byte limit exceeded")
    atomic_write_private(target, encoded)
    return {
        "room": room,
        "chat_key": chat_key,
        "path": str(target),
        "keys": len(keys),
        "documents": len(documents),
        "room_state_rows": len(state_rows),
        "chat_history_rows": len(history_rows),
        "store_rows": len(rows),
        "vector_points": len(vectors),
        "media_files": len(media),
    }


@dataclass(frozen=True)
class _RoomState:
    rows: list[dict[str, str | None]]
    documents: list[dict[str, Any]]
    state_rows: list[dict[str, str | None]]
    history: list[dict[str, Any]]
    vectors: list[dict[str, Any]]
    keys: list[dict[str, str]]
    media: list[MediaRecord]


@dataclass(frozen=True)
class _StagedMedia:
    record: MediaRecord
    original: Path
    staged: Path


async def _capture_room_state(
    services: Services,
    keystore: Keystore,
    room: str,
    chat_key: str,
) -> _RoomState:
    media = await _media_store(services).list_room_records(chat_key)
    rows = await room_rows(services, chat_key, enforce_limits=False)
    return _RoomState(
        rows=rows,
        documents=await room_documents(services, chat_key, enforce_limits=False),
        state_rows=await room_state_rows(services, chat_key, enforce_limits=False),
        history=await room_history_rows(services, chat_key, enforce_limits=False),
        vectors=await room_vector_points(services, chat_key, enforce_limits=False),
        keys=[
            {"key": entry.key, "room": entry.room, "name": entry.name, "role": entry.role}
            for entry in keystore.entries()
            if entry.room == room
        ],
        media=media,
    )


async def _capture_room_snapshots(services: Services, chat_key: str) -> list[tuple[int, str]]:
    """The room's undo ring as (turn, payload) pairs, so a failed import can put it back."""
    captured: list[tuple[int, str]] = []
    for turn in await services.store.snapshot_turns(chat_key):
        payload = await services.store.snapshot_get(chat_key, turn)
        if payload is not None:
            captured.append((turn, payload))
    return captured


async def _restore_room_snapshots(
    services: Services,
    chat_key: str,
    captured: list[tuple[int, str]],
) -> None:
    """Put a captured undo ring back verbatim.

    ``keep=0`` skips the trim: this is the restore of a ring that was already the right
    size, not a new turn boundary competing for room in it.
    """
    for turn, payload in captured:
        await services.store.snapshot_put(chat_key, turn, payload, keep=0)


async def _atomic_store_update(
    services: Services,
    *,
    delete_rows: list[dict[str, Any]] | None = None,
    upsert_rows: list[dict[str, Any]] | None = None,
    delete_documents_room: str | None = None,
    upsert_documents: list[dict[str, Any]] | None = None,
    delete_state_room: str | None = None,
    upsert_state: tuple[str, list[dict[str, Any]]] | None = None,
    clear_storages: tuple[str, list[str]] | None = None,
    preserve_foreign_bindings: bool = False,
) -> int:
    """Apply the room's store portion (KV bindings + documents + room_state) in ONE
    SQLite transaction.

    ``Store.set`` intentionally commits every call for ordinary use; backup restore needs a
    batch boundary, so this small internal operation uses the same guarded connection directly.

    ``clear_storages`` is ``(room, [storage, ...])`` for storages a snapshot does not carry
    and import must therefore empty; each rides the SAME transaction as the row replacement
    it accompanies, so a room can never come back from an import with half of it replaced.
    """
    delete_rows = delete_rows or []
    upsert_rows = upsert_rows or []
    upsert_documents = upsert_documents or []
    async with services.store._lock:
        conn = services.store._ensure_conn()
        try:
            conn.execute("BEGIN IMMEDIATE")
            safe_upserts: list[dict[str, Any]] = []
            for row in upsert_rows:
                store_key = str(row.get("store_key") or "")
                desired = row.get("value")
                if store_key.startswith("bound_room."):
                    current = conn.execute(
                        "SELECT value FROM kv WHERE store_key = ?",
                        (store_key,),
                    ).fetchall()
                    if any(item[0] is not None and item[0] != desired for item in current):
                        if preserve_foreign_bindings:
                            # A concurrent binder has moved this platform identity to another
                            # room. Rollback merges around it instead of resurrecting the old
                            # binding over the newer authorization decision.
                            continue
                        raise ValueError(
                            "bound room already belongs to a different room"  # i18n-exempt: invariant
                        )
                safe_upserts.append(row)

            deleted = 0
            regular_deletes = [
                row
                for row in delete_rows
                if not str(row.get("store_key") or "").startswith("bound_room.")
            ]
            if regular_deletes:
                cursor = conn.executemany(
                    "DELETE FROM kv WHERE user_key = ? AND store_key = ?",
                    [
                        (str(row.get("user_key") or ""), str(row.get("store_key") or ""))
                        for row in regular_deletes
                    ],
                )
                deleted += cursor.rowcount if cursor.rowcount != -1 else len(regular_deletes)
            for row in delete_rows:
                store_key = str(row.get("store_key") or "")
                if not store_key.startswith("bound_room."):
                    continue
                # Compare-and-delete: never erase a binding that changed rooms after capture.
                cursor = conn.execute(
                    "DELETE FROM kv WHERE user_key = ? AND store_key = ? AND value IS ?",
                    (str(row.get("user_key") or ""), store_key, row.get("value")),
                )
                deleted += max(0, cursor.rowcount)
            if safe_upserts:
                conn.executemany(
                    "INSERT OR REPLACE INTO kv (user_key, store_key, value) VALUES (?, ?, ?)",
                    [
                        (
                            str(row.get("user_key") or ""),
                            str(row.get("store_key") or ""),
                            row.get("value"),
                        )
                        for row in safe_upserts
                    ],
                )
            if delete_documents_room is not None:
                conn.execute("DELETE FROM documents WHERE room = ?", (delete_documents_room,))
            if upsert_documents:
                conn.executemany(
                    "INSERT OR REPLACE INTO documents"
                    " (room, type, id, schema_version, data, meta, grants, seq)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        (
                            str(row.get("room") or ""),
                            str(row.get("type") or ""),
                            str(row.get("id") or ""),
                            int(row.get("schema_version") or 1),
                            str(row.get("data") or "{}"),
                            str(row.get("meta") or "{}"),
                            str(row.get("grants") or "[]"),
                            int(row.get("seq") or 0),
                        )
                        for row in upsert_documents
                    ],
                )
            if delete_state_room is not None:
                conn.execute("DELETE FROM room_state WHERE room = ?", (delete_state_room,))
            if upsert_state is not None:
                state_room, state_rows = upsert_state
                if state_rows:
                    conn.executemany(
                        "INSERT OR REPLACE INTO room_state (room, key, value) VALUES (?, ?, ?)",
                        [
                            (state_room, str(row.get("key") or ""), row.get("value"))
                            for row in state_rows
                        ],
                    )
            if clear_storages is not None:
                clear_room, storages = clear_storages
                for storage in storages:
                    statement = _IMPORT_CLEAR_SQL.get(storage)
                    if statement is None:
                        # A facet declared a persisted storage no snapshot carries, and
                        # nothing here knows how to empty it. Failing the import is the
                        # only honest option: the alternative is the room silently keeping
                        # state the backup it just loaded knows nothing about.
                        raise RuntimeError(
                            f"no import-clear statement for storage {storage!r}"  # i18n-exempt: invariant
                        )
                    conn.execute(statement, (clear_room,))
            services.store._commit(conn)
        except BaseException:
            conn.rollback()
            raise
    return deleted


async def _replace_room_content(
    services: Services,
    chat_key: str,
    rows: list[dict[str, Any]],
    documents: list[dict[str, Any]],
    state_rows: list[dict[str, Any]],
    *,
    clear_storages: tuple[str, list[str]] | None = None,
    preserve_foreign_bindings: bool = True,
) -> None:
    current = await room_rows(services, chat_key, enforce_limits=False)
    await _atomic_store_update(
        services,
        delete_rows=current,
        upsert_rows=rows,
        delete_documents_room=chat_key,
        upsert_documents=documents,
        delete_state_room=chat_key,
        upsert_state=(chat_key, state_rows),
        clear_storages=clear_storages,
        preserve_foreign_bindings=preserve_foreign_bindings,
    )


async def _replace_room_history(
    services: Services,
    chat_key: str,
    history_rows: list[dict[str, Any]],
) -> None:
    """Wipe the room's history tree and write `history_rows` in its place.

    A named save is a whole-room checkpoint: rows the snapshot does not carry must
    not survive the load, and a failed load must be able to put the captured tree
    back the same way.
    """
    await services.store.history_delete_room(chat_key)
    for key in {row["key"] for row in history_rows}:
        await services.store.history_append(
            chat_key, key, [row for row in history_rows if row["key"] == key]
        )


async def _delete_room_vectors(services: Services, chat_key: str) -> int:
    vector_store = getattr(services.vector_db, "vector_store", None)
    if vector_store is None:
        return 0
    if not hasattr(vector_store, "delete"):
        raise RuntimeError("vector store cannot safely delete room points")  # i18n-exempt
    points = await room_vector_points(services, chat_key, enforce_limits=False)
    point_ids = [str(point["id"]) for point in points]
    if point_ids:
        # Delete the already ownership-validated exact ids. Broad single-field filters would
        # erase a corrupt point whose other ownership field names a different room.
        await vector_store.delete(point_ids)
    return len(point_ids)


async def _delete_room_collection_vectors(
    services: Services,
    chat_key: str,
    collections: frozenset[str],
) -> int:
    """Delete only the room's points in `collections` — the lanes a partial reset wipes.

    A story/chars reset wipes the chronicle documents but KEEPS the module and its lore
    vectors, so the room-wide deletion above is too much — and no deletion is too little:
    the orphaned points would keep matching the new playthrough's topical recall (each hit
    resolving to a document that no longer exists and being dropped, silently wasting
    recall slots) and pile up across repeated resets of the same room. Which lanes those
    are is the facets' answer, not this function's. Same posture as `_delete_room_vectors`:
    ownership-validated exact ids only.
    """
    vector_store = getattr(services.vector_db, "vector_store", None)
    if vector_store is None or not collections:
        return 0
    if not hasattr(vector_store, "delete"):
        raise RuntimeError("vector store cannot safely delete room points")  # i18n-exempt
    points = await room_vector_points(services, chat_key, enforce_limits=False)
    point_ids = [
        str(point["id"])
        for point in points
        if isinstance(point.get("payload"), dict)
        and point["payload"].get("collection") in collections
    ]
    if point_ids:
        await vector_store.delete(point_ids)
    return len(point_ids)


async def _replace_room_vectors(
    services: Services,
    chat_key: str,
    points: list[dict[str, Any]],
) -> None:
    await _delete_room_vectors(services, chat_key)
    if not points:
        return
    vector_store = getattr(services.vector_db, "vector_store", None)
    if vector_store is None or not hasattr(vector_store, "upsert"):
        raise RuntimeError("vector store cannot restore room points")  # i18n-exempt: internal rollback failure
    await vector_store.upsert(
        [
            (
                str(point["id"]),
                list(point["vector"]),
                dict(point.get("payload") or {}),
            )
            for point in points
        ]
    )


def _replace_room_keys(keystore: Keystore, room: str, keys: list[dict[str, str]]) -> None:
    """Restore missing pre-operation keys without erasing newer operator changes.

    A room-data delete spans several stores and cannot hold the keystore's OS lock while
    moving media. If an operations process mints a recovery key after our key-delete leg
    but before a later media failure, rollback must preserve that newer key. Likewise, a
    concurrent downgrade of a re-created key wins over the older snapshot.
    """
    with keystore.persisted_mutation():
        for item in keys:
            key = str(item.get("key") or "")
            existing = keystore.get(key)
            if existing is not None:
                if existing.room != room:
                    raise RuntimeError("room key was rebound during rollback")  # i18n-exempt: internal detail
                continue
            if not keystore.restore(
                key,
                room=room,
                name=str(item.get("name") or ""),
                role=str(item.get("role") or "player"),
            ):
                raise RuntimeError("failed to restore room key")


def _hash_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _link_or_copy(source: Path, target: Path) -> None:
    ensure_private_directory(target.parent)
    try:
        os.link(source, target)
    except OSError:
        shutil.copyfile(source, target)
    restrict_file(target)


async def _stage_room_media(
    services: Services,
    chat_key: str,
    records: list[MediaRecord],
) -> tuple[Path, list[_StagedMedia]]:
    root = _backup_base(services) / ".transactions" / uuid.uuid4().hex
    ensure_private_directory(root)
    media = _media_store(services)
    staged: list[_StagedMedia] = []
    try:
        for record in records:
            original = media._path(chat_key, record.hash)
            if (
                not original.is_file()
                or original.stat().st_size != record.size
                or _hash_path(original) != record.hash
            ):
                raise ValueError("room media is missing or corrupt")  # i18n-exempt: internal admin op detail
            backup = root / record.hash
            _link_or_copy(original, backup)
            staged.append(_StagedMedia(record=record, original=original, staged=backup))
    except BaseException:
        shutil.rmtree(root, ignore_errors=True)
        raise
    return root, staged


async def _restore_staged_media(
    services: Services,
    staged: list[_StagedMedia],
) -> None:
    if not staged:
        return
    media = _media_store(services)
    for item in staged:
        if not item.original.is_file():
            _link_or_copy(item.staged, item.original)
        elif (
            item.original.stat().st_size != item.record.size
            or _hash_path(item.original) != item.record.hash
        ):
            item.original.unlink()
            _link_or_copy(item.staged, item.original)

    await media._ensure_schema()
    async with services.store._lock:
        conn = services.store._ensure_conn()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.executemany(
                """
                INSERT OR REPLACE INTO media_index
                    (hash, room, mime, size, name, uploader, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        item.record.hash,
                        item.record.room,
                        item.record.mime,
                        item.record.size,
                        item.record.name,
                        item.record.uploader,
                        item.record.created_at,
                    )
                    for item in staged
                ],
            )
            services.store._commit(conn)
        except BaseException:
            conn.rollback()
            raise


async def _remove_imported_media(
    services: Services,
    chat_key: str,
    hashes: set[str],
) -> None:
    if not hashes:
        return
    media = _media_store(services)
    await media._ensure_schema()
    protected: set[str] = set()
    async with services.store._lock:
        conn = services.store._ensure_conn()
        for digest in hashes:
            target = media._path(chat_key, digest)
            other_rooms = conn.execute(
                "SELECT room FROM media_index WHERE room != ? AND hash = ?",
                (chat_key, digest),
            ).fetchall()
            if any(media._path(str(row[0]), digest) == target for row in other_rooms):
                protected.add(digest)

    # Remove the live index first. If SQLite refuses the transaction, every blob remains
    # reachable exactly as before. A later unlink failure can only leave an unindexed private
    # content-addressed orphan; it cannot damage the room state being restored.
    async with services.store._lock:
        conn = services.store._ensure_conn()
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.executemany(
                "DELETE FROM media_index WHERE room = ? AND hash = ?",
                [(chat_key, digest) for digest in hashes],
            )
            services.store._commit(conn)
        except BaseException:
            conn.rollback()
            raise

    for digest in hashes - protected:
        try:
            media._path(chat_key, digest).unlink()
        except FileNotFoundError:
            pass
        except OSError:
            logger.exception("failed to remove rolled-back room media blob")


async def _rollback_room_state(
    services: Services,
    keystore: Keystore,
    room: str,
    chat_key: str,
    state: _RoomState,
    *,
    staged_media: list[_StagedMedia] | None = None,
    imported_media: set[str] | None = None,
    restore_keys: bool = False,
) -> None:
    staged_media = staged_media or []
    imported_media = imported_media or set()
    errors: list[BaseException] = []
    for action in (
        lambda: _remove_imported_media(services, chat_key, imported_media),
        lambda: _restore_staged_media(services, staged_media),
        lambda: _replace_room_vectors(services, chat_key, state.vectors),
        lambda: _replace_room_content(services, chat_key, state.rows, state.documents, state.state_rows),
        lambda: _replace_room_history(services, chat_key, state.history),
    ):
        try:
            await action()
        except BaseException as exc:  # keep attempting independent rollback legs
            errors.append(exc)
    if restore_keys:
        try:
            _replace_room_keys(keystore, room, state.keys)
        except BaseException as exc:
            errors.append(exc)
    if errors:
        names = ", ".join(type(error).__name__ for error in errors)
        raise RuntimeError(f"room operation rollback failed: {names}") from errors[0]  # i18n-exempt: internal detail


def _discard_stage(root: Path) -> None:
    try:
        shutil.rmtree(root)
    except FileNotFoundError:
        return
    except OSError:
        # The logical room deletion already completed.  Retaining a private hard-link in a
        # 0700 recovery directory is safer than reporting failure after the last rollback
        # point and potentially losing the only recoverable copy.
        logger.exception("failed to remove completed room-backup transaction directory")


async def reset_room_state(
    services: Services,
    chat_key: str,
    *,
    scope: str = "story",
    keystore: Keystore | None = None,
) -> dict[str, Any]:
    """Wipe part of one room's campaign state in place, keeping keystore keys,
    channel/keeper bindings and live connections. ``scope`` chooses how much:

    - ``"story"`` (default): the narrative session only — chat, session/battle
      records, KP notes, initiative, clock, recap, relationships and in-play NPCs
      (an AI companion is one of those, and it leaves WHOLE: record, sheet and
      party-roster row, because half a companion is a ghost party member no command
      can reach). The PLAYERS' characters, the loaded module, world lore and media
      are KEPT, so the same table replays the same scenario from a clean slate.
    - ``"chars"``: the above PLUS the party's characters, so fresh investigators
      face the SAME module.
    - ``"all"``: everything above PLUS the module, world lore and media (KV rows,
      document vectors and blobs) — a brand-new campaign in the same room.

    Room settings (language, house rules, enabled skills, media/bot toggles) survive
    every level. Channel->session bindings survive too (none of the groups name
    ``bound_room``). Each leg is a plain wipe with nothing to restore, so re-running
    the reset simply clears whatever remained after a partial failure.
    """
    if scope not in RESET_SCOPES:
        raise ValueError(f"unknown reset scope: {scope}")  # i18n-exempt: internal guard
    # M17: content lives in the documents table and runtime state in room_state, both
    # room-scoped by an exact COLUMN — a dotted-neighbor room can no longer alias this
    # room's rows, so the pre-M17 prefix-ambiguity guard is structurally unnecessary here.
    registry = room_registry()
    # Facet-owned disposal a target list cannot name — a facet that owns a SLICE of a
    # family another facet owns wholesale (`infra.room_facets`). It runs FIRST: such a
    # hook selects its slice by reading the records the target lists below are about to
    # delete, so running it after them would leave it with nothing to select on. Which
    # facets these are, and what each one takes, is the registry's answer; the order is
    # this operation's, like every other leg.
    facet_ctx = FacetContext(services=services, room=room_for_chat_key(chat_key), chat_key=chat_key)
    for facet in registry.reset_hooks(scope):
        hook = facet.on_reset
        if hook is not None:
            await hook(facet_ctx)
    doc_types, state_keys, state_prefixes = registry.reset_targets(scope)
    storages = registry.storages_at(scope)
    deleted_docs = 0
    for doc_type in sorted(doc_types):
        deleted_docs += await services.store.doc_delete_type(chat_key, doc_type)
    deleted_state = await services.store.state_delete_keys(
        chat_key, keys=sorted(state_keys), prefixes=sorted(state_prefixes)
    )
    # M20 D: the append-only history tree and the undo ring are part of the narrative
    # session at every scope — a "fresh session" that could still be rewound into the old
    # one, or whose recap could still read it, would not be fresh. Both are whole-table
    # storages rather than key lists, which is why the facets that live in them name the
    # storage and the wipe is driven from that.
    if STORAGE_HISTORY in storages:
        deleted_state += await services.store.history_delete_room(chat_key)
    if STORAGE_SNAPSHOTS in storages:
        deleted_state += await services.store.snapshot_delete_room(chat_key)
    deleted_vectors = 0
    deleted_media = 0
    if scope == "all":
        # Every point the room owns, not just the claimed lanes: a full reset must also
        # take a collection left behind by an older build, which no live facet claims.
        deleted_vectors = await _delete_room_vectors(services, chat_key)
    elif STORAGE_VECTORS in storages:
        # The chronicle documents are wiped at EVERY scope (they ARE the narrative
        # session), so their embedding points must leave with them — the module's own
        # lore vectors survive, exactly like the module they index.
        deleted_vectors = await _delete_room_collection_vectors(
            services, chat_key, registry.vector_collections_at(scope)
        )
    if STORAGE_MEDIA in storages:
        # Uploaded blobs only a full reset clears.
        deleted_media = await _media_store(services).delete_room(chat_key)
    return {
        "chat_key": chat_key,
        "scope": scope,
        "documents": deleted_docs,
        "store_rows": deleted_state,
        "vector_points": deleted_vectors,
        "media_files": deleted_media,
    }


async def delete_room_data(
    services: Services,
    keystore: Keystore,
    room: str,
    *,
    hub: Any | None = None,
) -> dict[str, Any]:
    """Delete one room entirely. ``hub`` lets facets that own in-process state dispose of
    it too; a caller without a bus (the CLI) passes none and leaks nothing."""
    room = room.strip()
    if not room:
        raise ValueError("snapshot room is empty")
    chat_key = chat_key_for_room(room)
    state = await _capture_room_state(services, keystore, room, chat_key)
    stage_root, staged_media = await _stage_room_media(services, chat_key, state.media)
    keys_before_delete = state.keys
    keys_mutated = False

    try:
        deleted_rows = await _atomic_store_update(
            services,
            delete_rows=state.rows,
            delete_documents_room=chat_key,
            delete_state_room=chat_key,
        )
        deleted_rows += len(state.documents) + len(state.state_rows)
        deleted_rows += await services.store.history_delete_room(chat_key)
        deleted_rows += await services.store.snapshot_delete_room(chat_key)
        deleted_vectors = await _delete_room_vectors(services, chat_key)
        with keystore.persisted_mutation():
            # ``persisted_mutation`` refreshes a file-backed keystore under its cross-process
            # lock. Capture that authoritative pre-delete view so a later media failure never
            # drops a key minted by an operations process after our initial room snapshot.
            keys_before_delete = room_key_entries(keystore, room)
            deleted_keys = keystore.remove_room(room)
        keys_mutated = True
        # Media is last because it is the only leg that moves blob files.  The hard-link/copy
        # stage above remains available until every logical mutation has succeeded.
        deleted_media = await _media_store(services).delete_room(chat_key)
        # Facet-owned disposal that no target list can express — today only in-process
        # state, which is why it runs after every persisted leg: there is nothing to
        # compensate if it fails, and nothing that fails if the room is already gone.
        facet_ctx = FacetContext(services=services, room=room, chat_key=chat_key, hub=hub)
        for facet in room_registry().delete_hooks():
            hook = facet.on_delete
            if hook is not None:
                await hook(facet_ctx)
    except BaseException:
        rollback_state = _RoomState(
            rows=state.rows,
            documents=state.documents,
            state_rows=state.state_rows,
            history=state.history,
            vectors=state.vectors,
            keys=keys_before_delete,
            media=state.media,
        )
        try:
            await _rollback_room_state(
                services,
                keystore,
                room,
                chat_key,
                rollback_state,
                staged_media=staged_media,
                restore_keys=keys_mutated,
            )
        except BaseException as rollback_exc:
            # Keep the private staging directory for manual recovery if even compensation fails.
            raise RuntimeError("room delete failed and rollback was incomplete") from rollback_exc  # i18n-exempt
        _discard_stage(stage_root)
        raise

    _discard_stage(stage_root)
    return {
        "room": room,
        "chat_key": chat_key,
        "keys": deleted_keys,
        "store_rows": deleted_rows,
        "vector_points": deleted_vectors,
        "media_files": deleted_media,
    }


async def import_room(
    services: Services,
    keystore: Keystore,
    path: str,
    *,
    expected_room: str = "",
) -> dict[str, Any]:
    expected = expected_room.strip()
    source = _resolve_import_path(services, path, expected)
    restrict_file(source)
    # Bound the read itself, not only ``stat``: a concurrently replaced file cannot make the
    # process allocate an arbitrarily large JSON/base64 payload after the size check.
    with source.open("rb") as handle:
        encoded = handle.read(MAX_BACKUP_FILE_BYTES + 1)
    if not encoded or len(encoded) > MAX_BACKUP_FILE_BYTES:
        raise ValueError("room snapshot byte limit exceeded")
    try:
        raw = json.loads(encoded.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid room snapshot JSON") from exc
    if not isinstance(raw, dict) or int(raw.get("version", 0) or 0) != SNAPSHOT_VERSION:
        raise ValueError("unsupported room snapshot version")

    old_room = str(raw.get("room") or "").strip()
    if not old_room:
        raise ValueError("snapshot room is empty")
    old_chat_key = str(raw.get("chat_key") or "")
    if old_chat_key != chat_key_for_room(old_room):
        raise ValueError("snapshot chat key does not match its room")  # i18n-exempt: internal admin op detail
    # A networked keeper may only re-import a backup OF its own room (the admin layer passes
    # its bound room as `expected_room`); cross-room clone/rename stays a server-side/CLI op.
    if expected and old_room != expected:
        raise ValueError("snapshot belongs to a different room")  # i18n-exempt: mapped to localized op_failed
    room = expected or old_room
    new_chat_key = chat_key_for_room(room)

    # Validate every section before mutating any live component.  Invalid entries fail the
    # whole restore; silently skipping a forged row/key would produce a deceptively "successful"
    # partial room and makes backup corruption much harder to detect.
    raw_rows = _list_field(raw, "store_rows")
    _bounded_section(
        raw_rows,
        count_limit=MAX_BACKUP_STORE_ROWS,
        byte_limit=MAX_BACKUP_STORE_BYTES,
        name="store rows",
    )
    validated_rows: list[dict[str, Any]] = []
    row_ids: set[tuple[str, str]] = set()
    for row in raw_rows:
        if not isinstance(row, dict):
            raise ValueError("invalid store row")
        user_key = row.get("user_key", "")
        store_key = row.get("store_key", "")
        value = row.get("value")
        if not isinstance(user_key, str) or not isinstance(store_key, str):
            raise ValueError("invalid store row")
        if value is not None and not isinstance(value, str):
            raise ValueError("invalid store row")
        if store_key.startswith("bound_room.") and user_key:
            raise ValueError("invalid bound room row")
        rewritten = _rewrite_room_row(row, old_chat_key, new_chat_key)
        rewritten_key = str(rewritten.get("store_key") or "")
        if not _matches_room_store_key(rewritten_key, rewritten.get("value"), new_chat_key):
            raise ValueError("snapshot contains a store row owned by another room")  # i18n-exempt: internal detail
        row_id = (user_key, rewritten_key)
        if row_id in row_ids:
            raise ValueError("snapshot contains duplicate store rows")
        row_ids.add(row_id)
        validated_rows.append(
            {"user_key": user_key, "store_key": rewritten_key, "value": rewritten.get("value")}
        )

    raw_documents = _list_field(raw, "documents")
    _bounded_section(
        raw_documents,
        count_limit=MAX_BACKUP_STORE_ROWS,
        byte_limit=MAX_BACKUP_STORE_BYTES,
        name="documents",
    )
    validated_documents: list[dict[str, Any]] = []
    doc_ids: set[tuple[str, str]] = set()
    for row in raw_documents:
        if not isinstance(row, dict):
            raise ValueError("invalid document row")
        doc_type = row.get("type")
        doc_id = row.get("id")
        data = row.get("data")
        meta = row.get("meta", "{}")
        grants = row.get("grants", "[]")
        if not isinstance(doc_type, str) or not doc_type or not isinstance(doc_id, str) or not doc_id:
            raise ValueError("invalid document row")
        if not isinstance(data, str) or not isinstance(meta, str) or not isinstance(grants, str):
            raise ValueError("invalid document row")
        row_room = row.get("room", old_chat_key)
        if row_room != old_chat_key:
            raise ValueError("snapshot contains a document owned by another room")  # i18n-exempt: internal detail
        dedup = (doc_type, doc_id)
        if dedup in doc_ids:
            raise ValueError("snapshot contains duplicate documents")
        doc_ids.add(dedup)
        try:
            schema_version = int(row.get("schema_version") or 1)
            seq = int(row.get("seq") or 0)
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid document row") from exc
        validated_documents.append(
            {
                "room": new_chat_key,
                "type": doc_type,
                "id": doc_id,
                "schema_version": schema_version,
                "data": data.replace(old_chat_key, new_chat_key) if old_chat_key != new_chat_key else data,
                "meta": meta,
                "grants": grants,
                "seq": seq,
            }
        )

    raw_state = _list_field(raw, "room_state")
    _bounded_section(
        raw_state,
        count_limit=MAX_BACKUP_STORE_ROWS,
        byte_limit=MAX_BACKUP_STORE_BYTES,
        name="room state rows",
    )
    validated_state: list[dict[str, Any]] = []
    state_keys_seen: set[str] = set()
    for row in raw_state:
        if not isinstance(row, dict):
            raise ValueError("invalid room state row")
        key = row.get("key")
        value = row.get("value")
        if not isinstance(key, str) or not key:
            raise ValueError("invalid room state row")
        if value is not None and not isinstance(value, str):
            raise ValueError("invalid room state row")
        if key in state_keys_seen:
            raise ValueError("snapshot contains duplicate room state rows")  # i18n-exempt: internal detail
        state_keys_seen.add(key)
        if value is not None and old_chat_key != new_chat_key:
            value = value.replace(old_chat_key, new_chat_key)
        validated_state.append({"key": key, "value": value})

    raw_history = _list_field(raw, "chat_history")
    _bounded_section(
        raw_history,
        count_limit=MAX_BACKUP_STORE_ROWS,
        byte_limit=MAX_BACKUP_STORE_BYTES,
        name="chat history rows",
    )
    validated_history: list[dict[str, Any]] = []
    for row in raw_history:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
            raise ValueError("invalid chat history row")
        parent = row.get("parent_id")
        if parent is not None and not isinstance(parent, str):
            raise ValueError("invalid chat history row")
        validated_history.append(
            {
                "key": str(row.get("key") or "chat_history"),
                "id": row["id"],
                "parent_id": parent or None,
                "turn": int(row.get("turn") or 0),
                "role": str(row.get("role") or ""),
                "content": str(row.get("content") or ""),
                "seq": int(row.get("seq") or 0),
            }
        )

    raw_vectors = _list_field(raw, "vector_points")
    _bounded_section(
        raw_vectors,
        count_limit=MAX_BACKUP_VECTOR_POINTS,
        byte_limit=MAX_BACKUP_VECTOR_BYTES,
        name="vector points",
    )
    vector_store = getattr(services.vector_db, "vector_store", None)
    if raw_vectors and (vector_store is None or not hasattr(vector_store, "upsert")):
        raise ValueError("snapshot contains vectors but no vector store is available")  # i18n-exempt
    vector_dim = int(getattr(vector_store, "dim", 0) or 0)
    validated_vectors: list[tuple[str, list[float], dict[str, Any]]] = []
    vector_ids: set[str] = set()
    vector_values = 0
    for point in raw_vectors:
        if not isinstance(point, dict) or not isinstance(point.get("id"), str):
            raise ValueError("invalid vector point")
        if not isinstance(point.get("payload"), dict) or not isinstance(point.get("vector"), list):
            raise ValueError("invalid vector point")
        rewritten = _rewrite_vector_point(point, old_chat_key, new_chat_key)
        point_id = str(rewritten.get("id") or "")
        payload = dict(rewritten.get("payload") or {})
        vector = rewritten.get("vector")
        if not _vector_payload_owned_by_room(payload, new_chat_key):
            raise ValueError("snapshot contains a vector owned by another room")  # i18n-exempt: internal detail
        if not point_id or point_id in vector_ids or len(vector) != vector_dim:
            raise ValueError("invalid vector point")
        if any(
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(float(value))
            for value in vector
        ):
            raise ValueError("invalid vector point")
        vector_values += len(vector)
        if vector_values > MAX_BACKUP_VECTOR_VALUES:
            raise ValueError("vector value limit exceeded")
        vector_ids.add(point_id)
        validated_vectors.append((point_id, [float(value) for value in vector], payload))
    # Collision check only: a same-id point owned by another room must fail before
    # any live mutation. Room-owned leftovers are not listed here — the import
    # replaces the whole room vector set rather than deleting aliases of incoming ids.
    await _preflight_vector_import(
        vector_store,
        validated_vectors,
        new_chat_key,
    )

    raw_media = _list_field(raw, "media")
    if len(raw_media) > MAX_BACKUP_MEDIA_FILES:
        raise ValueError("media entry limit exceeded")
    media_store = _media_store(services)
    validated_media: list[tuple[PendingUpload, bytes]] = []
    media_hashes: set[str] = set()
    total_media_bytes = 0
    media_bytes_by_kind = {"image": 0, "audio": 0}
    for item in raw_media:
        if not isinstance(item, dict):
            raise ValueError("invalid media entry")
        try:
            size_raw = item.get("size")
            if isinstance(size_raw, bool):
                raise ValueError
            size = int(size_raw)
        except (ValueError, TypeError) as exc:
            raise ValueError("invalid media entry") from exc
        digest = str(item.get("hash") or "").lower()
        mime = str(item.get("mime") or "").lower()
        data_text = item.get("data")
        try:
            file_limit, quota_limit, allowed_mimes = _media_policy(services, mime)
        except ValueError as exc:
            raise ValueError("invalid media entry") from exc
        kind = "image" if mime in ALLOWED_IMAGE_MIMES else "audio"
        if (
            mime not in ALLOWED_MEDIA_MIMES
            or size <= 0
            or size > file_limit
            or not isinstance(data_text, str)
            or len(data_text) != 4 * ((size + 2) // 3)
            or digest in media_hashes
        ):
            raise ValueError("invalid media entry")
        total_media_bytes += size
        if total_media_bytes > MAX_BACKUP_MEDIA_BYTES:
            raise ValueError("media backup byte limit exceeded")
        media_bytes_by_kind[kind] += size
        if media_bytes_by_kind[kind] > quota_limit:
            raise ValueError("media snapshot exceeds room quota")
        try:
            data = base64.b64decode(data_text, validate=True)
        except (ValueError, TypeError) as exc:
            raise ValueError("invalid media entry") from exc
        if size != len(data) or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("invalid media entry")
        if mime == SVG_MIME:
            try:
                validate_svg_bytes(data)
            except SvgSafetyError as exc:
                raise ValueError("invalid media entry") from exc
        media_hashes.add(digest)
        validated_media.append(
            (
                PendingUpload(
                    upload_id="",
                    room=new_chat_key,
                    mime=mime,
                    size=size,
                    name=str(item.get("name") or "media")[:255],
                    uploader=str(item.get("uploader") or "backup")[:255],
                    sha256=digest,
                    max_file_bytes=file_limit,
                    room_quota_bytes=quota_limit,
                    allowed_mimes=allowed_mimes,
                ),
                data,
            )
        )
    raw_keys = _list_field(raw, "keys")
    if len(raw_keys) > MAX_BACKUP_KEYS:
        raise ValueError("room key limit exceeded")
    validated_keys: list[dict[str, str]] = []
    key_values: set[str] = set()
    for item in raw_keys:
        if not isinstance(item, dict):
            raise ValueError("invalid room key")
        key = item.get("key")
        name = item.get("name", "")
        role = item.get("role", "player")
        key_room = item.get("room", old_room)
        if (
            not isinstance(key, str)
            or not key.strip()
            or not isinstance(name, str)
            or role not in {"player", "keeper"}
            or key_room != old_room
            or key in key_values
        ):
            raise ValueError("invalid room key")
        existing = keystore.get(key)
        if existing is not None and existing.room != room:
            raise ValueError("snapshot key belongs to a different room")  # i18n-exempt: internal detail
        key_values.add(key)
        validated_keys.append({"key": key, "room": room, "name": name, "role": role})

    state = await _capture_room_state(services, keystore, room, new_chat_key)
    # The undo ring is the one persisted storage no snapshot carries, so the import
    # transaction below CLEARS it — otherwise `.undo` could rewind through the load into
    # the room's pre-import life. Capture it first: this operation compensates every
    # mutation it makes, and a ring only this code erased must come back with the rest.
    snapshots_before = await _capture_room_snapshots(services, new_chat_key)
    cleared_storages = sorted(room_registry().storages_not_exported())
    # Live blobs the snapshot does not name are extras: they must leave on a successful
    # load, and they must come back if a later leg fails. Stage them before any mutation
    # so rollback can put the bytes back after the live copies are removed.
    extra_media = [record for record in state.media if record.hash not in media_hashes]
    stage_root: Path | None = None
    staged_media: list[_StagedMedia] = []
    if extra_media:
        stage_root, staged_media = await _stage_room_media(services, new_chat_key, extra_media)
    created_media_hashes: set[str] = set()
    try:
        # A load is a checkpoint replacement, not a merge: wipe the live room's
        # exportable rows, then write the snapshot.
        await _replace_room_content(
            services,
            new_chat_key,
            validated_rows,
            validated_documents,
            validated_state,
            clear_storages=(new_chat_key, cleared_storages),
            # A live binding that already names another room is a conflict, not a
            # merge: fail the load rather than silently drop the snapshot row.
            # Rollback (the default) skips that upsert so a concurrent rebind wins.
            preserve_foreign_bindings=False,
        )
        # History rides outside that transaction: the tree is append-only at the
        # store API, so replacement is delete-then-append. A later-leg failure
        # puts the captured tree back through the same helper.
        await _replace_room_history(services, new_chat_key, validated_history)
        await _replace_room_vectors(
            services,
            new_chat_key,
            [
                {"id": point_id, "vector": vector, "payload": payload}
                for point_id, vector, payload in validated_vectors
            ],
        )
        for pending, data in validated_media:
            file_limit, quota_limit, allowed_mimes = _media_policy(services, pending.mime)
            existing = await media_store.validate_offer(
                room=new_chat_key,
                mime=pending.mime,
                size=pending.size,
                sha256=pending.sha256,
                max_file_bytes=file_limit,
                room_quota_bytes=quota_limit,
                allowed_mimes=allowed_mimes,
            )
            if existing is None:
                await media_store.commit_bytes(pending, data)
                created_media_hashes.add(pending.sha256)
        if extra_media:
            await _remove_imported_media(
                services,
                new_chat_key,
                {record.hash for record in extra_media},
            )

        imported_keys = 0
        with keystore.persisted_mutation():
            for item in validated_keys:
                # Re-check after ``persisted_mutation`` refreshes a file-backed keystore; a
                # concurrent process may have claimed this exact bearer key since validation.
                existing = keystore.get(item["key"])
                if existing is not None and existing.room != room:
                    raise ValueError("snapshot key belongs to a different room")  # i18n-exempt: internal detail
                if not keystore.restore(
                    item["key"],
                    room=room,
                    name=item["name"],
                    role=item["role"],
                ):
                    raise RuntimeError("failed to restore room key")
                imported_keys += 1
    except BaseException:
        rollback_errors: list[BaseException] = []
        try:
            await _rollback_room_state(
                services,
                keystore,
                room,
                new_chat_key,
                state,
                staged_media=staged_media,
                imported_media=created_media_hashes,
            )
        except BaseException as rollback_exc:
            rollback_errors.append(rollback_exc)
        # Its own independent leg, not a tail call behind the others: a failed media or
        # vector leg above must not ALSO cost the room its undo ring (M23 review — the
        # new leg has to join the attempt-everything discipline the others follow).
        try:
            await _restore_room_snapshots(services, new_chat_key, snapshots_before)
        except BaseException as ring_exc:
            rollback_errors.append(ring_exc)
        if rollback_errors:
            # Keep the private staging directory for manual recovery if even compensation fails.
            raise RuntimeError("room import failed and rollback was incomplete") from rollback_errors[0]  # i18n-exempt
        if stage_root is not None:
            _discard_stage(stage_root)
        raise

    if stage_root is not None:
        _discard_stage(stage_root)

    return {
        "room": room,
        "chat_key": new_chat_key,
        "path": str(source),
        "keys": imported_keys,
        "documents": len(validated_documents),
        "room_state_rows": len(validated_state),
        "chat_history_rows": len(validated_history),
        "store_rows": len(validated_rows),
        "vector_points": len(validated_vectors),
        "media_files": len(validated_media),
    }
