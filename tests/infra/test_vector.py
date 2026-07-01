"""Tests for infra.vector.VectorStore: brute-force cosine search order,
`filter` equality-narrowing, delete, and scroll/count — both in-memory and
SQLite-file-backed.

Fixture geometry (2-D, query = [1.0, 0.0]) is chosen so every point has a
distinct, well-separated cosine score against the query, keeping expected
result order unambiguous (no near-ties to reason about):
    p1 [ 1.0, 0.0]  -> score  1.0000  (module, room1)
    p2 [ 0.9, 0.1]  -> score ~0.9939  (module, room1)
    p3 [ 0.0, 1.0]  -> score  0.0000  (note,   room1)
    p4 [-1.0, 0.0]  -> score -1.0000  (module, room2)
"""

from __future__ import annotations

from pathlib import Path

import pytest

from infra.i18n import t
from infra.vector import VectorHit, VectorStore

QUERY = [1.0, 0.0]

P1 = ("p1", [1.0, 0.0], {"chat_key": "room1", "document_type": "module"})
P2 = ("p2", [0.9, 0.1], {"chat_key": "room1", "document_type": "module"})
P3 = ("p3", [0.0, 1.0], {"chat_key": "room1", "document_type": "note"})
P4 = ("p4", [-1.0, 0.0], {"chat_key": "room2", "document_type": "module"})


async def _seeded_store(**kwargs) -> VectorStore:
    store = VectorStore(dim=2, **kwargs)
    await store.upsert([P1, P2, P3, P4])
    return store


# ---------------------------------------------------------------------------
# search: topk order + limit
# ---------------------------------------------------------------------------


async def test_search_returns_hits_sorted_by_score_desc():
    store = await _seeded_store()

    hits = await store.search(QUERY, limit=5)

    assert [hit.id for hit in hits] == ["p1", "p2", "p3", "p4"]
    assert [hit.score for hit in hits] == pytest.approx([1.0, 0.9938837, 0.0, -1.0], abs=1e-6)
    # Scores are descending strictly (sanity on the ordering claim itself).
    assert all(hits[i].score >= hits[i + 1].score for i in range(len(hits) - 1))


async def test_search_honors_limit_for_topk_truncation():
    store = await _seeded_store()

    hits = await store.search(QUERY, limit=2)

    assert [hit.id for hit in hits] == ["p1", "p2"]


async def test_search_default_limit_is_five():
    store = VectorStore(dim=1)
    # Seven points with distinct scores; default limit must cap at 5.
    await store.upsert([(f"p{i}", [float(i)], {}) for i in range(1, 8)])

    hits = await store.search([1.0])

    assert len(hits) == 5


async def test_search_returns_payload_copy():
    store = await _seeded_store()

    [hit] = await store.search(QUERY, limit=1)

    assert hit.payload == {"chat_key": "room1", "document_type": "module"}


async def test_search_score_is_a_python_float():
    store = await _seeded_store()

    [hit] = await store.search(QUERY, limit=1)

    assert isinstance(hit.score, float)


async def test_search_with_no_candidates_returns_empty_list():
    store = VectorStore(dim=2)

    assert await store.search(QUERY) == []


# ---------------------------------------------------------------------------
# search: filter narrows
# ---------------------------------------------------------------------------


async def test_search_filter_excludes_non_matching_payloads():
    store = await _seeded_store()

    hits = await store.search(QUERY, limit=5, filter={"document_type": "module"})

    assert [hit.id for hit in hits] == ["p1", "p2", "p4"]


async def test_search_filter_on_multiple_keys_is_an_and():
    store = await _seeded_store()

    hits = await store.search(QUERY, limit=5, filter={"chat_key": "room1", "document_type": "module"})

    assert [hit.id for hit in hits] == ["p1", "p2"]


async def test_search_filter_matching_nothing_returns_empty_list():
    store = await _seeded_store()

    hits = await store.search(QUERY, limit=5, filter={"chat_key": "no-such-room"})

    assert hits == []


async def test_search_empty_filter_dict_matches_everything():
    store = await _seeded_store()

    hits = await store.search(QUERY, limit=5, filter={})

    assert [hit.id for hit in hits] == ["p1", "p2", "p3", "p4"]


# ---------------------------------------------------------------------------
# delete
# ---------------------------------------------------------------------------


async def test_delete_removes_points_from_search_results():
    store = await _seeded_store()

    await store.delete(["p1"])
    hits = await store.search(QUERY, limit=5)

    assert [hit.id for hit in hits] == ["p2", "p3", "p4"]


async def test_delete_reduces_count():
    store = await _seeded_store()
    assert await store.count() == 4

    await store.delete(["p1", "p2"])

    assert await store.count() == 2


