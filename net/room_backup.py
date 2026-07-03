"""Room snapshot export/import/delete helpers for keeper admin operations."""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from agent.services import Services
from gateway.session import SessionSource
from net.keystore import Keystore

SNAPSHOT_VERSION = 1

_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9_.-]+")

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
    "module_catalog",
    "module_fulltext",
    "module_init_status",
    "module_keeper_pool",
    "module_player_pool",
    "npc_list",
    "party_auto",
    "party_roster",
    "session_recap",
    "session_recap_debug",
    "session_recap_turns",
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


def _default_path(services: Services, room: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return _backup_base(services) / f"{_safe_room(room)}_{stamp}.json"


def _backup_filename(raw: str, fallback: str) -> str:
    """Reduce a client-supplied path to a safe `<name>.json` filename with no directory parts."""
    name = Path(raw.strip()).name  # discards directories, absolute roots, and `..` components
    stem = name[:-5] if name.endswith(".json") else name
    stem = _SAFE_NAME_RE.sub("_", stem).strip("_")
    return f"{stem or fallback}.json"


def _resolve_export_path(services: Services, room: str, path: str = "") -> Path:
    base = _backup_base(services)
    if not path.strip():
        return _default_path(services, room)
    target = (base / _backup_filename(path, _safe_room(room))).resolve()
    if not target.is_relative_to(base):  # belt-and-suspenders after `.name` stripping
        raise ValueError("backup path escapes the backups directory")  # i18n-exempt: internal error -> op_failed
    return target


def _matches_room_store_key(store_key: str, value: str | None, chat_key: str) -> bool:
    for base in _EXACT_BASES:
        if store_key == f"{base}.{chat_key}":
            return True
    for base in _PREFIX_BASES:
        if store_key.startswith(f"{base}.{chat_key}."):
            return True
    # Cross-transport room bindings store the target session key as the value.
    return store_key.startswith("bound_room.") and value == chat_key


def _rewrite_room_row(row: dict[str, Any], old_chat_key: str, new_chat_key: str) -> dict[str, Any]:
    copied = dict(row)
    copied["store_key"] = str(copied.get("store_key", "")).replace(old_chat_key, new_chat_key)
    if copied["store_key"].startswith("bound_room.") and copied.get("value") == old_chat_key:
        copied["value"] = new_chat_key
    return copied


def _rewrite_vector_point(point: dict[str, Any], old_chat_key: str, new_chat_key: str) -> dict[str, Any]:
    copied = dict(point)
    copied["payload"] = dict(copied.get("payload") or {})
    if copied["payload"].get("chat_key") == old_chat_key:
        copied["payload"]["chat_key"] = new_chat_key
    if copied["payload"].get("namespace") == old_chat_key:
        copied["payload"]["namespace"] = new_chat_key
    point_id = str(copied.get("id") or "")
    if point_id.startswith(f"{old_chat_key}:"):
        copied["id"] = f"{new_chat_key}:{point_id[len(old_chat_key) + 1:]}"
    return copied


async def room_rows(services: Services, chat_key: str) -> list[dict[str, str | None]]:
    rows = await services.store.list_rows()
    return [
        row
        for row in rows
        if _matches_room_store_key(str(row["store_key"]), row.get("value"), chat_key)
    ]


async def room_vector_points(services: Services, chat_key: str) -> list[dict[str, Any]]:
    vector_store = getattr(services.vector_db, "vector_store", None)
    if vector_store is None or not hasattr(vector_store, "dump"):
        return []
    points_by_id: dict[str, dict[str, Any]] = {}
    for point in await vector_store.dump(filter={"chat_key": chat_key}):
        points_by_id[str(point.get("id") or "")] = point
    for point in await vector_store.dump(filter={"collection": "worldbook", "namespace": chat_key}):
        points_by_id[str(point.get("id") or "")] = point
    return [point for point_id, point in points_by_id.items() if point_id]


def room_key_entries(keystore: Keystore, room: str) -> list[dict[str, str]]:
    return [
        {"key": entry.key, "room": entry.room, "name": entry.name, "role": entry.role}
        for entry in keystore.entries()
        if entry.room == room
    ]


async def export_room(services: Services, keystore: Keystore, room: str, path: str = "") -> dict[str, Any]:
    room = room.strip()
    chat_key = chat_key_for_room(room)
    rows = await room_rows(services, chat_key)
    vectors = await room_vector_points(services, chat_key)
    keys = room_key_entries(keystore, room)
    target = _resolve_export_path(services, room, path)
    target.parent.mkdir(parents=True, exist_ok=True)

    snapshot = {
        "version": SNAPSHOT_VERSION,
        "exported_at": datetime.now().isoformat(),
        "room": room,
        "chat_key": chat_key,
        "keys": keys,
        "store_rows": rows,
        "vector_points": vectors,
    }
    target.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "room": room,
        "chat_key": chat_key,
        "path": str(target),
        "keys": len(keys),
        "store_rows": len(rows),
        "vector_points": len(vectors),
    }


