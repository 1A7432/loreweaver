"""Tests for core.mvu_compat: InitVar detection + JSON5-lite parsing, the five pure MVU path
ops, ``<UpdateVariable>`` block extraction/tokenizing, tolerant command application, flattening,
defensive tree normalization, and the thin async document-persistence functions
(`load_mvu`/`save_mvu`/...) over an in-memory `infra.store.Store`, via `core.documents.DocumentStore`.
"""

from __future__ import annotations

import pytest

from core.documents import DocumentStore
from core.mvu_compat import (
    MAX_TREE_DEPTH,
    MAX_TREE_NODES,
    apply_add,
    apply_commands,
    apply_delete,
    apply_insert,
    apply_move,
    apply_set,
    flatten_leaves,
    is_initvar_entry,
    is_value_with_desc,
    leaf_value,
    load_mvu,
    mvu_apply_text,
    mvu_expose,
    mvu_exposed_prefixes,
    mvu_flatten,
    mvu_has_data,
    mvu_hide,
    mvu_init_from_initvar,
    normalize_tree,
    parse_initvar,
    parse_update_blocks,
)
from infra.store import Store

# A realistic MVU InitVar payload: line/block comments (CJK), a single-quoted key, an unquoted
# ASCII identifier key, trailing commas, ValueWithDescription leaves, and a `//` inside a URL.
INITVAR_TEXT = """
// MVU 变量初始化
{
  '理': {
    "情绪状态": {
      pleasure: [0.1, "[-1,1] range; updates on emotion change"],
    },
    "好感度": [33, "对主角的好感"],
  },
  "世界": {
    "link": "https://example.com/wiki//page", /* 保持原样 */
    "day": 1,
  },
}
"""

NARRATION = """他微微一笑。

<UpdateVariable>
<Analysis>
好感度 33 -> 35，愉快的交谈。
</Analysis>
_.set('理.好感度', 33, 35);//pleasant discussion
_.add('世界.day', 1)
</UpdateVariable>

雨停了。"""

# ---------------------------------------------------------------------------
# is_initvar_entry
# ---------------------------------------------------------------------------


def test_is_initvar_entry_matches_case_insensitively():
    assert is_initvar_entry("[InitVar]") is True
    assert is_initvar_entry("「[InitVar]变量初始化」") is True
    assert is_initvar_entry("MVU INITVAR block") is True
    assert is_initvar_entry("initvar") is True


def test_is_initvar_entry_rejects_non_strings_and_non_matches():
    assert is_initvar_entry("variables") is False
    assert is_initvar_entry("init var") is False
    assert is_initvar_entry("") is False
    assert is_initvar_entry(None) is False
    assert is_initvar_entry(42) is False


# ---------------------------------------------------------------------------
# parse_initvar — tolerant JSON5-lite
# ---------------------------------------------------------------------------


def test_parse_initvar_plain_json_object():
    assert parse_initvar('{"a": 1, "b": [1, 2]}') == {"a": 1, "b": [1, 2]}


def test_parse_initvar_strips_comments_but_not_inside_strings():
    text = (
        "{\n"
        '  "link": "https://example.com//page", // trailing comment\n'
        "  /* block\n     comment */\n"
        '  "笔记": "含//斜杠"\n'
        "}"
    )
    assert parse_initvar(text) == {"link": "https://example.com//page", "笔记": "含//斜杠"}


def test_parse_initvar_tolerates_trailing_commas():
    assert parse_initvar('{"a": [1, 2,], "b": {"c": 1,},}') == {"a": [1, 2], "b": {"c": 1}}


def test_parse_initvar_converts_single_quoted_strings():
    parsed = parse_initvar("{'name': 'it\\'s \"fine\"', 'n': 1}")
    assert parsed == {"name": 'it\'s "fine"', "n": 1}


def test_parse_initvar_quotes_unquoted_ascii_identifier_keys():
    parsed = parse_initvar('{pleasure: 0.1, _tag$: "x", nested: {inner: true}}')
    assert parsed == {"pleasure": 0.1, "_tag$": "x", "nested": {"inner": True}}


