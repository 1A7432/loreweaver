"""Room-scoped audio library and playback-control helpers.

Audio blobs are still stored by ``infra.media_store``. This module only gives
those blobs room-local semantics: a small library index plus transport-neutral
control frames clients can interpret with their own local player.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from typing import Any

from infra.media_store import MediaRecord
from infra.store import Store

AudioLayer = str
AudioAction = str

LAYERS = frozenset({"bgm", "ambience", "sfx"})
STATEFUL_LAYERS = frozenset({"bgm", "ambience"})
ACTIONS = frozenset({"play", "stop", "pause", "resume", "volume"})

_LIBRARY_REPLAY_CAP = 100
_MAX_TEXT = 255


@dataclass(frozen=True)
class AudioResolve:
    status: str
    item: dict[str, Any] | None = None
    matches: tuple[dict[str, Any], ...] = ()


async def add_audio_item(store: Store, chat_key: str, record: MediaRecord, from_name: str) -> dict[str, Any]:
    """Upsert a media record into the room's audio library and return its frame."""
    items = await list_audio_items(store, chat_key)
    previous = next((item for item in items if item.get("hash") == record.hash), None)
    frame = _frame_from_record(record, from_name)
    if previous is not None:
        for key in ("title", "license", "source", "tags"):
            if previous.get(key):
                frame[key] = previous[key]
    next_items = [item for item in items if item.get("hash") != record.hash]
    next_items.append(frame)
    await _set_json(store, _library_key(chat_key), next_items[-_LIBRARY_REPLAY_CAP:])
    return frame


async def list_audio_items(store: Store, chat_key: str) -> list[dict[str, Any]]:
    raw = await _get_json(store, _library_key(chat_key), [])
    if not isinstance(raw, list):
        return []
    items = [_normalize_item(item) for item in raw if isinstance(item, dict)]
    return [item for item in items if item is not None]


async def resolve_audio_item(store: Store, chat_key: str, query: str) -> AudioResolve:
    needle = str(query or "").strip().casefold()
    if not needle:
        return AudioResolve("not_found")
    items = await list_audio_items(store, chat_key)
    exact = [
        item
        for item in items
        if needle in {str(item.get("hash", "")).casefold(), str(item.get("name", "")).casefold(), str(item.get("title", "")).casefold()}
    ]
    if len(exact) == 1:
        return AudioResolve("ok", exact[0], tuple(exact))
    if len(exact) > 1:
        return AudioResolve("ambiguous", None, tuple(exact))
    prefix = [item for item in items if str(item.get("hash", "")).casefold().startswith(needle)]
    if len(prefix) == 1:
        return AudioResolve("ok", prefix[0], tuple(prefix))
    if len(prefix) > 1:
        return AudioResolve("ambiguous", None, tuple(prefix))
    fuzzy = [
        item
        for item in items
        if needle in str(item.get("name", "")).casefold() or needle in str(item.get("title", "")).casefold()
    ]
    if len(fuzzy) == 1:
        return AudioResolve("ok", fuzzy[0], tuple(fuzzy))
    if len(fuzzy) > 1:
        return AudioResolve("ambiguous", None, tuple(fuzzy))
    return AudioResolve("not_found")


async def update_audio_item(store: Store, chat_key: str, query: str, metadata: dict[str, Any]) -> AudioResolve:
    resolved = await resolve_audio_item(store, chat_key, query)
    if resolved.status != "ok" or resolved.item is None:
        return resolved
    items = await list_audio_items(store, chat_key)
    updated = dict(resolved.item)
    for key in ("title", "license", "source"):
        if key in metadata:
            value = _clean_text(metadata[key])
            if value:
                updated[key] = value
            else:
                updated.pop(key, None)
    if "tags" in metadata:
        tags = [_clean_text(tag) for tag in metadata["tags"] if _clean_text(tag)]
        if tags:
            updated["tags"] = tags[:16]
        else:
            updated.pop("tags", None)
    next_items = [updated if item.get("hash") == updated["hash"] else item for item in items]
    await _set_json(store, _library_key(chat_key), next_items[-_LIBRARY_REPLAY_CAP:])
    return AudioResolve("ok", updated, (updated,))


async def audio_state_frame(store: Store, chat_key: str) -> dict[str, Any]:
    state = await _load_state(store, chat_key)
    return {"type": "audio_state", "layers": [_normalize_layer_state(layer, state.get(layer)) for layer in sorted(LAYERS)]}


async def has_audio_state(store: Store, chat_key: str) -> bool:
    raw = await _get_json(store, _state_key(chat_key), {})
    return isinstance(raw, dict) and any(isinstance(value, dict) and value for value in raw.values())


