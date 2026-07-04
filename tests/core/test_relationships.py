"""Tests for core.relationships: the pure clamp/coerce/apply-delta/describe functions and the
thin async `RelationshipManager` persistence wrapper over an in-memory `infra.store.Store`.
"""

from __future__ import annotations

import pytest

from core.relationships import (
    TRACKS,
    RelationshipManager,
    apply_delta,
    clamp,
    coerce_int,
    describe,
    known_track,
    normalize_state,
    set_value,
)
from infra.i18n import I18n
from infra.store import Store


# ---------------------------------------------------------------------------
# known_track / clamp
# ---------------------------------------------------------------------------


def test_known_track_true_for_registered_tracks():
    assert known_track("affection") is True
    assert known_track("desire") is True


def test_known_track_false_for_unknown_track():
    assert known_track("nonexistent") is False


def test_clamp_within_range_is_unchanged():
    assert clamp("affection", 10) == 10
    assert clamp("desire", 50) == 50


def test_clamp_at_min_and_max_boundaries_is_unchanged():
    assert clamp("affection", -100) == -100
    assert clamp("affection", 100) == 100
    assert clamp("desire", 0) == 0
    assert clamp("desire", 100) == 100


def test_clamp_below_min_clamps_to_min():
    assert clamp("affection", -500) == -100
    assert clamp("desire", -10) == 0


def test_clamp_above_max_clamps_to_max():
    assert clamp("affection", 999) == 100
    assert clamp("desire", 250) == 100


def test_clamp_unknown_track_raises_value_error():
    with pytest.raises(ValueError):
        clamp("nonexistent", 5)


# ---------------------------------------------------------------------------
# coerce_int
# ---------------------------------------------------------------------------


def test_coerce_int_accepts_plain_int():
    assert coerce_int(5) == 5
    assert coerce_int(-5) == -5
    assert coerce_int(0) == 0


def test_coerce_int_accepts_float():
    assert coerce_int(5.0) == 5
    assert coerce_int(-3.7) == -3  # truncates toward zero, like int()


def test_coerce_int_accepts_signed_numeric_strings():
    assert coerce_int("+10") == 10
    assert coerce_int("-5") == -5
    assert coerce_int(" 3 ") == 3
    assert coerce_int("42") == 42


def test_coerce_int_rejects_garbage():
    assert coerce_int("not-a-number") is None
    assert coerce_int("") is None
    assert coerce_int("   ") is None
    assert coerce_int(None) is None
    assert coerce_int([1, 2]) is None
    assert coerce_int({"a": 1}) is None


def test_coerce_int_accepts_bool_as_int():
    assert coerce_int(True) == 1
    assert coerce_int(False) == 0


def test_coerce_int_rejects_infinity_and_nan_without_raising():
    # coerce_int is documented as total (never raises). inf overflows int(), nan is a ValueError,
    # and "1e400" parses to a float inf — all must degrade to None, not crash. This also guards
    # normalize_state, since json.loads accepts Infinity/NaN constants by default.
    assert coerce_int(float("inf")) is None
    assert coerce_int(float("-inf")) is None
    assert coerce_int(float("nan")) is None
    assert coerce_int("inf") is None
    assert coerce_int("-inf") is None
    assert coerce_int("Infinity") is None
    assert coerce_int("nan") is None
    assert coerce_int("1e400") is None  # float("1e400") == inf


def test_normalize_state_drops_infinity_values_without_raising():
    # A hostile/corrupt stored value carrying a JSON Infinity (json.loads accepts it) must be
    # dropped by normalize_state, not propagate an OverflowError out of the loader.
    raw = {"Alice": {"Bob": {"affection": float("inf"), "desire": 30}}}
    normalized = normalize_state(raw)
    assert normalized == {"Alice": {"Bob": {"desire": 30}}}


# ---------------------------------------------------------------------------
# apply_delta
# ---------------------------------------------------------------------------


def test_apply_delta_unset_starts_from_the_tracks_default():
    state: dict = {}
    new_state, old, new = apply_delta(state, "Alice", "Bob", "affection", 10)

    assert old == 0  # affection default
    assert new == 10
    assert new_state["Alice"]["Bob"]["affection"] == 10


