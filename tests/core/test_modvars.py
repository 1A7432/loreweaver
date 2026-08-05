"""Tests for core.modvars: the pure spec-building/validation/state-transition/rendering functions
and the thin async `ModvarManager` persistence wrapper over an in-memory `infra.store.Store`.
"""

from __future__ import annotations

import pytest

from core.modvars import (
    MAX_TEXT_LEN,
    MAX_VARS,
    ModvarManager,
    apply_adjust,
    apply_define,
    apply_remove,
    apply_set,
    build_spec,
    describe,
    empty_state,
    label_for,
    normalize_id,
    normalize_state,
    player_entries,
    validate_value,
)
from infra.i18n import I18n
from infra.store import Store

# ---------------------------------------------------------------------------
# normalize_id
# ---------------------------------------------------------------------------


def test_normalize_id_lowers_and_slugifies():
    assert normalize_id("Suspicion") == "suspicion"
    assert normalize_id("  Town Fear ") == "town_fear"
    assert normalize_id("clue-count") == "clue_count"


def test_normalize_id_rejects_garbage():
    assert normalize_id("") is None
    assert normalize_id("a" * 65) is None
    assert normalize_id(42) is None


# ---------------------------------------------------------------------------
# build_spec
# ---------------------------------------------------------------------------


def test_build_spec_number_with_bounds_and_labels():
    spec = build_spec(
        "Suspicion", "number", labels={"en": "Suspicion", "zh-CN": "怀疑度"}, minimum=0, maximum=10
    )
    assert spec["id"] == "suspicion"
    assert spec["minimum"] == 0 and spec["maximum"] == 10
    assert spec["labels"] == {"en": "Suspicion", "zh": "怀疑度"}
    assert spec["default"] == 0  # bounded number defaults to its minimum
    assert spec["visibility"] == "player"


def test_build_spec_defaults_per_kind():
    assert build_spec("a", "number")["default"] == 0
    assert build_spec("b", "number", minimum=5)["default"] == 5
    assert build_spec("c", "number", maximum=-3)["default"] == -3
    assert build_spec("d", "bool")["default"] is False
    assert build_spec("e", "text")["default"] == ""
    assert build_spec("f", "enum", options=["calm", "tense"])["default"] == "calm"


def test_build_spec_explicit_default_is_validated():
    assert build_spec("a", "number", minimum=0, maximum=10, default="15")["default"] == 10
    assert build_spec("b", "enum", options=["Calm", "Tense"], default="TENSE")["default"] == "Tense"


def test_build_spec_rejects_bad_input():
    with pytest.raises(ValueError):
        build_spec("BAD ID!!", "number")
    with pytest.raises(ValueError):
        build_spec("a", "float")
    with pytest.raises(ValueError):
        build_spec("a", "number", visibility="everyone")
    with pytest.raises(ValueError):
        build_spec("a", "number", minimum=10, maximum=0)
    with pytest.raises(ValueError):
        build_spec("a", "text", minimum=0)
    with pytest.raises(ValueError):
        build_spec("a", "enum", options=[])
    with pytest.raises(ValueError):
        build_spec("a", "bool", options=["yes"])


def test_build_spec_enum_dedupes_case_insensitively():
    spec = build_spec("mood", "enum", options=["Calm", "calm ", "Tense"])
    assert spec["options"] == ["Calm", "Tense"]


# ---------------------------------------------------------------------------
# validate_value
# ---------------------------------------------------------------------------


def test_validate_value_number_coerces_and_clamps():
    spec = build_spec("n", "number", minimum=0, maximum=10)
    assert validate_value(spec, "7") == 7
    assert validate_value(spec, 99) == 10
    assert validate_value(spec, -5) == 0
    with pytest.raises(ValueError):
        validate_value(spec, "not a number")


def test_validate_value_bool_accepts_word_forms():
    spec = build_spec("b", "bool")
    assert validate_value(spec, "yes") is True
    assert validate_value(spec, "off") is False
    assert validate_value(spec, 1) is True
    with pytest.raises(ValueError):
        validate_value(spec, "maybe")


def test_validate_value_text_truncates_and_rejects_structures():
    spec = build_spec("t", "text")
    assert validate_value(spec, "x" * (MAX_TEXT_LEN + 50)) == "x" * MAX_TEXT_LEN
    assert validate_value(spec, 42) == "42"
    with pytest.raises(ValueError):
        validate_value(spec, {"a": 1})