async def delete_room_data(services: Services, keystore: Keystore, room: str) -> dict[str, Any]:
    room = room.strip()
    chat_key = chat_key_for_room(room)
    rows = await room_rows(services, chat_key)
    deleted_rows = await services.store.delete_rows((str(row["user_key"]), str(row["store_key"])) for row in rows)
    vector_store = getattr(services.vector_db, "vector_store", None)
    deleted_vectors = 0
    if vector_store is not None and hasattr(vector_store, "delete_by_filter"):
        deleted_vectors = await vector_store.delete_by_filter(filter={"chat_key": chat_key})
        deleted_vectors += await vector_store.delete_by_filter(filter={"collection": "worldbook", "namespace": chat_key})
    deleted_keys = keystore.remove_room(room)
    keystore.persist()
    return {
        "room": room,
        "chat_key": chat_key,
        "keys": deleted_keys,
        "store_rows": deleted_rows,
        "vector_points": deleted_vectors,
    }


async def import_room(
    services: Services,
    keystore: Keystore,
    path: str,
    *,
    expected_room: str = "",
) -> dict[str, Any]:
    # Confine imports to the backups directory too: only a filename is honored, so a client
    # can't read arbitrary files off the server (and can only ever re-import a real snapshot).
    base = _backup_base(services)
    source = (base / Path(path).name).resolve()
    if not source.is_relative_to(base) or not source.is_file():
        raise ValueError("import source is not a room backup file")  # i18n-exempt: internal error -> op_failed
    raw = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or int(raw.get("version", 0) or 0) != SNAPSHOT_VERSION:
        raise ValueError("unsupported room snapshot version")

    old_room = str(raw.get("room") or "").strip()
    old_chat_key = str(raw.get("chat_key") or chat_key_for_room(old_room))
    expected = expected_room.strip()
    # A networked keeper may only re-import a backup OF its own room (the admin layer passes
    # its bound room as `expected_room`); cross-room clone/rename stays a server-side/CLI op.
    if expected and old_room != expected:
        raise ValueError("snapshot belongs to a different room")  # i18n-exempt: internal error -> op_failed
    room = expected or old_room
    if not room:
        raise ValueError("snapshot room is empty")
    new_chat_key = chat_key_for_room(room)

    imported_rows = 0
    for row in raw.get("store_rows") or []:
        if not isinstance(row, dict):
            continue
        rewritten = _rewrite_room_row(row, old_chat_key, new_chat_key)
        store_key = str(rewritten.get("store_key") or "")
        # Re-validate ownership on the way IN, not just on export: a tampered snapshot must
        # not be able to write arbitrary/global store keys (e.g. runtime_config.*) or another
        # room's rows into this deployment. Only rows scoped to the target room are restored.
        if not _matches_room_store_key(store_key, rewritten.get("value"), new_chat_key):
            continue
        await services.store.set(
            user_key=str(rewritten.get("user_key") or ""),
            store_key=store_key,
            value=rewritten.get("value"),
        )
        imported_rows += 1

    vector_points = []
    for point in raw.get("vector_points") or []:
        if not isinstance(point, dict):
            continue
        rewritten = _rewrite_vector_point(point, old_chat_key, new_chat_key)
        payload = dict(rewritten.get("payload") or {})
        # Same room-ownership guard as store rows — never upsert points scoped elsewhere.
        if payload.get("chat_key") != new_chat_key and payload.get("namespace") != new_chat_key:
            continue
        if not rewritten.get("id") or not isinstance(rewritten.get("vector"), list):
            continue
        vector_points.append((str(rewritten["id"]), rewritten["vector"], payload))
    if vector_points:
        await services.vector_db.vector_store.upsert(vector_points)

    imported_keys = 0
    for item in raw.get("keys") or []:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()
        if not key:
            continue
        # Never let a snapshot re-bind a key that already belongs to a DIFFERENT room
        # (cross-room hijack). A legitimate restore only ever re-creates its own room's keys.
        existing = keystore.get(key)
        if existing is not None and existing.room != room:
            continue
        if keystore.restore(key, room=room, name=str(item.get("name") or ""), role=str(item.get("role") or "player")):
            imported_keys += 1
    keystore.persist()

    return {
        "room": room,
        "chat_key": new_chat_key,
        "path": str(source),
        "keys": imported_keys,
        "store_rows": imported_rows,
        "vector_points": len(vector_points),
    }
