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

from agent.services import Services
from core.document_manager import document_point_id
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
from infra.svg import SVG_MIME, SvgSafetyError, validate_svg_bytes
from net.keystore import Keystore

SNAPSHOT_VERSION = 1

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

_EXACT_BASES = {
    "active_character",
    "bot_enabled",
    "chat_locale",
    "chat_history",
    "characters_list",
    "coc_rule",
    "game_clock",
    "initiative",
    "kp_notes",
    "locale",
    "media_enabled",
    "media_history",
    "module_catalog",
    "module_fulltext",
    "module_init_error",
    "module_init_status",
    "module_keeper_pool",
    "module_player_pool",
    "npc_list",
    "party_auto",
    "party_roster",
    "relationships",
    "session_recap",
    "session_recap_debug",
    "session_recap_turns",
    "skills_enabled",
    "audio_library",
    "audio_state",
    "usage_stats",
    "worldbook_index",
}

_PREFIX_BASES = {
    "battle_report",
    "characters",
    "npc",
    "session_history",
    "session_name",
    "session_record",
    "worldbook",
}

# --- `.reset` scope groups -----------------------------------------------------
# A scoped in-place restart, unlike backup/delete, partitions the room's own state
# rather than taking all of it. Room SETTINGS (language, house rules, enabled skills,
# media/bot toggles) are configuration, not campaign content, so they survive every
# reset level and appear in none of the groups below.
RESET_SCOPES = ("story", "chars", "all")

# `.reset` (lightest): a fresh narrative session — characters, module, lore and media
# are all kept. (`initiative_meta` and the `forge_module_*` ownership keys are wiped
# here/at `all` even though the backup allowlist above still omits them.)
_RESET_STORY_EXACT = frozenset(
    {
        "chat_history",
        "kp_notes",
        "initiative",
        "initiative_meta",
        "game_clock",
        "session_recap",
        "session_recap_debug",
        "session_recap_turns",
        "relationships",
        "usage_stats",
        "npc_list",
    }
)
_RESET_STORY_PREFIX = frozenset({"battle_report", "npc", "session_history", "session_name", "session_record"})
# `.reset chars`: also drop the party's characters, so fresh investigators face the SAME module.
_RESET_CHARS_EXACT = frozenset({"active_character", "characters_list", "party_roster", "party_auto"})
_RESET_CHARS_PREFIX = frozenset({"characters"})
# `.reset all`: also drop the module, world lore and media (KV rows here; vectors + blobs below).
_RESET_ALL_EXACT = frozenset(
    {
        "module_catalog",
        "module_fulltext",
        "module_init_error",
        "module_init_status",
        "module_keeper_pool",
        "module_player_pool",
        "media_history",
        "audio_library",
        "audio_state",
        "worldbook_index",
        "forge_module_last",
    }
)
_RESET_ALL_PREFIX = frozenset({"worldbook", "forge_module_owner"})


def _reset_bases(scope: str) -> tuple[set[str], set[str]]:
    """Return the (exact, prefix) store-key bases wiped at ``scope`` (cumulative)."""
    exact = set(_RESET_STORY_EXACT)
    prefix = set(_RESET_STORY_PREFIX)
    if scope in ("chars", "all"):
        exact |= _RESET_CHARS_EXACT
        prefix |= _RESET_CHARS_PREFIX
    if scope == "all":
        exact |= _RESET_ALL_EXACT
        prefix |= _RESET_ALL_PREFIX
    return exact, prefix


def _reset_row_matches(store_key: str, chat_key: str, exact: set[str], prefix: set[str]) -> bool:
    for base in exact:
        if store_key == f"{base}.{chat_key}":
            return True
    for base in prefix:
        if store_key.startswith(f"{base}.{chat_key}."):
            return True
    return False

# Scope note: these allowlists cover DURABLE, chat_key-scoped campaign state. Adapter-transient
# runtime state (e.g. the QQ adapter's `qq_hint_sent.{group_id}` / `qq_group_mode.{group_id}`,
# keyed by the raw platform channel id, not the room chat_key) is deliberately NOT captured — it
# is ephemeral per-channel bookkeeping, not campaign data, and is re-established at runtime.


def chat_key_for_room(room: str) -> str:
    return SessionSource(platform="tui", chat_type="group", chat_id=room).chat_key()


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
    for base in _EXACT_BASES:
        if store_key == f"{base}.{chat_key}":
            return True
    for base in _PREFIX_BASES:
        if store_key.startswith(f"{base}.{chat_key}."):
            return True
    # Cross-transport room bindings store the target session key as the value.
    return store_key.startswith("bound_room.") and value == chat_key