def test_apply_delta_accumulates_on_an_existing_value():
    state = {"Alice": {"Bob": {"affection": 20}}}
    new_state, old, new = apply_delta(state, "Alice", "Bob", "affection", 5)

    assert old == 20
    assert new == 25
    assert new_state["Alice"]["Bob"]["affection"] == 25


def test_apply_delta_clamps_at_the_tracks_boundary():
    state = {"Alice": {"Bob": {"affection": 95}}}
    _, old, new = apply_delta(state, "Alice", "Bob", "affection", 50)

    assert old == 95
    assert new == 100  # clamped


def test_apply_delta_clamps_desire_at_its_floor_of_zero():
    state = {"Alice": {"Bob": {"desire": 5}}}
    _, old, new = apply_delta(state, "Alice", "Bob", "desire", -50)

    assert old == 5
    assert new == 0


def test_apply_delta_returns_a_new_dict_without_mutating_the_input():
    state = {"Alice": {"Bob": {"affection": 10}}}
    new_state, _, _ = apply_delta(state, "Alice", "Bob", "affection", 5)

    assert state["Alice"]["Bob"]["affection"] == 10  # input untouched
    assert new_state["Alice"]["Bob"]["affection"] == 15
    assert new_state is not state


def test_apply_delta_unknown_track_raises_value_error():
    with pytest.raises(ValueError):
        apply_delta({}, "Alice", "Bob", "nonexistent", 5)


# ---------------------------------------------------------------------------
# set_value
# ---------------------------------------------------------------------------


def test_set_value_stores_the_clamped_value():
    state: dict = {}
    new_state, clamped = set_value(state, "Alice", "Bob", "affection", 500)

    assert clamped == 100
    assert new_state["Alice"]["Bob"]["affection"] == 100


def test_set_value_does_not_mutate_the_input():
    state = {"Alice": {"Bob": {"affection": 10}}}
    new_state, clamped = set_value(state, "Alice", "Bob", "affection", 30)

    assert state["Alice"]["Bob"]["affection"] == 10
    assert clamped == 30
    assert new_state["Alice"]["Bob"]["affection"] == 30


def test_set_value_unknown_track_raises_value_error():
    with pytest.raises(ValueError):
        set_value({}, "Alice", "Bob", "nonexistent", 5)


# ---------------------------------------------------------------------------
# normalize_state
# ---------------------------------------------------------------------------


def test_normalize_state_passes_through_a_well_formed_state():
    raw = {"Alice": {"Bob": {"affection": 10, "desire": 5}}}
    assert normalize_state(raw) == raw


def test_normalize_state_drops_unknown_tracks():
    raw = {"Alice": {"Bob": {"affection": 10, "totally_unknown_track": 999}}}
    assert normalize_state(raw) == {"Alice": {"Bob": {"affection": 10}}}


def test_normalize_state_drops_non_int_values():
    raw = {"Alice": {"Bob": {"affection": "not-a-number", "desire": 5}}}
    assert normalize_state(raw) == {"Alice": {"Bob": {"desire": 5}}}


def test_normalize_state_clamps_out_of_range_values():
    raw = {"Alice": {"Bob": {"affection": 9999}}}
    assert normalize_state(raw) == {"Alice": {"Bob": {"affection": 100}}}


def test_normalize_state_coerces_numeric_strings():
    raw = {"Alice": {"Bob": {"affection": "10"}}}
    assert normalize_state(raw) == {"Alice": {"Bob": {"affection": 10}}}


def test_normalize_state_drops_empty_target_and_subject_maps():
    raw = {"Alice": {"Bob": {"totally_unknown_track": 1}}, "Carol": {}}
    assert normalize_state(raw) == {}


@pytest.mark.parametrize(
    "garbage",
    [
        None,
        "just a string",
        123,
        [1, 2, 3],
        {"Alice": "not-a-dict"},
        {"Alice": {"Bob": "not-a-dict"}},
        {123: {"Bob": {"affection": 1}}},
        {"Alice": {456: {"affection": 1}}},
    ],
)
def test_normalize_state_never_raises_on_garbage_and_degrades_to_empty_or_partial(garbage):
    result = normalize_state(garbage)
    assert isinstance(result, dict)


# ---------------------------------------------------------------------------
# describe
# ---------------------------------------------------------------------------


def test_describe_empty_state_returns_empty_list():
    i18n = I18n(locale="en")
    assert describe({}, i18n) == []