def test_validate_value_enum_matches_case_insensitively_to_canonical():
    spec = build_spec("m", "enum", options=["Calm", "Tense"])
    assert validate_value(spec, "tense") == "Tense"
    with pytest.raises(ValueError):
        validate_value(spec, "panicked")


# ---------------------------------------------------------------------------
# apply_define / apply_set / apply_adjust / apply_remove
# ---------------------------------------------------------------------------


def test_apply_define_adds_variable_with_default_value():
    state = apply_define(empty_state(), build_spec("suspicion", "number", minimum=0, maximum=10))
    assert state["values"]["suspicion"] == 0


def test_apply_define_redefine_keeps_valid_value_and_reclamps():
    state = apply_define(empty_state(), build_spec("n", "number"))
    state, _, _ = apply_set(state, "n", 50)
    state = apply_define(state, build_spec("n", "number", minimum=0, maximum=10))
    assert state["values"]["n"] == 10  # old 50 re-clamped into the new bounds


def test_apply_define_redefine_incompatible_value_resets_to_default():
    state = apply_define(empty_state(), build_spec("v", "text"))
    state, _, _ = apply_set(state, "v", "hello")
    state = apply_define(state, build_spec("v", "enum", options=["calm", "tense"]))
    assert state["values"]["v"] == "calm"


def test_apply_define_enforces_the_variable_cap():
    state = empty_state()
    for index in range(MAX_VARS):
        state = apply_define(state, build_spec(f"v{index}", "bool"))
    with pytest.raises(ValueError):
        apply_define(state, build_spec("one_too_many", "bool"))
    # redefining an existing variable is still fine at the cap
    apply_define(state, build_spec("v0", "bool"))


def test_apply_define_does_not_mutate_input():
    state = empty_state()
    apply_define(state, build_spec("a", "bool"))
    assert state == empty_state()


def test_apply_set_returns_old_and_new():
    state = apply_define(empty_state(), build_spec("n", "number", minimum=0, maximum=10))
    state, old, new = apply_set(state, "n", "8")
    assert (old, new) == (0, 8)
    with pytest.raises(ValueError):
        apply_set(state, "ghost", 1)


def test_apply_adjust_clamps_and_rejects_non_numbers():
    state = apply_define(empty_state(), build_spec("n", "number", minimum=0, maximum=10))
    state, old, new = apply_adjust(state, "n", 99)
    assert (old, new) == (0, 10)
    state = apply_define(state, build_spec("t", "text"))
    with pytest.raises(ValueError):
        apply_adjust(state, "t", 1)
    with pytest.raises(ValueError):
        apply_adjust(state, "ghost", 1)


def test_apply_remove_drops_spec_and_value():
    state = apply_define(empty_state(), build_spec("n", "number"))
    state = apply_remove(state, "n")
    assert state == empty_state()
    with pytest.raises(ValueError):
        apply_remove(state, "n")


# ---------------------------------------------------------------------------
# normalize_state — defensive load path
# ---------------------------------------------------------------------------


def test_normalize_state_degrades_garbage_to_empty():
    assert normalize_state(None) == empty_state()
    assert normalize_state([1, 2]) == empty_state()
    assert normalize_state({"specs": "nope"}) == empty_state()


def test_normalize_state_drops_corrupt_specs_and_heals_invalid_values():
    good = build_spec("n", "number", minimum=0, maximum=10)
    raw = {
        "specs": {"n": good, "bad": {"kind": "float"}, "worse": 42},
        "values": {"n": 999, "bad": 1},
    }
    state = normalize_state(raw)
    assert list(state["specs"]) == ["n"]
    assert state["values"]["n"] == 10  # stored 999 re-clamped on load


def test_normalize_state_invalid_value_resets_to_default():
    spec = build_spec("m", "enum", options=["calm", "tense"])
    state = normalize_state({"specs": {"m": spec}, "values": {"m": "panicked"}})
    assert state["values"]["m"] == "calm"


def test_normalize_state_preserves_definition_order():
    state = empty_state()
    for name in ("zeta", "alpha", "mid"):
        state = apply_define(state, build_spec(name, "bool"))
    import json

    reloaded = normalize_state(json.loads(json.dumps(state)))
    assert list(reloaded["specs"]) == ["zeta", "alpha", "mid"]


# ---------------------------------------------------------------------------
# label_for / player_entries / describe
# ---------------------------------------------------------------------------