def test_parse_initvar_real_world_mvu_shape():
    parsed = parse_initvar(INITVAR_TEXT)
    assert parsed is not None
    assert parsed["理"]["情绪状态"]["pleasure"] == [0.1, "[-1,1] range; updates on emotion change"]
    assert parsed["理"]["好感度"] == [33, "对主角的好感"]
    assert parsed["世界"]["link"] == "https://example.com/wiki//page"
    assert parsed["世界"]["day"] == 1


def test_parse_initvar_rejects_unrecoverable_or_non_dict():
    assert parse_initvar("not json at all") is None
    assert parse_initvar("[1, 2]") is None
    assert parse_initvar("") is None
    assert parse_initvar('{"a": 1') is None
    assert parse_initvar("{'unterminated: 1}") is None


# ---------------------------------------------------------------------------
# parse_initvar — YAML fallback (the 2026-era MVU wire shape)
# ---------------------------------------------------------------------------

# A realistic YAML-form InitVar: block mapping with CJK keys, inline flow maps/lists,
# underscore-prefixed keys, quoted and plain scalars, a comment, and a
# ValueWithDescription leaf riding a flow list.
YAML_INITVAR_TEXT = """\
世界:
  日: 1
  时段: 上午  # 注释与数据同行
  今日访客配额: 3
  监控录像: ""
  声望: { 圣哺: 20, 残堇: 20 }
  已登记访客: []
玩家资源:
  精力: { 当前值: 8, 训练经验: 0 }
  _小憩日: -1
  保护准备: false
结局标记: [进行中, "本周目状态"]
"""


def test_parse_initvar_yaml_block_mapping():
    parsed = parse_initvar(YAML_INITVAR_TEXT)
    assert parsed is not None
    assert parsed["世界"]["日"] == 1
    assert parsed["世界"]["时段"] == "上午"
    assert parsed["世界"]["监控录像"] == ""
    assert parsed["世界"]["声望"] == {"圣哺": 20, "残堇": 20}
    assert parsed["世界"]["已登记访客"] == []
    assert parsed["玩家资源"]["精力"] == {"当前值": 8, "训练经验": 0}
    assert parsed["玩家资源"]["_小憩日"] == -1
    assert parsed["玩家资源"]["保护准备"] is False
    assert parsed["结局标记"] == ["进行中", "本周目状态"]


def test_parse_initvar_yaml_survives_apostrophe_prose():
    # A bare apostrophe wrecks the JSON5 route (unterminated string) — YAML doesn't care.
    assert parse_initvar("提示: today's visitor knocks\n计数: 2\n") == {
        "提示": "today's visitor knocks",
        "计数": 2,
    }


def test_parse_initvar_yaml_rejects_aliases_and_non_mappings():
    assert parse_initvar("a: &x [1, 2]\nb: *x\n") is None  # alias-bomb class rejected outright
    assert parse_initvar("- 1\n- 2\n") is None
    assert parse_initvar("just prose\n") is None
    assert parse_initvar("a:\n\tb: 1\n") is None  # tab indentation = YAML scanner error


def test_parse_initvar_yaml_11_semantics_are_pinned():
    # PyYAML is YAML 1.1: `yes`/`no` load as booleans, duplicate keys last-win. The studio
    # mirror (yaml-1.1 schema) pins the same pair — keep both tests in sync.
    assert parse_initvar("开关: yes\n开关: no\n") == {"开关": False}


def test_parse_initvar_yaml_dates_become_iso_strings():
    # PyYAML auto-types ISO dates; `normalize_tree` would drop date objects as non-JSON.
    assert parse_initvar("下次检查: 2026-08-04\n嵌套: { 时刻: [2026-08-04, 备注] }\n") == {
        "下次检查": "2026-08-04",
        "嵌套": {"时刻": ["2026-08-04", "备注"]},
    }


# ---------------------------------------------------------------------------
# ValueWithDescription helpers
# ---------------------------------------------------------------------------