async def build_audio_control(
    store: Store,
    chat_key: str,
    *,
    layer: AudioLayer,
    action: AudioAction,
    item: dict[str, Any] | None = None,
    volume: float | None = None,
    loop: bool | None = None,
    fade_ms: int | None = None,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Build an audio control frame and update persisted state where relevant."""
    if layer not in LAYERS or action not in ACTIONS:
        raise ValueError("audio_bad_control")
    volume_value = _clamp_volume(volume) if volume is not None else None
    control: dict[str, Any] = {
        "type": "audio_control",
        "id": uuid.uuid4().hex,
        "action": action,
        "layer": layer,
        "server_ts": time.time(),
    }
    if item is not None:
        control.update(
            {
                "hash": item["hash"],
                "mime": item["mime"],
                "name": item["name"],
            }
        )
        if item.get("title"):
            control["title"] = item["title"]
    if volume_value is not None:
        control["volume"] = volume_value
    if loop is not None:
        control["loop"] = bool(loop)
    if fade_ms is not None:
        control["fade_ms"] = max(0, int(fade_ms))

    if layer not in STATEFUL_LAYERS:
        return control, None

    state = await _load_state(store, chat_key)
    current = dict(state.get(layer) or {"layer": layer, "playing": False})
    if action == "play" and item is not None:
        current = {
            "layer": layer,
            "hash": item["hash"],
            "mime": item["mime"],
            "name": item["name"],
            "playing": True,
            "volume": volume_value if volume_value is not None else current.get("volume", 1.0),
            "loop": bool(loop) if loop is not None else True,
            "started_at": time.time(),
        }
        if item.get("title"):
            current["title"] = item["title"]
    elif action == "stop":
        current["playing"] = False
    elif action == "pause":
        current["playing"] = False
    elif action == "resume":
        current["playing"] = True
    elif action == "volume" and volume_value is not None:
        current["volume"] = volume_value

    state[layer] = current
    await _set_json(store, _state_key(chat_key), state)
    return control, await audio_state_frame(store, chat_key)


def _frame_from_record(record: MediaRecord, from_name: str) -> dict[str, Any]:
    return {
        "type": "audio_library_item",
        "id": record.hash,
        "hash": record.hash,
        "mime": record.mime,
        "size": record.size,
        "name": _clean_text(record.name) or record.hash,
        "from": _clean_text(from_name) or record.uploader,
        "ts": record.created_at,
    }


def _normalize_item(item: dict[str, Any]) -> dict[str, Any] | None:
    hash_value = str(item.get("hash") or item.get("id") or "")
    mime = str(item.get("mime") or "")
    name = _clean_text(item.get("name")) or hash_value
    if not hash_value or not mime:
        return None
    out: dict[str, Any] = {
        "type": "audio_library_item",
        "id": str(item.get("id") or hash_value),
        "hash": hash_value,
        "mime": mime,
        "size": int(item.get("size") or 0),
        "name": name,
        "from": _clean_text(item.get("from")) or "",
        "ts": float(item.get("ts") or 0),
    }
    for key in ("title", "license", "source"):
        value = _clean_text(item.get(key))
        if value:
            out[key] = value
    tags = item.get("tags")
    if isinstance(tags, list):
        clean_tags = [_clean_text(tag) for tag in tags if _clean_text(tag)]
        if clean_tags:
            out["tags"] = clean_tags[:16]
    return out


def _normalize_layer_state(layer: str, state: Any) -> dict[str, Any]:
    if not isinstance(state, dict):
        return {"layer": layer, "playing": False}
    out: dict[str, Any] = {
        "layer": layer,
        "playing": bool(state.get("playing")),
    }
    for key in ("hash", "mime", "name", "title"):
        value = _clean_text(state.get(key))
        if value:
            out[key] = value
    if "volume" in state:
        out["volume"] = _clamp_volume(state.get("volume"))
    if "loop" in state:
        out["loop"] = bool(state.get("loop"))
    if "started_at" in state:
        try:
            out["started_at"] = float(state.get("started_at"))
        except (TypeError, ValueError):
            pass
    return out


async def _load_state(store: Store, chat_key: str) -> dict[str, Any]:
    raw = await _get_json(store, _state_key(chat_key), {})
    return raw if isinstance(raw, dict) else {}


async def _get_json(store: Store, key: str, default: Any) -> Any:
    try:
        raw = await store.get(user_key="", store_key=key)
        return json.loads(raw) if raw else default
    except Exception:
        return default


async def _set_json(store: Store, key: str, value: Any) -> None:
    await store.set(user_key="", store_key=key, value=json.dumps(value, ensure_ascii=False))


def _library_key(chat_key: str) -> str:
    return f"audio_library.{chat_key}"


def _state_key(chat_key: str) -> str:
    return f"audio_state.{chat_key}"


def _clean_text(value: Any) -> str:
    text = str(value or "").replace("\x00", "").strip()
    return text[:_MAX_TEXT]


def _clamp_volume(value: Any) -> float:
    try:
        volume = float(value)
    except (TypeError, ValueError):
        volume = 1.0
    return max(0.0, min(1.0, volume))