def test_label_for_fallback_chain():
    spec = build_spec("suspicion", "number", labels={"zh": "怀疑度"})
    assert label_for(spec, "zh-CN") == "怀疑度"
    assert label_for(spec, "en") == "怀疑度"  # any-label fallback when en missing
    spec_both = build_spec("suspicion", "number", labels={"en": "Suspicion", "zh": "怀疑度"})
    assert label_for(spec_both, "en") == "Suspicion"
    assert label_for(build_spec("bare", "bool"), "en") == "bare"


def test_player_entries_filters_keeper_only_structurally():
    state = apply_define(empty_state(), build_spec("fear", "number", minimum=0, maximum=10))
    state = apply_define(state, build_spec("true_culprit", "text", visibility="keeper"))
    entries = player_entries(state, "en")
    assert [entry["id"] for entry in entries] == ["fear"]
    assert entries[0]["min"] == 0 and entries[0]["max"] == 10
    # the keeper-only variable must not appear in ANY field of the wire payload
    assert "true_culprit" not in str(entries)


def test_player_entries_omits_absent_bounds():
    state = apply_define(empty_state(), build_spec("score", "number"))
    (entry,) = player_entries(state, "en")
    assert "min" not in entry and "max" not in entry


def test_describe_localizes_and_tags_keeper_lines():
    state = apply_define(
        empty_state(), build_spec("fear", "number", labels={"en": "Town Fear"}, minimum=0, maximum=10)
    )
    state = apply_define(state, build_spec("alerted", "bool", visibility="keeper"))
    lines = describe(state, I18n(locale="en"), "en")
    assert len(lines) == 2
    assert "Town Fear" in lines[0] and "range 0–10" in lines[0]
    assert "KEEPER-ONLY" in lines[1] and "no" in lines[1]


def test_describe_empty_state_is_empty():
    assert describe(empty_state(), I18n(locale="en"), "en") == []


# ---------------------------------------------------------------------------
# ModvarManager — persistence wrapper
# ---------------------------------------------------------------------------


async def test_manager_load_on_a_fresh_room_is_empty():
    manager = ModvarManager(Store())
    assert await manager.load("room1") == empty_state()


async def test_manager_define_set_adjust_persist():
    manager = ModvarManager(Store())
    await manager.define("room1", build_spec("n", "number", minimum=0, maximum=10))
    old, new = await manager.set("room1", "n", 4)
    assert (old, new) == (0, 4)
    old, new = await manager.adjust("room1", "n", 99)
    assert (old, new) == (4, 10)
    state = await manager.load("room1")
    assert state["values"]["n"] == 10


async def test_manager_remove_persists():
    manager = ModvarManager(Store())
    await manager.define("room1", build_spec("n", "bool"))
    await manager.remove("room1", "n")
    assert await manager.load("room1") == empty_state()


async def test_manager_load_tolerates_corrupt_stored_json():
    store = Store()
    await store.set(user_key="", store_key="module_vars.room1", value="{not json")
    assert await ModvarManager(store).load("room1") == empty_state()


async def test_manager_state_is_scoped_per_chat_key():
    manager = ModvarManager(Store())
    await manager.define("room1", build_spec("n", "bool"))
    assert await manager.load("room2") == empty_state()


async def test_manager_player_entries_and_describe_wrappers():
    manager = ModvarManager(Store())
    await manager.define("room1", build_spec("fear", "number", labels={"zh": "恐惧"}, minimum=0, maximum=10))
    await manager.define("room1", build_spec("secret", "text", visibility="keeper"))
    entries = await manager.player_entries("room1", "zh")
    assert [entry["label"] for entry in entries] == ["恐惧"]
    lines = await manager.describe("room1", I18n(locale="zh"), "zh")
    assert len(lines) == 2


def test_normalize_id_accepts_cjk_ids_first_class():
    # The studio forge and native bundles (M14) author CJK tracker ids; they ride the
    # same `state.variables` wire field where MVU CJK ids are already normal.
    assert normalize_id("理智") == "理智"
    assert normalize_id("怀疑度") == "怀疑度"
    assert normalize_id("雨 夜") == "雨_夜"  # spaces still slug to underscores
    assert normalize_id("Town Fear") == "town_fear"  # ASCII path unchanged
    assert normalize_id("bad!id") is None  # ASCII punctuation still rejected
    assert normalize_id("零宽​间隔") is None  # unicode format chars rejected
    assert normalize_id("响铃\x07符") is None  # ASCII control chars rejected
    assert normalize_id("变量") == "变量"  # the pre-M14 blanket CJK rejection is gone
