"""Unlisted media (protocol 2.4): the session-report blobs' audience column.

A report blob is indexed like any media but is invisible to every lookup that names no
audience, fetchable by keeper-only or member audiences as declared, counted against the
image quota, and migrated onto old databases.
"""

from __future__ import annotations

import hashlib
import sqlite3

import pytest

from infra.media_store import (
    ALLOWED_IMAGE_MIMES,
    AUDIENCE_KEEPER,
    AUDIENCE_MEMBERS,
    AUDIENCE_ROOM,
    REPORT_MIME,
    MediaError,
    MediaStore,
    PendingUpload,
    audiences_for_role,
)
from infra.store import Store

HTML = b"<!DOCTYPE html><p>report</p>"


async def _report(store: MediaStore, audience: str, data: bytes = HTML, room: str = "room-a"):
    return await store.register_server_blob(
        room=room, data=data, mime=REPORT_MIME, name="r.html", uploader="u", audience=audience
    )


async def test_unlisted_blob_is_invisible_without_an_explicit_audience(tmp_path):
    store = MediaStore(Store(), tmp_path)
    record = await _report(store, AUDIENCE_KEEPER)
    assert record.audience == AUDIENCE_KEEPER

    assert await store.get_record("room-a", record.hash) is None
    with pytest.raises(MediaError, match="media_not_found"):
        await store.read_bytes("room-a", record.hash)
    with pytest.raises(MediaError, match="media_not_found"):
        await store.read_bytes("room-a", record.hash, audiences=audiences_for_role("player"))
    found, data = await store.read_bytes("room-a", record.hash, audiences=audiences_for_role("keeper"))
    assert data == HTML and found.mime == REPORT_MIME

    # The internal inventory still sees it (lifecycle operations walk it).
    assert [item.hash for item in await store.list_room_records("room-a")] == [record.hash]


async def test_members_audience_is_fetchable_by_any_member_but_still_unlisted(tmp_path):
    store = MediaStore(Store(), tmp_path)
    record = await _report(store, AUDIENCE_MEMBERS)
    assert await store.get_record("room-a", record.hash) is None
    _, data = await store.read_bytes("room-a", record.hash, audiences=audiences_for_role("player"))
    assert data == HTML


async def test_html_can_never_become_listed_media(tmp_path):
    store = MediaStore(Store(), tmp_path)
    with pytest.raises(MediaError):
        await _report(store, AUDIENCE_ROOM)
    digest = hashlib.sha256(HTML).hexdigest()
    with pytest.raises(MediaError, match="media_bad_mime"):
        await store.commit_bytes(
            PendingUpload("u1", "room-a", REPORT_MIME, len(HTML), "r.html", "u", digest, allowed_mimes=frozenset({REPORT_MIME})),
            HTML,
        )
    # And the upload whitelist never offered it in the first place.
    with pytest.raises(MediaError, match="media_bad_mime"):
        await store.validate_offer(room="room-a", mime=REPORT_MIME, size=len(HTML), sha256=digest)


async def test_same_bytes_under_another_audience_are_refused_not_republished(tmp_path):
    store = MediaStore(Store(), tmp_path, allowed_mimes=ALLOWED_IMAGE_MIMES)
    record = await _report(store, AUDIENCE_KEEPER)
    # Someone offering the exact report bytes as an image must not get the keeper record
    # back as an "existing" room upload.
    assert await store.validate_offer(room="room-a", mime="image/png", size=len(HTML), sha256=record.hash) is None
    with pytest.raises(MediaError, match="media_bad_upload"):
        await store.commit_bytes(
            PendingUpload("u1", "room-a", "image/png", len(HTML), "x.png", "u", record.hash), HTML
        )
    # The identical report regenerated under its own audience is simply the same record.
    again = await _report(store, AUDIENCE_KEEPER)
    assert again.hash == record.hash


async def test_reports_count_against_the_image_quota(tmp_path):
    store = MediaStore(Store(), tmp_path, room_quota_bytes=len(HTML) + 10)
    await _report(store, AUDIENCE_MEMBERS)
    image = b"\x89PNG\r\n\x1a\n" + b"x" * 20
    digest = hashlib.sha256(image).hexdigest()
    with pytest.raises(MediaError, match="media_quota_exceeded"):
        await store.validate_offer(room="room-a", mime="image/png", size=len(image), sha256=digest)
    with pytest.raises(MediaError, match="media_quota_exceeded"):
        await store.commit_bytes(PendingUpload("u1", "room-a", "image/png", len(image), "i.png", "u", digest), image)
    with pytest.raises(MediaError, match="media_quota_exceeded"):
        await _report(store, AUDIENCE_KEEPER, data=b"<p>" + b"y" * 30 + b"</p>")


async def test_an_old_media_index_gains_the_audience_column(tmp_path):
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE media_index (hash TEXT NOT NULL, room TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,"
        " name TEXT NOT NULL, uploader TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY (room, hash))"
    )
    conn.execute("INSERT INTO media_index VALUES ('ab', 'room-a', 'image/png', 3, 'old.png', 'u', 1.0)")
    conn.commit()
    conn.close()
    store = MediaStore(Store(str(db)), tmp_path)
    records = await store.list_room_records("room-a")
    assert [(item.hash, item.audience) for item in records] == [("ab", AUDIENCE_ROOM)]
    assert (await store.get_record("room-a", "ab")) is not None