def test_is_value_with_desc_shape_detection():
    assert is_value_with_desc([0.1, "desc"]) is True
    assert is_value_with_desc(["a", "b"]) is True  # upstream's own ambiguity, by construction
    assert is_value_with_desc([1, 2]) is False
    assert is_value_with_desc([1, "a", "b"]) is False
    assert is_value_with_desc("x") is False
    assert is_value_with_desc({"a": 1}) is False


def test_leaf_value_unwraps_only_value_with_desc():
    assert leaf_value([5, "desc"]) == 5
    assert leaf_value(7) == 7
    assert leaf_value([1, 2, 3]) == [1, 2, 3]
    assert leaf_value(None) is None


# ---------------------------------------------------------------------------
# apply_set
# ---------------------------------------------------------------------------


def test_apply_set_updates_value_with_desc_and_keeps_description():
    tree = {"理": {"好感度": [33, "对主角的好感"]}}
    out = apply_set(tree, "理.好感度", 35)
    assert out["理"]["好感度"] == [35, "对主角的好感"]


def test_apply_set_replaces_plain_leaf_without_mutating_input():
    tree = {"a": {"b": 1}}
    out = apply_set(tree, "a.b", "text")
    assert out == {"a": {"b": "text"}}
    assert tree == {"a": {"b": 1}}


def test_apply_set_expected_old_is_advisory_only():
    tree = {"理": {"好感度": [33, "desc"]}}
    out = apply_set(tree, "理.好感度", 35, expected_old=999)  # mismatch must NOT reject
    assert out["理"]["好感度"] == [35, "desc"]


def test_apply_set_autocreates_missing_intermediate_dicts():
    out = apply_set({"a": {"x": 1}}, "a.b.c", 5)
    assert out == {"a": {"x": 1, "b": {"c": 5}}}
    assert apply_set({}, "新章节.进度", 0) == {"新章节": {"进度": 0}}


def test_apply_set_addresses_list_indices_numerically():
    tree = {"party": [{"hp": 10}, {"hp": 8}]}
    out = apply_set(tree, "party.1.hp", 6)
    assert out["party"] == [{"hp": 10}, {"hp": 6}]


def test_apply_set_raises_on_bad_paths():
    with pytest.raises(ValueError):
        apply_set({"a": 1}, "", 1)
    with pytest.raises(ValueError):
        apply_set({"a": 1}, "a..b", 1)
    with pytest.raises(ValueError):
        apply_set({"a": [1]}, "a.5", 2)  # index out of range
    with pytest.raises(ValueError):
        apply_set({"a": [1, 2]}, "a.x", 3)  # non-numeric list index
    with pytest.raises(ValueError):
        apply_set({"a": 1}, "a.b", 2)  # scalar mid-path


# ---------------------------------------------------------------------------
# apply_insert
# ---------------------------------------------------------------------------


def test_apply_insert_list_append_and_index():
    tree = {"tags": ["a", "c"]}
    out = apply_insert(tree, "tags", "d")
    assert out["tags"] == ["a", "c", "d"]
    out = apply_insert(tree, "tags", "b", key=1)
    assert out["tags"] == ["a", "b", "c"]
    assert tree == {"tags": ["a", "c"]}


def test_apply_insert_dict_key_and_wrapped_container():
    tree = {"info": {"k": 1}, "vwd": [["x"], "desc"]}
    out = apply_insert(tree, "info", 2, key="j")
    assert out["info"] == {"k": 1, "j": 2}
    out = apply_insert(tree, "vwd", "y")  # inserts through the ValueWithDescription wrapper
    assert out["vwd"] == [["x", "y"], "desc"]


def test_apply_insert_raises_on_bad_targets():
    tree = {"info": {"k": 1}, "s": "str"}
    with pytest.raises(ValueError):
        apply_insert(tree, "info", 1)  # dict insert without a key
    with pytest.raises(ValueError):
        apply_insert(tree, "missing", 1)
    with pytest.raises(ValueError):
        apply_insert(tree, "s", 1)  # scalar target
    with pytest.raises(ValueError):
        apply_insert({"l": ["a"]}, "l", "x", key="nope")  # non-numeric list index


# ---------------------------------------------------------------------------
# apply_delete
# ---------------------------------------------------------------------------


