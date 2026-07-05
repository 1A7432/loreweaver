import hashlib

import pytest

from infra.media_store import ALLOWED_AUDIO_MIMES, ALLOWED_IMAGE_MIMES, MediaError, MediaStore, PendingUpload
from infra.store import Store


def _png_bytes(seed: bytes = b"img") -> bytes:
    return b"\x89PNG\r\n\x1a\n" + seed


async def test_media_store_rejects_bad_mime_size_and_quota(tmp_path):
    store = MediaStore(Store(), tmp_path, max_file_bytes=16, room_quota_bytes=12)
    data = _png_bytes(b"a")
    digest = hashlib.sha256(data).hexdigest()

    with pytest.raises(MediaError, match="media_bad_mime"):
        await store.validate_offer(room="room-a", mime="text/plain", size=len(data), sha256=digest)

    with pytest.raises(MediaError, match="media_too_large"):
        await store.validate_offer(room="room-a", mime="image/png", size=99, sha256=digest)

    await store.commit_bytes(
        PendingUpload("u1", "room-a", "image/png", len(data), "a.png", "u", digest),
        data,
    )
    other = _png_bytes(b"bb")
    other_digest = hashlib.sha256(other).hexdigest()
    with pytest.raises(MediaError, match="media_quota_exceeded"):
        await store.validate_offer(room="room-a", mime="image/png", size=len(other), sha256=other_digest)


async def test_media_store_rejects_sha_mismatch_and_dedupes(tmp_path):
    store = MediaStore(Store(), tmp_path)
    data = _png_bytes()
    digest = hashlib.sha256(data).hexdigest()
    pending = PendingUpload("u1", "room-a", "image/png", len(data), "a.png", "u", digest)

    with pytest.raises(MediaError, match="media_hash_mismatch"):
        await store.commit_bytes(PendingUpload("bad", "room-a", "image/png", len(data), "a.png", "u", "0" * 64), data)

    first = await store.commit_bytes(pending, data)
    duplicate = await store.validate_offer(room="room-a", mime="image/png", size=len(data), sha256=digest)

    assert duplicate == first
    assert await store.room_total_size("room-a") == len(data)


async def test_media_store_is_room_isolated(tmp_path):
    store = MediaStore(Store(), tmp_path)
    data = _png_bytes()
    digest = hashlib.sha256(data).hexdigest()
    await store.commit_bytes(PendingUpload("u1", "room-a", "image/png", len(data), "a.png", "u", digest), data)

    record, loaded = await store.read_bytes("room-a", digest)
    assert record.hash == digest
    assert loaded == data

    with pytest.raises(MediaError, match="media_not_found"):
        await store.read_bytes("room-b", digest)


async def test_media_store_offer_policy_can_be_overridden_for_audio(tmp_path):
    store = MediaStore(Store(), tmp_path, max_file_bytes=4, room_quota_bytes=4, allowed_mimes=ALLOWED_IMAGE_MIMES | ALLOWED_AUDIO_MIMES)
    data = b"ID3audio"
    digest = hashlib.sha256(data).hexdigest()

    with pytest.raises(MediaError, match="media_too_large"):
        await store.validate_offer(room="room-a", mime="audio/mpeg", size=len(data), sha256=digest)

    existing = await store.validate_offer(
        room="room-a",
        mime="audio/mpeg",
        size=len(data),
        sha256=digest,
        max_file_bytes=32,
        room_quota_bytes=64,
        allowed_mimes=ALLOWED_AUDIO_MIMES,
    )
    assert existing is None


async def test_media_store_rejects_unsafe_svg_on_commit(tmp_path):
    store = MediaStore(Store(), tmp_path)
    data = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    digest = hashlib.sha256(data).hexdigest()

    with pytest.raises(MediaError, match="media_bad_svg"):
        await store.commit_bytes(PendingUpload("u1", "room-a", "image/svg+xml", len(data), "bad.svg", "u", digest), data)
