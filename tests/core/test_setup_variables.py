"""M26 §5.3 — "set before play" variables, and the ONE tree-write primitive behind them.

The flag half (`core.modvars`/`core.lorecard`) and the write half (`core.mvu_compat`)
live here; the command and prompt surfaces that consume them are tested beside those.
"""

from __future__ import annotations

import json

import pytest

from core.documents import DocumentStore
from core.lorecard import parse_lorecard_bytes
from core.modvars import build_spec, normalize_spec, normalize_state
from core.mvu_compat import (
    mvu_add_path,
    mvu_init_from_initvar,
    mvu_set_path,
    nearest_paths,
    path_leaf,
)
from infra.store import Store


# ---------------------------------------------------------------------------
# The flag
# ---------------------------------------------------------------------------


def test_setup_is_stored_only_when_true_so_existing_specs_keep_their_shape():
    plain = build_spec("difficulty", "enum", options=["easy", "hard"])
    flagged = build_spec("difficulty", "enum", options=["easy", "hard"], setup=True)

    assert "setup" not in plain
    assert flagged["setup"] is True
    assert {key: value for key, value in flagged.items() if key != "setup"} == plain


def test_normalize_spec_and_state_carry_the_flag_through_storage():
    stored = {"id": "难度", "kind": "enum", "options": ["轻松", "残酷"], "setup": True}

    assert normalize_spec("难度", stored)["setup"] is True
    state = normalize_state({"specs": {"难度": stored}, "values": {}})
    assert state["specs"]["难度"]["setup"] is True
    # A round trip through JSON (how it is actually stored) keeps it.
    assert normalize_state(json.loads(json.dumps(state)))["specs"]["难度"]["setup"] is True


def test_a_native_lorecard_declares_setup_variables():
    payload = {
        "format": "loreweaver.card",
        "format_version": 1,
        "name": "试作模组",
        "variables": [
            {"id": "难度", "kind": "enum", "options": ["轻松", "标准", "残酷"], "setup": True},
            {"id": "恐惧", "kind": "number", "minimum": 0, "maximum": 10},
        ],
    }

    card = parse_lorecard_bytes(json.dumps(payload).encode("utf-8"), "试作.lorecard.json")

    specs = {spec["id"]: spec for spec in card.variable_specs}
    assert specs["难度"]["setup"] is True
    assert "setup" not in specs["恐惧"]


# ---------------------------------------------------------------------------
# The write primitive
# ---------------------------------------------------------------------------


async def _tree_room() -> DocumentStore:
    documents = DocumentStore(Store())
    await mvu_init_from_initvar(
        documents, "room1", {"配置": {"难度": "标准", "恐惧": 2, "描述": [1, "with a description"]}}
    )
    return documents


async def test_mvu_set_path_writes_an_existing_leaf_and_reports_old_and_new():
    documents = await _tree_room()

    assert await mvu_set_path(documents, "room1", "配置.难度", "残酷") == ("标准", "残酷")
    assert await mvu_set_path(documents, "room1", "配置.难度", "轻松") == ("残酷", "轻松")


async def test_mvu_set_path_keeps_a_value_with_description_wrapper():
    documents = await _tree_room()

    old, new = await mvu_set_path(documents, "room1", "配置.描述", 9)

    assert (old, new) == (1, 9)
    from core.mvu_compat import load_mvu

    assert (await load_mvu(documents, "room1"))["配置"]["描述"] == [9, "with a description"]


async def test_mvu_set_path_refuses_an_unknown_path_for_the_admin_posture():
    documents = await _tree_room()

    with pytest.raises(ValueError):
        await mvu_set_path(documents, "room1", "配置.不存在", "x")

    # The model tool's posture still creates — the tree's SHAPE is the module's business.
    assert await mvu_set_path(documents, "room1", "配置.不存在", "x", existing_only=False) == (None, "x")


async def test_mvu_add_path_nudges_a_number_and_refuses_a_missing_one():
    documents = await _tree_room()

    assert await mvu_add_path(documents, "room1", "配置.恐惧", 3) == (2, 5)
    with pytest.raises(ValueError):
        await mvu_add_path(documents, "room1", "配置.没有这个", 1)
    with pytest.raises(ValueError):
        await mvu_add_path(documents, "room1", "配置.难度", 1)  # not a number


async def test_nearest_paths_helps_a_mistyped_path_without_choosing_one():
    documents = await _tree_room()
    from core.mvu_compat import load_mvu

    tree = await load_mvu(documents, "room1")

    assert "配置.难度" in nearest_paths(tree, "配置.难")
    assert nearest_paths(tree, "完全不相干", limit=2)[:2] == nearest_paths(tree, "完全不相干", limit=2)
    assert len(nearest_paths(tree, "配置", limit=2)) == 2


async def test_path_leaf_unwraps_and_raises_on_a_miss():
    documents = await _tree_room()
    from core.mvu_compat import load_mvu

    tree = await load_mvu(documents, "room1")

    assert path_leaf(tree, "配置.描述") == 1
    with pytest.raises(ValueError):
        path_leaf(tree, "配置.缺席")
