"""The reachability gate for content-addressed ``ui`` blocks (M19).

``core.hooks`` validates the SHAPE of an ``image`` block — 64 hex chars, capped
caption — but a shape check cannot know whether this room may fetch that blob.
The media byte channel already answers ``{op:"get", hash}`` only for the caller's
own room media plus assets of packs ENABLED in that room; an ``image`` block
pointing anywhere else would render as a permanent broken picture (and would be
a probe for what other rooms hold). So every emitted image hash is resolved here,
against exactly those two sources, before the frame reaches the wire:

- room media (``infra.media_store``) — uploads, KP-generated handouts, Director art;
- enabled-pack assets (``gateway.panels``) — the module's own shipped pictures.

An unresolvable hash drops its block; a frame left with no blocks drops entirely.
The resolved MIME is stamped onto the block so clients never have to guess, and a
hash that resolves to something that is not a picture drops too (an ``image``
block aimed at an mp3 is an authoring error, not a render).
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from core.hooks import UI_IMAGE_MIMES
from gateway.panels import pack_asset_mime
from infra.media_store import ALLOWED_MEDIA_MIMES, MediaStore

if TYPE_CHECKING:
    from agent.services import Services

logger = logging.getLogger(__name__)


async def resolve_room_image_mime(services: Services, chat_key: str, sha256: str) -> str | None:
    """The image MIME ``chat_key`` may fetch ``sha256`` as, or ``None``.

    Room media first (the common case), then assets of packs enabled in this room.
    A hash that resolves to a non-image MIME answers ``None``: the caller drops the
    block rather than shipping a picture frame that decodes to audio.
    """
    settings = services.settings.tui
    store = MediaStore(
        services.store,
        services.settings.data_dir,
        max_file_bytes=max(settings.media_max_file_bytes, settings.audio_max_file_bytes),
        room_quota_bytes=max(settings.media_room_quota_bytes, settings.audio_room_quota_bytes),
        allowed_mimes=ALLOWED_MEDIA_MIMES,
    )
    try:
        record = await store.get_record(chat_key, sha256)
    except Exception:  # noqa: BLE001 — a lookup failure means "not reachable", never a broken turn
        logger.debug("ui_media: room media lookup failed for %s", sha256[:12], exc_info=True)
        record = None
    mime = record.mime if record is not None else await pack_asset_mime(services, chat_key, sha256)
    if not mime:
        return None
    return mime.casefold() if mime.casefold() in UI_IMAGE_MIMES else None


async def filter_ui_media(services: Services, chat_key: str, frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """``frames`` with every unreachable ``image`` block removed (see the module docstring).

    Hashes are resolved once per call, so a turn that shows the same handout in several
    frames costs one lookup. Frames without image blocks pass through untouched.
    """
    if not frames or not any(
        block.get("kind") == "image" for frame in frames for block in frame.get("blocks") or ()
    ):
        return frames
    resolved: dict[str, str | None] = {}
    filtered: list[dict[str, Any]] = []
    for frame in frames:
        blocks: list[dict[str, Any]] = []
        for block in frame.get("blocks") or ():
            if block.get("kind") != "image":
                blocks.append(block)
                continue
            digest = str(block.get("hash") or "")
            if digest not in resolved:
                resolved[digest] = await resolve_room_image_mime(services, chat_key, digest)
            mime = resolved[digest]
            if mime is None:
                logger.info("ui_media: dropped image block %s — not reachable from this room", digest[:12])
                continue
            blocks.append({**block, "mime": mime})
        if blocks:
            filtered.append({**frame, "blocks": blocks})
    return filtered