async def test_delete_unknown_id_is_a_noop():
    store = await _seeded_store()

    await store.delete(["does-not-exist"])

    assert await store.count() == 4


# ---------------------------------------------------------------------------
# scroll / count honor filter
# ---------------------------------------------------------------------------


async def test_count_without_filter_counts_everything():
    store = await _seeded_store()
    assert await store.count() == 4


async def test_count_with_filter_only_counts_matches():
    store = await _seeded_store()

    assert await store.count(filter={"document_type": "module"}) == 3
    assert await store.count(filter={"document_type": "note"}) == 1
    assert await store.count(filter={"chat_key": "room2"}) == 1
    assert await store.count(filter={"chat_key": "no-such-room"}) == 0


async def test_scroll_without_filter_returns_every_point():
    store = await _seeded_store()

    hits = await store.scroll()

    assert {hit.id for hit in hits} == {"p1", "p2", "p3", "p4"}


async def test_scroll_with_filter_only_returns_matches():
    store = await _seeded_store()

    hits = await store.scroll(filter={"document_type": "note"})

    assert [hit.id for hit in hits] == ["p3"]
    assert hits[0].payload == {"chat_key": "room1", "document_type": "note"}


async def test_scroll_honors_limit():
    store = await _seeded_store()

    hits = await store.scroll(limit=2)

    assert len(hits) == 2


async def test_scroll_hits_carry_a_placeholder_zero_score():
    store = await _seeded_store()

    hits = await store.scroll(filter={"document_type": "note"})

    assert hits[0].score == 0.0


# ---------------------------------------------------------------------------
# upsert semantics
# ---------------------------------------------------------------------------


async def test_upsert_same_id_overwrites_vector_and_payload():
    store = VectorStore(dim=2)
    await store.upsert([("p1", [1.0, 0.0], {"tag": "old"})])
    await store.upsert([("p1", [0.0, 1.0], {"tag": "new"})])

    assert await store.count() == 1
    [hit] = await store.scroll()
    assert hit.payload == {"tag": "new"}

    # Vector was replaced too: p1 now scores 0 against the original query
    # and 1.0 against the new axis.
    [hit] = await store.search([0.0, 1.0], limit=1)
    assert hit.score == pytest.approx(1.0)


async def test_upsert_is_isolated_between_separate_in_memory_stores():
    store_a = VectorStore(dim=2)
    store_b = VectorStore(dim=2)

    await store_a.upsert([P1])

    assert await store_a.count() == 1
    assert await store_b.count() == 0


# ---------------------------------------------------------------------------
# dimension validation
# ---------------------------------------------------------------------------


async def test_upsert_wrong_dimension_raises_localized_value_error():
    store = VectorStore(dim=2)

    with pytest.raises(ValueError, match=t("infra.vector.dimension_mismatch", expected=2, actual=3)):
        await store.upsert([("p1", [1.0, 0.0, 0.0], {})])


async def test_search_wrong_dimension_raises_localized_value_error():
    store = await _seeded_store()

    with pytest.raises(ValueError, match=t("infra.vector.dimension_mismatch", expected=2, actual=1)):
        await store.search([1.0])


# ---------------------------------------------------------------------------
# persistence: path=None (in-memory) vs a real SQLite file
# ---------------------------------------------------------------------------


async def test_in_memory_store_does_not_create_a_file(tmp_path: Path):
    store = VectorStore(dim=2)
    await store.upsert([P1])

    assert list(tmp_path.iterdir()) == []
    store.close()  # no-op: no connection was ever opened


async def test_file_backed_store_persists_across_instances(tmp_path: Path):
    db_path = tmp_path / "vectors.sqlite3"

    store1 = VectorStore(dim=2, path=db_path)
    await store1.upsert([P1, P2])
    store1.close()

    store2 = VectorStore(dim=2, path=db_path)
    hits = await store2.search(QUERY, limit=5)

    assert [hit.id for hit in hits] == ["p1", "p2"]
    assert db_path.exists()
    store2.close()


async def test_file_backed_store_persists_deletes_across_instances(tmp_path: Path):
    db_path = tmp_path / "vectors.sqlite3"

    store1 = VectorStore(dim=2, path=db_path)
    await store1.upsert([P1, P2])
    await store1.delete(["p1"])
    store1.close()

    store2 = VectorStore(dim=2, path=db_path)

    assert await store2.count() == 1
    store2.close()


# ---------------------------------------------------------------------------
# VectorHit shape
# ---------------------------------------------------------------------------


def test_vectorhit_field_shape():
    hit = VectorHit(id="p1", score=0.5, payload={"chat_key": "room1"})
    assert (hit.id, hit.score, hit.payload) == ("p1", 0.5, {"chat_key": "room1"})