def _known_chat_keys_from_rows(rows: list[dict[str, Any]]) -> set[str]:
    """Recover unambiguous logical-room ids from exact KV rows and bindings.

    Prefix-shaped rows cannot be parsed safely (the suffix may be either an entity id or a
    dotted child room), so they deliberately do not contribute candidates here.
    """
    known: set[str] = set()
    for row in rows:
        store_key = row.get("store_key")
        value = row.get("value")
        if isinstance(store_key, str):
            for base in _EXACT_BASES:
                prefix = f"{base}."
                if store_key.startswith(prefix):
                    candidate = store_key[len(prefix) :]
                    if candidate.startswith(_TUI_CHAT_KEY_PREFIX):
                        known.add(candidate)
                    break
        if (
            isinstance(store_key, str)
            and store_key.startswith("bound_room.")
            and isinstance(value, str)
            and value.startswith(_TUI_CHAT_KEY_PREFIX)
        ):
            known.add(value)
    return known


async def _known_room_chat_keys(services: Services, keystore: Keystore) -> set[str]:
    # Refresh first so an externally moved/minted room key participates in the ambiguity guard.
    keystore.refresh()
    known = {chat_key_for_room(entry.room) for entry in keystore.entries() if entry.room.strip()}
    known.update(_known_chat_keys_from_rows(await services.store.list_rows()))
    return known


def _guard_room_prefix_ambiguity(chat_key: str, known_chat_keys: set[str]) -> None:
    """Fail closed when a dotted child room aliases this room's prefix-shaped KV namespace."""
    child_prefix = f"{chat_key}."
    if any(candidate != chat_key and candidate.startswith(child_prefix) for candidate in known_chat_keys):
        raise ValueError(
            "room id has an ambiguous dotted-prefix neighbor"  # i18n-exempt: internal invariant
        )


def _rewrite_room_row(row: dict[str, Any], old_chat_key: str, new_chat_key: str) -> dict[str, Any]:
    copied = dict(row)
    copied["store_key"] = str(copied.get("store_key", "")).replace(old_chat_key, new_chat_key)
    if copied["store_key"].startswith("bound_room.") and copied.get("value") == old_chat_key:
        copied["value"] = new_chat_key
    return copied


def _rewrite_payload_ownership(value: Any, old_chat_key: str, new_chat_key: str) -> Any:
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
    """Require both the vector kind's primary scope and every ownership field to agree.

    Worldbook points are namespace-scoped; document/other room vectors are chat-key-scoped.
    A second ownership field is allowed only when it points to the same target room. Nested
    metadata is checked too so a forged payload cannot smuggle a foreign owner through backup.
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
    if payload.get("collection") == "worldbook":
        return payload.get("namespace") == chat_key
    return payload.get("chat_key") == chat_key


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
    """Reject global id collisions and find obsolete aliases in the target room.

    Vector ids are global even though retrieval is payload-scoped. A same-room
    point with the same id is an ordinary upsert; the same id owned by any other
    room must fail before import mutates live state. Legacy backup aliases for the
    same document/chunk are returned for removal after canonical points publish.
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
    prefixes = [f"{base}.{chat_key}" for base in _EXACT_BASES]
    prefixes.extend(f"{base}.{chat_key}." for base in _PREFIX_BASES)
    prefixes.append("bound_room.")
    rows = await services.store.list_rows(store_key_prefixes=prefixes)
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
    _guard_room_prefix_ambiguity(chat_key, await _known_room_chat_keys(services, keystore))
    rows = await room_rows(services, chat_key, enforce_limits=True)
    # Close the guard/read race: if a dotted child appeared before the prefix query, detect it
    # before serializing any selected row; if it appeared afterwards, it was not selected.
    _guard_room_prefix_ambiguity(chat_key, await _known_room_chat_keys(services, keystore))
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
        "keys": keys,
        "store_rows": rows,
        "vector_points": vectors,
        "media": media,
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
        "store_rows": len(rows),
        "vector_points": len(vectors),
        "media_files": len(media),
    }


@dataclass(frozen=True)
class _RoomState:
    rows: list[dict[str, str | None]]
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
    _guard_room_prefix_ambiguity(chat_key, await _known_room_chat_keys(services, keystore))
    media = await _media_store(services).list_room_records(chat_key)
    rows = await room_rows(services, chat_key, enforce_limits=False)
    _guard_room_prefix_ambiguity(chat_key, await _known_room_chat_keys(services, keystore))
    return _RoomState(
        rows=rows,
        vectors=await room_vector_points(services, chat_key, enforce_limits=False),
        keys=[
            {"key": entry.key, "room": entry.room, "name": entry.name, "role": entry.role}
            for entry in keystore.entries()
            if entry.room == room
        ],
        media=media,
    )