def test_describe_all_default_values_returns_empty_list():
    state = {"Alice": {"Bob": {"affection": 0, "desire": 0}}}
    i18n = I18n(locale="en")
    assert describe(state, i18n) == []


def test_describe_renders_one_line_per_subject_target_pair():
    state = {"Alice": {"Bob": {"affection": 20}}, "Bob": {"Alice": {"desire": 10}}}
    i18n = I18n(locale="en")

    lines = describe(state, i18n)

    assert len(lines) == 2
    assert any("Alice" in line and "Bob" in line for line in lines)


def test_describe_ordering_is_stable_and_sorted_by_subject_then_target():
    state = {
        "Zoe": {"Bob": {"affection": 5}},
        "Alice": {"Zed": {"affection": 5}, "Bob": {"affection": 5}},
    }
    i18n = I18n(locale="en")

    lines = describe(state, i18n)

    # Alice/Bob, Alice/Zed, Zoe/Bob — subject sorted first, then target within subject.
    assert lines[0].startswith("Alice") and "Bob" in lines[0]
    assert lines[1].startswith("Alice") and "Zed" in lines[1]
    assert lines[2].startswith("Zoe")


def test_describe_omits_default_tracks_but_keeps_non_default_ones():
    state = {"Alice": {"Bob": {"affection": 0, "desire": 40}}}
    i18n = I18n(locale="en")

    lines = describe(state, i18n)

    assert len(lines) == 1
    assert i18n.t("relationships.track.desire") in lines[0]
    assert i18n.t("relationships.track.affection") not in lines[0]


def test_describe_is_localized_per_i18n_locale():
    state = {"Alice": {"Bob": {"affection": 30}}}
    en = I18n(locale="en")
    zh = I18n(locale="zh")

    en_lines = describe(state, en)
    zh_lines = describe(state, zh)

    assert en.t("relationships.track.affection") in en_lines[0]
    assert zh.t("relationships.track.affection") in zh_lines[0]
    assert en_lines[0] != zh_lines[0]


# ---------------------------------------------------------------------------
# RelationshipManager
# ---------------------------------------------------------------------------


async def test_manager_load_on_a_fresh_chat_is_empty():
    manager = RelationshipManager(Store())
    assert await manager.load("chat-1") == {}


async def test_manager_adjust_persists_and_returns_old_new():
    manager = RelationshipManager(Store())

    old, new = await manager.adjust("chat-1", "Alice", "Bob", "affection", 15)
    assert (old, new) == (0, 15)

    state = await manager.load("chat-1")
    assert state["Alice"]["Bob"]["affection"] == 15


async def test_manager_adjust_accumulates_across_calls():
    manager = RelationshipManager(Store())

    await manager.adjust("chat-1", "Alice", "Bob", "affection", 15)
    old, new = await manager.adjust("chat-1", "Alice", "Bob", "affection", 10)

    assert (old, new) == (15, 25)


async def test_manager_set_persists_the_clamped_value():
    manager = RelationshipManager(Store())

    clamped = await manager.set("chat-1", "Alice", "Bob", "desire", 500)
    assert clamped == 100

    state = await manager.load("chat-1")
    assert state["Alice"]["Bob"]["desire"] == 100


async def test_manager_describe_reflects_persisted_state():
    manager = RelationshipManager(Store())
    i18n = I18n(locale="en")

    assert await manager.describe("chat-1", i18n) == []

    await manager.adjust("chat-1", "Alice", "Bob", "affection", 20)
    lines = await manager.describe("chat-1", i18n)

    assert len(lines) == 1
    assert "Alice" in lines[0] and "Bob" in lines[0]


async def test_manager_load_tolerates_corrupt_stored_json():
    store = Store()
    await store.set(user_key="", store_key="relationships.chat-corrupt", value="{not valid json")
    manager = RelationshipManager(store)

    assert await manager.load("chat-corrupt") == {}


async def test_manager_state_is_scoped_per_chat_key():
    manager = RelationshipManager(Store())

    await manager.adjust("chat-a", "Alice", "Bob", "affection", 10)
    await manager.adjust("chat-b", "Alice", "Bob", "affection", 99)

    state_a = await manager.load("chat-a")
    state_b = await manager.load("chat-b")

    assert state_a["Alice"]["Bob"]["affection"] == 10
    assert state_b["Alice"]["Bob"]["affection"] == 99
