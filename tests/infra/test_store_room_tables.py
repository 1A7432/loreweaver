"""The M17 store tables: `room_state` semantics and its CAS primitive.

(Document-table semantics are covered end-to-end in tests/documents/; this
file pins the raw room_state behaviors backup/reset/CAS consumers rely on.)
"""

from __future__ import annotations

from infra.store import Store

ROOM = "tui:group:alpha"
OTHER = "tui:group:beta"


async def test_room_state_rows_are_room_scoped_by_column():
    store = Store(":memory:")
    await store.state_set(ROOM, "chat_history", "[]")
    await store.state_set(ROOM, "session_record.current", "{}")
    await store.state_set(OTHER, "chat_history", "other")

    assert await store.state_get(ROOM, "chat_history") == "[]"
    assert {row["key"] for row in await store.state_list(ROOM)} == {"chat_history", "session_record.current"}
    assert [row["key"] for row in await store.state_list(ROOM, prefix="session_record.")] == [
        "session_record.current"
    ]

    deleted = await store.state_delete_keys(ROOM, keys=["chat_history"], prefixes=["session_record."])
    assert deleted == 2
    assert await store.state_list(ROOM) == []
    assert await store.state_get(OTHER, "chat_history") == "other"  # neighbor untouched


async def test_room_state_prefix_listing_escapes_like_metacharacters():
    store = Store(":memory:")
    await store.state_set(ROOM, "battle_report.2026_01", "a")
    await store.state_set(ROOM, "battle_reportX2026Y99", "trap")

    rows = await store.state_list(ROOM, prefix="battle_report.")
    assert [row["key"] for row in rows] == ["battle_report.2026_01"]


async def test_state_set_if_values_is_compare_and_set():
    store = Store(":memory:")
    await store.state_set(ROOM, "initiative", "v1")

    committed = await store.state_set_if_values(
        ROOM, expected=[("initiative", "v1")], updates=[("initiative", "v2"), ("initiative_meta", "{}")]
    )
    assert committed is True
    assert await store.state_get(ROOM, "initiative") == "v2"
    assert await store.state_get(ROOM, "initiative_meta") == "{}"

    stale = await store.state_set_if_values(
        ROOM, expected=[("initiative", "v1")], updates=[("initiative", "v3")]
    )
    assert stale is False
    assert await store.state_get(ROOM, "initiative") == "v2"  # nothing moved

    # A missing row compares as None — the seed-once pattern.
    seeded = await store.state_set_if_values(
        ROOM, expected=[("session_record.current", None)], updates=[("session_record.current", "{}")]
    )
    assert seeded is True


async def test_state_delete_room_wipes_only_that_room():
    store = Store(":memory:")
    await store.state_set(ROOM, "a", "1")
    await store.state_set(ROOM, "b", "2")
    await store.state_set(OTHER, "a", "keep")

    assert await store.state_delete_room(ROOM) == 2
    assert await store.state_list(ROOM) == []
    assert await store.state_get(OTHER, "a") == "keep"