async def _atomic_store_update(
    services: Services,
    *,
    delete_rows: list[dict[str, Any]] | None = None,
    upsert_rows: list[dict[str, Any]] | None = None,
    preserve_foreign_bindings: bool = False,
) -> int:
    """Apply the room KV portion in one SQLite transaction.

    ``Store.set`` intentionally commits every call for ordinary use; backup restore needs a
    batch boundary, so this small internal operation uses the same guarded connection directly.
    """
    delete_rows = delete_rows or []
    upsert_rows = upsert_rows or []
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
            services.store._commit(conn)
        except BaseException:
            conn.rollback()
            raise
    return deleted


async def _replace_room_rows(
    services: Services,
    chat_key: str,
    rows: list[dict[str, Any]],
) -> None:
    current = await room_rows(services, chat_key, enforce_limits=False)
    await _atomic_store_update(
        services,
        delete_rows=current,
        upsert_rows=rows,
        preserve_foreign_bindings=True,
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
        lambda: _replace_room_rows(services, chat_key, state.rows),
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
      records, KP notes, initiative, clock, recap, relationships and in-play NPCs.
      Characters, the loaded module, world lore and media are KEPT, so the same
      table replays the same scenario from a clean slate.
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
    # Fail closed on a dotted-child room that aliases this room's prefix-shaped KV namespace:
    # reset deletes rows by store-key prefix (worldbook/characters/session_history/...), so an
    # unguarded reset of "camp" would also wipe "camp.side"'s rows. Mirror the guard every other
    # room op (export/delete/import) already runs. The keystore-backed room set is authoritative —
    # it names a dotted child even when that child has only prefix-shaped rows, which
    # `_known_chat_keys_from_rows` deliberately cannot recover; on a keystore-less transport
    # (single-room CLI, where no neighbor can exist) fall back to the row-derived set.
    known = (
        await _known_room_chat_keys(services, keystore)
        if keystore is not None
        else _known_chat_keys_from_rows(await services.store.list_rows())
    )
    _guard_room_prefix_ambiguity(chat_key, known)
    exact, prefix = _reset_bases(scope)
    prefixes = [f"{base}.{chat_key}" for base in exact]
    prefixes.extend(f"{base}.{chat_key}." for base in prefix)
    rows = await services.store.list_rows(store_key_prefixes=prefixes)
    targets = [
        row for row in rows if _reset_row_matches(str(row.get("store_key") or ""), chat_key, exact, prefix)
    ]
    deleted_rows = await _atomic_store_update(services, delete_rows=targets)
    deleted_vectors = 0
    deleted_media = 0
    if scope == "all":
        # Module document chunks and uploaded media blobs only a full reset clears.
        deleted_vectors = await _delete_room_vectors(services, chat_key)
        deleted_media = await _media_store(services).delete_room(chat_key)
    return {
        "chat_key": chat_key,
        "scope": scope,
        "store_rows": deleted_rows,
        "vector_points": deleted_vectors,
        "media_files": deleted_media,
    }


async def delete_room_data(services: Services, keystore: Keystore, room: str) -> dict[str, Any]:
    room = room.strip()
    if not room:
        raise ValueError("snapshot room is empty")
    chat_key = chat_key_for_room(room)
    state = await _capture_room_state(services, keystore, room, chat_key)
    stage_root, staged_media = await _stage_room_media(services, chat_key, state.media)
    keys_before_delete = state.keys
    keys_mutated = False

    try:
        deleted_rows = await _atomic_store_update(services, delete_rows=state.rows)
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
    except BaseException:
        rollback_state = _RoomState(
            rows=state.rows,
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
    known_chat_keys = await _known_room_chat_keys(services, keystore)
    _guard_room_prefix_ambiguity(new_chat_key, known_chat_keys)

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
    # Old snapshots may have been produced by the formerly ambiguous prefix matcher. Exact rows
    # inside the snapshot can therefore reveal a dotted child room even if that room is currently
    # offline; reject the whole import instead of reclassifying its rows as the parent room.
    snapshot_known_chat_keys = _known_chat_keys_from_rows(
        [row for row in raw_rows if isinstance(row, dict)]
    )
    _guard_room_prefix_ambiguity(
        new_chat_key,
        known_chat_keys | snapshot_known_chat_keys,
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
    stale_vector_ids = await _preflight_vector_import(
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
    created_media_hashes: set[str] = set()
    try:
        await _atomic_store_update(services, upsert_rows=validated_rows)
        if validated_vectors:
            await vector_store.upsert(validated_vectors)
        if stale_vector_ids:
            await vector_store.delete(stale_vector_ids)
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
        try:
            await _rollback_room_state(
                services,
                keystore,
                room,
                new_chat_key,
                state,
                imported_media=created_media_hashes,
            )
        except BaseException as rollback_exc:
            raise RuntimeError("room import failed and rollback was incomplete") from rollback_exc  # i18n-exempt
        raise

    return {
        "room": room,
        "chat_key": new_chat_key,
        "path": str(source),
        "keys": imported_keys,
        "store_rows": len(validated_rows),
        "vector_points": len(validated_vectors),
        "media_files": len(validated_media),
    }
