"""Tests for core.varspace: the unified variable resolver over modvars + the MVU tree."""

from __future__ import annotations

from core.varspace import build_resolver


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


def test_tree_walker_is_reachable_under_a_public_name():
    """The MVU tree walker is public API: `agent.kp_tools_vars` reads leaves through it."""
    from core.varspace import resolve_tree_path

    tree = {"理": {"好感度": [33, "desc"]}, "party": [{"hp": 12}, {"hp": [7, "wounded"]}]}
    assert resolve_tree_path(tree, "理.好感度") == 33  # dotted path + ValueWithDescription unwrap
    assert resolve_tree_path(tree, "party.0.hp") == 12  # numeric segment indexes a list
    assert resolve_tree_path(tree, "party.1.hp") == 7
    assert resolve_tree_path(tree, "party") == [{"hp": 12}, {"hp": [7, "wounded"]}]  # non-leaf node
    assert resolve_tree_path(tree, "理.仇恨度") is None  # missing path
    assert resolve_tree_path(tree, "理.好感度.deeper") is None  # walking past a leaf


def test_build_resolver_still_reads_both_stores():
    """Positive control: the live entry point resolves modvars AND the MVU tree."""
    resolve = build_resolver({"fear": 4}, {"理": {"好感度": [33, "d"]}})
    assert resolve("fear") == 4
    assert resolve("理.好感度") == 33
    assert resolve("ghost") is None