def test_apply_delete_node_at_path():
    tree = {"a": {"b": 1, "c": 2}, "l": ["x", "y", "z"]}
    out = apply_delete(tree, "a.b")
    assert out["a"] == {"c": 2}
    out = apply_delete(tree, "l.1")
    assert out["l"] == ["x", "z"]
    assert tree == {"a": {"b": 1, "c": 2}, "l": ["x", "y", "z"]}


def test_apply_delete_with_key_index_and_value():
    tree = {"a": {"b": 1, "c": 2}, "l": ["x", "y", "z"]}
    assert apply_delete(tree, "a", key="c")["a"] == {"b": 1}
    assert apply_delete(tree, "l", key=2)["l"] == ["x", "y"]  # int-like key → index
    assert apply_delete(tree, "l", key="y")["l"] == ["x", "z"]  # else → first value match


def test_apply_delete_raises_on_missing():
    tree = {"a": {"b": 1}, "l": ["x"]}
    with pytest.raises(ValueError):
        apply_delete(tree, "a.zzz")
    with pytest.raises(ValueError):
        apply_delete(tree, "l", key=9)
    with pytest.raises(ValueError):
        apply_delete(tree, "l", key="nope")
    with pytest.raises(ValueError):
        apply_delete(tree, "a.b", key="x")  # scalar target with a key


# ---------------------------------------------------------------------------
# apply_add
# ---------------------------------------------------------------------------


def test_apply_add_numeric_delta_and_wrapped_leaf():
    tree = {"hp": 10, "score": [1.5, "desc"]}
    assert apply_add(tree, "hp", -3)["hp"] == 7
    assert apply_add(tree, "score", 0.5)["score"] == [2.0, "desc"]  # description kept
    assert tree == {"hp": 10, "score": [1.5, "desc"]}


def test_apply_add_toggles_booleans():
    tree = {"alerted": False, "armed": [True, "desc"], "hp": 10}
    assert apply_add(tree, "alerted", 1)["alerted"] is True  # bool target toggles
    assert apply_add(tree, "alerted", True)["alerted"] is True  # bool delta toggles too
    assert apply_add(tree, "armed", 1)["armed"] == [False, "desc"]
    # documented edge: a bool delta on a number toggles its truthiness
    assert apply_add(tree, "hp", True)["hp"] is False


def test_apply_add_raises_on_non_numeric_targets():
    tree = {"hp": 10, "s": "x"}
    with pytest.raises(ValueError):
        apply_add(tree, "missing", 1)
    with pytest.raises(ValueError):
        apply_add(tree, "s", 1)
    with pytest.raises(ValueError):
        apply_add(tree, "hp", "lots")
    with pytest.raises(ValueError):
        apply_add(tree, "s", True)  # toggle needs a bool/number target


# ---------------------------------------------------------------------------
# apply_move
# ---------------------------------------------------------------------------


def test_apply_move_moves_node_with_wrapper_intact():
    tree = {"inv": {"sword": [1, "count"]}, "stash": {}}
    out = apply_move(tree, "inv.sword", "stash.sword")
    assert out == {"inv": {}, "stash": {"sword": [1, "count"]}}
    assert tree == {"inv": {"sword": [1, "count"]}, "stash": {}}


def test_apply_move_raises_on_missing_source_or_destination():
    tree = {"inv": {"sword": 1}}
    with pytest.raises(ValueError):
        apply_move(tree, "inv.ghost", "inv.other")
    with pytest.raises(ValueError):
        apply_move(tree, "inv.sword", "no.such.place")  # move never auto-creates
    assert tree == {"inv": {"sword": 1}}


# ---------------------------------------------------------------------------
# parse_update_blocks
# ---------------------------------------------------------------------------


def test_parse_update_blocks_real_world_narration():
    commands, cleaned = parse_update_blocks(NARRATION)
    assert [command["op"] for command in commands] == ["set", "add"]
    assert commands[0] == {"op": "set", "path": "理.好感度", "args": [33, 35], "reason": "pleasant discussion"}
    assert commands[1] == {"op": "add", "path": "世界.day", "args": [1], "reason": ""}
    assert cleaned == "他微微一笑。\n\n雨停了。"


