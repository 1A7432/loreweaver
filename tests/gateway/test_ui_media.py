"""Tests for `gateway.ui_media` — the reachability gate on content-addressed `ui`
blocks (M19 item 6). `core.hooks` only checks an image block's SHAPE; this layer
decides whether the room may actually fetch that blob, so an emitted hash that is
neither room media nor an enabled-pack asset never reaches the wire."""

from __future__ import annotations

import hashlib

from agent.services import build_services
from gateway.ui_media import filter_ui_media
from infra.config import Settings
from infra.embeddings import FakeEmbeddings
from infra.llm import FakeLLM
from infra.media_store import ALLOWED_MEDIA_MIMES, MediaStore

ROOM = "tui:group:stage"
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360f8ffff3f0005fe02fea7a0a5810000000049454e44ae426082"
)
MP3 = b"ID3\x03\x00\x00\x00\x00\x00\x00fake audio bytes"


def _services(tmp_path):
    settings = Settings()
    settings.data_dir = tmp_path
    return build_services(settings, llm=FakeLLM(), embeddings=FakeEmbeddings(64))


async def _register(services, data: bytes, mime: str, name: str) -> str:
    tui = services.settings.tui
    store = MediaStore(
        services.store,
        services.settings.data_dir,
        max_file_bytes=max(tui.media_max_file_bytes, tui.audio_max_file_bytes),
        room_quota_bytes=max(tui.media_room_quota_bytes, tui.audio_room_quota_bytes),
        allowed_mimes=ALLOWED_MEDIA_MIMES,
    )
    record = await store.register_blob(room=ROOM, data=data, mime=mime, name=name, uploader="kp")
    return record.hash


def _frame(*blocks):
    return {"blocks": list(blocks), "panel": "inline"}


async def test_room_media_passes_and_gets_its_authoritative_mime(tmp_path):
    services = _services(tmp_path)
    digest = await _register(services, PNG, "image/png", "handout.png")

    # The emitter declared no mime at all; the gate stamps the stored one so the
    # client never has to guess how to decode the bytes.
    frames = await filter_ui_media(services, ROOM, [_frame({"kind": "image", "hash": digest, "caption": "灯谱残页"})])

    assert frames == [_frame({"kind": "image", "hash": digest, "caption": "灯谱残页", "mime": "image/png"})]


async def test_a_hash_this_room_cannot_fetch_is_dropped(tmp_path):
    services = _services(tmp_path)
    stranger = hashlib.sha256(b"some other room's picture").hexdigest()

    frames = await filter_ui_media(
        services,
        ROOM,
        [_frame({"kind": "image", "hash": stranger}, {"kind": "text", "text": "the wall is bare"})],
    )

    # The unreachable picture goes; the rest of the frame survives untouched.
    assert frames == [_frame({"kind": "text", "text": "the wall is bare"})]


async def test_a_frame_left_with_no_blocks_drops_entirely(tmp_path):
    services = _services(tmp_path)
    stranger = hashlib.sha256(b"nothing here").hexdigest()

    assert await filter_ui_media(services, ROOM, [_frame({"kind": "image", "hash": stranger})]) == []


async def test_a_hash_that_resolves_to_audio_is_not_a_picture(tmp_path):
    services = _services(tmp_path)
    digest = await _register(services, MP3, "audio/mpeg", "tide.mp3")

    assert await filter_ui_media(services, ROOM, [_frame({"kind": "image", "hash": digest})]) == []


async def test_frames_without_image_blocks_pass_through_unchanged(tmp_path):
    services = _services(tmp_path)
    frames = [_frame({"kind": "text", "text": "hello"}), _frame({"kind": "divider"})]

    # Identity, not just equality: a turn with no images must not pay for a rebuild.
    assert await filter_ui_media(services, ROOM, frames) is frames
