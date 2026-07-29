"""Tests for core.varspace: the unified variable resolver over modvars + the MVU tree."""

from __future__ import annotations

from core.modvars import ModvarManager, build_spec
from core.varspace import build_resolver, load_resolver
from infra.store import Store


def test_modvars_win_over_the_mvu_tree():
    resolve = build_resolver({"fear": 3}, {"fear": [9, "desc"]})
    assert resolve("fear") == 3


def test_root_prefixes_are_stripped():
    resolve = build_resolver({"stage": 2}, {"理": {"好感度": [33, "desc"]}})
    assert resolve("variables.stage") == 2
    assert resolve("stat_data.理.好感度") == 33


def test_mvu_tree_walk_unwraps_value_with_description_and_indexes_lists():
    tree = {"party": [{"hp": 12}, {"hp": [7, "wounded"]}], "flag": True}
    resolve = build_resolver({}, tree)
    assert resolve("party.0.hp") == 12
    assert resolve("party.1.hp") == 7
    assert resolve("flag") is True


def test_missing_paths_and_bad_input_resolve_to_none():
    resolve = build_resolver({}, {"a": {"b": 1}})
    assert resolve("a.zzz") is None
    assert resolve("a.b.c") is None
    assert resolve("") is None
    assert resolve(None) is None  # type: ignore[arg-type]


async def test_load_resolver_reads_both_stores():
    store = Store()
    await ModvarManager(store).define("room1", build_spec("fear", "number", default="4"))
    from core.mvu_compat import MvuManager

    await MvuManager(store).init_from_initvar("room1", {"理": {"好感度": [33, "d"]}})
    resolve = await load_resolver(store, "room1")
    assert resolve("fear") == 4
    assert resolve("理.好感度") == 33
    assert resolve("ghost") is None