def test_parse_update_blocks_discards_command_like_lines_inside_analysis():
    text = (
        "<UpdateVariable>\n"
        "<Analysis>\n"
        "_.set('ghost.value', 1)\n"
        "</Analysis>\n"
        "_.set('real.value', 2)\n"
        "</UpdateVariable>"
    )
    commands, cleaned = parse_update_blocks(text)
    assert len(commands) == 1
    assert commands[0]["path"] == "real.value" and commands[0]["args"] == [2]
    assert cleaned == ""


def test_parse_update_blocks_multiple_blocks_in_order_with_attributes():
    text = (
        "a\n<UpdateVariable>_.set('x', 1)</UpdateVariable>\n"
        'mid\n<UPDATEVARIABLE foo="1">_.add(\'x\', 2)</UpdateVariable>\nz'
    )
    commands, cleaned = parse_update_blocks(text)
    assert [(command["op"], command["path"]) for command in commands] == [("set", "x"), ("add", "x")]
    assert cleaned == "a\n\nmid\n\nz"


def test_parse_update_blocks_accepts_fenced_block():
    text = "before\n```\n<UpdateVariable>\n_.set('a', 1)\n</UpdateVariable>\n```\nafter"
    commands, cleaned = parse_update_blocks(text)
    assert len(commands) == 1
    assert commands[0] == {"op": "set", "path": "a", "args": [1], "reason": ""}
    assert cleaned == "before\n\nafter"


def test_parse_update_blocks_tokenizes_rich_arguments():
    text = (
        "<UpdateVariable>\n"
        "_.set('msg', \"he said \\\"hi\\\", ok\")\n"
        "_.set('flag', true)\n"
        "_.set('none', null)\n"
        "_.set('num', -2.5)\n"
        "_.insert('tags', ['a', 'b'])\n"
        '_.set(\'obj\', {"k": [1, 2]})\n'
        "</UpdateVariable>"
    )
    commands, cleaned = parse_update_blocks(text)
    assert [command["op"] for command in commands] == ["set", "set", "set", "set", "insert", "set"]
    assert commands[0]["args"] == ['he said "hi", ok']  # commas/escapes inside strings survive
    assert commands[1]["args"] == [True]
    assert commands[2]["args"] == [None]
    assert commands[3]["args"] == [-2.5]
    assert commands[4]["args"] == [["a", "b"]]  # single-quoted JSON chunk still lands
    assert commands[5]["args"] == [{"k": [1, 2]}]
    assert cleaned == ""


def test_parse_update_blocks_skips_garbage_lines():
    text = (
        "<UpdateVariable>\n"
        "random prose line\n"
        "_.explode('a')\n"
        "_.set('a'\n"
        "_.set(42, 1)\n"
        "_.delete('a', 'b', 'c')\n"
        "_.set('a.b', 1)\n"
        "</UpdateVariable>"
    )
    commands, _ = parse_update_blocks(text)
    assert len(commands) == 1
    assert commands[0]["path"] == "a.b"


def test_parse_update_blocks_without_block_returns_original_text():
    plain = "just narration // with a stray ``` fence and <Analysis>text</Analysis>"
    commands, cleaned = parse_update_blocks(plain)
    assert commands == []
    assert cleaned == plain  # byte-identical


# ---------------------------------------------------------------------------
# apply_commands — tolerant, in-order
# ---------------------------------------------------------------------------


def test_apply_commands_applies_in_order_and_records_errors():
    tree = {"hp": 10}
    commands = [
        {"op": "set", "path": "hp", "args": [5], "reason": ""},
        {"op": "delete", "path": "ghost", "args": [], "reason": ""},
        {"op": "add", "path": "hp", "args": [2], "reason": ""},
        {"op": "warp", "path": "hp", "args": [], "reason": ""},
    ]
    new_tree, applied, errors = apply_commands(tree, commands)
    assert new_tree["hp"] == 7
    assert [command["op"] for command in applied] == ["set", "add"]
    assert len(errors) == 2
    assert errors[0].startswith("delete ghost:")
    assert errors[1].startswith("warp hp:")
    assert tree == {"hp": 10}  # input never mutated


