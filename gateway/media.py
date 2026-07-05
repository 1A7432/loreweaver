"""Shared media-frame helpers for room transports and KP tools."""

from __future__ import annotations

import json
import uuid
from typing import Any

from gateway.hub import Event, RoomHub
from infra.media_store import MediaRecord
from infra.store import Store

MEDIA_HISTORY_REPLAY_CAP = 30


def media_frame(record: MediaRecord, *, from_name: str, frame_id: str | None = None) -> dict[str, Any]:
    return {
        "type": "media",
        "id": frame_id or uuid.uuid4().hex,
        "hash": record.hash,
        "mime": record.mime,
        "size": record.size,
        "name": record.name,
        "from": from_name,
        "ts": record.created_at,
    }


async def record_media_history(store: Store, chat_key: str, frame: dict[str, Any]) -> None:
    store_key = f"media_history.{chat_key}"
    try:
        raw = await store.get(user_key="", store_key=store_key)
        history = json.loads(raw) if raw else []
    except Exception:
        history = []
    if not isinstance(history, list):
        history = []
    history.append(dict(frame))
    await store.set(
        user_key="",
        store_key=store_key,
        value=json.dumps(history[-MEDIA_HISTORY_REPLAY_CAP:], ensure_ascii=False),
    )


async def publish_media(
    hub: RoomHub | None,
    store: Store,
    chat_key: str,
    frame: dict[str, Any],
) -> None:
    await record_media_history(store, chat_key, frame)
    if hub is not None:
        await hub.publish(chat_key, Event.media(frame))