# ---------------------------------------------------------------------------
# flatten_leaves
# ---------------------------------------------------------------------------


def test_flatten_leaves_depth_first_order_and_unwrap():
    tree = {
        "a": {"x": [1, "desc"], "y": [1, 2, 3]},
        "b": "str",
        "c": [{"k": 1}, 2],
    }
    entries = flatten_leaves(tree, 10)
    assert entries == [
        {"path": "a.x", "value": 1},  # ValueWithDescription unwraps
        {"path": "a.y", "value": [1, 2, 3]},  # a scalar list renders as the list
        {"path": "b", "value": "str"},
        {"path": "c.0.k", "value": 1},  # a container list recurses with numeric segments
        {"path": "c.1", "value": 2},
    ]


def test_flatten_leaves_respects_limit():
    tree = {"a": 1, "b": 2, "c": 3, "d": 4}
    entries = flatten_leaves(tree, 2)
    assert entries == [{"path": "a", "value": 1}, {"path": "b", "value": 2}]
    assert flatten_leaves(tree, 0) == []


# ---------------------------------------------------------------------------
# normalize_tree — defensive load path
# ---------------------------------------------------------------------------


def test_normalize_tree_degrades_non_dicts_and_drops_garbage():
    assert normalize_tree(None) == {}
    assert normalize_tree([1, 2]) == {}
    assert normalize_tree("x") == {}
    raw = {"ok": 1, 2: "dropped", "inf": float("inf"), "obj": {1, 2}, "n": None}
    assert normalize_tree(raw) == {"ok": 1, "n": None}


def test_normalize_tree_caps_depth():
    raw: dict = {}
    node = raw
    for _ in range(12):
        node["k"] = {}
        node = node["k"]
    normalized = normalize_tree(raw)
    depth = 0
    node = normalized
    while "k" in node:
        node = node["k"]
        depth += 1
    assert depth == MAX_TREE_DEPTH - 1  # the deeper tail was dropped


def test_normalize_tree_caps_total_nodes():
    raw = {f"k{i}": i for i in range(MAX_TREE_NODES + 100)}
    normalized = normalize_tree(raw)
    assert len(normalized) == MAX_TREE_NODES


# ---------------------------------------------------------------------------
# Document persistence — load_mvu/save_mvu/mvu_* wrappers
# ---------------------------------------------------------------------------


async def test_load_mvu_on_a_fresh_room_is_empty():
    documents = DocumentStore(Store())
    assert await load_mvu(documents, "room1") == {}
    assert await mvu_has_data(documents, "room1") is False


async def test_load_mvu_tolerates_a_malformed_stored_document():
    documents = DocumentStore(Store())
    await documents.put("room1", "mvu_tree", "mvu", {"tree": "not-a-dict"})
    assert await load_mvu(documents, "room1") == {}
    await documents.put("room1", "mvu_tree", "mvu", {"tree": [1, 2]})
    assert await load_mvu(documents, "room1") == {}


async def test_init_from_initvar_merge_existing_wins():
    documents = DocumentStore(Store())
    parsed = parse_initvar(INITVAR_TEXT)
    assert await mvu_init_from_initvar(documents, "room1", parsed) is True
    await mvu_apply_text(documents, "room1", NARRATION)  # progress: 好感度 33 → 35, day 1 → 2
    assert await mvu_init_from_initvar(documents, "room1", parsed) is False  # nothing new
    tree = await load_mvu(documents, "room1")
    assert tree["理"]["好感度"] == [35, "对主角的好感"]  # re-import kept the progress
    assert tree["世界"]["day"] == 2
    assert await mvu_init_from_initvar(documents, "room1", {"新章节": {"进度": 0}}) is True
    tree = await load_mvu(documents, "room1")
    assert tree["新章节"] == {"进度": 0}
    assert tree["理"]["好感度"] == [35, "对主角的好感"]


async def test_apply_text_end_to_end_persists():
    documents = DocumentStore(Store())
    await mvu_init_from_initvar(documents, "room1", parse_initvar(INITVAR_TEXT))
    cleaned, applied, errors = await mvu_apply_text(documents, "room1", NARRATION)
    assert cleaned == "他微微一笑。\n\n雨停了。"
    assert [command["op"] for command in applied] == ["set", "add"]
    assert applied[0]["reason"] == "pleasant discussion"
    assert errors == []
    tree = await load_mvu(documents, "room1")
    assert tree["理"]["好感度"] == [35, "对主角的好感"]
    assert tree["世界"]["day"] == 2


async def test_apply_text_without_block_is_a_no_op():
    documents = DocumentStore(Store())
    cleaned, applied, errors = await mvu_apply_text(documents, "room1", "plain narration")
    assert (cleaned, applied, errors) == ("plain narration", [], [])
    assert await mvu_has_data(documents, "room1") is False


async def test_apply_text_all_failing_commands_saves_nothing():
    documents = DocumentStore(Store())
    cleaned, applied, errors = await mvu_apply_text(
        documents, "room1", "<UpdateVariable>_.delete('ghost')</UpdateVariable>"
    )
    assert cleaned == "" and applied == [] and len(errors) == 1
    assert await mvu_has_data(documents, "room1") is False


async def test_mvu_state_is_scoped_per_chat_key():
    documents = DocumentStore(Store())
    assert await mvu_init_from_initvar(documents, "room1", {"a": 1}) is True
    assert await mvu_has_data(documents, "room1") is True
    assert await mvu_has_data(documents, "room2") is False
    assert await load_mvu(documents, "room2") == {}


async def test_mvu_flatten_wrapper_and_has_data():
    documents = DocumentStore(Store())
    await mvu_init_from_initvar(documents, "room1", parse_initvar(INITVAR_TEXT))
    entries = await mvu_flatten(documents, "room1", 3)
    assert entries == [
        {"path": "理.情绪状态.pleasure", "value": 0.1},
        {"path": "理.好感度", "value": 33},
        {"path": "世界.link", "value": "https://example.com/wiki//page"},
    ]
    assert await mvu_has_data(documents, "room1") is True


# ---------------------------------------------------------------------------
# Player exposure (state-panel visibility) — fail-closed by default
# ---------------------------------------------------------------------------


def test_path_is_exposed_is_segment_aligned_and_star_exposes_all():
    from core.mvu_compat import path_is_exposed

    assert path_is_exposed("理.好感度", ["理"])
    assert path_is_exposed("理", ["理"])
    assert not path_is_exposed("理二号.好感度", ["理"])  # prefix must end on a segment
    assert not path_is_exposed("理.好感度", [])  # empty list exposes nothing
    assert path_is_exposed("anything.at.all", ["*"])


async def test_expose_hide_round_trip_with_caps_and_malformed_document():
    from core.mvu_compat import MAX_EXPOSED_PREFIXES

    documents = DocumentStore(Store())
    assert await mvu_exposed_prefixes(documents, "room1") == []

    assert await mvu_expose(documents, "room1", " 理. ") is True  # trimmed + normalized
    assert await mvu_expose(documents, "room1", "理") is False  # duplicate
    assert await mvu_expose(documents, "room1", "   ") is False  # unusable
    assert await mvu_exposed_prefixes(documents, "room1") == ["理"]

    assert await mvu_hide(documents, "room1", "理") is True
    assert await mvu_hide(documents, "room1", "理") is False
    assert await mvu_exposed_prefixes(documents, "room1") == []

    # A malformed stored document degrades to the fail-closed default.
    await documents.put("room1", "mvu_tree", "mvu", {"tree": {}, "exposed": "not-a-list"})
    assert await mvu_exposed_prefixes(documents, "room1") == []

    # The list cap holds.
    for index in range(MAX_EXPOSED_PREFIXES + 5):
        await mvu_expose(documents, "room2", f"p{index}")
    assert len(await mvu_exposed_prefixes(documents, "room2")) == MAX_EXPOSED_PREFIXES
